/**
 * Client FTP — fiche C (`EX-C-06`, `EX-C-07`).
 *
 * Le binaire d'IDM instrumente un dialogue FTP classique : `CWD` → `TYPE I` → `SIZE` →
 * (`REST`) → `RETR`, en mode **passif** obligatoire (annexe 15 §2.3). C'est exactement la
 * séquence implémentée ici : le mode actif n'est pas proposé, parce que la cible ne
 * l'utilise pas et que réinventer un serveur qui se connecte au client est un risque inutile.
 *
 * Ce module ne fait que FTP : pas de proxy (`CFTPProxyConnection` reste à faire, `EX-C-09`),
 * pas de FTPS implicite (`AUTH TLS` est absent des chaînes d'IDM).
 *
 * @module ftp
 */

import net from 'node:net';
import { open } from 'node:fs/promises';

/** Réponse FTP : code à trois chiffres, éventuellement multiligne. */
export class FtpError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'FtpError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Décompose une URL FTP.
 * @param {string} url
 * @returns {{host: string, port: number, user: string, password: string, path: string}}
 */
export function parseFtpUrl(url) {
  const target = new URL(url);
  if (target.protocol !== 'ftp:') {
    throw new FtpError(`protocole non FTP : ${target.protocol}`, 'NOT_FTP', { url });
  }
  const user = decodeURIComponent(target.username || 'anonymous');
  const password = decodeURIComponent(target.password || '');
  const path = decodeURIComponent(target.pathname || '/');
  return {
    host: target.hostname,
    port: target.port ? Number(target.port) : 21,
    user,
    password,
    path,
  };
}

/**
 * Extrait l'adresse du serveur de données d'une réponse `227` (`h1,h2,h3,h4,p1,p2`).
 * @param {string} reply
 * @returns {{host: string, port: number}}
 */
export function parsePasvReply(reply) {
  const match = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(reply);
  if (!match) {
    throw new FtpError(`réponse PASV illisible : ${reply}`, 'PASV_MALFORMED', { reply });
  }
  const [, a, b, c, d, high, low] = match.map(Number);
  return { host: `${a}.${b}.${c}.${d}`, port: high * 256 + low };
}

/**
 * Lit les réponses ligne à ligne sur un socket de contrôle.
 * @param {import('node:net').Socket} socket
 */
function createReplyReader(socket) {
  let buffer = '';
  /** @type {string[]} */
  let lines = [];
  /** @type {((reply: {code: number, message: string, lines: string[]}) => void) | null} */
  let waiting = null;

  const flush = () => {
    if (!waiting) return;
    // Une réponse complète : `123 ...` ou `123-...` suivi d'une ligne `123 ...`.
    while (lines.length > 0) {
      const first = /^(\d{3})([ -])/.exec(lines[0]);
      if (!first) {
        lines.shift();
        continue;
      }
      const code = Number(first[1]);
      if (first[2] === ' ') {
        const [head, ...rest] = lines;
        lines = rest;
        const resolve = waiting;
        waiting = null;
        resolve({ code, message: head.slice(4), lines: [head] });
        return;
      }
      const end = lines.findIndex((line, index) => index > 0
        && new RegExp(`^${code} `).test(line));
      if (end < 0) return; // réponse multiligne encore incomplète
      const block = lines.slice(0, end + 1);
      lines = lines.slice(end + 1);
      const resolve = waiting;
      waiting = null;
      resolve({
        code,
        message: block[0].slice(4),
        lines: block,
      });
      return;
    }
  };

  socket.setEncoding('latin1');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\r\n');
    while (index >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\r\n');
    }
    flush();
  });

  return () => new Promise((resolve) => {
    waiting = resolve;
    flush();
  });
}

/**
 * Session FTP sur une connexion de contrôle.
 *
 * @param {{host: string, port: number, user?: string, password?: string,
 *   timeout?: number}} options
 * @returns {Promise<{command: (line: string) => Promise<{code: number, message: string}>,
 *   login: () => Promise<void>, pasv: () => Promise<{host: string, port: number}>,
 *   size: (path: string) => Promise<number | null>, retrieve: (path: string,
 *   options: {restartAt?: number}) => Promise<import('node:net').Socket>,
 *   close: () => void}>}
 */
