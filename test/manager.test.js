import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { download } from '../src/connection-loop.js';
import { createManager, ManagerError, nomLibre, analyserUrl, PROGRESSION_MS } from '../src/manager.js';

/** Serveur de test : un fichier, `Range` honoré, taille annoncée. */
async function banc(contenu) {
  const serveur = http.createServer((req, res) => {
    const plage = req.headers.range;
    const commun = {
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    };
    if (plage) {
      const [debut, fin] = /bytes=(\d+)-(\d*)/.exec(plage).slice(1);
      const a = Number(debut);
      const b = fin === '' ? contenu.length - 1 : Math.min(Number(fin), contenu.length - 1);
      res.writeHead(206, {
        ...commun,
        'content-length': b - a + 1,
        'content-range': `bytes ${a}-${b}/${contenu.length}`,
      });
      res.end(contenu.subarray(a, b + 1));
      return;
    }
    res.writeHead(200, { ...commun, 'content-length': contenu.length });
    res.end(req.method === 'HEAD' ? undefined : contenu);
  });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const { port } = serveur.address();
  return { serveur, url: (chemin = '/fichier.bin') => `http://127.0.0.1:${port}${chemin}`, fermer: () => new Promise((ok) => serveur.close(ok)) };
}

test('WP-51 : une URL non http(s) est refusée avant tout accès réseau', () => {
  assert.throws(() => analyserUrl('file:///etc/passwd'), (e) => e instanceof ManagerError && e.code === 'SCHEMA_REFUSE');
  assert.throws(() => analyserUrl('ftp://exemple.fr/f'), (e) => e.code === 'SCHEMA_REFUSE');
  assert.throws(() => analyserUrl('pas une url'), (e) => e.code === 'URL_INVALIDE');
  assert.throws(() => analyserUrl(''), (e) => e.code === 'URL_MANQUANTE');
  assert.equal(analyserUrl('  https://exemple.fr/a  ').href, 'https://exemple.fr/a');
});

test('WP-51 : le nom local vient de l’URL et ne collisionne pas', () => {
  const pris = new Set();
  const premier = nomLibre('https://exemple.fr/a/rapport.pdf', 'dl', pris);
  pris.add(premier);
  const second = nomLibre('https://exemple.fr/b/rapport.pdf', 'dl', pris);
  assert.equal(premier, 'rapport.pdf');
  assert.equal(second, 'rapport-2.pdf');
  pris.add(second);
  assert.equal(nomLibre('https://exemple.fr/c/rapport.pdf', 'dl', pris), 'rapport-3.pdf');
});

test('WP-51 : ajouter enregistre une intention sans rien télécharger', () => {
  let appels = 0;
  const manager = createManager({ dossier: 'dl', telecharger: async () => { appels += 1; } });
  const tache = manager.ajouter({ url: 'https://exemple.fr/fichier.bin' });
  assert.equal(tache.id, 'T-1');
  assert.equal(tache.etat, 'attente');
  assert.equal(tache.cible, join('dl', 'fichier.bin'));
  assert.equal(appels, 0, 'aucun appel au moteur avant demarrer');
  assert.equal(manager.compteurs().attente, 1);
  assert.equal(manager.journal().at(-1).message, 'ajouté à la file : fichier.bin');
});

test('WP-51 : deux URL de même nom reçoivent deux fichiers distincts', () => {
  const manager = createManager({ dossier: 'dl', telecharger: async () => ({}) });
  manager.ajouter({ url: 'https://exemple.fr/a/rapport.pdf' });
  manager.ajouter({ url: 'https://exemple.fr/b/rapport.pdf' });
  const noms = manager.taches().map((t) => t.nom);
  assert.deepEqual(noms, ['rapport.pdf', 'rapport-2.pdf']);
  assert.throws(
    () => manager.ajouter({ url: 'https://exemple.fr/c/x.bin', nom: 'rapport.pdf' }),
    (e) => e.code === 'NOM_DEJA_PRIS',
  );
});

