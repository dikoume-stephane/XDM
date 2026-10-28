import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  BASE_HEADERS,
  HttpError,
  IDLE_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_URL_LENGTH,
  acceptsRanges,
  announcedSize,
  assertUrlLength,
  chunkRangeHeader,
  isRedirect,
  normalizeHeaders,
  openSegment,
  parseContentRange,
  planConnections,
  probe,
  rangeHeader,
  readWithIdleTimeout,
  resolveLocation,
  resumeRangeHeader,
} from '../src/http-client.js';

/** Transport factice : une table `url -> réponse`, journalise les requêtes. */
function fakeTransport(routes) {
  const calls = [];
  const transport = async (url, options = {}) => {
    calls.push({ url, ...options, headers: { ...(options.headers || {}) } });
    const route = routes[url];
    if (!route) throw new Error(`route inconnue : ${url}`);
    const response = typeof route === 'function' ? route(options) : route;
    if (response instanceof Error) throw response;
    return {
      status: response.status,
      headers: normalizeHeaders(response.headers || {}),
      stream: response.stream ?? (async function* empty() {})(),
    };
  };
  return { transport, calls };
}

/** Sérialiseur minimal de « corps » : une suite de morceaux, ou rien. */
function bodyOf(...parts) {
  return (async function* emit() {
    for (const part of parts) yield Buffer.from(part);
  })();
}

test('T-A-08 : un serveur qui ignore Range ne donne qu’une connexion', async () => {
  const { transport, calls } = fakeTransport({
    'http://h/file.bin': { status: 200, headers: { 'content-length': '4096' } },
  });
  const caps = await probe('http://h/file.bin', { transport });

  assert.equal(caps.acceptRanges, false);
  assert.equal(caps.size, 4096);
  assert.equal(planConnections(caps, { maxConnections: 8, chunkCount: 4 }), 1);
  // Une seule requête, et la compression est refusée (EX-A-16).
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['accept-encoding'], 'identity');
});

test('T-A-08 (suite) : `Accept-Ranges: bytes` + `Content-Length` autorise N connexions', async () => {
  const { transport } = fakeTransport({
    'http://h/file.bin': {
      status: 200,
      headers: { 'accept-ranges': 'bytes', 'content-length': '10485760' },
    },
  });
  const caps = await probe('http://h/file.bin', { transport });
  assert.equal(caps.acceptRanges, true);
  assert.equal(planConnections(caps, { maxConnections: 8, chunkCount: 12 }), 8);
  assert.equal(planConnections(caps, { maxConnections: 8, chunkCount: 3 }), 3);
});

test('T-A-08 (suite) : un `206` sans `Content-Range` n’est pas une plage valide', () => {
  assert.equal(acceptsRanges(206, {}), false);
  assert.equal(acceptsRanges(206, { 'content-range': 'bytes 0-99/1000' }), true);
  assert.equal(acceptsRanges(200, { 'accept-ranges': 'none', 'content-length': '10' }), false);
  assert.equal(acceptsRanges(200, { 'accept-ranges': 'bytes' }), false, 'taille inconnue ⇒ repli');
  assert.equal(acceptsRanges(404, { 'accept-ranges': 'bytes' }), false);
});

test('T-A-08 (suite) : en-têtes `Range` et calcul de la taille annoncée', () => {
  assert.equal(rangeHeader(2048, 4095), 'bytes=2048-4095');
  assert.equal(chunkRangeHeader({ start: 0, size: 2048 }), 'bytes=0-2047');
  assert.equal(resumeRangeHeader(4096), 'bytes=4096-');
  assert.throws(() => rangeHeader(10, 9), /fin de plage invalide/);
  assert.throws(() => resumeRangeHeader(-1), /offset de reprise invalide/);

  assert.deepEqual(parseContentRange('bytes 0-1023/4096'), { start: 0, end: 1023, total: 4096 });
  assert.deepEqual(parseContentRange('bytes 0-1023/*'), { start: 0, end: 1023, total: null });
  assert.equal(parseContentRange('bytes 10-5/100'), null);
  assert.equal(parseContentRange('bytes 0-100/100'), null, 'fin ≥ total');
  assert.equal(parseContentRange(undefined), null);

  assert.equal(announcedSize({ 'content-range': 'bytes 0-9/5000' }), 5000);
  assert.equal(announcedSize({ 'content-length': '42' }), 42);
  assert.equal(announcedSize({}), null);
});

test('T-A-15 : redirections — résolution relative, limite de 10, URL bornée', async () => {
  assert.equal(resolveLocation('http://h/a/b/c', '../d'), 'http://h/a/d');
  assert.equal(resolveLocation('http://h/a/b/c', '/x'), 'http://h/x');
  assert.equal(resolveLocation('https://h/a', 'https://autre/z?q=1'), 'https://autre/z?q=1');
  assert.throws(() => resolveLocation('http://h/', ''), /Location vide/);
  assert.throws(() => resolveLocation('http://h/', 'ftp://h/x'), /schéma non supporté/);

  // 10 redirections suivies, la 11ᵉ refusée.
  const routes = {};
  for (let i = 0; i < 12; i += 1) {
    routes[`http://h/r${i}`] = { status: 302, headers: { location: `/r${i + 1}` } };
  }
  const { transport, calls } = fakeTransport(routes);
  await assert.rejects(
    () => probe('http://h/r0', { transport }),
    (error) => error instanceof HttpError && error.code === 'TOO_MANY_REDIRECTS',
  );
  assert.equal(calls.length, MAX_REDIRECTS + 1);
  assert.equal(calls.at(-1).url, `http://h/r${MAX_REDIRECTS}`);

  // Une chaîne courte aboutit et expose l'URL finale.
  const short = fakeTransport({
    'http://h/a': { status: 301, headers: { location: 'http://h/b' } },
    'http://h/b': { status: 200, headers: { 'content-length': '7', etag: '"v1"' } },
  });
  const caps = await probe('http://h/a', { transport: short.transport });
  assert.equal(caps.finalUrl, 'http://h/b');
  assert.equal(caps.redirects, 1);
  assert.equal(caps.etag, '"v1"');
  assert.equal(isRedirect(303), true);
  assert.equal(isRedirect(300), false);

  // Une URL trop longue est refusée avant tout appel réseau.
  const tooLong = `http://h/${'a'.repeat(MAX_URL_LENGTH)}`;
  const spy = fakeTransport({});
  await assert.rejects(
    () => probe(tooLong, { transport: spy.transport }),
    (error) => error instanceof HttpError && error.code === 'URL_TOO_LONG',
  );
  assert.equal(spy.calls.length, 0);
  assert.equal(assertUrlLength(`http://h/${'é'.repeat(10)}`).length, 19);
  // La borne compte des octets, pas des caractères.
  assert.equal(Buffer.byteLength(`http://h/${'é'.repeat(10)}`), 29);
});

