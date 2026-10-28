import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import {
  CHUNK_ENCODINGS,
  DEFAULT_ACCEPT,
  DEFAULT_USER_AGENT,
  PAGE_ENCODINGS,
  buildChunkHeaders,
  buildHeaders,
  buildPageHeaders,
  lowercaseKeys,
} from '../src/headers.js';
import { decodeBody, fetchText, openSegment } from '../src/http-client.js';

test('T-C-02 : en-têtes de requête — agent, accept, referer, cookie', () => {
  const headers = buildHeaders();
  assert.equal(headers['User-Agent'], DEFAULT_USER_AGENT);
  assert.equal(headers.Accept, DEFAULT_ACCEPT);
  assert.equal(headers['Accept-Encoding'], PAGE_ENCODINGS);
  assert.equal(headers.Referer, undefined);

  const full = buildHeaders({
    referer: 'https://example.com/page',
    cookie: 'sid=abc',
    userAgent: 'Test/1.0',
    accept: '*/*',
  });
  assert.equal(full.Referer, 'https://example.com/page');
  assert.equal(full.Cookie, 'sid=abc');
  assert.equal(full['User-Agent'], 'Test/1.0');
  assert.equal(full.Accept, '*/*');

  // L'appelant gagne sur les valeurs par défaut, casse comprise.
  const overridden = buildHeaders({ overrides: { 'User-Agent': 'Autre/2', Accept: 'text/plain' } });
  assert.equal(overridden['user-agent'], 'Autre/2');
  assert.equal(overridden.accept, 'text/plain');

  assert.deepEqual(lowercaseKeys({ 'X-Test': 'a', Vide: undefined }), { 'x-test': 'a' });
});

test('T-C-05 : deux politiques de compression, jamais confondues', () => {
  // `EX-A-16` : les morceaux restent en `identity`, un `Range` compressé n'aurait pas de sens.
  assert.equal(CHUNK_ENCODINGS, 'identity');
  assert.equal(buildChunkHeaders()['Accept-Encoding'], 'identity');
  // `EX-C-05` : une page accepte `gzip, deflate`.
  assert.equal(PAGE_ENCODINGS, 'gzip, deflate');
  assert.equal(buildPageHeaders({ referer: 'http://h/' })['Accept-Encoding'], 'gzip, deflate');
});

test('T-C-05 : un corps gzip, deflate ou brotli est décompressé', () => {
  const text = Buffer.from('contenu compressé '.repeat(20));
  assert.equal(decodeBody(zlib.gzipSync(text), 'gzip').toString(), text.toString());
  assert.equal(decodeBody(zlib.deflateSync(text), 'deflate').toString(), text.toString());
  assert.equal(decodeBody(zlib.brotliCompressSync(text), 'br').toString(), text.toString());
  // Sans en-tête, ou avec un en-tête menteur, on ne devine pas : octets rendus tels quels.
  assert.deepEqual(decodeBody(text, undefined), text);
  assert.deepEqual(decodeBody(text, 'gzip'), text);
  assert.deepEqual(decodeBody(text, ''), text);
});

test('T-C-02/T-C-05 : fetchText annonce gzip et décompresse ce qu’il reçoit', async () => {
  const seen = [];
  const page = '<html><body>bonjour</body></html>';
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const body = zlib.gzipSync(Buffer.from(page));
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${port}`;

  try {
    const page1 = await fetchText(`${origin}/`, { referer: 'http://h/amont' });
    assert.equal(page1.body, page);
    assert.equal(page1.encoding, 'gzip');
    assert.equal(seen[0]['accept-encoding'], 'gzip, deflate');
    assert.equal(seen[0].referer, 'http://h/amont');
    assert.match(seen[0]['user-agent'], /XDM/);

    // Compression refusée explicitement : l'en-tête redevient `identity`.
    await fetchText(`${origin}/`, { compression: false });
    assert.equal(seen[1]['accept-encoding'], 'identity');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('T-A-16/T-C-05 : les segments gardent identity, même quand fetchText compresse', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['accept-encoding']);
    res.writeHead(206, {
      'content-range': 'bytes 0-3/10',
      'content-length': '4',
    });
    res.end('abcd');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${port}`;
  try {
    const segment = await openSegment(`${origin}/f.bin`, { start: 0, size: 4 });
    segment.stream.destroy();
    await fetchText(`${origin}/page`, { compression: true });
    assert.equal(seen[0], 'identity', 'segment : identity (EX-A-16)');
    assert.equal(seen[1], 'gzip, deflate', 'page : compression acceptée (EX-C-05)');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
