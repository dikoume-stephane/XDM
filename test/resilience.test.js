import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  RETRYABLE_STATUSES,
  RetryError,
  isRetryableStatus,
  parseRetryAfter,
  planRetry,
  retryDelay,
} from '../src/retry.js';
import {
  HttpError, fetchText, normalizeHeaders, openSegment, probe,
} from '../src/http-client.js';
import { download } from '../src/connection-loop.js';
import { runQueue } from '../src/grab-runner.js';
import { addTask } from '../src/task-queue.js';
import { createQueue } from '../src/index.js';

/** Serveur qui répond selon une table `chemin → (req, res) => void`. */
async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    const handler = routes[path];
    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    return await fn(`http://127.0.0.1:${port}`, server);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('T-C-11 : quels statuts méritent une nouvelle tentative', () => {
  for (const status of RETRYABLE_STATUSES) assert.equal(isRetryableStatus(status), true, String(status));
  assert.equal(isRetryableStatus(408), true, 'proxy surchargé');
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(undefined), false);
});

test('T-C-11 : `Retry-After` en secondes ou en date, jamais négatif', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter(' 0 '), 0);
  assert.equal(parseRetryAfter('99999999'), MAX_RETRY_AFTER_MS, 'plafonné à une heure');
  assert.equal(parseRetryAfter('pas une date'), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(['30', '60']), 30_000, 'première valeur');

  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(parseRetryAfter('Wed, 28 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Wed, 28 Oct 2026 11:00:00 GMT', now), 0, 'date passée ⇒ tout de suite');
});

test('T-C-11 : recul exponentiel plafonné, sans aléa', () => {
  assert.equal(retryDelay(1), DEFAULT_BACKOFF_MS);
  assert.equal(retryDelay(2), DEFAULT_BACKOFF_MS * 2);
  assert.equal(retryDelay(3), DEFAULT_BACKOFF_MS * 4);
  assert.equal(retryDelay(20), MAX_BACKOFF_MS, 'plafond');
  assert.equal(retryDelay(1, { base: 100, max: 150 }), 100);
  assert.equal(retryDelay(3, { base: 100, max: 150 }), 150);
  assert.throws(() => retryDelay(0), RetryError);
  assert.throws(() => retryDelay(1.5), RetryError);
  assert.throws(() => retryDelay(1, { base: 0 }), RetryError);
});

test('T-C-11 : plan de reprise — le serveur prime, le plafond tranche', () => {
  // Verdict ferme : on ne rejoue pas un 404.
  assert.deepEqual(planRetry({ status: 404, attempts: 0 }), {
    retry: false, delayMs: 0, reason: 'statut 404 définitif',
  });

  // Le serveur annonce : on le croit, plutôt que d'appliquer notre recul.
  assert.deepEqual(
    planRetry({ status: 429, attempts: 1, headers: { 'retry-after': '7' } }),
    { retry: true, delayMs: 7000, reason: 'Retry-After du serveur' },
  );

  // Sans annonce : recul exponentiel du nombre de tentatives déjà faites.
  assert.deepEqual(planRetry({ status: 503, attempts: 0 }), {
    retry: true, delayMs: DEFAULT_BACKOFF_MS, reason: 'recul exponentiel',
  });
  assert.equal(planRetry({ status: 503, attempts: 2 }).delayMs, DEFAULT_BACKOFF_MS * 4);

  // Plafond atteint : on renonce en le disant, au lieu de tourner indéfiniment.
  assert.deepEqual(planRetry({ status: 503, attempts: 3, maxAttempts: 3 }), {
    retry: false, delayMs: 0, reason: '3 tentative(s), plafond 3',
  });

  assert.throws(() => planRetry({ status: 503, attempts: -1 }), RetryError);
  assert.throws(() => planRetry({ status: 503, attempts: 0, maxAttempts: 0 }), RetryError);
});

test('T-C-11 : la sonde refuse un statut non exploitable, avec son diagnostic', async () => {
  await withServer({
    '/limite': (req, res) => {
      res.writeHead(429, { 'retry-after': '30', 'content-length': '0' });
      res.end();
    },
    '/indispo': (req, res) => {
      res.writeHead(503, { 'content-length': '0' });
      res.end();
    },
    '/absent': (req, res) => {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
    },
  }, async (origin) => {
    await assert.rejects(
      () => probe(`${origin}/limite`),
      (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.code, 'HTTP_STATUS');
        assert.equal(error.details.status, 429);
        assert.equal(error.details.retryable, true);
        assert.equal(error.details.retryAfterMs, 30_000, 'l’attente demandée est transmise');
        assert.match(error.message, /statut 429/);
        return true;
      },
    );

    await assert.rejects(() => probe(`${origin}/indispo`), (error) => error.details.retryable === true);
    await assert.rejects(
      () => probe(`${origin}/absent`),
      (error) => error.details.status === 404 && error.details.retryable === false,
    );
  });
});

