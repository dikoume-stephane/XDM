import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCHEMES, main, parseArgs, transportFor } from '../bin/xdm.js';
import { DownloadError } from '../src/connection-loop.js';

const CONTENT = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 7) % 251));

/** Serveur FTP minimal : accueil, USER/PASS, CWD, TYPE, SIZE, REST, PASV, RETR. */
async function startFtpServer({ size = true } = {}) {
  const log = [];
  let restOffset = 0;
  /** @type {import('node:net').Socket[]} */
  const sockets = [];
  const dataServers = new Set();
  const server = net.createServer((control) => {
    sockets.push(control);
    control.setEncoding('latin1');
    let buffer = '';
    const send = (line) => control.write(`${line}\r\n`);
    send('220 prêt');
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
        if (verb === 'USER') send('331 mot de passe');
        else if (verb === 'PASS') send('230 ok');
        else if (verb === 'CWD') send('250 ok');
        else if (verb === 'TYPE') send('200 ok');
        else if (verb === 'SIZE') send(size ? `213 ${CONTENT.length}` : '550 inconnu');
        else if (verb === 'REST') {
          restOffset = Number(argument);
          send('350 reprise');
        } else if (verb === 'PASV') {
          const data = net.createServer((socket) => {
            socket.end(CONTENT.subarray(restOffset));
            data.close();
            dataServers.delete(data);
          });
          dataServers.add(data);
          data.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (data.address());
            send(`227 Entering Passive Mode (127,0,0,1,${Math.floor(port / 256)},${port % 256})`);
          });
        } else if (verb === 'RETR') {
          send('150 en cours');
          setTimeout(() => send('226 terminé'), 30);
        } else if (verb === 'QUIT') {
          send('221 au revoir');
          control.end();
        } else send('500 inconnu');
      }
    });
    control.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `ftp://anonymous@127.0.0.1:${port}`,
    log,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      for (const data of dataServers) data.close();
      dataServers.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-cliftp-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-C-13 : le schéma choisit le transport, un schéma inconnu est refusé sans réseau', () => {
  assert.deepEqual(SCHEMES, { http: 'http', https: 'http', ftp: 'ftp' });
  assert.equal(transportFor('http://h/x'), 'http');
  assert.equal(transportFor('https://h/x'), 'http');
  assert.equal(transportFor('FTP://h/x'), 'ftp', 'la casse du schéma est ignorée');

  for (const url of ['mailto:a@b', 'file:///tmp/x', 'data:text/plain,x']) {
    assert.throws(
      () => transportFor(url),
      (error) => error instanceof DownloadError
        && error.code === 'USAGE'
        && /schéma non pris en charge/.test(error.message),
      url,
    );
  }
  assert.throws(() => transportFor('pas une url'), /URL invalide/);
  assert.equal(parseArgs(['ftp://h/a/b.zip', '.', '--proxy', 'http://p:3128']).proxy, 'http://p:3128');
  assert.throws(() => parseArgs(['http://h/', '--proxy']), /--proxy attend une URL/);
});

test('T-C-13 : `xdm ftp://…` télécharge réellement, avec la séquence observée', async () => {
  const site = await startFtpServer();
  await withTempDir(async (dir) => {
    try {
      const lines = [];
      const result = await main([`${site.origin}/pub/paquet.bin`, dir], {
        log: (line) => lines.push(line),
      });
      assert.equal(result.size, CONTENT.length);
      assert.equal(result.target, join(dir, 'paquet.bin'));
      assert.deepEqual(await readFile(result.target), CONTENT);

      // Le fichier vient du serveur, par la séquence que la cible utilise réellement.
      const verbs = site.log.map((line) => line.split(' ')[0]);
      assert.deepEqual(verbs.slice(0, 5), ['USER', 'PASS', 'CWD', 'TYPE', 'SIZE']);
      assert.ok(verbs.includes('PASV'), 'mode passif obligatoire');
      assert.ok(verbs.indexOf('RETR') > verbs.indexOf('PASV'));
      assert.ok(lines.some((line) => line.startsWith('taille distante')));
    } finally {
      await site.close();
    }
  });
});

test('T-C-13 : une taille distante inconnue n’empêche pas le transfert', async () => {
  const site = await startFtpServer({ size: false });
  await withTempDir(async (dir) => {
    try {
      const lines = [];
      const result = await main([`${site.origin}/sans-taille.bin`, dir], {
        log: (line) => lines.push(line),
      });
      assert.deepEqual(await readFile(result.target), CONTENT);
      assert.ok(lines.some((line) => line.includes('inconnue')),
        'l’absence de `SIZE` est dite, pas contournée en silence');
    } finally {
      await site.close();
    }
  });
});

test('T-C-13 : une reprise FTP repart de l’octet déjà présent', async () => {
  const site = await startFtpServer();
  await withTempDir(async (dir) => {
    try {
      const target = join(dir, 'partiel.bin');
      // Un fichier local tronqué : `downloadFtp` doit envoyer `REST` avant `RETR`.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(target, CONTENT.subarray(0, 1000));

      await main([`${site.origin}/partiel.bin`, dir], { log: () => {} });
      const verbs = site.log.map((line) => line.split(' ')[0]);
      assert.ok(verbs.includes('REST'), 'reprise demandée au serveur');
      const rest = site.log.find((line) => line.startsWith('REST'));
      assert.equal(rest, 'REST 1000');
      assert.ok(verbs.indexOf('REST') < verbs.indexOf('RETR'));

      const final = await readFile(target);
      assert.equal(final.length, CONTENT.length);
      assert.deepEqual(final, CONTENT, 'le fichier final est complet, pas concaténé deux fois');
    } finally {
      await site.close();
    }
  });
});
