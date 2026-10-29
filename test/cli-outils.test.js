import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { main, parseArgs, parseHeader } from '../bin/xdm-grab.js';

const SECRET = 'Bearer jeton-de-test';

/**
 * Site qui exige **deux** choses pour servir un fichier : le cookie posé par la page
 * d'accueil, et l'en-tête fourni par `--entete`. Il refuse aussi une page sans cookie, ce
 * qui prouve que l'exploration envoie bien la session (et pas seulement les téléchargements).
 */
async function startGuardedSite() {
  const refus = { fichier: 0, page: 0 };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    const cookie = req.headers.cookie ?? '';
    if (path === '/robots.txt') {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    if (path === '/') {
      const body = Buffer.from('<a href="/data/a.bin">a</a><a href="/protegee.html">p</a>'
        + '<a href="/libre.html">l</a>');
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-length': String(body.length),
        'set-cookie': 'sid=page; Path=/; Max-Age=3600',
      });
      res.end(body);
      return;
    }
    if (path === '/libre.html') {
      const body = Buffer.from('<a href="/data/b.bin">b</a>');
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    if (!cookie.includes('sid=page')) {
      refus.page += 1;
      res.writeHead(403, { 'content-length': '0' });
      res.end();
      return;
    }
    if (path === '/protegee.html') {
      const body = Buffer.from('page protégée par cookie');
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    const files = { '/data/a.bin': 'A', '/data/b.bin': 'B' };
    if (files[path]) {
      if (req.headers.authorization !== SECRET) {
        refus.fichier += 1;
        res.writeHead(401, { 'content-length': '0' });
        res.end();
        return;
      }
      const body = Buffer.from(files[path]);
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-length': '0' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    refus: () => ({ ...refus }),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-outils-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-C-15 : `--entete` ne peut pas injecter d’en-tête', () => {
  assert.deepEqual(parseHeader('Authorization: Bearer x'), {
    name: 'authorization', value: 'Bearer x',
  });
  assert.deepEqual(parseHeader('  X-Trace :  a:b  '), { name: 'x-trace', value: 'a:b' },
    'le nom est normalisé, la valeur garde ses deux-points');
  assert.deepEqual(parseHeader('Referer:http://h/'), { name: 'referer', value: 'http://h/' });

  assert.throws(() => parseHeader('Authorization'), /attendu « Nom: valeur »/);
  assert.throws(() => parseHeader(': valeur'), /attendu « Nom: valeur »/);
  assert.throws(() => parseHeader('Nom avec espaces: x'), /nom d'en-tête invalide/);
  // La raison d'être de la validation : `\r\n` fabriquerait un second en-tête.
  assert.throws(() => parseHeader('X: a\r\nHost: evil.test'), /retour à la ligne interdit/);
  assert.throws(() => parseHeader('X: a\nY: b'), /retour à la ligne interdit/);

  assert.deepEqual(parseArgs(['http://h/', '--entete', 'A: 1', '--entete', 'B: 2']).headers,
    { a: '1', b: '2' });
  assert.throws(() => parseArgs(['http://h/', '--entete']), /--entete attend/);
  assert.throws(() => parseArgs(['http://h/', '--arret-erreurs', '0']), /valeur invalide/);
  assert.equal(parseArgs(['http://h/', '--arret-erreurs', '3']).maxErrors, 3);
  assert.equal(parseArgs(['http://h/', '--essai']).dryRun, true);
});

test('T-C-15 : l’en-tête part avec les pages **et** les fichiers, la session avec les pages', async () => {
  const site = await startGuardedSite();
  await withTempDir(async (dir) => {
    try {
      // Sans `--entete` : les deux fichiers sont refusés en 401, et la page protégée
      // prouve que le cookie posé par l'accueil sert bien à l'exploration (D-063).
      const sansEntete = await main([`${site.origin}/`, join(dir, 'sans')], { log: () => {} });
      assert.equal(sansEntete.failed, 2, 'les deux fichiers exigent l’en-tête');
      assert.equal(site.refus().fichier, 2);
      assert.equal(site.refus().page, 0, 'aucune page refusée : le cookie est envoyé');

      const avecEntete = await main(
        [`${site.origin}/`, join(dir, 'avec'), '--entete', `Authorization: ${SECRET}`],
        { log: () => {} },
      );
      assert.equal(avecEntete.failed, 0, 'les fichiers sont servis quand l’en-tête part');
      assert.equal(avecEntete.done, 2);
    } finally {
      await site.close();
    }
  });
});

test('T-C-16 : `--essai` montre le plan sans rien écrire ni télécharger', async () => {
  const site = await startGuardedSite();
  await withTempDir(async (dir) => {
    const cible = join(dir, 'jamais-cree');
    try {
      const lignes = [];
      const result = await main(
        [`${site.origin}/`, cible, '--essai', '--entete', `Authorization: ${SECRET}`],
        { log: (line) => lignes.push(line) },
      );

      assert.equal(result.dryRun, true);
      assert.equal(result.started, false, 'rien n’a été exécuté');
      assert.equal(result.done, 0);
      assert.equal(result.failed, 0);
      assert.ok(result.pages >= 2, `pages visitées malgré tout : ${result.pages}`);
      assert.equal(result.queue.tasks.length, 2, 'le plan est complet');
      assert.deepEqual(result.queue.tasks.map((task) => task.state), ['PENDING', 'PENDING']);
      assert.equal(result.diagnostics.stopped, 'épuisement');
      assert.ok(lignes.some((line) => line.startsWith('essai :')));

      // Aucun effet de bord : pas même le dossier cible, ni `empty.html`, ni file.
      await assert.rejects(() => readdir(cible), (error) => error.code === 'ENOENT');
      assert.equal(site.refus().fichier, 0, 'aucun fichier demandé : un essai ne télécharge pas');
    } finally {
      await site.close();
    }
  });
});

test('T-C-16 : `--essai --sortie json` reste consommable par un script', async () => {
  const site = await startGuardedSite();
  await withTempDir(async (dir) => {
    try {
      const cli = fileURLToPath(new URL('../bin/xdm-grab.js', import.meta.url));
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [cli, `${site.origin}/`, join(dir, 'essai'), '--essai', '--sortie', 'json',
          '--entete', `Authorization: ${SECRET}`],
        { encoding: 'utf8' },
      );
      const summary = JSON.parse(stdout);
      assert.equal(summary.dryRun, true);
      assert.equal(summary.started, false);
      assert.equal(summary.tasks, 2);
      assert.equal(summary.done, 0);
      await assert.rejects(() => readdir(join(dir, 'essai')), (error) => error.code === 'ENOENT');
    } finally {
      await site.close();
    }
  });
});
