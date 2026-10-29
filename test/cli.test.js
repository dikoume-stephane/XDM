import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { USAGE, main, parseArgs } from '../bin/xdm.js';
import { DownloadError } from '../src/connection-loop.js';

function content(size) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = i % 251;
  return buffer;
}

test('T-A-14 : la CLI refuse une invocation sans URL', async () => {
  await assert.rejects(() => main([], { log: () => {} }), (error) => {
    assert.ok(error instanceof DownloadError);
    assert.equal(error.code, 'USAGE');
    return true;
  });
  assert.match(USAGE, /xdm <url>/);
  assert.throws(() => parseArgs(['http://h/f', '--inconnu']), /option inconnue/);
  assert.throws(() => parseArgs(['http://h/f', '--connexions', 'x']), /--connexions attend un entier/);
  assert.deepEqual(parseArgs(['http://h/f', 'dl', '--connexions', '2', '--morceau', '512']), {
    url: 'http://h/f',
    directory: 'dl',
    connections: 2,
    chunkSize: 512,
    headers: {},
    incremental: false,
    resume: true,
    output: 'texte',
  });
  // `--entete` : même validation que l'aspiration (module partagé), et l'injection est refusée.
  assert.deepEqual(parseArgs(['http://h/f', '--entete', 'Authorization: Bearer x']).headers,
    { authorization: 'Bearer x' });
  assert.throws(() => parseArgs(['http://h/f', '--entete', 'X: a\r\nY: b']), /retour à la ligne/);
  assert.throws(() => parseArgs(['http://h/f', '--entete']), /--entete attend/);
  assert.equal(parseArgs(['http://h/f', '--incremental']).incremental, true);
});

test('T-A-14 : téléchargement complet depuis la CLI, nom déduit de l’URL', async () => {
  const body = content(1024);
  const server = http.createServer((req, res) => {
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  const dir = await mkdtemp(join(tmpdir(), 'xdm-cli-'));
  const lines = [];
  try {
    const result = await main(
      [`http://127.0.0.1:${port}/rapport%20final.pdf`, dir, '--connexions', '2', '--morceau', '256'],
      { log: (line) => lines.push(line) },
    );
    assert.equal(result.target, join(dir, 'rapport final.pdf'));
    assert.equal(result.size, 1024);
    assert.deepEqual(await readFile(result.target), body);
    assert.ok(lines.some((line) => line.includes('100 %')), lines.join('\n'));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
