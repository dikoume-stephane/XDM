import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createManager } from '../src/manager.js';
import { startUiServer, MAX_CORPS } from '../src/ui-server.js';
import { VERSION } from '../src/version.js';

/** Démarre un serveur sur un port libre avec un gestionnaire pilotable. */
async function avecServeur(callback, { telecharger = async () => ({ size: 10 }) } = {}) {
  const manager = createManager({ dossier: 'dl', telecharger, maxActifs: 1 });
  const instance = await startUiServer({ port: 0, manager });
  try {
    return await callback({ ...instance, manager, base: instance.url.replace(/\/$/, '') });
  } finally {
    await instance.fermer();
  }
}

test('WP-51 : l’interface statique est servie avec les bons types', async () => {
  await avecServeur(async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /<title>XDM/);
    assert.match(html, /File d'attente/);
    assert.match(html, /aria-live="polite"/);

    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.match(await css.text(), /--c-primaire/);

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    const absent = await fetch(`${base}/inconnu.css`);
    assert.equal(absent.status, 404);
    assert.equal((await absent.json()).erreur.code, 'INTROUVABLE');
  });
});

test('WP-51 : une sortie de la racine statique est refusée', async () => {
  await avecServeur(async ({ base }) => {
    const reponse = await fetch(`${base}/%2e%2e%2fsrc%2fmanager.js`);
    assert.equal(reponse.status, 403);
    assert.equal((await reponse.json()).erreur.code, 'HORS_RACINE');
  });
});

test('WP-51 : GET /api/etat expose version, dossier et listes', async () => {
  await avecServeur(async ({ base }) => {
    const reponse = await fetch(`${base}/api/etat`);
    assert.equal(reponse.status, 200);
    const corps = await reponse.json();
    assert.equal(corps.version, VERSION);
    assert.equal(corps.dossier, 'dl');
    assert.deepEqual(corps.taches, []);
    assert.equal(corps.compteurs.attente, 0);
    assert.equal(reponse.headers.get('cache-control'), 'no-store');
  });
});

test('WP-51 : POST /api/taches valide l’URL et rend 201', async () => {
  await avecServeur(async ({ base }) => {
    const bon = await fetch(`${base}/api/taches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://exemple.fr/fichier.bin' }),
    });
    assert.equal(bon.status, 201);
    const { tache } = await bon.json();
    assert.equal(tache.nom, 'fichier.bin');
    assert.equal(tache.etat, 'attente');

    const liste = await (await fetch(`${base}/api/taches`)).json();
    assert.equal(liste.taches.length, 1);

    const refusee = await fetch(`${base}/api/taches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    assert.equal(refusee.status, 400);
    assert.equal((await refusee.json()).erreur.code, 'SCHEMA_REFUSE');

    const manquante = await fetch(`${base}/api/taches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(manquante.status, 400);
    assert.equal((await manquante.json()).erreur.code, 'URL_MANQUANTE');

    const doublon = await fetch(`${base}/api/taches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://exemple.fr/b/fichier.bin', nom: 'fichier.bin' }),
    });
    assert.equal(doublon.status, 409);
    assert.equal((await doublon.json()).erreur.code, 'NOM_DEJA_PRIS');
  });
});

test('WP-51 : un corps JSON invalide ou trop gros est refusé', async () => {
  await avecServeur(async ({ base }) => {
    const invalide = await fetch(`${base}/api/taches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ pas du json',
    });
    assert.equal(invalide.status, 400);
    assert.equal((await invalide.json()).erreur.code, 'JSON_INVALIDE');

    const enorme = await fetch(`${base}/api/taches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://exemple.fr/f.bin', bourrage: 'x'.repeat(MAX_CORPS + 1024) }),
    });
    assert.equal(enorme.status, 413);
    assert.equal((await enorme.json()).erreur.code, 'CORPS_TROP_GRAND');
  });
});

