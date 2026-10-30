import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addTask, completeTask, createQueue, saveQueue, transition } from '../src/task-queue.js';
import { createUiServer } from '../src/ui-server.js';

/** Site témoin : une page, un fichier lié. */
async function site() {
  const pages = {
    '/index.html': '<html><body><a href="/f.bin">F</a></body></html>',
    '/f.bin': Buffer.alloc(512, 3),
  };
  const serveur = http.createServer((req, res) => {
    const contenu = pages[new URL(req.url, 'http://x').pathname];
    if (contenu === undefined) {
      res.writeHead(404, { 'content-length': 0 });
      res.end();
      return;
    }
    const corps = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, 'utf8');
    res.writeHead(200, {
      'content-type': req.url.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream',
      'content-length': corps.length,
      'accept-ranges': 'bytes',
    });
    res.end(req.method === 'HEAD' ? undefined : corps);
  });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const { port } = serveur.address();
  return {
    url: (chemin = '/index.html') => `http://127.0.0.1:${port}${chemin}`,
    fermer: () => new Promise((ok) => serveur.close(ok)),
  };
}

/** Démarre le serveur sur un port libre, avec un fichier de réglages temporaire. */
async function avecServeur(callback) {
  const racine = await mkdtemp(join(tmpdir(), 'xdm-api-'));
  const cheminReglages = join(racine, 'reglages.json');
  const dossier = join(racine, 'dl');
  const { serveur, manager, port } = createUiServer({
    reglages: { chemin: cheminReglages, existe: false, dossier, connexions: 2, maxActifs: 1 },
  });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  try {
    return await callback({ base, manager, racine, dossier, cheminReglages });
  } finally {
    await new Promise((ok) => serveur.close(() => ok(undefined)));
    await rm(racine, { recursive: true, force: true });
  }
}

const json = (base, chemin, options = {}) =>
  fetch(`${base}${chemin}`, {
    ...options,
    headers: options.corps ? { 'content-type': 'application/json' } : undefined,
    body: options.corps ? JSON.stringify(options.corps) : undefined,
  });

test('T-E-06 : les réglages se lisent, se modifient et se persistent', async () => {
  await avecServeur(async ({ base, cheminReglages }) => {
    const lus = await (await json(base, '/api/reglages')).json();
    assert.equal(lus.reglages.connexions, 2);

    const modifie = await json(base, '/api/reglages', { method: 'PATCH', corps: { connexions: 8, theme: 'sombre' } });
    assert.equal(modifie.status, 200);
    const { reglages } = await modifie.json();
    assert.equal(reglages.connexions, 8);
    assert.equal(reglages.theme, 'sombre');

    const disque = JSON.parse(await readFile(cheminReglages, 'utf8'));
    assert.equal(disque.connexions, 8);
    assert.equal(disque.theme, 'sombre');

    const etat = await (await json(base, '/api/etat')).json();
    assert.equal(etat.connexions, 8, 'le gestionnaire a reçu le nouveau réglage');
  });
});

test('WP-52 : un réglage invalide est refusé, et rien n’est écrit', async () => {
  await avecServeur(async ({ base, cheminReglages }) => {
    const robots = await json(base, '/api/reglages', { method: 'PATCH', corps: { robots: false } });
    assert.equal(robots.status, 400);
    assert.equal((await robots.json()).erreur.code, 'ROBOTS_VERROUILLE');

    const borne = await json(base, '/api/reglages', { method: 'PATCH', corps: { connexions: 0 } });
    assert.equal(borne.status, 400);
    assert.equal((await borne.json()).erreur.code, 'REGLE_INVALIDE');

    const theme = await json(base, '/api/reglages', { method: 'PATCH', corps: { theme: 'neon' } });
    assert.equal(theme.status, 400);

    await assert.rejects(() => readFile(cheminReglages, 'utf8'), /ENOENT/);
  });
});

test('WP-52 : la vérification refuse un dossier sans file et accepte un dossier préparé', async () => {
  await avecServeur(async ({ base, racine }) => {
    const vide = join(racine, 'vide');
    await writeFile(join(racine, 'inutile.txt'), 'x');
    const absent = await json(base, '/api/verifications', { method: 'POST', corps: { dossier: vide } });
    assert.equal(absent.status, 404);
    assert.equal((await absent.json()).erreur.code, 'DOSSIER_ABSENT');

    const sansFile = await json(base, '/api/verifications', { method: 'POST', corps: { dossier: racine } });
    assert.equal(sansFile.status, 404);
    assert.equal((await sansFile.json()).erreur.code, 'FILE_ABSENTE');

    const dossier = join(racine, 'ok');
    await writeFile(join(racine, '.keep'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dossier, { recursive: true });
    let file = createQueue({});
    const ajout = addTask(file, { url: 'https://exemple.fr/a.bin', target: join(dossier, 'a.bin'), totalSize: 4 });
    file = ajout.queue;
    file = transition(file, ajout.task.id, 'ACTIVE');
    file = transition(file, ajout.task.id, 'VERIFYING');
    file = completeTask(file, ajout.task.id);
    await saveQueue(dossier, file);
    await writeFile(join(dossier, 'a.bin'), Buffer.from([1, 2, 3, 4]));

    const reponse = await json(base, '/api/verifications', { method: 'POST', corps: { dossier } });
    assert.equal(reponse.status, 200);
    const { rapport } = await reponse.json();
    assert.equal(rapport.codeSortie, 0);
    assert.equal(rapport.conformes, true);
    assert.equal(rapport.compteurs.verifies, 1);
    assert.equal(rapport.anomalies, 0);
  });
});

test('WP-52 : une aspiration se lance par l’API et se suit jusqu’au bout', async () => {
  const temoin = await site();
  try {
    await avecServeur(async ({ base, manager }) => {
      const refusee = await json(base, '/api/aspirations', { method: 'POST', corps: { url: 'file:///etc/passwd' } });
      assert.equal(refusee.status, 400);
      assert.equal((await refusee.json()).erreur.code, 'SCHEMA_REFUSE');

      const lancee = await json(base, '/api/aspirations', { method: 'POST', corps: { url: temoin.url('/index.html'), profondeur: 2, maxPages: 5 } });
      assert.equal(lancee.status, 202);
      const { aspiration } = await lancee.json();
      assert.equal(aspiration.id, 'A-1');
      assert.equal(aspiration.etat, 'en_cours');

      for (let i = 0; i < 200; i += 1) {
        const etat = manager.aspirations()[0];
        if (etat.etat !== 'en_cours') break;
        await new Promise((ok) => setTimeout(ok, 20));
      }
      const fin = manager.aspirations()[0];
      assert.equal(fin.etat, 'termine', `état final : ${fin.etat} (${fin.erreur ? fin.erreur.message : ''})`);
      assert.equal(fin.codeSortie, 0);
      assert.equal(fin.termines, fin.taches);
      assert.ok(fin.taches >= 1);

      const liste = await (await json(base, '/api/aspirations')).json();
      assert.equal(liste.aspirations.length, 1);

      // Le dossier produit par l'aspiration est vérifiable tel quel.
      const verif = await json(base, '/api/verifications', { method: 'POST', corps: { dossier: fin.dossier } });
      assert.equal(verif.status, 200);
      assert.equal((await verif.json()).rapport.anomalies, 0);
    });
  } finally {
    await temoin.fermer();
  }
});
