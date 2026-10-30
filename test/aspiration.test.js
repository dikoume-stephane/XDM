import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AspirationError, executerAspiration, nomDossier } from '../src/aspiration.js';
import { PROJECT_SUFFIX } from '../src/project.js';

/** Site témoin minimal : deux pages, deux fichiers, une branche interdite. */
async function site() {
  const pages = {
    '/index.html': '<html><body><a href="/a.html">A</a><a href="/f.bin">F</a><a href="/prive/x.html">P</a></body></html>',
    '/a.html': '<html><body><a href="/g.bin">G</a></body></html>',
    '/prive/x.html': '<html><body>privé</body></html>',
    '/robots.txt': 'User-agent: *\nDisallow: /prive/\n',
    '/f.bin': Buffer.alloc(1024, 7),
    '/g.bin': Buffer.alloc(2048, 9),
  };
  const serveur = http.createServer((req, res) => {
    const chemin = new URL(req.url, 'http://x').pathname;
    const contenu = pages[chemin];
    if (contenu === undefined) {
      res.writeHead(404, { 'content-length': 0 });
      res.end();
      return;
    }
    const corps = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, 'utf8');
    const type = chemin.endsWith('.html') ? 'text/html; charset=utf-8'
      : chemin === '/robots.txt' ? 'text/plain; charset=utf-8'
        : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': corps.length, 'accept-ranges': 'bytes' });
    res.end(req.method === 'HEAD' ? undefined : corps);
  });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const { port } = serveur.address();
  return {
    url: (chemin = '/index.html') => `http://127.0.0.1:${port}${chemin}`,
    fermer: () => new Promise((ok) => serveur.close(ok)),
  };
}

test('T-E-08 : une aspiration écrit le projet, la file et les fichiers', async () => {
  const temoin = await site();
  const racine = await mkdtemp(join(tmpdir(), 'xdm-asp-'));
  const phases = [];
  try {
    const resultat = await executerAspiration({
      url: temoin.url('/index.html'),
      racine,
      profondeur: 2,
      maxPages: 10,
      onEtape: (etape) => phases.push(etape.phase),
    });
    assert.equal(resultat.pages >= 2, true, `pages visitées : ${resultat.pages}`);
    assert.ok(resultat.retenus >= 2, `fichiers retenus : ${resultat.retenus}`);
    assert.equal(resultat.taches, resultat.termines);
    assert.equal(resultat.codeSortie, 0);
    assert.equal(phases[0], 'parcours');
    for (const attendue of ['parcours', 'plan', 'telechargement', 'tache', 'fini']) {
      assert.ok(phases.includes(attendue), `phase manquante : ${attendue} (${phases.join(', ')})`);
    }

    const dossier = resultat.dossier;
    assert.equal(dossier.startsWith(racine), true);
    const contenu = await readdir(dossier);
    assert.ok(contenu.includes('queue.json'), 'la file est écrite dans le dossier de l’aspiration');
    assert.ok(contenu.some((nom) => nom.endsWith(PROJECT_SUFFIX)), 'le projet est écrit');
    assert.ok(contenu.includes('a.html'), 'une page liée est enregistrée sur disque');
    const fichier = await readFile(join(dossier, 'f.bin'));
    assert.equal(fichier.length, 1024);
    assert.equal(fichier[0], 7);
  } finally {
    await temoin.fermer();
    await rm(racine, { recursive: true, force: true });
  }
});

test('WP-52 : robots.txt est respecté, la branche interdite n’est pas aspirée', async () => {
  const temoin = await site();
  const racine = await mkdtemp(join(tmpdir(), 'xdm-asp-'));
  try {
    const resultat = await executerAspiration({ url: temoin.url('/'), racine, profondeur: 3, maxPages: 20 });
    await assert.rejects(() => stat(join(resultat.dossier, 'prive', 'x.html')), /ENOENT/);
    assert.equal(resultat.codeSortie, 0);
  } finally {
    await temoin.fermer();
    await rm(racine, { recursive: true, force: true });
  }
});

test('WP-52 : une URL refusée ne crée aucun dossier', async () => {
  const racine = await mkdtemp(join(tmpdir(), 'xdm-asp-'));
  try {
    await assert.rejects(
      () => executerAspiration({ url: 'file:///etc/passwd', racine }),
      (e) => e instanceof AspirationError && e.code === 'SCHEMA_REFUSE',
    );
    await assert.rejects(() => executerAspiration({ url: 'pas une url', racine }), (e) => e.code === 'URL_INVALIDE');
    await assert.rejects(() => executerAspiration({ url: '', racine }), (e) => e.code === 'URL_MANQUANTE');
    await assert.rejects(
      () => executerAspiration({ url: 'https://exemple.fr/', racine, profondeur: 0 }),
      (e) => e.code === 'PROFONDEUR_INVALIDE',
    );
    await assert.rejects(
      () => executerAspiration({ url: 'https://exemple.fr/', racine, maxPages: 0 }),
      (e) => e.code === 'PAGES_INVALIDE',
    );
    assert.deepEqual(await readdir(racine), []);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('WP-52 : le nom de dossier est sûr, même pour un hôte hostile', () => {
  assert.match(nomDossier('https://exemple.fr/a', Date.UTC(2026, 9, 30, 12, 0, 0)), /^exemple\.fr-20261030-120000$/);
  assert.equal(nomDossier('https://a_b.fr/x', 0), 'a-b.fr-19700101-000000');
  assert.equal(nomDossier('https://exemple.fr:8080/x', 0), 'exemple.fr-19700101-000000');
  assert.equal(nomDossier('pas une url', 0), 'site-19700101-000000');
});
