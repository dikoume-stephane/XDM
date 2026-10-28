/**
 * Proxys — fiche C (`EX-C-09`, `EX-C-10`).
 *
 * Le binaire d'IDM déclare quatre familles (`UseHttpProxy`, `UseHttpsProxy`, `UseFtpProxy`,
 * `Socks5ProxyDNS`) et deux schémas d'authentification (`Proxy-Authorization: Basic %s`,
 * `Digest username=…`) — annexe 15 §2.5. Ce module couvre ce qui est **utilisable sans
 * négociation exotique** :
 *  - HTTP et HTTPS par tunnel `CONNECT` (le mode « https proxy » d'IDM) ;
 *  - SOCKS5, avec ou sans authentification par mot de passe (RFC 1929), et résolution DNS
 *    côté proxy (`Socks5ProxyDNS` d'IDM ⇒ on envoie un nom d'hôte, pas une IP) ;
 *  - `Proxy-Authorization: Basic`.
 * Le `Digest` est laissé de côté : il exige un aller-retour `407` et un nonce, donc un état
 * de négociation par proxy (`Q-C-06`).
 *
 * Le résultat est un **transport** de la même forme que ceux de `http-client.js`, ce qui
 * permet de le composer avec `withCookies` sans toucher au moteur.
 *
 * @module proxy
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

import { normalizeHeaders } from './http-client.js';

/** Délai par défaut d'un tunnel ou d'une poignée de main. */
export const PROXY_TIMEOUT_MS = 20_000;

/** Erreur de proxy, porteuse d'un code stable. */
export class ProxyError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Décompose une URL de proxy.
 *
 * Schémas acceptés : `http`, `https`, `socks4`, `socks5` (alias `socks5h` = résolution DNS
 * côté proxy, qui est notre comportement par défaut).
 *
 * @param {string} url
 * @returns {{type: 'http' | 'https' | 'socks4' | 'socks5', host: string, port: number,
 *   auth: {user: string, password: string} | null}}
 */
export function parseProxyUrl(url) {
  const target = new URL(url);
  const scheme = target.protocol.replace(':', '');
  const type = scheme === 'socks5h' ? 'socks5' : scheme;
  if (!['http', 'https', 'socks4', 'socks5'].includes(type)) {
    throw new ProxyError(`type de proxy non pris en charge : ${scheme}`, 'BAD_PROXY', { url });
  }
  const defaultPort = type === 'socks4' || type === 'socks5' ? 1080 : 8080;
  const port = target.port ? Number(target.port) : defaultPort;
  const user = decodeURIComponent(target.username || '');
  const password = decodeURIComponent(target.password || '');
  return {
    type: /** @type {any} */ (type),
    host: target.hostname,
    port,
    auth: user ? { user, password } : null,
  };
}

/**
 * En-tête `Proxy-Authorization: Basic`.
 * @param {{user: string, password: string}} auth
 * @returns {string}
 */
export function basicProxyAuth({ user, password }) {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Lit exactement `length` octets, ou échoue.
 * @param {import('node:net').Socket} socket
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
function readExactly(socket, length) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= length) {
        cleanup();
        // Le surplus éventuel est remis dans le socket via `unshift`.
        if (buffer.length > length) socket.unshift(buffer.subarray(length));
        resolve(buffer.subarray(0, length));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new ProxyError('connexion fermée pendant la négociation', 'PROXY_CLOSED'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.pause();
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.resume();
  });
}

/**
 * Négociation SOCKS5 (RFC 1928) puis connexion à la cible.
 *
 * @param {import('node:net').Socket} socket
 * @param {{host: string, port: number}} target
 * @param {{auth?: {user: string, password: string} | null}} [options]
 * @returns {Promise<void>}
 */
export async function socks5Handshake(socket, target, { auth = null } = {}) {
  socket.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const [version, method] = await readExactly(socket, 2);
  if (version !== 5) throw new ProxyError(`SOCKS inattendu : version ${version}`, 'BAD_SOCKS');
  if (method === 0xff) throw new ProxyError('aucune méthode SOCKS acceptée', 'SOCKS_NO_METHOD');
  if (method === 2) {
    if (!auth) throw new ProxyError('le proxy exige un mot de passe', 'SOCKS_AUTH_REQUIRED');
    const user = Buffer.from(auth.user, 'utf8');
    const password = Buffer.from(auth.password, 'utf8');
    socket.write(Buffer.concat([
      Buffer.from([1, user.length]), user, Buffer.from([password.length]), password,
    ]));
    const [, status] = await readExactly(socket, 2);
    if (status !== 0) throw new ProxyError('authentification SOCKS refusée', 'SOCKS_AUTH_FAILED');
  } else if (method !== 0) {
    throw new ProxyError(`méthode SOCKS non gérée : ${method}`, 'SOCKS_METHOD');
  }

  const host = Buffer.from(target.host, 'utf8');
  // ATYP=3 (nom de domaine) : la résolution est faite par le proxy (`Socks5ProxyDNS`).
  socket.write(Buffer.concat([
    Buffer.from([5, 1, 0, 3, host.length]), host,
    Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
  ]));
  const head = await readExactly(socket, 4);
  if (head[0] !== 5) throw new ProxyError(`réponse SOCKS invalide : ${head[0]}`, 'BAD_SOCKS');
  if (head[1] !== 0) {
    throw new ProxyError(`connexion SOCKS refusée (code ${head[1]})`, 'SOCKS_REFUSED', { code: head[1] });
  }
  const addressType = head[3];
  if (addressType === 1) await readExactly(socket, 4);
  else if (addressType === 4) await readExactly(socket, 16);
  else if (addressType === 3) {
    const [length] = await readExactly(socket, 1);
    await readExactly(socket, length);
  } else throw new ProxyError(`type d'adresse SOCKS inconnu : ${addressType}`, 'BAD_SOCKS');
  await readExactly(socket, 2);
}

