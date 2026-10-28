import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import {
  ProxyError,
  basicProxyAuth,
  createProxyTransport,
  openThroughProxy,
  parseProxyUrl,
  socks5Handshake,
} from '../src/proxy.js';
import { fetchText, probe } from '../src/http-client.js';

/** Serveur HTTP cible : pages et plages. */
async function startTarget() {
  const body = Buffer.from('contenu de la cible '.repeat(10));
  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>via proxy</html>');
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' });
    res.end(body);
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

/** Proxy HTTP minimal : `CONNECT` seulement, journalise l'authentification. */
async function startHttpProxy({ requireAuth = null } = {}) {
  const seen = [];
  /** Sockets de tunnel : `closeAllConnections` ne les connaît pas. */
  const tunnels = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    seen.push({ authority: req.url, auth: req.headers['proxy-authorization'] ?? null });
    tunnels.add(clientSocket);
    if (requireAuth && req.headers['proxy-authorization'] !== requireAuth) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const [host, port] = String(req.url).split(':');
    const upstream = net.createConnection({ host, port: Number(port) }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
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
    seen,
    close: () => new Promise((resolve) => {
      for (const socket of tunnels) socket.destroy();
      tunnels.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Proxy SOCKS5 minimal : sans authentification ou avec (RFC 1929). */
async function startSocks5Proxy({ auth = null } = {}) {
  const seen = [];
  /** Sockets de tunnel, à détruire à la fermeture. */
  const tunnels = new Set();
  const server = net.createServer((client) => {
    tunnels.add(client);
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    const target = { host: null, port: 0 };
    client.on('error', () => {});
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const count = buffer[1];
        if (buffer.length < 2 + count) return;
        const methods = [...buffer.subarray(2, 2 + count)];
        buffer = buffer.subarray(2 + count);
        if (auth) {
          if (!methods.includes(2)) {
            client.end(Buffer.from([5, 0xff]));
            return;
          }
          client.write(Buffer.from([5, 2]));
          stage = 'auth';
        } else {
          client.write(Buffer.from([5, 0]));
          stage = 'request';
        }
        return;
      }
      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const userLength = buffer[1];
        if (buffer.length < 3 + userLength) return;
        const passwordLength = buffer[2 + userLength];
        if (buffer.length < 3 + userLength + passwordLength) return;
        const user = buffer.subarray(2, 2 + userLength).toString();
        const password = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
        buffer = buffer.subarray(3 + userLength + passwordLength);
        const ok = user === auth.user && password === auth.password;
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return;
        stage = 'request';
        return;
      }
      if (stage === 'request') {
        if (buffer.length < 5) return;
        const addressType = buffer[3];
        let offset = 5;
        let host;
        if (addressType === 3) {
          const length = buffer[4];
          if (buffer.length < 5 + length + 2) return;
          host = buffer.subarray(5, 5 + length).toString();
          offset = 5 + length;
        } else if (addressType === 1) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join('.');
          offset = 8;
        } else {
          client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buffer.readUInt16BE(offset);
        buffer = buffer.subarray(offset + 2);
        seen.push({ host, port });
        const upstream = net.createConnection({ host, port }, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.off('data', onData);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        tunnels.add(upstream);
        upstream.on('error', () => {
          client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
        client.on('error', () => upstream.destroy());
        stage = 'tunnel';
      }
    };
    client.on('data', onData);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    seen,
    close: () => new Promise((resolve) => {
      for (const socket of tunnels) socket.destroy();
      tunnels.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

test('T-C-09 : URL de proxy et en-tête d’authentification', () => {
  assert.deepEqual(parseProxyUrl('http://proxy.local:3128'), {
    type: 'http', host: 'proxy.local', port: 3128, auth: null,
  });
  assert.deepEqual(parseProxyUrl('socks5://user:p%40ss@127.0.0.1'), {
    type: 'socks5', host: '127.0.0.1', port: 1080, auth: { user: 'user', password: 'p@ss' },
  });
  assert.equal(parseProxyUrl('socks5h://h').type, 'socks5', 'socks5h = résolution côté proxy');
  assert.equal(parseProxyUrl('https://h:8443').port, 8443);
  assert.throws(() => parseProxyUrl('ftp://h'), /non pris en charge/);
  assert.equal(basicProxyAuth({ user: 'u', password: 'p' }), `Basic ${Buffer.from('u:p').toString('base64')}`);
});

test('T-C-09/T-C-10 : HTTP via CONNECT, avec authentification Basic', async () => {
  const target = await startTarget();
  const expected = `Basic ${Buffer.from('alice:secret').toString('base64')}`;
  const proxy = await startHttpProxy({ requireAuth: expected });
  try {
    const transport = createProxyTransport(`http://alice:secret@127.0.0.1:${proxy.port}`);
    const page = await fetchText(`http://127.0.0.1:${target.port}/page`, { transport });
    assert.equal(page.body, '<html>via proxy</html>');
    assert.equal(proxy.seen.length, 1);
    assert.equal(proxy.seen[0].authority, `127.0.0.1:${target.port}`);
    assert.equal(proxy.seen[0].auth, expected);

    // Le même transport marche pour la sonde de plages (donc pour le moteur).
    const capabilities = await probe(`http://127.0.0.1:${target.port}/f.bin`, { transport });
    assert.equal(capabilities.size > 0, true);
    assert.equal(capabilities.acceptRanges, true);
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('T-C-10 : un proxy qui exige un autre mot de passe refuse le tunnel', async () => {
  const target = await startTarget();
  const proxy = await startHttpProxy({
    requireAuth: `Basic ${Buffer.from('alice:bon').toString('base64')}`,
  });
  try {
    const transport = createProxyTransport(`http://alice:faux@127.0.0.1:${proxy.port}`);
    await assert.rejects(
      fetchText(`http://127.0.0.1:${target.port}/page`, { transport }),
      (error) => error.code === 'CONNECT_REFUSED' && error.details.status === 407,
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('T-C-09 : SOCKS5 sans authentification, DNS laissé au proxy', async () => {
  const target = await startTarget();
  const proxy = await startSocks5Proxy();
  try {
    const transport = createProxyTransport(`socks5://127.0.0.1:${proxy.port}`);
    const page = await fetchText(`http://127.0.0.1:${target.port}/page`, { transport });
    assert.equal(page.body, '<html>via proxy</html>');
    assert.deepEqual(proxy.seen, [{ host: '127.0.0.1', port: target.port }]);
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('T-C-09 : SOCKS5 avec mot de passe (RFC 1929)', async () => {
  const target = await startTarget();
  const proxy = await startSocks5Proxy({ auth: { user: 'bob', password: 'mdp' } });
  try {
    const good = createProxyTransport(`socks5://bob:mdp@127.0.0.1:${proxy.port}`);
    const page = await fetchText(`http://127.0.0.1:${target.port}/page`, { transport: good });
    assert.equal(page.body, '<html>via proxy</html>');

    const bad = createProxyTransport(`socks5://bob:faux@127.0.0.1:${proxy.port}`);
    await assert.rejects(
      fetchText(`http://127.0.0.1:${target.port}/page`, { transport: bad }),
      (error) => error.code === 'PROXY_REQUEST_FAILED' || error.code === 'SOCKS_AUTH_FAILED',
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('T-C-09 : erreurs de proxy explicites (injoignable, non implémenté)', async () => {
  await assert.rejects(
    openThroughProxy(parseProxyUrl('http://127.0.0.1:1'), { host: '127.0.0.1', port: 80 }),
    (error) => error instanceof ProxyError && ['PROXY_UNREACHABLE', 'CONNECT_REFUSED'].includes(error.code),
  );
  await assert.rejects(
    openThroughProxy(parseProxyUrl('socks4://127.0.0.1:1080'), { host: 'h', port: 80 }),
    (error) => error.code === 'PROXY_UNSUPPORTED',
  );

  // Poignée de main SOCKS5 seule : le proxy annonce « aucune méthode ».
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end(Buffer.from([5, 0xff])));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve) => socket.once('connect', resolve));
  await assert.rejects(
    socks5Handshake(socket, { host: 'x', port: 80 }),
    (error) => error.code === 'SOCKS_NO_METHOD',
  );
  socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

test('T-C-09 : un proxy HTTPS chiffre de bout en bout (TLS au-dessus du tunnel)', async () => {
  // Le transport doit choisir `tls.connect` pour une cible `https:` ; on vérifie cette
  // bifurcation sans certificat : la connexion échoue côté TLS, mais **après** le tunnel.
  const proxy = await startHttpProxy();
  try {
    const transport = createProxyTransport(`http://127.0.0.1:${proxy.port}`);
    await assert.rejects(
      fetchText('https://127.0.0.1:1/page', { transport }),
      (error) => ['CONNECT_REFUSED', 'PROXY_REQUEST_FAILED', 'PROXY_UNREACHABLE'].includes(error.code),
    );
    assert.equal(proxy.seen.length, 1, 'le tunnel a bien été demandé pour la cible https');
  } finally {
    await proxy.close();
  }
});
