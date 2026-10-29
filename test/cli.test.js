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

test('T-A-33 : les bornes de `--connexions` et `--morceau` sont refusées, pas corrigées', async () => {
  // Refus **local** : le message nomme la valeur reçue et l'intervalle attendu (`D-079`).
  assert.throws(() => parseArgs(['http://h/f', '--connexions', '0']), /de 1 à 128 \(reçu : 0\)/);
  assert.throws(() => parseArgs(['http://h/f', '--connexions', '129']), /reçu : 129/);
  assert.throws(() => parseArgs(['http://h/f', '--morceau', '0']), /de 1 à 10485760 octets/);
  assert.throws(() => parseArgs(['http://h/f', '--morceau', '10485761']), /reçu : 10485761/);
  // Les bornes elles-mêmes passent : refuser 128 serait refuser un réglage observé.
  assert.equal(parseArgs(['http://h/f', '--connexions', '128']).connections, 128);
  assert.equal(parseArgs(['http://h/f', '--morceau', '10485760']).chunkSize, 10485760);
  assert.equal(parseArgs(['http://h/f', '--morceau', '1']).chunkSize, 1);

  // Un découpage minuscule reste **licite** mais il est signalé : sans cet avertissement,
  // `--morceau 100` sur 5 Mio tournait plus de 400 s sans un mot.
  const body = content(64 * 1024);
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
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
    });
    res.end(body.subarray(start, end + 1));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const dir = await mkdtemp(join(tmpdir(), 'xdm-bornes-'));
  const lignes = [];
  try {
    await main([`http://127.0.0.1:${port}/f.bin`, dir, '--morceau', '100'], {
      log: (line) => lignes.push(line),
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
    await rm(dir, { recursive: true, force: true });
  }
  const avertissement = lignes.find((line) => line.startsWith('avertissement :'));
  assert.ok(avertissement, `aucun avertissement dans : ${lignes.join(' | ')}`);
  assert.match(avertissement, /6\d\d morceaux de 100 octets/);
});
