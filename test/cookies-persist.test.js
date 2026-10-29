import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CookieError,
  createCookieJar,
  loadCookieJar,
  saveCookieJar,
  serializeCookieJar,
} from '../src/cookies.js';
import { main } from '../bin/xdm-grab.js';
import { loadQueue } from '../src/task-queue.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-ck-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-C-12 : seuls les cookies datés sont enregistrés, le fichier est privé', async () => {
  await withTempDir(async (dir) => {
    const now = 1_700_000_000_000;
    const jar = createCookieJar({ now: () => now });
    jar.store('http://h/app/page', { 'set-cookie': 'sid=abc; Path=/app; Max-Age=3600' });
    jar.store('http://h/app/page', { 'set-cookie': 'session=xyz; Path=/' });
    assert.equal(jar.size(), 2);

    const document = serializeCookieJar(jar, now);
    assert.equal(document.cookies.length, 1, 'le cookie de session n’est pas écrit');
    assert.equal(document.cookies[0].name, 'sid');

    const file = join(dir, 'cookies.json');
    const saved = await saveCookieJar(jar, file, { now });
    assert.equal(saved.saved, 1);

    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600, `fichier privé attendu, obtenu ${mode.toString(8)}`);

    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes('session=xyz'), 'aucune trace du cookie de session');

    const { jar: reloaded, loaded } = await loadCookieJar(file, { now: now + 1000 });
    assert.equal(loaded, 1);
    assert.equal(reloaded.cookieHeader('http://h/app/x'), 'sid=abc');
    assert.equal(reloaded.cookieHeader('http://h/autre'), null, 'le chemin est respecté');
  });
});

test('T-C-12 : un cookie expiré n’est ni écrit ni relu, un fichier corrompu lève', async () => {
  await withTempDir(async (dir) => {
    const now = 1_700_000_000_000;
    const jar = createCookieJar({ now: () => now });
    jar.store('http://h/', { 'set-cookie': 'court=1; Max-Age=10' });
    const file = join(dir, 'c.json');
    await saveCookieJar(jar, file, { now });

    // Relu après expiration : le cookie est écarté, pas rajeuni.
    const later = await loadCookieJar(file, { now: now + 60_000 });
    assert.equal(later.loaded, 0);
    assert.equal(later.jar.size(), 0);

    // Fichier absent : magasin vide (première exécution), pas d'erreur.
    const missing = await loadCookieJar(join(dir, 'absent.json'));
    assert.equal(missing.loaded, 0);
    await assert.rejects(
      () => loadCookieJar(join(dir, 'absent.json'), { missingOk: false }),
      (error) => error.code === 'ENOENT',
    );

    // Fichier illisible ou d'une autre version : on refuse, on ne devine pas.
    await writeFile(file, '{ pas du json');
    await assert.rejects(() => loadCookieJar(file), (error) => error instanceof CookieError);
    await writeFile(file, JSON.stringify({ version: 99, cookies: [] }));
    await assert.rejects(() => loadCookieJar(file), /inattendu/);

    // Entrées partielles : elles sont ignorées, le reste est relu.
    await writeFile(file, JSON.stringify({
      version: 1,
      cookies: [
        { name: 'ok', value: '1', domain: 'h', path: '/', expires: now + 60_000 },
        { name: 'sans-domaine', value: '1', path: '/', expires: now + 60_000 },
        { name: 'chemin-relatif', value: '1', domain: 'h', path: 'relatif', expires: now + 60_000 },
        { name: 'expire', value: '1', domain: 'h', path: '/', expires: now - 1 },
      ],
    }));
    const partial = await loadCookieJar(file, { now });
    assert.equal(partial.loaded, 1);
    assert.equal(partial.jar.cookieHeader('http://h/x'), 'ok=1');
  });
});

