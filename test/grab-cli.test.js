import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { USAGE, filtersOf, main, parseArgs } from '../bin/xdm-grab.js';
import { createProject, addFilter, loadProject, loadQueue } from '../src/index.js';
import { EMPTY_HTML, EMPTY_HTML_NAME } from '../src/grabber.js';

/** Site de test : pages HTML + fichiers téléchargeables. */
function makeSite() {
  const files = {
    '/fichiers/a.txt': Buffer.from('contenu A'),
    '/fichiers/b.bin': Buffer.from([1, 2, 3, 4, 5]),
  };
  const pages = {
    '/': '<a href="/fichiers/a.txt">a</a><a href="/fichiers/b.bin">b</a><a href="/page2.html">p2</a>',
    '/page2.html': '<a href="/fichiers/a.txt">doublon</a>',
  };
  return { pages, files };
}

async function startSite() {
  const { pages, files } = makeSite();
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    if (path in pages) {
      const body = Buffer.from(pages[path]);
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    const file = files[path];
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) {
      res.writeHead(200, { 'content-length': String(file.length) });
      res.end(file);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), file.length - 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${file.length}`,
      'content-length': String(end - start + 1),
    });
    res.end(file.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-grabcli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-B-08 : arguments de la CLI d’aspiration', () => {
  assert.deepEqual(parseArgs(['http://h/site']), {
    url: 'http://h/site',
    directory: '.',
    depth: 2,
    maxPages: 2000,
    connections: 4,
    robots: true,
  });
  assert.deepEqual(
    parseArgs(['http://h/', 'dl', '--profondeur', '3', '--pages', '10', '--connexions', '2', '--sans-robots']),
    { url: 'http://h/', directory: 'dl', depth: 3, maxPages: 10, connections: 2, robots: false },
  );
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['pas-une-url']), /URL invalide/);
  assert.throws(() => parseArgs(['http://h/', '--profondeur', '0']), /valeur invalide/);
  assert.throws(() => parseArgs(['http://h/', '--inconnu']), /option inconnue/);
  assert.match(USAGE, /xdm-grab/);
});

test('T-B-03 : les filtres actifs du projet alimentent le parcours', () => {
  let project = createProject({ name: 'p', rootUrl: 'http://h/' });
  assert.equal(project.filters.include.length, 0);
  project = addFilter(project, 'include', '*.txt,*.bin');

  const filters = filtersOf(project);
  assert.deepEqual(filters.include, ['*.txt', '*.bin']);
  assert.ok(filters.exclude.length > 0, 'exclusions par défaut présentes');

  const disabled = {
    ...project,
    filters: {
      ...project.filters,
      include: project.filters.include.map((f) => ({ ...f, actif: false })),
    },
  };
  assert.deepEqual(filtersOf(disabled).include, []);
});

test('T-B-10 : aspiration de bout en bout depuis la CLI', async () => {
  const site = await startSite();
  await withTempDir(async (dir) => {
    const lines = [];
    try {
      const result = await main(
        [`${site.origin}/`, dir, '--profondeur', '2', '--connexions', '2'],
        { log: (line) => lines.push(line) },
      );

      assert.equal(result.pages, 2, 'deux pages HTML visitées');
      assert.equal(result.done, 2, 'deux fichiers téléchargés');
      assert.equal(result.failed, 0);

      // Arborescence locale conforme à celle du site.
      assert.deepEqual(await readFile(join(dir, 'fichiers', 'a.txt'), 'utf8'), 'contenu A');
      assert.deepEqual(await readFile(join(dir, 'fichiers', 'b.bin')), Buffer.from([1, 2, 3, 4, 5]));
      // Les pages HTML sont exclues par défaut (masque `*.html`), `empty.html` est écrit.
      assert.deepEqual((await readdir(dir)).sort(), [
        '127.0.0.1.xdmspider.json',
        EMPTY_HTML_NAME,
        'fichiers',
        'queue.json',
      ]);
      assert.equal(await readFile(join(dir, EMPTY_HTML_NAME), 'utf8'), EMPTY_HTML);

      // Projet et file persistés, états à jour.
      const project = await loadProject(join(dir, '127.0.0.1.xdmspider.json'));
      assert.equal(project.entries.length, 2);
      assert.deepEqual(project.entries.map((e) => e.etat), ['termine', 'termine']);
      const queue = await loadQueue(dir);
      assert.deepEqual(queue.tasks.map((t) => t.state), ['DONE', 'DONE']);
      assert.ok(lines.some((line) => line.includes('2 page(s) visitée(s)')));
      assert.ok(lines.some((line) => line.includes('téléchargés : 2 / 2')));
    } finally {
      await site.close();
    }
  });
});

test('T-B-20 : une ressource manquante produit un échec explicite, sans bloquer', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const body = Buffer.from('<a href="/manquant.bin">x</a>');
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    if (req.url === '/manquant.bin') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  await withTempDir(async (dir) => {
    try {
      const result = await main([`http://127.0.0.1:${port}/`, dir, '--profondeur', '1'], {
        log: () => {},
      });
      assert.equal(result.done, 0);
      assert.equal(result.failed, 1);
      const queue = await loadQueue(dir);
      assert.equal(queue.tasks[0].state, 'FAILED');
      assert.ok(queue.tasks[0].error);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