test('WP-51 : la file respecte maxActifs et l’ordre d’arrivée', async () => {
  const ordre = [];
  let libres = [];
  const manager = createManager({
    dossier: 'dl',
    maxActifs: 1,
    telecharger: async (url) => {
      ordre.push(new URL(url).pathname);
      await new Promise((ok) => libres.push(ok));
      return {};
    },
  });
  manager.ajouter({ url: 'https://exemple.fr/1.bin' });
  manager.ajouter({ url: 'https://exemple.fr/2.bin' });
  manager.ajouter({ url: 'https://exemple.fr/3.bin' });
  const termine = manager.demarrer();
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(ordre, ['/1.bin'], 'une seule tâche active à la fois');
  assert.equal(manager.compteurs().enCours, 1);
  libres.shift()();
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(ordre, ['/1.bin', '/2.bin']);
  libres.shift()();
  await new Promise((ok) => setTimeout(ok, 20));
  libres.shift()();
  await termine;
  assert.deepEqual(ordre, ['/1.bin', '/2.bin', '/3.bin']);
  assert.equal(manager.compteurs().historique, 3);
});

test('T-E-04 : progression diffusée par paliers, pas à chaque octet', async () => {
  let horloge = 0;
  const manager = createManager({
    dossier: 'dl',
    maintenant: () => horloge,
    telecharger: async (url, cible, options) => {
      for (let i = 1; i <= 50; i += 1) {
        horloge += 10; // 500 ms au total
        options.onProgress({ done: i * 10, total: 500 });
      }
      return { size: 500 };
    },
  });
  const evenements = [];
  manager.abonner((e) => evenements.push(e));
  manager.ajouter({ url: 'https://exemple.fr/f.bin' });
  await manager.demarrer();
  const progressions = evenements.filter((e) => e.type === 'progression');
  assert.ok(progressions.length >= 1, 'au moins un événement de progression');
  assert.ok(progressions.length < 10, `paliers respectés (${progressions.length} événements pour 50 appels)`);
  // 500 ms / 200 ms ⇒ 2 paliers, plus la fin de tâche.
  assert.ok(progressions.length <= Math.ceil(500 / PROGRESSION_MS) + 1);
  const fin = manager.historique()[0];
  assert.equal(fin.etat, 'termine');
  assert.equal(fin.codeSortie, 0);
  assert.equal(fin.taille, 500);
});

test('WP-51 : un échec donne un code de sortie 1 et une trace au journal', async () => {
  const manager = createManager({
    dossier: 'dl',
    telecharger: async () => {
      const erreur = new Error('503 après 3 tentatives');
      erreur.code = 'HTTP_503';
      throw erreur;
    },
  });
  manager.ajouter({ url: 'https://exemple.fr/f.bin' });
  await manager.demarrer();
  const entree = manager.historique()[0];
  assert.equal(entree.etat, 'echec');
  assert.equal(entree.codeSortie, 1);
  assert.equal(entree.erreur.code, 'HTTP_503');
  assert.match(manager.journal().at(-1).message, /503 après 3 tentatives/);
  assert.equal(manager.journal().at(-1).niveau, 'erreur');
});

test('WP-51 : on peut retirer une tâche en attente, pas une tâche en cours', async () => {
  let libere;
  const manager = createManager({
    dossier: 'dl',
    maxActifs: 1,
    telecharger: () => new Promise((ok) => { libere = ok; }),
  });
  manager.ajouter({ url: 'https://exemple.fr/1.bin' });
  manager.ajouter({ url: 'https://exemple.fr/2.bin' });
  const termine = manager.demarrer();
  await new Promise((ok) => setTimeout(ok, 10));
  assert.throws(() => manager.retirer('T-1'), (e) => e.code === 'TACHE_ACTIVE');
  assert.throws(() => manager.retirer('T-99'), (e) => e.code === 'TACHE_INCONNUE');
  const retiree = manager.retirer('T-2');
  assert.equal(retiree.etat, 'attente');
  assert.equal(manager.compteurs().attente, 0);
  libere({});
  await termine;
  assert.equal(manager.historique().length, 1);
});