test('WP-51 : DELETE retire une tâche en attente, refuse une tâche en cours', async () => {
  let libere;
  await avecServeur(
    async ({ base, manager }) => {
      await fetch(`${base}/api/taches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://exemple.fr/1.bin' }),
      });
      const deux = await fetch(`${base}/api/taches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://exemple.fr/2.bin' }),
      });
      const { tache } = await deux.json();

      const retiree = await fetch(`${base}/api/taches/${tache.id}`, { method: 'DELETE' });
      assert.equal(retiree.status, 200);

      const inconnue = await fetch(`${base}/api/taches/T-999`, { method: 'DELETE' });
      assert.equal(inconnue.status, 404);
      assert.equal((await inconnue.json()).erreur.code, 'TACHE_INCONNUE');

      void manager.demarrer();
      await new Promise((ok) => setTimeout(ok, 20));
      const active = await fetch(`${base}/api/taches/T-1`, { method: 'DELETE' });
      assert.equal(active.status, 409);
      assert.equal((await active.json()).erreur.code, 'TACHE_ACTIVE');
      libere({});
    },
    { telecharger: () => new Promise((ok) => { libere = ok; }) },
  );
});

test('WP-51 : les méthodes et routes inconnues rendent du JSON, pas du HTML', async () => {
  await avecServeur(async ({ base }) => {
    const methode = await fetch(`${base}/api/etat`, { method: 'PUT' });
    assert.equal(methode.status, 405);
    assert.equal((await methode.json()).erreur.code, 'METHODE_REFUSEE');

    const route = await fetch(`${base}/api/inconnue`);
    assert.equal(route.status, 404);
    assert.equal((await route.json()).erreur.code, 'ROUTE_INCONNUE');
    assert.match(route.headers.get('content-type'), /application\/json/);
  });
});

test('WP-51 : POST /api/demarrer lance la file sans bloquer la réponse', async () => {
  await avecServeur(async ({ base, manager }) => {
    await fetch(`${base}/api/taches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://exemple.fr/f.bin' }),
    });
    const demarrage = await fetch(`${base}/api/demarrer`, { method: 'POST' });
    assert.equal(demarrage.status, 202);
    assert.deepEqual(await demarrage.json(), { demarre: true });

    for (let i = 0; i < 50 && manager.historique().length === 0; i += 1) {
      await new Promise((ok) => setTimeout(ok, 10));
    }
    assert.equal(manager.historique().length, 1);
    const historique = await (await fetch(`${base}/api/historique`)).json();
    assert.equal(historique.entrees[0].etat, 'termine');
    const journal = await (await fetch(`${base}/api/journal`)).json();
    assert.ok(journal.entrees.some((e) => e.message.includes('terminé')));
  });
});

test('WP-51 : le flux SSE envoie l’instantané puis les événements', async () => {
  await avecServeur(async ({ base, manager }) => {
    const controleur = new AbortController();
    const reponse = await fetch(`${base}/api/evenements`, { signal: controleur.signal });
    assert.equal(reponse.status, 200);
    assert.match(reponse.headers.get('content-type'), /text\/event-stream/);
    const lecteur = reponse.body.getReader();
    const decodeur = new TextDecoder();

    const lire = async (motif, limite = 20) => {
      let texte = '';
      for (let i = 0; i < limite; i += 1) {
        const { value, done } = await lecteur.read();
        if (done) break;
        texte += decodeur.decode(value, { stream: true });
        if (texte.includes(motif)) return texte;
      }
      return texte;
    };

    const initial = await lire('event: etat');
    assert.match(initial, /event: etat/);
    assert.match(initial, /"dossier":"dl"/);

    manager.ajouter({ url: 'https://exemple.fr/sse.bin' });
    const apres = await lire('event: ajout');
    assert.match(apres, /event: ajout/);
    assert.match(apres, /sse\.bin/);
    assert.match(apres, /event: journal/);

    controleur.abort();
    await lecteur.cancel().catch(() => {});
  });
});

test('WP-51 : l’écoute par défaut reste sur la boucle locale', async () => {
  const instance = await startUiServer({ port: 0 });
  try {
    assert.equal(instance.hote, '127.0.0.1');
    assert.match(instance.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(instance.port > 0);
  } finally {
    await instance.fermer();
  }
});
