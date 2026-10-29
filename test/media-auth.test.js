import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main as mediaMain, parseArgs as parseMediaArgs } from '../bin/xdm-media.js';
import { main as xdmMain, parseArgs as parseXdmArgs } from '../bin/xdm.js';
import { main as grabMain, parseArgs as parseGrabArgs } from '../bin/xdm-grab.js';
import { downloadMedia } from '../src/media.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-media-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Flux HLS protégé : la playlist **et** les segments exigent soit un en-tête, soit un cookie.
 * La playlist pose le cookie de session — c'est le cas réel d'un jeton obtenu à l'entrée.
 */
async function startProtectedStream({ needHeader = null, needCookie = false, setCookie = false } = {}) {
  const playlist = '#EXTM3U\n#EXTINF:1,\nseg0.ts\n#EXTINF:1,\nseg1.ts\n#EXT-X-ENDLIST\n';
  const segments = { 'seg0.ts': Buffer.from('AAAA'), 'seg1.ts': Buffer.from('BBBB') };
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    // Le cookie de session est posé **par** la playlist : c'est donc seulement aux segments
    // qu'il est exigé. L'en-tête, lui, vaut pour tout (c'est un jeton d'accès).
    const cookieOk = !needCookie || req.url === '/live.m3u8'
      || String(req.headers.cookie ?? '').includes('session=ok');
    const authorised = (!needHeader || req.headers[needHeader.name] === needHeader.value) && cookieOk;
    if (!authorised) {
      res.writeHead(401, { 'content-length': '0' });
      res.end();
      return;
    }
    if (req.url === '/live.m3u8') {
      const body = Buffer.from(playlist);
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(body.length),
        ...(setCookie ? { 'set-cookie': 'session=ok; Path=/; Max-Age=3600' } : {}),
      });
      res.end(body);
      return;
    }
    const body = segments[req.url.slice(1)];
    if (!body) {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), body.length - 1);
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': String(end - start + 1),
      });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/live.m3u8`,
    seen,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}

test('T-D-11 : `--entete` couvre la playlist **et** les segments', async () => {
  const stream = await startProtectedStream({ needHeader: { name: 'x-token', value: 'abc' } });
  await withTempDir(async (dir) => {
    try {
      // Sans l'en-tête : la playlist est refusée, rien n'est téléchargé.
      await assert.rejects(() => mediaMain([stream.url, dir], { log: () => {} }), /401/);

      const summary = await mediaMain(
        [stream.url, dir, '--entete', 'X-Token: abc'],
        { log: () => {} },
      );
      assert.equal(summary.segments, 2);
      // Les segments sont nommés par leur index (`segment-00001.ts`), pas par l'URL.
      assert.equal((await readFile(join(dir, 'segment-00001.ts'), 'utf8')), 'AAAA');
      // Les segments portent l'en-tête : la preuve est côté serveur, pas côté client.
      const segments = stream.seen.filter((entry) => entry.url.startsWith('/seg'));
      // Deux segments **distincts**, chacun pouvant être demandé deux fois (reprise par plage).
      assert.equal(new Set(segments.map((entry) => entry.url)).size, 2);
      assert.ok(segments.every((entry) => entry.headers['x-token'] === 'abc'));
    } finally {
      await stream.close();
    }
  });
});

test('T-D-11 : `--cookies` transporte la session de la playlist vers les segments', async () => {
  const stream = await startProtectedStream({ needCookie: true, setCookie: true });
  await withTempDir(async (dir) => {
    try {
      const jar = join(dir, 'cookies.json');
      const summary = await mediaMain([stream.url, dir, '--cookies', jar], { log: () => {} });
      assert.equal(summary.segments, 2);
      const saved = JSON.parse(await readFile(jar, 'utf8'));
      assert.equal(saved.cookies.length, 1, 'le cookie `Max-Age` est persisté');
      assert.equal(saved.cookies[0].name, 'session');
      // Le magasin est relu : le second passage n'a pas besoin que le serveur repose le cookie.
      const second = await mediaMain([stream.url, dir, '--cookies', jar], { log: () => {} });
      assert.equal(second.segments, 2);
    } finally {
      await stream.close();
    }
  });
});

test('T-D-11 : le transport atteint aussi les segments sans `BYTERANGE`', async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const transport = () => {};
    const fake = async (url, target, options) => {
      calls.push({ url, options });
      return { size: 4, requests: 1 };
    };
    await downloadMedia({
      playlistUrl: 'http://h/p.m3u8',
      directory: dir,
      fetchText: async () => '#EXTM3U\n#EXTINF:1,\nseg1.ts\n',
      downloadFn: fake,
      transport,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.transport, transport,
      'sans transport, un segment part en direct : proxy et cookies ignorés');
  });
});

test('T-D-11 : `--proxy` sert la playlist et les segments ; un proxy illisible est refusé', async () => {
  const stream = await startProtectedStream();
  const tunnels = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    tunnels.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  const proxyPort = proxy.address().port;
  await withTempDir(async (dir) => {
    try {
      const summary = await mediaMain(
        [stream.url, dir, '--proxy', `http://127.0.0.1:${proxyPort}`],
        { log: () => {} },
      );
      assert.equal(summary.segments, 2);
      // Playlist + 2 segments = au moins trois tunnels (`keep-alive` interdit ici).
      assert.ok(tunnels.length >= 3, `tunnels : ${tunnels.length}`);
      assert.throws(() => parseMediaArgs(['http://h/a.m3u8', '--proxy', 'ftp://x:1']), /proxy invalide/);
    } finally {
      await stream.close();
      proxy.close();
    }
  });
});