/** Site qui exige un cookie posé par la page d'accueil. */
async function startGuardedSite() {
  const files = { '/f/doc.txt': Buffer.from('contenu protégé') };
  let withCookie = 0;
  let withoutCookie = 0;
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    if (path === '/') {
      const body = Buffer.from('<a href="/f/doc.txt">doc</a>');
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-length': String(body.length),
        'set-cookie': 'sid=graine; Path=/; Max-Age=3600',
      });
      res.end(body);
      return;
    }
    if (path === '/robots.txt') {
      // `robots.txt` est demandé **avant** toute page, donc avant tout cookie : il ne compte
      // pas comme une requête anonyme (et son absence n'interdit rien).
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    if (!(req.headers.cookie ?? '').includes('sid=graine')) {
      withoutCookie += 1;
      res.writeHead(403, { 'content-length': '0' });
      res.end();
      return;
    }
    withCookie += 1;
    const file = files[path];
    if (!file) {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': String(file.length) });
    res.end(file);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    counters: () => ({ withCookie, withoutCookie }),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('T-C-12 : `--cookies` fait survivre la session à une reprise', async () => {
  const site = await startGuardedSite();
  await withTempDir(async (dir) => {
    const jarPath = join(dir, 'cookies.json');
    try {
      // Première passe : la page pose le cookie, le fichier est téléchargé.
      const first = await main(
        [`${site.origin}/`, join(dir, 'site'), '--inclure', '*', '--sans-exclusions',
          '--cookies', jarPath],
        { log: () => {} },
      );
      assert.equal(first.failed, 0, 'le cookie posé par la page a servi au téléchargement');
      assert.ok(site.counters().withCookie >= 1);
      assert.equal(site.counters().withoutCookie, 0, 'aucune requête anonyme');

      const saved = JSON.parse(await readFile(jarPath, 'utf8'));
      assert.ok(saved.cookies.some((cookie) => cookie.name === 'sid'), 'cookie daté conservé');

      // Seconde exécution : on rejoue **uniquement** le téléchargement, sans repasser par la
      // page qui pose le cookie. La tâche est remise en échec et le fichier supprimé — c'est
      // le scénario d'une coupure, et le seul qui prouve que le cookie vient du fichier.
      const queuePath = join(dir, 'site', 'queue.json');
      const queue = JSON.parse(await readFile(queuePath, 'utf8'));
      const task = queue.tasks.find((entry) => entry.url.endsWith('/f/doc.txt'));
      task.state = 'FAILED';
      task.error = 'coupure simulée';
      await writeFile(queuePath, JSON.stringify(queue, null, 2));
      await rm(join(dir, 'site', 'f', 'doc.txt'));

      const before = site.counters();
      const second = await main(
        [`${site.origin}/`, join(dir, 'site'), '--reprendre', '--cookies', jarPath],
        { log: () => {} },
      );
      assert.equal(second.failed, 0);
      assert.ok(site.counters().withCookie > before.withCookie,
        'le fichier a bien été redemandé');
      assert.equal(site.counters().withoutCookie, before.withoutCookie,
        'aucune requête sans cookie après rechargement du magasin');
      assert.equal(
        await readFile(join(dir, 'site', 'f', 'doc.txt'), 'utf8'),
        'contenu protégé',
      );
      assert.deepEqual(
        (await loadQueue(join(dir, 'site'))).tasks.map((entry) => entry.state),
        ['DONE', 'DONE'],
      );
    } finally {
      await site.close();
    }
  });
});

test('T-C-12 : sans `--cookies`, rien n’est écrit sur le disque', async () => {
  const site = await startGuardedSite();
  await withTempDir(async (dir) => {
    try {
      const result = await main(
        [`${site.origin}/`, dir, '--inclure', '*', '--sans-exclusions'],
        { log: () => {} },
      );
      assert.equal(result.failed, 0, 'le cookie reste en mémoire le temps de la session');
      assert.equal(site.counters().withoutCookie, 0);
      const entries = await readFile(join(dir, 'queue.json'), 'utf8');
      assert.ok(entries.length > 0);
      await assert.rejects(() => stat(join(dir, 'cookies.json')), /ENOENT/);
    } finally {
      await site.close();
    }
  });
});
