import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { download } from '../src/connection-loop.js';
import { createManager } from '../src/manager.js';

/** Contenu de référence : déterministe, vérifiable octet par octet. */
function contenu(taille = 512 * 1024) {
  const tampon = Buffer.alloc(taille);
  for (let i = 0; i < taille; i += 1) tampon[i] = i % 251;
  return tampon;
}

/**
 * Banc d'essai : `Range` honoré, et un mode lent qui envoie par petits paquets espacés.
 *
 * Le mode lent est indispensable : sans lui, un fichier est terminé avant qu'on ait pu
 * demander la suspension, et le test ne prouverait rien.
 */
async function banc({ taille = 512 * 1024, lent = false } = {}) {
  const corps = contenu(taille);
  const serveur = http.createServer(async (req, res) => {
    const plage = req.headers.range ? /bytes=(\d+)-(\d*)/.exec(req.headers.range) : null;
    let debut = 0;
    let fin = corps.length - 1;
    let statut = 200;
    const entetes = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
    if (plage) {
      debut = Number(plage[1]);
      fin = plage[2] === '' ? corps.length - 1 : Math.min(Number(plage[2]), corps.length - 1);
      statut = 206;
      entetes['content-range'] = `bytes ${debut}-${fin}/${corps.length}`;
    }
    entetes['content-length'] = fin - debut + 1;
    res.writeHead(statut, entetes);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const morceau = corps.subarray(debut, fin + 1);
    if (!lent) {
      res.end(morceau);
      return;
    }
    for (let i = 0; i < morceau.length; i += 8192) {
      if (res.destroyed) return;
      res.write(morceau.subarray(i, i + 8192));
      await new Promise((ok) => setTimeout(ok, 25));
    }
    res.end();
  });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const { port } = serveur.address();
  return {
    corps,
    url: () => `http://127.0.0.1:${port}/f.bin`,
    fermer: () =>
      new Promise((ok) => {
        serveur.closeAllConnections?.();
        serveur.close(ok);
      }),
  };
}

/** Attend qu'une condition devienne vraie, sans dormir plus que nécessaire. */
async function attendre(condition, { limite = 5000, pas = 25 } = {}) {
  const debut = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (Date.now() - debut > limite) return false;
    await new Promise((ok) => setTimeout(ok, pas));
  }
}

test('T-E-21 : un signal déjà annulé n’ouvre aucune connexion et n’écrit rien', async () => {
  const temoin = await banc();
  const racine = await mkdtemp(join(tmpdir(), 'xdm-susp-'));
  const cible = join(racine, 'f.bin');
  try {
    const controleur = new AbortController();
    controleur.abort('test');
    await assert.rejects(
      download(temoin.url(), cible, { signal: controleur.signal }),
      (error) => error.code === 'ANNULE',
    );
    assert.deepEqual(await readdir(racine), [], 'rien n’est écrit quand rien n’a commencé');
  } finally {
    await temoin.fermer();
    await rm(racine, { recursive: true, force: true });
  }
});

test('T-E-21 : annuler en cours laisse un fichier partiel, et la reprise va au bout', async () => {
  const temoin = await banc({ taille: 512 * 1024, lent: true });
  const racine = await mkdtemp(join(tmpdir(), 'xdm-susp-'));
  const cible = join(racine, 'f.bin');
  try {
    const controleur = new AbortController();
    const promesse = download(temoin.url(), cible, { signal: controleur.signal, connections: 1 });
    // On laisse partir quelques paquets, puis on suspend.
    await attendre(async () => (await readdir(racine)).some((nom) => nom.includes('.xdm-part')), { limite: 3000 });
    await new Promise((ok) => setTimeout(ok, 120));
    controleur.abort('suspendu');
    await assert.rejects(promesse, (error) => error.code === 'ANNULE');

    const restes = await readdir(racine);
    assert.equal(restes.includes('f.bin'), false, 'aucune promotion : le fichier n’est pas terminé');
    assert.ok(restes.some((nom) => nom.includes('.xdm-part')), 'le fichier de travail est conservé');

    // Reprise sans signal : le fichier final est identique à la source.
    const resultat = await download(temoin.url(), cible, { connections: 1, promote: true });
    assert.equal(resultat.size, temoin.corps.length);
    assert.deepEqual(await readFile(cible), temoin.corps);
  } finally {
    await temoin.fermer();
    await rm(racine, { recursive: true, force: true });
  }
});

