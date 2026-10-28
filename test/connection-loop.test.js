import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DownloadError,
  MAX_SOCKETS,
  buildChunkMap,
  download,
  planWorkers,
} from '../src/connection-loop.js';
import { intervals, progress, validateChunkMap } from '../src/chunk-map.js';
import { savePartFile } from '../src/part-file.js';
import { normalizeHeaders } from '../src/http-client.js';

/** Contenu déterministe : l'octet d'offset `i` vaut `i % 251`. */
function expectedContent(size) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = i % 251;
  return buffer;
}

/** Réponse factice à partir d'un corps complet et d'une plage demandée. */
function rangedReply(body, range, status = 206, variant = 0) {
  const match = /^bytes=(\d+)-(\d+)?$/.exec(range || '');
  if (!match) {
    return {
      status: 200,
      headers: normalizeHeaders({ 'content-length': String(body.length) }),
      stream: (async function* full() { yield Buffer.from(body); })(),
    };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
  const slice = Buffer.from(body.subarray(start, end + 1)).map((byte) => byte + variant);
  return {
    status,
    headers: normalizeHeaders({
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(slice.length),
    }),
    stream: (async function* part() { yield slice; })(),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-loop-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: (pathname) => `http://127.0.0.1:${port}${pathname}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('T-A-19/T-A-13 : découpage de la carte et plafond de travailleurs', () => {
  const map = buildChunkMap({ url: 'http://h/f', target: '/tmp/f', totalSize: 10, chunkSize: 4 });
  assert.deepEqual(map.chunks.map((c) => [c.id, c.start, c.next]), [
    [1, 0, 2],
    [2, 4, 3],
    [3, 8, 0],
  ]);
  assert.deepEqual(intervals(map).map((i) => [i.start, i.end]), [[0, 4], [4, 8], [8, 10]]);
  assert.equal(validateChunkMap(map).ok, true);

  assert.equal(planWorkers(4, 2), 2);
  assert.equal(planWorkers(4, 10), 4);
  assert.equal(planWorkers(500, 200, MAX_SOCKETS), 128);
  assert.equal(planWorkers(4, 10, 1), 1);
  assert.equal(planWorkers(4, 0), 0);
  assert.equal(MAX_SOCKETS, 128);
});

test('T-A-01/T-A-08 : téléchargement multi-connexions sur un serveur à plages', async () => {
  const body = expectedContent(4096);
  const ranges = [];
  const server = await startServer((req, res) => {
    ranges.push(req.headers.range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) {
      res.writeHead(416);
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(end - start + 1),
    });
    res.end(Buffer.from(body.subarray(start, end + 1)));
  });

  await withTempDir(async (dir) => {
    const target = join(dir, 'fichier.bin');
    try {
      const result = await download(server.url('/f'), target, {
        chunkSize: 1024,
        connections: 2,
        overlap: 128,
      });
      assert.equal(result.size, 4096);
      assert.equal(result.divergence, false);
      assert.equal(result.restarts, 0);
      assert.equal(result.connections, 2);
      assert.ok(result.requests >= 4, `requêtes : ${result.requests}`);
      assert.deepEqual(await readFile(result.workPath), body);
      assert.ok(ranges.every((value) => typeof value === 'string' && value.startsWith('bytes=')));
    } finally {
      await server.close();
    }
  });
});

test('T-A-08 : un serveur sans plages ⇒ une connexion, un morceau unique', async () => {
  const body = expectedContent(3000);
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(Buffer.from(body));
  });

  await withTempDir(async (dir) => {
    const target = join(dir, 'plat.bin');
    try {
      const result = await download(server.url('/plat'), target, {
        chunkSize: 512,
        connections: 4,
      });
      assert.equal(result.connections, 1);
      assert.equal(result.chunkSize, 3000);
      assert.equal(result.divergence, false);
      assert.deepEqual(await readFile(result.workPath), body);
    } finally {
      await server.close();
    }
  });
});

test('T-A-25/T-A-19 : inactivité en cours de morceau ⇒ reprise au dernier octet écrit', async () => {
  const body = expectedContent(2048);
  const attempts = new Map();
  const requested = [];
  const server = await startServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) {
      res.writeHead(416);
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    requested.push(start);
    const seen = (attempts.get(start) ?? 0) + 1;
    attempts.set(start, seen);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(end - start + 1),
    });
    if (seen === 1 && start === 960) {
      // Première vue de ce morceau : on livre la moitié puis on se tait.
      res.write(Buffer.from(body.subarray(start, start + 256)));
      return;
    }
    res.end(Buffer.from(body.subarray(start, end + 1)));
  });

  await withTempDir(async (dir) => {
    const target = join(dir, 'coupure.bin');
    try {
      const result = await download(server.url('/f'), target, {
        chunkSize: 1024,
        connections: 1,
        overlap: 64,
        idleMs: 200,
      });
      assert.ok(result.restarts >= 1, `redémarrages : ${result.restarts}`);
      assert.deepEqual(await readFile(result.workPath), body);
      // La reprise ne repart pas de zéro : le morceau 2 est redemandé à 1152,
      // soit l'offset confirmé 1216 moins les 64 octets de recouvrement.
      assert.ok(requested.includes(1152), `plages demandées : ${requested.join(',')}`);
      assert.ok(!requested.slice(2).includes(0), 'aucune reprise depuis zéro');
    } finally {
      await server.close();
    }
  });
});

test('T-A-10 : contenus divergents ⇒ repli à une connexion et résultat cohérent', async () => {
  const body = expectedContent(1024);
  let calls = 0;
  const transport = async (url, options = {}) => {
    calls += 1;
    const variant = calls % 2 === 0 ? 0 : 7;
    const reply = rangedReply(body, options.headers?.range, 206, variant);
    // Sonde : `bytes=0-0` répond en 206 pour annoncer le support des plages.
    return reply;
  };

  await withTempDir(async (dir) => {
    const target = join(dir, 'divergent.bin');
    const result = await download('http://h/divergent', target, {
      transport,
      chunkSize: 256,
      connections: 2,
      overlap: 64,
    });
    assert.equal(result.divergence, true);
    assert.equal(result.connections, 1);
    const bytes = await readFile(result.workPath);
    assert.equal(bytes.length, 1024);
    // Après repli, un seul flux a rempli le fichier : il correspond exactement à
    // **une** des deux vues, jamais à un mélange des deux.
    const variants = [0, 7].map((shift) => Buffer.from(body).map((b) => b + shift));
    assert.ok(
      variants.some((candidate) => candidate.equals(bytes)),
      'le fichier doit venir d’une seule vue',
    );
  });
});

test('T-A-13 : jamais plus de 128 sockets simultanées', async () => {
  const body = expectedContent(200);
  let active = 0;
  let peak = 0;
  const transport = async (_url, options = {}) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return rangedReply(body, options.headers?.range);
  };

  await withTempDir(async (dir) => {
    const target = join(dir, 'sockets.bin');
    const result = await download('http://h/many', target, {
      transport,
      chunkSize: 1,
      connections: 500,
      overlap: 64,
    });
    assert.equal(result.connections, MAX_SOCKETS);
    assert.ok(peak <= MAX_SOCKETS, `pic : ${peak}`);
    assert.ok(peak > 1, `pic : ${peak}`);
    assert.deepEqual(await readFile(result.workPath), body);
  });
});

test('T-A-08 (erreur) : taille inconnue ⇒ refus explicite', async () => {
  const transport = async () => ({
    status: 200,
    headers: normalizeHeaders({}),
    stream: (async function* empty() {})(),
  });
  await assert.rejects(
    () => download('http://h/nosize', '/tmp/inexistant.bin', { transport }),
    (error) => error instanceof DownloadError && error.code === 'UNKNOWN_SIZE',
  );
});

test('T-A-12 : le téléchargement ne promeut pas le fichier', async () => {
  const body = expectedContent(64);
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(Buffer.from(body));
  });
  await withTempDir(async (dir) => {
    const target = join(dir, 'brut.bin');
    try {
      const result = await download(server.url('/b'), target, { connections: 1 });
      assert.equal(result.workPath.endsWith('.xdm-part'), true);
      await assert.rejects(() => readFile(target), /ENOENT/);
      assert.deepEqual(await readFile(result.workPath), body);
      assert.equal(progress({ totalSize: 64, chunks: [{ id: 1, start: 0, next: 0, completed: true }] }).downloaded, 64);
    } finally {
      await server.close();
    }
  });
});

test('T-A-19/T-A-21 : reprise depuis la carte persistée — aucun morceau clos redemandé', async () => {
  const body = expectedContent(2048);
  const requested = [];
  const server = await startServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) {
      res.writeHead(416);
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    requested.push(start);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(end - start + 1),
    });
    res.end(Buffer.from(body.subarray(start, end + 1)));
  });

  await withTempDir(async (dir) => {
    const target = join(dir, 'reprise.bin');
    const url = server.url('/f');
    try {
      // État d'une exécution interrompue : morceau 1 clos, 2 et 3 à faire.
      const map = buildChunkMap({ url, target, totalSize: 2048, chunkSize: 512 });
      map.chunks[0].completed = true;
      const workPath = `${target}.xdm-part`;
      const partial = Buffer.alloc(2048);
      Buffer.from(body.subarray(0, 512)).copy(partial);
      await writeFile(workPath, partial);
      await savePartFile(target, map);

      const result = await download(url, target, { chunkSize: 512, connections: 2, overlap: 64 });
      assert.equal(result.resumed, true);
      // La première requête est la sonde `bytes=0-0` ; ensuite, aucune plage ne
      // doit repasser sous la borne du morceau 2 (448 = 512 - recouvrement 64).
      assert.equal(requested[0], 0);
      assert.ok(!requested.slice(1).some((start) => start < 448), `reprises : ${requested.join(',')}`);
      assert.ok(requested.includes(448), `recouvrement attendu : ${requested.join(',')}`);
      assert.deepEqual(await readFile(workPath), body);
      assert.equal(result.promoted, null);
    } finally {
      await server.close();
    }
  });
});

test('T-A-12 : promotion explicite après vérification', async () => {
  const body = expectedContent(700);
  const server = await startServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) {
      res.writeHead(416);
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(end - start + 1),
    });
    res.end(Buffer.from(body.subarray(start, end + 1)));
  });
  await withTempDir(async (dir) => {
    const target = join(dir, 'promu.bin');
    try {
      const result = await download(server.url('/f'), target, {
        chunkSize: 256,
        connections: 2,
        promote: true,
      });
      assert.equal(result.promoted, target);
      assert.deepEqual(await readFile(target), body);
      // La carte a disparu avec la promotion.
      await assert.rejects(() => readFile(`${target}.xdm-part.json`), /ENOENT/);
    } finally {
      await server.close();
    }
  });
});
