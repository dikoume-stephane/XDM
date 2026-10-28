import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { USAGE, main, parseArgs, summarize } from '../bin/xdm-media.js';

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXTINF:4,
a.ts
#EXTINF:4,
b.ts
#EXT-X-ENDLIST
`;

/** Petit serveur de flux : une playlist, deux segments. */
async function startStream() {
  const routes = {
    '/live.m3u8': Buffer.from(PLAYLIST),
    '/a.ts': Buffer.from('AAA'),
    '/b.ts': Buffer.from('BBBB'),
  };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    const body = routes[path];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
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
  const dir = await mkdtemp(join(tmpdir(), 'xdm-mcli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-D-03 : arguments de la CLI de flux', () => {
  assert.deepEqual(parseArgs(['http://h/live.m3u8']), {
    url: 'http://h/live.m3u8',
    directory: '.',
    bandwidth: undefined,
    maxSegments: undefined,
    assemble: null,
    output: 'texte',
  });
  assert.deepEqual(
    parseArgs(['http://h/live.m3u8', 'dl', '--qualite', '1200000', '--segments', '5', '--assembler', 'out.ts', '--sortie', 'json']),
    {
      url: 'http://h/live.m3u8',
      directory: 'dl',
      bandwidth: 1200000,
      maxSegments: 5,
      assemble: 'out.ts',
      output: 'json',
    },
  );
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['pas-une-url']), /URL invalide/);
  assert.throws(() => parseArgs(['http://h/a.m3u8', '--segments', '0']), /valeur invalide/);
  assert.throws(() => parseArgs(['http://h/a.m3u8', '--assembler']), /--assembler attend un fichier/);
  assert.throws(() => parseArgs(['http://h/a.m3u8', '--sortie', 'xml']), /format de sortie inconnu/);
  assert.match(USAGE, /xdm-media/);
});

test('T-D-03 : téléchargement d’un flux depuis la CLI, assemblage facultatif', async () => {
  const stream = await startStream();
  await withTempDir(async (root) => {
    try {
      const lines = [];
      const summary = await main(
        [`${stream.origin}/live.m3u8`, join(root, 'flux'), '--assembler', join(root, 'out.ts')],
        { log: (line) => lines.push(line) },
      );

      assert.equal(summary.segments, 2);
      assert.equal(summary.bytes, 7);
      assert.equal(summary.encrypted, false);
      assert.equal(summary.bandwidth, null, 'playlist média : pas de variante');
      assert.equal(summary.assembled, join(root, 'out.ts'));

      assert.deepEqual(
        (await readdir(join(root, 'flux'))).sort(),
        ['index.m3u8', 'segment-00001.ts', 'segment-00002.ts'],
      );
      assert.equal(await readFile(join(root, 'out.ts'), 'utf8'), 'AAABBBB');
      assert.ok(lines.some((line) => line.includes('segment 1')));
      assert.ok(lines.some((line) => line.includes('assemblé')));

      // Sans assemblage, aucun fichier supplémentaire.
      const plain = await main([`${stream.origin}/live.m3u8`, join(root, 'sec')], { log: () => {} });
      assert.equal(plain.assembled, null);
      assert.equal((await readdir(join(root, 'sec'))).length, 3);
    } finally {
      await stream.close();
    }
  });
});

test('T-D-03 : la sortie JSON ne contient que le résumé', async () => {
  const stream = await startStream();
  await withTempDir(async (root) => {
    try {
      const cli = fileURLToPath(new URL('../bin/xdm-media.js', import.meta.url));
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [cli, `${stream.origin}/live.m3u8`, join(root, 'flux'), '--segments', '1', '--sortie', 'json'],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(stdout);
      assert.deepEqual(Object.keys(parsed).sort(), [
        'assembled', 'bandwidth', 'bytes', 'directory', 'encrypted', 'media', 'playlist', 'segments',
      ]);
      assert.equal(parsed.segments, 1);
      assert.equal(parsed.bytes, 3, 'un seul segment téléchargé');
      assert.equal(parsed.assembled, null);
      assert.match(stderr, /segment 1/);

      assert.deepEqual(summarize({
        playlistUrl: 'http://h/p.m3u8',
        mediaPlaylistUrl: 'http://h/p.m3u8',
        directory: '/tmp',
        segments: 2,
        bytes: 10,
        encrypted: false,
        variant: { bandwidth: 900 },
      }), {
        playlist: 'http://h/p.m3u8',
        media: 'http://h/p.m3u8',
        directory: '/tmp',
        segments: 2,
        bytes: 10,
        encrypted: false,
        bandwidth: 900,
        assembled: null,
      });
    } finally {
      await stream.close();
    }
  });
});