test('T-E-22 : le gestionnaire suspend et reprend sans compter d’échec', async () => {
  const temoin = await banc({ taille: 512 * 1024, lent: true });
  const racine = await mkdtemp(join(tmpdir(), 'xdm-susp-mgr-'));
  try {
    const gestionnaire = createManager({ dossier: racine, connexions: 1, maxActifs: 1 });
    const tache = gestionnaire.ajouter({ url: temoin.url(), nom: 'f.bin' });

    // Suspendre avant démarrage : la tâche quitte la file sans rien télécharger.
    gestionnaire.suspendre(tache.id);
    assert.equal(gestionnaire.etat().taches[0].etat, 'suspendu');
    assert.equal(gestionnaire.etat().compteurs.suspendu, 1);

    // Reprise puis démarrage : le transfert part vraiment.
    gestionnaire.reprendre(tache.id);
    // `reprendre` remet en file **et** relance : selon la place disponible, la tâche est
    // encore en attente ou déjà repartie. Les deux états sont corrects, « suspendu » non.
    assert.ok(
      ['attente', 'en_cours'].includes(gestionnaire.etat().taches[0].etat),
      `état après reprise : ${gestionnaire.etat().taches[0].etat}`,
    );
    const execution = gestionnaire.demarrer();

    await attendre(() => {
      const t = gestionnaire.etat().taches.find((x) => x.id === tache.id);
      return t && t.fait > 0;
    }, { limite: 4000 });

    gestionnaire.suspendre(tache.id);
    await execution;

    const suspendue = gestionnaire.etat().taches.find((x) => x.id === tache.id);
    assert.equal(suspendue.etat, 'suspendu', `état : ${suspendue.etat}`);
    assert.equal(gestionnaire.etat().compteurs.historique, 0, 'une suspension n’entre pas dans l’historique');
    assert.equal(
      gestionnaire.journal().filter((entree) => entree.niveau === 'erreur').length,
      0,
      'une suspension n’est pas une erreur',
    );

    // Reprise : le fichier arrive entier, sans avoir tout retéléchargé au hasard.
    gestionnaire.reprendre(tache.id);
    // Une tâche terminée quitte `taches` pour `historique` : c'est l'historique qu'on attend.
    const fini = await attendre(() => {
      const instantane = gestionnaire.etat();
      return instantane.historique.some((x) => x.id === tache.id) || instantane.taches.some((x) => x.id === tache.id && x.etat === 'echec');
    }, { limite: 15000 });
    assert.equal(fini, true, 'la reprise se termine');
    const finale = gestionnaire.etat();
    assert.equal(finale.compteurs.historique, 1);
    assert.equal(finale.historique[0].etat, 'termine');
    assert.deepEqual(await readFile(join(racine, 'f.bin')), temoin.corps);
  } finally {
    await temoin.fermer();
    await rm(racine, { recursive: true, force: true });
  }
});

test('T-E-22 : suspendre une tâche finie est refusé, avec le code qui le dit', () => {
  const gestionnaire = createManager({ dossier: '/tmp/xdm-susp-vide', telecharger: async () => ({ size: 0 }) });
  const tache = gestionnaire.ajouter({ url: 'http://exemple.test/f.bin' });
  gestionnaire.retirer(tache.id);
  assert.throws(() => gestionnaire.suspendre(tache.id), (error) => error.code === 'TACHE_INCONNUE');
  assert.throws(() => gestionnaire.reprendre(tache.id), (error) => error.code === 'TACHE_INCONNUE');
});

test('T-E-22 : l’API expose suspendre et reprendre, et refuse le reste', async () => {
  const { createUiServer } = await import('../src/ui-server.js');
  const racine = await mkdtemp(join(tmpdir(), 'xdm-susp-api-'));
  const { serveur } = createUiServer({ dossier: racine });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  try {
    const ajout = await fetch(`${base}/api/taches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://exemple.test/f.bin' }),
    });
    const { tache } = await ajout.json();

    const suspendue = await fetch(`${base}/api/taches/${tache.id}/suspendre`, { method: 'POST' });
    assert.equal(suspendue.status, 200);
    assert.equal((await suspendue.json()).tache.etat, 'suspendu');

    const reprise = await fetch(`${base}/api/taches/${tache.id}/reprendre`, { method: 'POST' });
    assert.equal(reprise.status, 200);
    assert.ok(['attente', 'en_cours'].includes((await reprise.json()).tache.etat));

    // Reprendre une tâche qui n'est pas suspendue est une erreur explicite, pas un silence.
    // (Une tâche remise en file est `attente` ou `en_cours` : dans les deux cas, ce n'est
    // plus « suspendu », donc la reprise suivante est refusée.)
    const refus = await fetch(`${base}/api/taches/${tache.id}/reprendre`, { method: 'POST' });
    assert.equal(refus.status, 400);
    assert.equal((await refus.json()).erreur.code, 'ETAT_INVALIDE');

    const mauvaiseMethode = await fetch(`${base}/api/taches/${tache.id}/suspendre`);
    assert.equal(mauvaiseMethode.status, 405);

    const inconnue = await fetch(`${base}/api/taches/T-404/suspendre`, { method: 'POST' });
    assert.equal(inconnue.status, 404);
  } finally {
    await new Promise((ok) => serveur.close(() => ok(undefined)));
    await rm(racine, { recursive: true, force: true });
  }
});