export async function openFtpSession({
  host,
  port = 21,
  user = 'anonymous',
  password = '',
  timeout = 30_000,
}) {
  const socket = net.createConnection({ host, port });
  socket.setTimeout(timeout);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new FtpError(`délai dépassé : ${host}:${port}`, 'TIMEOUT')));
  });
  const readReply = createReplyReader(socket);

  /** Envoie une commande et rend sa réponse. */
  const command = async (line) => {
    socket.write(`${line}\r\n`);
    const reply = await readReply();
    return reply;
  };

  const session = {
    command,
    async login() {
      const greeting = await readReply();
      if (greeting.code !== 220) {
        throw new FtpError(`accueil FTP inattendu : ${greeting.code}`, 'BAD_GREETING', greeting);
      }
      const userReply = await command(`USER ${user}`);
      if (userReply.code === 331) {
        const passReply = await command(`PASS ${password}`);
        if (passReply.code >= 400) {
          throw new FtpError(`authentification refusée : ${passReply.code}`, 'LOGIN_FAILED', passReply);
        }
      } else if (userReply.code >= 400) {
        throw new FtpError(`utilisateur refusé : ${userReply.code}`, 'LOGIN_FAILED', userReply);
      }
      return undefined;
    },
    async pasv() {
      const reply = await command('PASV');
      if (reply.code !== 227) {
        // `EX-C-07` : sans PASV, pas de repli silencieux — on échoue explicitement.
        throw new FtpError(
          `le serveur refuse le mode passif (${reply.code}) : ${reply.message}`,
          'PASV_UNSUPPORTED',
          { reply: reply.code },
        );
      }
      return parsePasvReply(reply.lines?.[0] ?? reply.message);
    },
    async size(path) {
      const reply = await command(`SIZE ${path}`);
      if (reply.code !== 213) return null;
      const size = Number(reply.message);
      return Number.isFinite(size) ? size : null;
    },
    async retrieve(path, { restartAt = 0 } = {}) {
      const data = await session.pasv();
      if (restartAt > 0) {
        const rest = await command(`REST ${restartAt}`);
        if (rest.code >= 400) {
          throw new FtpError(`REST refusé : ${rest.code}`, 'REST_REFUSED', { restartAt });
        }
      }
      const dataSocket = net.createConnection({ host: data.host, port: data.port });
      await new Promise((resolve, reject) => {
        dataSocket.once('connect', resolve);
        dataSocket.once('error', reject);
      });
      const reply = await command(`RETR ${path}`);
      if (reply.code !== 150 && reply.code !== 125) {
        dataSocket.destroy();
        throw new FtpError(`RETR refusé : ${reply.code} ${reply.message}`, 'RETR_REFUSED', reply);
      }
      return dataSocket;
    },
    close() {
      socket.destroy();
    },
  };
  return session;
}

/**
 * Télécharge un fichier FTP dans un fichier local, avec reprise.
 *
 * @param {string} url
 * @param {string} target
 * @param {{resume?: boolean, timeout?: number,
 *   onEvent?: (event: object) => void}} [options]
 * @returns {Promise<{target: string, size: number | null, bytes: number, resumed: boolean,
 *   restartAt: number}>}
 */
export async function downloadFtp(url, target, { resume = true, timeout, onEvent = () => {} } = {}) {
  const parsed = parseFtpUrl(url);
  const session = await openFtpSession({ ...parsed, ...(timeout ? { timeout } : {}) });
  try {
    await session.login();
    // `CWD` puis `TYPE I` : des octets, jamais du texte retraité (annexe 15 §2.3).
    const directory = parsed.path.slice(0, parsed.path.lastIndexOf('/') + 1) || '/';
    const name = parsed.path.slice(directory.length);
    if (directory !== '/') await session.command(`CWD ${directory}`);
    await session.command('TYPE I');

    const size = await session.size(name);
    onEvent({ type: 'size', size });

    let restartAt = 0;
    if (resume) {
      const handle = await open(target, 'r').catch(() => null);
      if (handle) {
        const stats = await handle.stat();
        await handle.close();
        restartAt = stats.size;
      }
    }
    if (size !== null && restartAt > size) restartAt = 0; // fichier local plus gros : on repart

    const stream = await session.retrieve(name, { restartAt });
    const file = await open(target, restartAt > 0 ? 'r+' : 'w');
    let written = 0;
    try {
      for await (const chunk of stream) {
        await file.write(chunk, 0, chunk.length, restartAt + written);
        written += chunk.length;
      }
    } finally {
      await file.close();
      stream.destroy();
    }

    if (size !== null && restartAt + written !== size) {
      throw new FtpError(
        `transfert incomplet : ${restartAt + written} / ${size}`,
        'INCOMPLETE',
        { written: restartAt + written, size },
      );
    }
    return { target, size, bytes: written, resumed: restartAt > 0, restartAt };
  } finally {
    session.close();
  }
}
