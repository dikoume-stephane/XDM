import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import {
  digestProxyAuth,
  parseProxyChallenge,
} from '../src/proxy.js';
import { fetchText } from '../src/http-client.js';

const md5 = (value) => crypto.createHash('md5').update(value, 'utf8').digest('hex');

/** Vérifie côté serveur un `Proxy-Authorization: Digest …` (qop=auth, MD5). */
function verifyDigest(header, { user, password, method, uri }) {
  const params = Object.fromEntries(
    [...header.slice(7).matchAll(/([a-z-]+)=(?:"([^"]*)"|([^,]+))/gi)]
      .map((match) => [match[1].toLowerCase(), match[2] ?? match[3]]),
  );
  const ha1 = md5(`${user}:${params.realm}:${password}`);
  const ha2 = md5(`${method}:${params.uri}`);
  const expected = params.qop
    ? md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:auth:${ha2}`)
    : md5(`${ha1}:${params.nonce}:${ha2}`);
  return {
    ok: params.response === expected && params.uri === uri && params.username === user,
    params,
  };
}

/** Proxy HTTP à défi Digest : refuse tout `CONNECT` sans preuve valide. */
async function startDigestProxy({ user = 'alice', password = 'secret', realm = 'corp' } = {}) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const seen = [];
  const tunnels = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    tunnels.add(clientSocket);
    const authorization = req.headers['proxy-authorization'] ?? null;
    seen.push(authorization);

    const accepted = authorization
      && authorization.startsWith('Digest ')
      && verifyDigest(authorization, { user, password, method: 'CONNECT', uri: req.url }).ok;

    if (!accepted) {
      clientSocket.end(
        `HTTP/1.1 407 Proxy Authentication Required\r\n`
        + `Proxy-Authenticate: Digest realm="${realm}", nonce="${nonce}", qop="auth", algorithm=MD5\r\n`
        + 'Content-Length: 0\r\n\r\n',
      );
      return;
    }
    const [host, port] = String(req.url).split(':');
    const upstream = net.createConnection({ host, port: Number(port) }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    tunnels.add(upstream);
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    nonce,
    seen,
    close: () => new Promise((resolve) => {
      for (const socket of tunnels) socket.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

async function startTarget() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>derrière digest</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

test('T-C-10 : lecture d’un défi Proxy-Authenticate', () => {
  assert.deepEqual(parseProxyChallenge('Basic realm="proxy"'), { scheme: 'basic', params: {} });
  assert.deepEqual(
    parseProxyChallenge('Digest realm="corp", nonce="abc", qop="auth,auth-int", algorithm=MD5, opaque="op"'),
    {
      scheme: 'digest',
      params: { realm: 'corp', nonce: 'abc', qop: 'auth,auth-int', algorithm: 'MD5', opaque: 'op' },
    },
  );
  assert.throws(() => parseProxyChallenge('Digest realm="corp"'), /défi Digest incomplet/);
  assert.throws(() => parseProxyChallenge('Negotiate'), /non géré/);
});

test('T-C-10 : calcul de la réponse Digest (RFC 7616, qop=auth)', () => {
  const challenge = { realm: 'corp', nonce: 'abc123', qop: 'auth', algorithm: 'MD5' };
  const header = digestProxyAuth(
    { user: 'alice', password: 'secret' },
    challenge,
    { method: 'CONNECT', uri: 'example.com:443', cnonce: 'deadbeef', nonceCount: 1 },
  );
  assert.match(header, /^Digest /);
  const { ok, params } = verifyDigest(header, {
    user: 'alice',
    password: 'secret',
    method: 'CONNECT',
    uri: 'example.com:443',
  });
  assert.equal(ok, true);
  assert.equal(params.nc, '00000001');
  assert.equal(params.cnonce, 'deadbeef');
  assert.equal(params.qop, 'auth');

  // Sans qop : la formule ancienne (RFC 2069) reste correcte.
  const legacy = digestProxyAuth(
    { user: 'alice', password: 'secret' },
    { realm: 'corp', nonce: 'abc' },
    { method: 'CONNECT', uri: 'example.com:443' },
  );
  assert.equal(verifyDigest(legacy, {
    user: 'alice', password: 'secret', method: 'CONNECT', uri: 'example.com:443',
  }).ok, true);

  // Un mot de passe faux ne passe pas.
  const wrong = digestProxyAuth(
    { user: 'alice', password: 'faux' },
    challenge,
    { method: 'CONNECT', uri: 'example.com:443' },
  );
  assert.equal(verifyDigest(wrong, {
    user: 'alice', password: 'secret', method: 'CONNECT', uri: 'example.com:443',
  }).ok, false);

  assert.throws(
    () => digestProxyAuth({ user: 'a', password: 'b' }, { realm: 'r', nonce: 'n', algorithm: 'SHA-256' },
      { method: 'CONNECT', uri: 'x' }),
    /algorithme Digest non géré/,
  );
});

test('T-C-10 : CONNECT négocié en Digest, avec un seul aller-retour', async () => {
  const target = await startTarget();
  const proxy = await startDigestProxy();
  try {
    const { createProxyTransport } = await import('../src/proxy.js');
    const transport = createProxyTransport(`http://alice:secret@127.0.0.1:${proxy.port}`);
    const page = await fetchText(`http://127.0.0.1:${target.port}/page`, { transport });
    assert.equal(page.body, '<html>derrière digest</html>');

    assert.equal(proxy.seen.length, 2, 'une tentative refusée, une acceptée');
    assert.match(proxy.seen[0], /^Basic /, 'première tentative : Basic');
    assert.match(proxy.seen[1], /^Digest /, 'seconde tentative : Digest');
    assert.ok(proxy.seen[1].includes(proxy.nonce), 'le nonce du défi est repris');
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('T-C-10 : mauvais mot de passe en Digest — refus explicite', async () => {
  const target = await startTarget();
  const proxy = await startDigestProxy({ password: 'autre' });
  try {
    const { createProxyTransport } = await import('../src/proxy.js');
    const transport = createProxyTransport(`http://alice:faux@127.0.0.1:${proxy.port}`);
    await assert.rejects(
      fetchText(`http://127.0.0.1:${target.port}/page`, { transport }),
      (error) => error.code === 'CONNECT_REFUSED' && error.details.status === 407,
    );
    assert.equal(proxy.seen.length, 2, 'aucune troisième tentative (pas de boucle)');
  } finally {
    await proxy.close();
    await target.close();
  }
});