test('T-A-24 : `xdm --cookies` réutilise le cookie posé par la sonde', async () => {
  const body = Buffer.from('contenu protegé');
  const seen = [];
  let anonymousBudget = 1;
  const server = http.createServer((req, res) => {
    seen.push({ range: req.headers.range, cookie: req.headers.cookie });
    const hasSession = String(req.headers.cookie ?? '').includes('session=ok');
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const cookie = 'session=ok; Path=/; Max-Age=3600';
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), body.length - 1);
      // La toute première requête (la **sonde**) est admise sans jeton : c'est elle qui le
      // reçoit. Toutes les suivantes l'exigent — c'est là que le magasin doit jouer.
      const amnesty = start === 0 && anonymousBudget > 0;
      if (amnesty) anonymousBudget -= 1;
      if (!amnesty && !hasSession) {
        res.writeHead(401, { 'content-length': '0' });
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': String(end - start + 1),
        'set-cookie': cookie,
      });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'set-cookie': cookie,
    });
    res.end(body);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await withTempDir(async (dir) => {
    try {
      const url = `http://127.0.0.1:${port}/f.bin`;
      const jar = join(dir, 'cookies.json');
      const result = await xdmMain([url, dir, '--morceau', '4', '--cookies', jar], { log: () => {} });
      assert.equal(await readFile(result.target, 'utf8'), 'contenu protegé');
      const saved = JSON.parse(await readFile(jar, 'utf8'));
      assert.equal(saved.cookies[0].name, 'session');
      // Les requêtes de plages ont porté le cookie : c'est ce que le serveur a vu.
      const rangeRequests = seen.filter((entry) => entry.range && entry.range !== 'bytes=0-0');
      assert.ok(rangeRequests.length > 0, 'aucune plage non nulle demandée');
      assert.ok(rangeRequests.every((entry) => String(entry.cookie ?? '').includes('session=ok')));
      // Sans `--cookies`, les plages sont refusées : le défaut n'est pas « magique ».
      await assert.rejects(
        () => xdmMain([url, join(dir, 'sans'), '--morceau', '4'], { log: () => {} }),
        /401/,
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    }
  });
});

test('T-A-25 : les trois CLI refusent un argument positionnel de trop', () => {
  assert.throws(() => parseXdmArgs(['http://h/f', 'dl', 'http://h/g']), /trop d'arguments/);
  assert.throws(() => parseGrabArgs(['http://h/', 'dl', 'http://h/g']), /trop d'arguments/);
  assert.throws(() => parseMediaArgs(['http://h/a.m3u8', 'dl', 'http://h/b.m3u8']), /trop d'arguments/);
  // Deux arguments restent valides : l'URL et le dossier.
  assert.equal(parseXdmArgs(['http://h/f', 'dl']).directory, 'dl');
  assert.equal(parseMediaArgs(['http://h/a.m3u8', 'dl']).directory, 'dl');
});

test('T-B-50 : `--verifier --sortie json` inclut les tâches non commencées', async () => {
  await withTempDir(async (dir) => {
    const { createQueue, addTask, saveQueue } = await import('../src/task-queue.js');
    let queue = createQueue({});
    queue = addTask(queue, { url: 'http://h/a.bin', target: join(dir, 'a.bin'), totalSize: 4 }).queue;
    await saveQueue(dir, queue); // tâche PENDING, fichier absent
    const result = await grabMain(['http://h/', dir, '--verifier'], { log: () => {} });
    const { summarize } = await import('../bin/xdm-grab.js');
    const summary = summarize(result);
    assert.deepEqual(summary.verify.absent, ['a.bin']);
    assert.equal(summary.conforms, true, 'une tâche non commencée n’est pas un écart');
  });
});

test('T-A-34 : `xdm --cookies` annonce le nombre de cookies écrits, pas « undefined »', async () => {
  // Le fichier posé par la sonde est daté : c'est le seul cas persisté (`D-062`).
  const body = Buffer.from('contenu');
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'set-cookie': 'session=ok; Path=/; Max-Age=3600',
    });
    res.end(body);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await withTempDir(async (dir) => {
    const lignes = [];
    try {
      await xdmMain([`http://127.0.0.1:${port}/f.bin`, dir, '--cookies', join(dir, 'c.json')], {
        log: (line) => lignes.push(line),
      });
    } finally {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    }
    const annonce = lignes.find((line) => line.startsWith('cookies'));
    assert.ok(annonce, `aucune ligne « cookies » dans : ${lignes.join(' | ')}`);
    assert.match(annonce, /\(1 cookie\(s\)\)/, 'le compte lu est un champ qui n\'existe pas');
    assert.doesNotMatch(annonce, /undefined/);
  });
});

test('T-D-12 : `xdm-media --cookies` annonce lui aussi le compte réel', async () => {
  const stream = await startProtectedStream({ needHeader: { name: 'x-jeton', value: 'k' }, setCookie: true });
  await withTempDir(async (dir) => {
    const lignes = [];
    try {
      await mediaMain(
        [stream.url, dir, '--entete', 'x-jeton: k', '--cookies', join(dir, 'c.json')],
        { log: (line) => lignes.push(line) },
      );
    } finally {
      await stream.close();
    }
    const annonce = lignes.find((line) => line.startsWith('cookies'));
    assert.ok(annonce, `aucune ligne « cookies » dans : ${lignes.join(' | ')}`);
    assert.match(annonce, /\(1 cookie\(s\)\)/);
    assert.doesNotMatch(annonce, /undefined/);
  });
});
