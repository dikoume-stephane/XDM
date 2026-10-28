import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadDash } from '../src/dash.js';

/** Boîte MP4 : taille sur 4 octets, type sur 4, charge utile ensuite. */
function box(type, payload) {
  const buffer = Buffer.alloc(8 + payload.length);
  buffer.writeUInt32BE(8 + payload.length, 0);
  buffer.write(type, 4, 'latin1');
  payload.copy(buffer, 8);
  return buffer;
}

/** Boîte `sidx` version 0 avec les tailles de sous-segments demandées. */
function sidxBox(sizes) {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0); // reference_ID
  header.writeUInt32BE(1000, 4); // timescale
  header.writeUInt32BE(0, 8); // earliest_presentation_time
  header.writeUInt32BE(0, 12); // first_offset
  const count = Buffer.alloc(4);
  count.writeUInt16BE(sizes.length, 2);
  const entries = Buffer.alloc(12 * sizes.length);
  sizes.forEach((size, index) => {
    entries.writeUInt32BE(size, index * 12);
    entries.writeUInt32BE(500, index * 12 + 4);
    entries.writeUInt32BE(0x90000000, index * 12 + 8);
  });
  const prefix = Buffer.alloc(4);
  prefix.writeUInt8(0, 0);
  return box('sidx', Buffer.concat([prefix, header, count, entries]));
}

const INIT = Buffer.concat([
  box('ftyp', Buffer.from('iso6\0\0\0\0', 'latin1')),
  box('moov', Buffer.alloc(24, 0x4d)),
]);
const SIZES = [100, 200, 50];
const DATA = Buffer.from(Array.from({ length: SIZES.reduce((a, b) => a + b, 0) }, (_, i) => i % 251));
const INDEX = sidxBox(SIZES);
const MEDIA = Buffer.concat([INIT, INDEX, DATA]);
const SI_DX_START = INIT.length;

/** Serveur MP4 : plages obligatoires, contenu déterministe. */
async function startServer() {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    const body = path === '/video.mp4' ? MEDIA : path === '/init.mp4' ? INIT : null;
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' });
      res.end(body);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
    });
    res.end(body.subarray(start, end + 1));
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
  const dir = await mkdtemp(join(tmpdir(), 'xdm-dash-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-D-08 : un fichier MP4 segmenté se télécharge par son index sidx', async () => {
  const server = await startServer();
  await withTempDir(async (root) => {
    try {
      const directory = join(root, 'dash');
      const events = [];
      const result = await downloadDash({
        fileUrl: `${server.origin}/video.mp4`,
        directory,
        onEvent: (event) => events.push(event),
      });

      assert.equal(result.segments.length, 3);
      assert.equal(result.timescale, 1000);
      assert.deepEqual(result.segments.map((s) => s.size), SIZES);
      assert.deepEqual(result.segments.map((s) => s.offset), [
        SI_DX_START + INDEX.length,
        SI_DX_START + INDEX.length + 100,
        SI_DX_START + INDEX.length + 300,
      ]);
      assert.deepEqual(events.map((e) => e.type), ['segment', 'segment', 'segment']);

      // Init = tout ce qui précède le `sidx` ; segments = plages exactes du fichier.
      assert.deepEqual(await readFile(join(directory, 'init.mp4')), INIT);
      assert.deepEqual(await readFile(join(directory, 'segment-00001.m4s')), DATA.subarray(0, 100));
      assert.deepEqual(await readFile(join(directory, 'segment-00002.m4s')), DATA.subarray(100, 300));
      assert.deepEqual(await readFile(join(directory, 'segment-00003.m4s')), DATA.subarray(300));
      assert.deepEqual(
        (await readdir(directory)).sort(),
        ['init.mp4', 'segment-00001.m4s', 'segment-00002.m4s', 'segment-00003.m4s'],
      );
      assert.equal(result.bytes, INIT.length + DATA.length);
    } finally {
      await server.close();
    }
  });
});

test('T-D-08 : URL d’initialisation séparée et nombre de segments borné', async () => {
  const server = await startServer();
  await withTempDir(async (root) => {
    try {
      const directory = join(root, 'dash2');
      const result = await downloadDash({
        fileUrl: `${server.origin}/video.mp4`,
        initUrl: `${server.origin}/init.mp4`,
        directory,
        maxSegments: 2,
      });
      assert.equal(result.segments.length, 2);
      assert.equal(result.initUrl, `${server.origin}/init.mp4`);
      assert.deepEqual(await readFile(join(directory, 'init.mp4')), INIT);
      assert.deepEqual(await readFile(join(directory, 'segment-00002.m4s')), DATA.subarray(100, 300));
      assert.equal((await readdir(directory)).length, 3, 'init + 2 segments');
      assert.equal(result.bytes, INIT.length + 300);
    } finally {
      await server.close();
    }
  });
});

test('T-D-08 : sans index, le téléchargement refuse plutôt que de deviner', async () => {
  const server = await startServer();
  await withTempDir(async (root) => {
    try {
      // `init.mp4` est un MP4 sans `sidx` : l'outil doit s'arrêter net.
      await assert.rejects(
        downloadDash({ fileUrl: `${server.origin}/init.mp4`, directory: join(root, 'vide') }),
        /aucun index sidx/,
      );
    } finally {
      await server.close();
    }
  });
});
