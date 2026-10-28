import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchText } from '../src/http-client.js';
import { assembleMedia, downloadMedia, extensionOf, planMedia, segmentName } from '../src/media.js';
import { parsePlaylist } from '../src/hls.js';

const SEGMENTS = {
  'seg-1.ts': Buffer.from('SEGMENT-UN'),
  'seg-2.ts': Buffer.from('SEGMENT-DEUX'),
  'seg-3.ts': Buffer.from('SEGMENT-TROIS'),
  'init.mp4': Buffer.from('INIT!!'),
};

/** Site de test : playlist maître, playlist média, segments, et un fichier à plages. */
async function startStream({ encrypted = false } = {}) {
  const media = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 251));
  const routes = {
    '/master.m3u8': Buffer.from(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360
bas/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
haut/index.m3u8
`),
    '/bas/index.m3u8': Buffer.from(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4,
seg-1.ts
#EXTINF:4,
seg-2.ts
#EXT-X-ENDLIST
`),
    '/haut/index.m3u8': Buffer.from(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
${encrypted ? '#EXT-X-KEY:METHOD=AES-128,URI="cle.bin"\n' : ''}#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
seg-1.ts
#EXTINF:4,
seg-2.ts
#EXT-X-DISCONTINUITY
#EXTINF:2,
seg-3.ts
#EXT-X-ENDLIST
`),
    '/haut/cle.bin': Buffer.from('0123456789abcdef'),
    '/haut/init.mp4': SEGMENTS['init.mp4'],
    '/haut/seg-1.ts': SEGMENTS['seg-1.ts'],
    '/haut/seg-2.ts': SEGMENTS['seg-2.ts'],
    '/haut/seg-3.ts': SEGMENTS['seg-3.ts'],
    '/plages.m3u8': Buffer.from(`#EXTM3U
#EXTINF:2,
#EXT-X-BYTERANGE:100@0
media.bin
#EXTINF:2,
#EXT-X-BYTERANGE:150
media.bin
#EXT-X-ENDLIST
`),
    '/media.bin': media,
  };

  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    const body = routes[path];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    if (start > end) {
      res.writeHead(416);
      res.end();
      return;
    }
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(end - start + 1),
    });
    res.end(body.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    media,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-media-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-D-03 : plan d’un flux — noms locaux et total de durée', () => {
  const playlist = parsePlaylist(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
a.m4s
#EXTINF:4,
b.m4s
`, { baseUrl: 'http://h/v/' });
  const plan = planMedia(playlist);
  assert.deepEqual(plan.segments.map((s) => s.name), ['segment-00001.m4s', 'segment-00002.m4s']);
  assert.equal(plan.init.name, 'init.mp4');
  assert.equal(plan.totalDuration, 10);
  assert.equal(plan.encrypted, false);
  assert.equal(segmentName(0), 'segment-00001.ts');
  assert.equal(segmentName(99), 'segment-00100.ts');
  assert.equal(extensionOf('http://h/a/b.M4S'), '.m4s');
  assert.equal(extensionOf('http://h/a/b'), '.ts');
  assert.throws(() => planMedia({ type: 'master', segments: [] }), /playlist média attendue/);
});

test('T-D-02 : téléchargement d’un flux complet, variante la plus haute', async () => {
  const stream = await startStream();
  await withTempDir(async (root) => {
    try {
      const directory = join(root, 'flux');
      const events = [];
      const result = await downloadMedia({
        playlistUrl: `${stream.origin}/master.m3u8`,
        directory,
        fetchText,
        onEvent: (event) => events.push(event.type),
      });

      assert.equal(result.variant.bandwidth, 2000000, 'variante la plus haute');
      assert.equal(result.segments, 3);
      assert.equal(result.encrypted, false);
      assert.equal(result.files.length, 4, 'init + 3 segments');
      assert.deepEqual(events.slice(0, 2), ['variant', 'init'], 'init avant les segments');

      // Contenu local identique aux octets servis.
      assert.deepEqual(await readFile(join(directory, 'init.mp4')), SEGMENTS['init.mp4']);
      assert.deepEqual(await readFile(join(directory, 'segment-00001.ts')), SEGMENTS['seg-1.ts']);
      assert.deepEqual(await readFile(join(directory, 'segment-00003.ts')), SEGMENTS['seg-3.ts']);
      assert.deepEqual((await readdir(directory)).sort(), [
        'index.m3u8', 'init.mp4', 'segment-00001.ts', 'segment-00002.ts', 'segment-00003.ts',
      ]);
      const copy = await readFile(join(directory, 'index.m3u8'), 'utf8');
      assert.match(copy, /#EXT-X-MAP:URI="init\.mp4"/, 'playlist d’origine conservée');
      assert.equal((await stat(join(directory, 'segment-00002.ts'))).size, SEGMENTS['seg-2.ts'].length);
      assert.equals === undefined; // garde-fou : pas d'API obsolète
    } finally {
      await stream.close();
    }
  });
});

test('T-D-05 : segments définis par plage d’octets', async () => {
  const stream = await startStream();
  await withTempDir(async (root) => {
    try {
      const directory = join(root, 'plages');
      const result = await downloadMedia({
        playlistUrl: `${stream.origin}/plages.m3u8`,
        directory,
        fetchText,
      });
      assert.equal(result.segments, 2);
      // L'extension suit l'URL source (`.bin`), pas le type de playlist.
      const first = await readFile(join(directory, 'segment-00001.bin'));
      const second = await readFile(join(directory, 'segment-00002.bin'));
      assert.deepEqual(first, stream.media.subarray(0, 100));
      assert.deepEqual(second, stream.media.subarray(100, 250), 'plage implicite enchaînée');
      assert.equal(result.bytes, 250);
    } finally {
      await stream.close();
    }
  });
});

test('T-D-06 : une playlist chiffrée est téléchargée et signalée, pas déchiffrée', async () => {
  const stream = await startStream({ encrypted: true });
  await withTempDir(async (root) => {
    try {
      const result = await downloadMedia({
        playlistUrl: `${stream.origin}/master.m3u8`,
        directory: join(root, 'chiffre'),
        fetchText,
      });
      assert.equal(result.encrypted, true);
      assert.equal(result.playlist.key.method, 'AES-128');
      // Les octets sont ceux du serveur : aucun déchiffrement n'a eu lieu.
      assert.deepEqual(await readFile(join(result.directory, 'segment-00001.ts')), SEGMENTS['seg-1.ts']);
    } finally {
      await stream.close();
    }
  });
});

test('T-D-10 : assemblage bout à bout, et refus d’assembler du vide', async () => {
  const stream = await startStream();
  await withTempDir(async (root) => {
    try {
      const result = await downloadMedia({
        playlistUrl: `${stream.origin}/haut/index.m3u8`,
        directory: join(root, 'asm'),
        fetchText,
        maxSegments: 2,
      });
      assert.equal(result.files.length, 3, 'init + 2 segments');
      const target = join(root, 'sortie.ts');
      const assembled = await assembleMedia(result.files, target);
      const expected = Buffer.concat([
        SEGMENTS['init.mp4'], SEGMENTS['seg-1.ts'], SEGMENTS['seg-2.ts'],
      ]);
      assert.equal(assembled.size, expected.length);
      assert.deepEqual(await readFile(target), expected);
      await assert.rejects(assembleMedia([], target), /aucun fichier/);
    } finally {
      await stream.close();
    }
  });
});