test('T-C-11 : un 429 pendant le téléchargement échoue explicitement, sans fichier', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-retry-'));
  try {
    const target = join(dir, 'fichier.bin');
    await withServer({
      '/fichier.bin': (req, res) => {
        res.writeHead(429, { 'retry-after': '5' });
        res.end();
      },
    }, async (origin) => {
      await assert.rejects(
        () => download(`${origin}/fichier.bin`, target),
        (error) => error.code === 'HTTP_STATUS' && error.details.status === 429,
      );
      // Aucune promotion, aucun fichier final : un échec ne laisse pas de moignon.
      await assert.rejects(() => readFile(target), /ENOENT/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('T-C-11 : une redirection en boucle s’arrête à la limite, sans boucler', async () => {
  await withServer({
    '/a': (req, res) => {
      res.writeHead(302, { location: '/b' });
      res.end();
    },
    '/b': (req, res) => {
      res.writeHead(302, { location: '/a' });
      res.end();
    },
  }, async (origin) => {
    await assert.rejects(
      () => probe(`${origin}/a`),
      (error) => error.code === 'TOO_MANY_REDIRECTS',
    );
    await assert.rejects(
      () => fetchText(`${origin}/a`),
      (error) => error.code === 'TOO_MANY_REDIRECTS',
    );
  });
});

test('T-C-11 : plage invalide — 416 n’est pas confondu avec un fichier vide', async () => {
  await withServer({
    '/court.bin': (req, res) => {
      const range = req.headers.range ?? '';
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      if (start > 0) {
        res.writeHead(416, { 'content-range': 'bytes */10', 'content-length': '0' });
        res.end();
        return;
      }
      res.writeHead(206, { 'content-range': 'bytes 0-9/10', 'content-length': '10' });
      res.end(Buffer.alloc(10, 1));
    },
  }, async (origin) => {
    const first = await probe(`${origin}/court.bin`);
    assert.equal(first.status, 206);
    assert.equal(first.size, 10);

    // Hors fichier : le serveur répond `416`, `openSegment` ne le maquille pas en succès.
    const segment = await openSegment(`${origin}/court.bin`, { start: 50, size: 11 });
    assert.equal(segment.status, 416);
    assert.equal(segment.ranged, false);
    segment.stream.resume();
  });
});

test('T-C-11 : une page compressée reste lisible après un 200', async () => {
  await withServer({
    '/gz': (req, res) => {
      const body = zlib.gzipSync(Buffer.from('<p>bonjour</p>'));
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(body.length) });
      res.end(body);
    },
  }, async (origin) => {
    const page = await fetchText(`${origin}/gz`);
    assert.equal(page.body, '<p>bonjour</p>');
    assert.equal(page.encoding, 'gzip');
  });
});

test('T-C-11 : la file rejoue un 503 puis réussit — sans attente réelle dans les tests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-retry2-'));
  const body = Buffer.from('contenu après incident');
  let hits = 0;
  try {
    await withServer({
      '/fichier.bin': (req, res) => {
        hits += 1;
        if (hits === 1) {
          res.writeHead(503, { 'retry-after': '1', 'content-length': '0' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-length': String(body.length) });
        res.end(body);
      },
    }, async (origin) => {
      const target = join(dir, 'fichier.bin');
      const queue = addTask(createQueue({}), { url: `${origin}/fichier.bin`, target }).queue;
      const waits = [];
      const outcome = await runQueue(queue, {
        maxAttempts: 3,
        sleep: async (ms) => { waits.push(ms); },
      });

      // Une sonde par tentative (`503` puis `200`) et la requête du morceau.
      assert.equal(hits, 3, 'la relance repart de la sonde, pas d’un morceau');
      assert.equal(outcome.queue.tasks[0].state, 'DONE');
      assert.equal(outcome.queue.tasks[0].attempts, 2);
      assert.deepEqual(waits, [1000], 'le Retry-After du serveur est respecté');
      assert.deepEqual(await readFile(target), body);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('T-C-11 : la file ne rejoue pas un 404, ni au-delà du plafond', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-retry3-'));
  try {
    let hits = 0;
    await withServer({
      '/absent.bin': (req, res) => {
        hits += 1;
        res.writeHead(404, { 'content-length': '0' });
        res.end();
      },
    }, async (origin) => {
      const queue = addTask(createQueue({}), { url: `${origin}/absent.bin`, target: join(dir, 'x.bin') }).queue;
      const outcome = await runQueue(queue, { maxAttempts: 5, sleep: async () => {} });
      assert.equal(hits, 1, 'un verdict ferme ne se rejoue pas');
      assert.equal(outcome.queue.tasks[0].state, 'FAILED');
      assert.equal(outcome.queue.tasks[0].attempts, 1);
    });

    let saturations = 0;
    await withServer({
      '/sature.bin': (req, res) => {
        saturations += 1;
        res.writeHead(503, { 'content-length': '0' });
        res.end();
      },
    }, async (origin) => {
      const queue = addTask(createQueue({}), { url: `${origin}/sature.bin`, target: join(dir, 'y.bin') }).queue;
      const outcome = await runQueue(queue, { maxAttempts: 2, sleep: async () => {} });
      assert.equal(saturations, 2, 'plafond de tentatives respecté');
      assert.equal(outcome.queue.tasks[0].state, 'FAILED');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