/**
 * Ouvre un tunnel `CONNECT` à travers un proxy HTTP/HTTPS.
 *
 * @param {{host: string, port: number, auth?: {user: string, password: string} | null,
 *   secure?: boolean}} proxy
 * @param {{host: string, port: number}} target
 * @param {{timeout?: number}} [options]
 * @returns {Promise<import('node:net').Socket>}
 */
export function httpConnectTunnel(proxy, target, { timeout = PROXY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const authority = `${target.host}:${target.port}`;
    const headers = {};
    if (proxy.auth) headers['Proxy-Authorization'] = basicProxyAuth(proxy.auth);
    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
      timeout,
    });
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new ProxyError(
          `tunnel refusé par le proxy : ${response.statusCode}`,
          'CONNECT_REFUSED',
          { status: response.statusCode, authority },
        ));
        return;
      }
      socket.setTimeout(0);
      resolve(socket);
    });
    request.once('timeout', () => {
      request.destroy();
      reject(new ProxyError('délai dépassé vers le proxy', 'PROXY_TIMEOUT'));
    });
    request.once('error', (error) => reject(new ProxyError(
      `proxy injoignable : ${error.message}`, 'PROXY_UNREACHABLE', { cause: error },
    )));
    request.end();
  });
}

/**
 * Ouvre une connexion vers la cible, à travers le proxy décrit.
 *
 * @param {ReturnType<typeof parseProxyUrl>} proxy
 * @param {{host: string, port: number}} target
 * @param {{timeout?: number}} [options]
 * @returns {Promise<import('node:net').Socket>}
 */
export async function openThroughProxy(proxy, target, { timeout = PROXY_TIMEOUT_MS } = {}) {
  if (proxy.type === 'http' || proxy.type === 'https') {
    return httpConnectTunnel(proxy, target, { timeout });
  }
  if (proxy.type !== 'socks5') {
    // SOCKS4 n'est pas implémenté : mieux vaut un refus net qu'un protocole approximatif.
    throw new ProxyError(`proxy ${proxy.type} non implémenté`, 'PROXY_UNSUPPORTED', { type: proxy.type });
  }
  const socket = net.createConnection({ host: proxy.host, port: proxy.port });
  socket.setTimeout(timeout);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', (error) => reject(new ProxyError(
      `proxy injoignable : ${error.message}`, 'PROXY_UNREACHABLE', { cause: error },
    )));
    socket.once('timeout', () => reject(new ProxyError('délai dépassé vers le proxy', 'PROXY_TIMEOUT')));
  });
  socket.setTimeout(0);
  try {
    await socks5Handshake(socket, target, { auth: proxy.auth ?? null });
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * Fabrique un transport HTTP passant par un proxy.
 *
 * La forme est celle de `http-client.js` : `(url, {method, headers}) => {status, headers,
 * stream}`. On peut donc l'injecter dans `probe`, `openSegment`, `fetchText` ou
 * l'envelopper avec `withCookies`.
 *
 * @param {string | ReturnType<typeof parseProxyUrl>} proxyUrl
 * @param {{timeout?: number}} [options]
 * @returns {(url: string, options?: {method?: string, headers?: Record<string, string>})
 *   => Promise<{status: number, headers: Record<string, string>,
 *   stream: import('node:stream').Readable}>}
 */
export function createProxyTransport(proxyUrl, { timeout = PROXY_TIMEOUT_MS } = {}) {
  const proxy = typeof proxyUrl === 'string' ? parseProxyUrl(proxyUrl) : proxyUrl;

  return async function proxyTransport(url, { method = 'GET', headers = {} } = {}) {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const port = target.port ? Number(target.port) : (secure ? 443 : 80);
    const tunnel = await openThroughProxy(
      proxy,
      { host: target.hostname, port },
      { timeout },
    );
    // HTTPS au-dessus du tunnel : TLS est établi **de bout en bout**, le proxy ne voit
    // que des octets chiffrés (`useHttpsProxy` d'IDM).
    const connection = secure
      ? tls.connect({ socket: tunnel, servername: target.hostname })
      : tunnel;

    return new Promise((resolve, reject) => {
      const request = (secure ? https : http).request({
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent: false,
        createConnection: () => connection,
      }, (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: normalizeHeaders(/** @type {any} */ (response.headers)),
          stream: response,
        });
      });
      request.once('error', (error) => {
        connection.destroy();
        reject(new ProxyError(
          `requête via proxy échouée : ${error.message}`,
          'PROXY_REQUEST_FAILED',
          { cause: error },
        ));
      });
      request.end();
    });
  };
}
