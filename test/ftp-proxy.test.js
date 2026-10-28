import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadFtp } from '../src/ftp.js';

const CONTENT = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 3) % 251));

/** Serveur FTP minimal (comme dans `ftp.test.js`, réduit à ce qui sert ici). */
async function startFtp() {
  const sockets = [];
  const dataServers = new Set();
  const server = net.createServer((control) => {
    sockets.push(control);
    control.setEncoding('latin1');
    let buffer = '';
    const send = (line) => control.write(`${line}\r\n`);
    send('220 prêt');
    control.on('error', () => {});
    control.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\r\n');
        const verb = line.split(' ')[0];
        if (verb === 'USER') send('331 mot de passe');
        else if (verb === 'PASS') send('230 connecté');
        else if (verb === 'CWD') send('250 ok');
        else if (verb === 'TYPE') send('200 ok');
        else if (verb === 'SIZE') send(`213 ${CONTENT.length}`);
        else if (verb === 'PASV') {
          const data = net.createServer((socket) => {
            socket.end(CONTENT);
            data.close();
            dataServers.delete(data);
          });
          dataServers.add(data);
          data.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (data.address());
            send(`227 Entering Passive Mode (127,0,0,1,${Math.floor(port / 256)},${port % 256})`);
          });
        } else if (verb === 'RETR') {
          send('150 envoi');
          setTimeout(() => send('226 fini'), 20);
        } else send('500 ?');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    origin: `ftp://anonymous@127.0.0.1:${port}/pub/fichier.bin`,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      for (const data of dataServers) data.close();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Proxy HTTP `CONNECT` (journalise les tunnels). */
async function startHttpProxy() {
  const tunnels = new Set();
  const seen = [];
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    seen.push(req.url);
    tunnels.add(clientSocket);
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
    seen,
    close: () => new Promise((resolve) => {
      for (const socket of tunnels) socket.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Proxy SOCKS5 minimal, sans authentification. */
async function startSocks5() {
  const tunnels = new Set();
  const seen = [];
  const server = net.createServer((client) => {
    tunnels.add(client);
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    client.on('error', () => {});
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        buffer = buffer.subarray(2 + buffer[1]);
        client.write(Buffer.from([5, 0]));
        stage = 'request';
        return;
      }
      if (stage === 'request') {
        if (buffer.length < 5) return;
        const length = buffer[4];
        if (buffer.length < 5 + length + 2) return;
        const host = buffer.subarray(5, 5 + length).toString();
        const port = buffer.readUInt16BE(5 + length);
        seen.push({ host, port });
        const upstream = net.createConnection({ host, port }, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        tunnels.add(upstream);
        upstream.on('error', () => client.end(Buffer.from([5, 5, 0, 0, 0, 0, 0, 0, 0, 0])));
        stage = 'tunnel';
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    seen,
    close: () => new Promise((resolve) => {
      for (const socket of tunnels) socket.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-ftppx-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-C-09 : FTP derrière un proxy HTTP (CFTPProxyConnection)', async () => {
  const ftp = await startFtp();
  const proxy = await startHttpProxy();
  await withTempDir(async (dir) => {
    const target = join(dir, 'f.bin');
    try {
      const events = [];
      const result = await downloadFtp(ftp.origin, target, {
        proxy: `http://127.0.0.1:${proxy.port}`,
        onEvent: (event) => events.push(event.type),
      });
      assert.equal(result.bytes, CONTENT.length);
      assert.deepEqual(await readFile(target), CONTENT);
      assert.deepEqual(proxy.seen, [`127.0.0.1:${ftp.port}`], 'le contrôle passe par le proxy');
      assert.ok(events.includes('proxy'), 'l’usage du proxy est signalé');
    } finally {
      await proxy.close();
      await ftp.close();
    }
  });
});

test('T-C-09 : FTP derrière un proxy SOCKS5', async () => {
  const ftp = await startFtp();
  const proxy = await startSocks5();
  await withTempDir(async (dir) => {
    const target = join(dir, 's.bin');
    try {
      const result = await downloadFtp(ftp.origin, target, {
        proxy: `socks5://127.0.0.1:${proxy.port}`,
      });
      assert.equal(result.bytes, CONTENT.length);
      assert.deepEqual(await readFile(target), CONTENT);
      assert.deepEqual(proxy.seen, [{ host: '127.0.0.1', port: ftp.port }]);
    } finally {
      await proxy.close();
      await ftp.close();
    }
  });
});

test('T-C-09 : proxy injoignable — échec explicite, pas de connexion directe', async () => {
  const ftp = await startFtp();
  await withTempDir(async (dir) => {
    try {
      await assert.rejects(
        downloadFtp(ftp.origin, join(dir, 'x.bin'), { proxy: 'http://127.0.0.1:1' }),
        (error) => ['PROXY_UNREACHABLE', 'CONNECT_REFUSED'].includes(error.code),
      );
    } finally {
      await ftp.close();
    }
  });
});