test('T-A-16 : `Accept-Encoding: identity` part sur chaque segment', async () => {
  const { transport, calls } = fakeTransport({
    'http://h/f': {
      status: 206,
      headers: { 'content-range': 'bytes 0-2047/10485760', 'content-length': '2048' },
      stream: bodyOf('a'.repeat(16)),
    },
  });
  const segment = await openSegment('http://h/f', { start: 0, size: 2048 }, {
    transport,
    headers: { 'user-agent': 'XDM/0.1' },
  });
  assert.equal(segment.ranged, true);
  assert.equal(segment.range, 'bytes=0-2047');
  assert.equal(calls[0].headers['accept-encoding'], 'identity');
  assert.equal(calls[0].headers['user-agent'], 'XDM/0.1');
  assert.equal(BASE_HEADERS['accept-encoding'], 'identity');
});

test('T-A-16 (suite) : un `206` inattendu se replie proprement (flux drainé)', async () => {
  let destroyed = false;
  const stream = { destroy: () => { destroyed = true; } };
  const { transport } = fakeTransport({
    'http://h/f': { status: 200, headers: { 'content-length': '10' }, stream },
  });
  const segment = await openSegment('http://h/f', { start: 0, size: 10 }, { transport });
  assert.equal(segment.ranged, false);
  assert.equal(destroyed, true);
});

test('T-A-17 : la sonde n’ouvre qu’une seule connexion à la fois', async () => {
  let active = 0;
  let peak = 0;
  const { transport } = fakeTransport({
    'http://h/f': () => {
      active += 1;
      peak = Math.max(peak, active);
      active -= 1;
      return { status: 200, headers: { 'content-length': '1' } };
    },
  });
  await probe('http://h/f', { transport });
  assert.equal(peak, 1);
});

test('T-A-18/T-A-25 : inactivité bornée ⇒ `IDLE_TIMEOUT` avec offset de reprise', async () => {
  // Flux qui donne deux morceaux puis se tait.
  const stream = (async function* stall() {
    yield Buffer.from('abcd');
    yield Buffer.from('efgh');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  })();

  const seen = [];
  await assert.rejects(
    () => readWithIdleTimeout(stream, {
      idleMs: 80,
      startOffset: 100,
      onChunk: (chunk, offset) => seen.push([Buffer.from(chunk).toString(), offset]),
    }),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, 'IDLE_TIMEOUT');
      assert.equal(error.details.received, 8);
      assert.equal(error.details.resumeAt, 108);
      return true;
    },
  );
  assert.deepEqual(seen, [['abcd', 100], ['efgh', 104]]);
  assert.equal(resumeRangeHeader(108), 'bytes=108-');
  assert.equal(IDLE_TIMEOUT_MS, 30_000);
});

test('T-A-18/T-A-25 (suite) : un flux complet rend `received` et `resumeAt`', async () => {
  const outcome = await readWithIdleTimeout(bodyOf('12345', '6789'), { idleMs: 500 });
  assert.deepEqual(outcome, { received: 9, resumeAt: 9 });
});

test('T-A-08 (bout en bout) : serveur local réel — en-têtes et repli', async () => {
  /** @type {{range?: string, encoding?: string}[]} */
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ range: req.headers.range, encoding: req.headers['accept-encoding'] });
    const total = 1000;
    if (req.url === '/plain') {
      res.writeHead(200, { 'content-length': String(total) });
      res.end(Buffer.alloc(total, 7));
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) {
      res.writeHead(416);
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), total - 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${total}`,
      'content-length': String(end - start + 1),
    });
    res.end(Buffer.alloc(end - start + 1, 1));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  try {
    const ranged = await probe(`http://127.0.0.1:${port}/f`);
    assert.equal(ranged.acceptRanges, true);
    assert.equal(ranged.size, 1000);
    assert.equal(planConnections(ranged, { maxConnections: 8, chunkCount: 4 }), 4);

    const plain = await probe(`http://127.0.0.1:${port}/plain`);
    assert.equal(plain.acceptRanges, false);
    assert.equal(planConnections(plain, { maxConnections: 8, chunkCount: 4 }), 1);

    const segment = await openSegment(`http://127.0.0.1:${port}/f`, { start: 100, size: 50 });
    assert.equal(segment.ranged, true);
    const outcome = await readWithIdleTimeout(segment.stream, { idleMs: 2_000 });
    assert.equal(outcome.received, 50);

    assert.ok(seen.every((entry) => entry.encoding === 'identity'));
    assert.equal(seen[1].range, 'bytes=0-0');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