test('WP-51 : abonner rend une fonction de désabonnement effective', () => {
  const manager = createManager({ dossier: 'dl', telecharger: async () => ({}) });
  let recus = 0;
  const quitter = manager.abonner(() => { recus += 1; });
  manager.ajouter({ url: 'https://exemple.fr/a.bin' });
  assert.ok(recus > 0);
  const avant = recus;
  quitter();
  manager.ajouter({ url: 'https://exemple.fr/b.bin' });
  assert.equal(recus, avant);
});

test('T-E-03 : bout en bout avec le vrai moteur — fichier écrit, historique à jour', async () => {
  const contenu = Buffer.alloc(256 * 1024);
  for (let i = 0; i < contenu.length; i += 1) contenu[i] = i % 251;
  const site = await banc(contenu);
  const dossier = await mkdtemp(join(tmpdir(), 'xdm-ui-'));
  try {
    const manager = createManager({ dossier, connexions: 2, telecharger: download });
    const tache = manager.ajouter({ url: site.url('/fichier.bin') });
    await manager.demarrer();
    const entree = manager.historique()[0];
    assert.equal(entree.etat, 'termine');
    assert.equal(entree.codeSortie, 0);
    assert.equal(entree.taille, contenu.length);
    const ecrit = await readFile(join(dossier, tache.nom));
    assert.equal(ecrit.length, contenu.length);
    assert.equal(ecrit[0], contenu[0]);
    assert.equal(ecrit.at(-1), contenu.at(-1));
    const info = await stat(join(dossier, tache.nom));
    assert.ok(info.isFile());
    assert.equal(manager.taches().length, 0, 'la tâche a quitté la file');
  } finally {
    await site.fermer();
    await rm(dossier, { recursive: true, force: true });
  }
});

test('WP-51 : le dossier de destination est créé au démarrage', async () => {
  const racine = await mkdtemp(join(tmpdir(), 'xdm-ui-'));
  const dossier = join(racine, 'sous', 'dossier');
  let vu = false;
  try {
    const manager = createManager({
      dossier,
      telecharger: async (url, cible) => {
        vu = (await stat(join(dossier))).isDirectory() && cible.startsWith(dossier);
        return { size: 1 };
      },
    });
    manager.ajouter({ url: 'https://exemple.fr/f.bin' });
    await manager.demarrer();
    assert.ok(vu, 'le dossier existait au moment de l’appel au moteur');
    assert.equal(manager.historique()[0].etat, 'termine');
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('WP-51 : un échec réseau réel est consigné sans faire tomber le gestionnaire', async () => {
  const dossier = await mkdtemp(join(tmpdir(), 'xdm-ui-'));
  try {
    const manager = createManager({ dossier, connexions: 1, telecharger: download });
    manager.ajouter({ url: 'http://127.0.0.1:9/absent.bin' });
    await manager.demarrer();
    const entree = manager.historique()[0];
    assert.equal(entree.etat, 'echec');
    assert.equal(entree.codeSortie, 1);
    assert.equal(manager.compteurs().enCours, 0);
  } finally {
    await rm(dossier, { recursive: true, force: true });
  }
});

test('T-E-15 : un dossier de destination absent est créé, et une seule exécution démarre', async () => {
  const temoin = await banc(Buffer.alloc(64 * 1024, 4));
  const racine = await mkdtemp(join(tmpdir(), 'xdm-mgr-'));
  // Dossier **inexistant** : c'est le cas d'un premier lancement.
  const dossier = join(racine, 'dl', 'profond');
  try {
    const gestionnaire = createManager({ dossier, connexions: 2, maxActifs: 2 });
    gestionnaire.ajouter({ url: temoin.url('/a.bin'), nom: 'a.bin' });
    gestionnaire.ajouter({ url: temoin.url('/b.bin'), nom: 'b.bin' });
    await gestionnaire.demarrer();
    const etat = gestionnaire.etat();
    assert.equal(etat.compteurs.historique, 2, 'les deux tâches sont terminées une fois chacune');
    assert.equal(etat.compteurs.enCours, 0);
    const contenu = await readdir(dossier);
    assert.deepEqual(contenu.sort(), ['a.bin', 'b.bin']);
  } finally {
    await temoin.fermer();
    await rm(racine, { recursive: true, force: true });
  }
});
