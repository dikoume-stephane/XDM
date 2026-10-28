import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FtpError,
  downloadFtp,
  openFtpSession,
  parseFtpUrl,
  parsePasvReply,
} from '../src/ftp.js';

const CONTENT = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

/**
 * Serveur FTP minimal mais réel : accueil, USER/PASS, CWD, TYPE, SIZE, REST, PASV, RETR.
 * `refusePasv` simule un serveur qui n'accepte que le mode actif (`EX-C-07`).
 */
async function startFtpServer({ refusePasv = false, abortAfter = null } = {}) {
  const log = [];
  let restOffset = 0;

  /** @type {import('node:net').Socket[]} */
  const sockets = [];
  /** @type {import('node:net').Server[]} serveurs de données ouverts par PASV */
  const dataServers = new Set();
  const server = net.createServer((control) => {
    sockets.push(control);
    control.setEncoding('latin1');
    let buffer = '';
    const send = (line) => control.write(`${line}\r\n`);
    send('220 serveur de test prêt');

    control.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\r\n');
        const [verb, ...rest] = line.split(' ');
        const argument = rest.join(' ');
        log.push(line);
        if (verb === 'USER') send('331 mot de passe requis');
        else if (verb === 'PASS') send('230 connecté');
        else if (verb === 'CWD') send('250 répertoire changé');
        else if (verb === 'TYPE') send('200 type réglé');
        else if (verb === 'SIZE') send(`213 ${CONTENT.length}`);
        else if (verb === 'REST') {
          restOffset = Number(argument);
          send('350 reprise acceptée');
        } else if (verb === 'PASV') {
          if (refusePasv) {
            send('502 commande PASV non implémentée');
            continue;
          }
          const data = net.createServer((socket) => {
            const slice = CONTENT.subarray(restOffset);
            const limit = abortAfter ?? slice.length;
            socket.end(slice.subarray(0, limit));
            data.close();
            dataServers.delete(data);
          });
          dataServers.add(data);
          data.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (data.address());
            const high = Math.floor(port / 256);
            const low = port % 256;
            send(`227 Entering Passive Mode (127,0,0,1,${high},${low})`);
          });
        } else if (verb === 'RETR') {
          send('150 transfert en cours');
          // La fin de transfert arrive après la fermeture du canal de données.
          setTimeout(() => send('226 transfert terminé'), 30);
        } else if (verb === 'QUIT') {
          send('221 au revoir');
          control.end();
        } else {
          send('500 commande inconnue');
        }
      }
    });
    control.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    log,
    origin: `ftp://anonymous@127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      // Fermer aussi les connexions de contrôle et les serveurs de données ouverts.
      for (const socket of sockets) socket.destroy();
      for (const data of dataServers) data.close();
      dataServers.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-ftp-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-C-06 : URL FTP et réponse PASV', () => {
  assert.deepEqual(parseFtpUrl('ftp://user:pass@example.com:2121/pub/fichier.zip'), {
    host: 'example.com',
    port: 2121,
    user: 'user',
    password: 'pass',
    path: '/pub/fichier.zip',
  });
  assert.equal(parseFtpUrl('ftp://example.com/a.bin').user, 'anonymous');
  assert.throws(() => parseFtpUrl('http://example.com/a'), /protocole non FTP/);
  assert.deepEqual(parsePasvReply('227 Entering Passive Mode (192,168,1,4,19,137)'), {
    host: '192.168.1.4',
    port: 19 * 256 + 137,
  });
  assert.throws(() => parsePasvReply('227 ok'), (error) => error.code === 'PASV_MALFORMED');
});

test('T-C-06 : séquence CWD → TYPE I → SIZE → RETR', async () => {
  const site = await startFtpServer();
  await withTempDir(async (dir) => {
    const target = join(dir, 'fichier.bin');
    try {
      const result = await downloadFtp(`${site.origin}/pub/fichier.bin`, target);
      assert.equal(result.size, CONTENT.length);
      assert.equal(result.bytes, CONTENT.length);
      assert.equal(result.resumed, false);
      assert.deepEqual(await readFile(target), CONTENT);

      assert.deepEqual(site.log.slice(0, 5), [
        'USER anonymous',
        'PASS ',
        'CWD /pub/',
        'TYPE I',
        'SIZE fichier.bin',
      ], 'ordre exact du dialogue observé dans IDMan');
      assert.ok(site.log.includes('PASV'), 'mode passif utilisé');
      assert.ok(site.log.includes('RETR fichier.bin'));
    } finally {
      await site.close();
    }
  });
});

test('T-C-06 : reprise par REST sur un fichier partiel', async () => {
  const site = await startFtpServer();
  await withTempDir(async (dir) => {
    const target = join(dir, 'partiel.bin');
    try {
      // Un fichier local de 2000 octets déjà téléchargés.
      await writeFile(target, CONTENT.subarray(0, 2000));
      const result = await downloadFtp(`${site.origin}/fichier.bin`, target);
      assert.equal(result.resumed, true);
      assert.equal(result.restartAt, 2000);
      assert.equal(result.bytes, CONTENT.length - 2000);
      assert.ok(site.log.includes('REST 2000'), 'REST porte la taille locale');
      assert.deepEqual(await readFile(target), CONTENT, 'fichier complet et cohérent');
    } finally {
      await site.close();
    }
  });
});

test('T-C-07 : refus de PASV — échec explicite, aucun repli silencieux', async () => {
  const site = await startFtpServer({ refusePasv: true });
  await withTempDir(async (dir) => {
    try {
      await assert.rejects(
        downloadFtp(`${site.origin}/fichier.bin`, join(dir, 'x.bin')),
        (error) => {
          assert.ok(error instanceof FtpError);
          assert.equal(error.code, 'PASV_UNSUPPORTED');
          assert.match(error.message, /mode passif/);
          return true;
        },
      );
    } finally {
      await site.close();
    }
  });
});

test('T-C-06 : un transfert tronqué est signalé, pas promu', async () => {
  const site = await startFtpServer({ abortAfter: 100 });
  await withTempDir(async (dir) => {
    try {
      await assert.rejects(
        downloadFtp(`${site.origin}/fichier.bin`, join(dir, 'tronque.bin')),
        (error) => error.code === 'INCOMPLETE',
      );
    } finally {
      await site.close();
    }
  });
});

test('T-C-06 : session brute — commandes et fermeture', async () => {
  const site = await startFtpServer();
  const session = await openFtpSession({ host: '127.0.0.1', port: site.port });
  try {
    await session.login();
    const reply = await session.command('TYPE I');
    assert.equal(reply.code, 200);
    const passive = await session.pasv();
    assert.equal(passive.host, '127.0.0.1');
    assert.ok(passive.port > 0);
    assert.equal(await session.size('fichier.bin'), CONTENT.length);
  } finally {
    session.close();
    await site.close();
  }
});
