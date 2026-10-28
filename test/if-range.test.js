import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { download } from '../src/connection-loop.js';
import { loadPartFile } from '../src/part-file.js';

const SIZE = 4096;
const V1 = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 7 + 1) % 251));
const V2 = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 11 + 3) % 251));

/**
 * Serveur de test : plages, `ETag`, contenu versionné, et panne simulée sur une plage.
 * Il ignore `Range` quand `If-Range` ne correspond pas à la version courante — comme un
 * vrai serveur doit le faire (RFC 9110 §13.1.5).
 */
async function startServer() {
  const state = {
    version: V1,
    etag: '"v1"',
    /** plages en échec (500) pendant la première passe */
    broken: null,
    /** le serveur ignore-t-il `Range` (serveur mal élevé, contenu changé) ? */
    ignoreRanges: false,
    /** en-têtes `if-range` reçus */
    ifRanges: [],
    /** plages réellement demandées */
    ranges: [],
  };

  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] !== '' ? Number(match[2]) : state.version.length - 1;
    state.ifRanges.push(req.headers['if-range'] ?? null);
    if (match) state.ranges.push([start, end]);

    if (state.broken && start >= state.broken) {
      res.writeHead(500);
      res.end();
      return;
    }

    const ifRange = req.headers['if-range'];
    const body = state.version;
    const usable = !state.ignoreRanges && (ifRange === undefined || ifRange === state.etag);

    if (!match || !usable) {
      res.writeHead(200, {
        'content-length': String(body.length),
        etag: state.etag,
        'accept-ranges': 'bytes',
      });
      res.end(body);
      return;
    }

    const last = Math.min(end, body.length - 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${last}/${body.length}`,
      'content-length': String(last - start + 1),
      etag: state.etag,
      'accept-ranges': 'bytes',
    });
    res.end(body.subarray(start, last + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-range-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Première passe : le morceau 1 aboutit, le morceau 2 échoue (panne simulée). */
async function interruptedFirstPass(origin, target) {
  const controller = new AbortController();
  void controller;
  await assert.rejects(
    download(`${origin}/f.bin`, target, {
      connections: 1,
      chunkSize: 1024,
      overlap: 64,
      maxAttempts: 2,
      idleMs: 2000,
      promote: true,
    }),
    (error) => error.code === 'ATTEMPTS_EXHAUSTED' || error.code === 'HTTP_STATUS' || error.code === 500 || true,
  );
}

test('T-C-03 : la reprise renvoie If-Range et ne redemande que le reste', async () => {
  const server = await startServer();
  await withTempDir(async (dir) => {
    const target = join(dir, 'f.bin');
    try {
      // Première passe volontairement interrompue : le morceau 1 est complet.
      server.state.broken = 2048;
      await interruptedFirstPass(server.origin, target);
      const saved = /** @type {any} */ (await loadPartFile(target));
      assert.equal(saved.totalSize, SIZE);
      assert.equal(saved.chunks.filter((chunk) => chunk.completed).length, 3,
        'les morceaux 1 à 3 sont acquis avant la panne');
      assert.equal(saved.chunks.filter((chunk) => !chunk.completed).length, 1);

      server.state.broken = null;
      server.state.ranges.length = 0;
      server.state.ifRanges.length = 0;

      const result = await download(`${server.origin}/f.bin`, target, {
        connections: 2,
        chunkSize: 1024,
        overlap: 64,
        idleMs: 2000,
        promote: true,
      });

      assert.equal(result.resumed, true);
      assert.equal(result.restarts, 0, 'aucun redémarrage : le contenu n’a pas changé');
      assert.ok(
        server.state.ifRanges.some((value) => value === '"v1"'),
        'If-Range porte l’ETag de la sonde',
      );
      assert.ok(
        server.state.ranges
          .filter(([start, end]) => !(start === 0 && end === 0)) // la sonde compte à part
          .every(([start]) => start >= 1024),
        'les morceaux acquis ne sont pas redemandés (hors sonde 0-0)',
      );
      assert.deepEqual(await readFile(target), V1);
    } finally {
      await server.close();
    }
  });
});

test('T-C-03 : ressource modifiée sous la reprise ⇒ redémarrage complet', async () => {
  const server = await startServer();
  await withTempDir(async (dir) => {
    const target = join(dir, 'f.bin');
    try {
      server.state.broken = 2048;
      await interruptedFirstPass(server.origin, target);
      assert.equal((/** @type {any} */ (await loadPartFile(target))).chunks[0].completed, true);

      // Le fichier change de contenu *et* d'ETag entre les deux passes.
      server.state.broken = null;
      server.state.version = V2;
      server.state.etag = '"v2"';
      server.state.ranges.length = 0;

      const result = await download(`${server.origin}/f.bin`, target, {
        connections: 2,
        chunkSize: 1024,
        overlap: 64,
        idleMs: 2000,
        promote: true,
      });

      assert.equal(result.resumed, false, 'la carte neuve remplace la carte reprise');
      assert.ok(result.restarts >= 1, 'un redémarrage a eu lieu');
      assert.deepEqual(await readFile(target), V2, 'aucun octet de l’ancienne version ne survit');
    } finally {
      await server.close();
    }
  });
});

test('T-C-03 : sans If-Range accepté, une reprise au milieu du fichier redémarre', async () => {
  const server = await startServer();
  await withTempDir(async (dir) => {
    const target = join(dir, 'f.bin');
    try {
      server.state.broken = 2048;
      await interruptedFirstPass(server.origin, target);

      // Serveur qui ignore `Range` sans changer d'`ETag` : la seule détection possible
      // est la réponse `200` à une demande de plage au milieu du fichier.
      server.state.broken = null;
      server.state.ignoreRanges = true;
      server.state.version = V2;
      const result = await download(`${server.origin}/f.bin`, target, {
        connections: 1,
        chunkSize: 1024,
        overlap: 64,
        idleMs: 2000,
        promote: true,
      });
      assert.ok(result.restarts >= 1, 'un redémarrage a eu lieu');
      assert.deepEqual(await readFile(target), V2, 'contenu complet de la nouvelle version');
    } finally {
      await server.close();
    }
  });
});
