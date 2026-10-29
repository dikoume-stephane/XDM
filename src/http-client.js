/**
 * Client HTTP du moteur — lot `WP-21`.
 *
 * Couvre les exigences `EX-A-08` (plages, repli à une connexion), `EX-A-15`
 * (redirections bornées), `EX-A-16` (`Accept-Encoding: identity`),
 * `EX-A-17` (aucun réseau hors de la demande) et `EX-A-18` (inactivité 30 s).
 *
 * Aucune dépendance : `node:http`, `node:https`, `URL` (stdlib).
 * Le transport est injectable, ce qui rend tout le protocole testable hors réseau.
 *
 * @module http-client
 */

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

import { DEFAULT_ACCEPT, DEFAULT_USER_AGENT, PAGE_ENCODINGS, lowercaseKeys } from './headers.js';
import { isRetryableStatus, parseRetryAfter } from './retry.js';

/** Limite de redirections suivies (`0x27ff` compare sur la taille d'URL, `EX-A-15`). */
export const MAX_REDIRECTS = 10;

/** Longueur maximale d'une URL, en octets (`cmp ecx, 0x27ff` — 10 239). */
export const MAX_URL_LENGTH = 10239;

/** Inactivité tolérée sur une connexion avant redémarrage (`cmp eax, 0x1e`, `EX-A-18`). */
export const IDLE_TIMEOUT_MS = 30_000;

/**
 * En-têtes de base d'une requête de morceaux : compression refusée (un `Range` sur un corps
 * compressé ne serait pas aligné, `EX-A-16`), agent annoncé (`EX-C-02`).
 */
export const BASE_HEADERS = Object.freeze({
  'accept-encoding': 'identity',
  'user-agent': 'XDM/1.0 (+grabber)',
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Erreur de protocole, porteuse d'un code stable pour les tests.
 */
export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.details = details;
  }
}

/**
 * En-têtes en minuscules, valeurs aplaties.
 * @param {Record<string, string | string[] | undefined>} raw
 * @returns {Record<string, string>}
 */
export function normalizeHeaders(raw = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * `Range: bytes=<début>-<fin incluse>` (`EX-A-08`).
 * @param {number} start
 * @param {number} endInclusive
 * @returns {string}
 */
export function rangeHeader(start, endInclusive) {
  if (!Number.isInteger(start) || start < 0) {
    throw new HttpError(`début de plage invalide : ${start}`, 'BAD_RANGE');
  }
  if (!Number.isInteger(endInclusive) || endInclusive < start) {
    throw new HttpError(`fin de plage invalide : ${endInclusive}`, 'BAD_RANGE');
  }
  return `bytes=${start}-${endInclusive}`;
}

/**
 * Plage d'un morceau `{start, size}` en en-tête `Range`.
 * @param {{start: number, size: number}} chunk
 * @returns {string}
 */
export function chunkRangeHeader(chunk) {
  return rangeHeader(chunk.start, chunk.start + chunk.size - 1);
}

/**
 * Plage de reprise : tout ce qui reste à partir du dernier octet confirmé.
 * @param {number} nextOffset
 * @returns {string}
 */
export function resumeRangeHeader(nextOffset) {
  if (!Number.isInteger(nextOffset) || nextOffset < 0) {
    throw new HttpError(`offset de reprise invalide : ${nextOffset}`, 'BAD_RANGE');
  }
  return `bytes=${nextOffset}-`;
}

/**
 * Décode un `Content-Range: bytes 0-1023/4096`.
 * @param {string | undefined} value
 * @returns {{start: number, end: number, total: number | null} | null}
 */
export function parseContentRange(value) {
  if (typeof value !== 'string') return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end < start) return null;
  const total = m[3] === '*' ? null : Number(m[3]);
  if (total !== null && end >= total) return null;
  return { start, end, total };
}

/**
 * @param {number} status
 * @returns {boolean}
 */
export function isRedirect(status) {
  return REDIRECT_STATUSES.has(status);
}

/**
 * Résolution d'une `Location` relative (RFC 3986) en URL absolue.
 * @param {string} base
 * @param {string} location
 * @returns {string}
 */
export function resolveLocation(base, location) {
  if (typeof location !== 'string' || location.trim() === '') {
    throw new HttpError('en-tête Location vide', 'BAD_LOCATION', { base });
  }
  let resolved;
  try {
    resolved = new URL(location, base).href;
  } catch {
    throw new HttpError(`Location illisible : ${location}`, 'BAD_LOCATION', { base, location });
  }
  const protocol = new URL(resolved).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new HttpError(`schéma non supporté : ${protocol}`, 'BAD_SCHEME', { resolved });
  }
  return resolved;
}

/**
 * Vérifie la longueur d'une URL (octets, pas caractères).
 * @param {string} url
 * @returns {string}
 */
export function assertUrlLength(url) {
  const bytes = Buffer.byteLength(String(url), 'utf8');
  if (bytes > MAX_URL_LENGTH) {
    throw new HttpError(
      `URL de ${bytes} octets > ${MAX_URL_LENGTH}`,
      'URL_TOO_LONG',
      { url, bytes },
    );
  }
  return url;
}

/**
 * Le serveur accepte-t-il les plages ? `206` + `Content-Range`, ou `Accept-Ranges: bytes`
 * avec une taille connue (`EX-A-08`).
 * @param {number} status
 * @param {Record<string, string>} headers
 * @returns {boolean}
 */
export function acceptsRanges(status, headers) {
  if (status === 206) return parseContentRange(headers['content-range']) !== null;
  if (status !== 200) return false;
  const accept = (headers['accept-ranges'] || '').toLowerCase();
  const size = Number(headers['content-length']);
  return accept === 'bytes' && Number.isFinite(size) && size > 0;
}

/**
 * Taille annoncée : `Content-Range` d'abord, `Content-Length` ensuite.
 * @param {Record<string, string>} headers
 * @returns {number | null}
 */
export function announcedSize(headers) {
  const range = parseContentRange(headers['content-range']);
  if (range && range.total !== null) return range.total;
  const length = Number(headers['content-length']);
  if (Number.isFinite(length) && length > 0) return length;
  return null;
}

/**
 * Nombre de connexions à ouvrir. Sans plage : **une seule** (`EX-A-08`).
 * @param {{acceptRanges: boolean, size: number | null}} capabilities
 * @param {{maxConnections?: number, chunkCount?: number}} [options]
 * @returns {number}
 */
export function planConnections(capabilities, { maxConnections = 8, chunkCount = Infinity } = {}) {
  if (!capabilities || capabilities.acceptRanges !== true) return 1;
  if (capabilities.size === null || !Number.isFinite(capabilities.size) || capabilities.size <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(maxConnections, chunkCount));
}

/**
 * Transport par défaut. Signature : `(url, {method, headers}) => Promise<{status, headers, stream}>`.
 * @param {string} url
 * @param {{method?: string, headers?: Record<string, string>}} [options]
 * @returns {Promise<{status: number, headers: Record<string, string>, stream: import('node:stream').Readable}>}
 */
export function defaultTransport(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const request = lib.request(target, { method, headers }, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: normalizeHeaders(response.headers),
        stream: response,
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * Ferme proprement un corps dont on ne veut pas.
 * @param {{destroy?: () => void, resume?: () => void}} stream
 */
function drain(stream) {
  if (stream && typeof stream.destroy === 'function') stream.destroy();
  else if (stream && typeof stream.resume === 'function') stream.resume();
}

/**
 * Sonde une URL en suivant les redirections.
 *
 * N'ouvre **qu'une** connexion à la fois, et une seule au total (`EX-A-17`).
 *
 * @param {string} url
 * @param {{transport?: typeof defaultTransport, headers?: Record<string, string>, maxRedirects?: number}} [options]
 * @returns {Promise<{url: string, finalUrl: string, redirects: number, status: number,
 *   acceptRanges: boolean, size: number | null, etag: string | null,
 *   lastModified: string | null, contentType: string | null,
 *   contentDisposition?: string | null}>}
 */
export async function probe(url, {
  transport = defaultTransport,
  headers = {},
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  let current = assertUrlLength(url);
  let redirects = 0;
  for (;;) {
    const response = await transport(current, {
      method: 'GET',
      // Sonder avec une plage d'un octet : `206` prouve le support, `200` le nie.
      headers: { ...BASE_HEADERS, range: 'bytes=0-0', ...headers },
    });
    const responseHeaders = normalizeHeaders(response.headers);
    drain(response.stream);

    if (isRedirect(response.status)) {
      if (redirects >= maxRedirects) {
        throw new HttpError(
          `${redirects + 1}ᵉ redirection refusée (limite ${maxRedirects})`,
          'TOO_MANY_REDIRECTS',
          { url: current, redirects },
        );
      }
      current = assertUrlLength(resolveLocation(current, responseHeaders.location));
      redirects += 1;
      continue;
    }

    // `304` en réponse à `If-Modified-Since` (`D-070`) : la ressource n'a pas changé. Ce
    // n'est ni une erreur ni une taille inconnue — c'est la réponse attendue d'une
    // vérification conditionnelle, et l'appelant doit pouvoir s'arrêter là sans écrire.
    if (response.status === 304) {
      return {
        url,
        finalUrl: current,
        status: 304,
        notModified: true,
        size: null,
        acceptRanges: null,
        etag: responseHeaders.etag ?? null,
        lastModified: responseHeaders['last-modified'] ?? null,
        contentType: responseHeaders['content-type'] ?? null,
        contentDisposition: responseHeaders['content-disposition'] ?? null,
      };
    }

    // Un statut autre que `200`/`206` n'est pas une réponse exploitable : le dire ici, avec
    // son statut et l'attente demandée, évite qu'un `429` ressorte plus tard comme une
    // « taille inconnue » — un message faux qui enverrait chercher le bug au mauvais endroit.
    if (response.status !== 200 && response.status !== 206) {
      throw new HttpError(
        `statut ${response.status} pour ${current}`,
        'HTTP_STATUS',
        {
          url: current,
          status: response.status,
          retryable: isRetryableStatus(response.status),
          retryAfterMs: parseRetryAfter(responseHeaders['retry-after']),
        },
      );
    }

    const acceptRanges = acceptsRanges(response.status, responseHeaders);
    return {
      url,
      finalUrl: current,
      redirects,
      status: response.status,
      acceptRanges,
      size: announcedSize(responseHeaders),
      etag: responseHeaders.etag ?? null,
      lastModified: responseHeaders['last-modified'] ?? null,
      contentType: responseHeaders['content-type'] ?? null,
      // Nom que le serveur donne au fichier (`Content-Disposition`, RFC 6266) : une URL
      // `…/download?id=3` ne dit rien, l'en-tête si (`D-072`).
      contentDisposition: responseHeaders['content-disposition'] ?? null,
    };
  }
}

/**
 * Ouvre un segment : `Range` + `If-Range` éventuel, compression refusée.
 *
 * @param {string} url
 * @param {{start: number, size: number}} chunk
 * @param {{transport?: typeof defaultTransport, ifRange?: string | null,
 *   headers?: Record<string, string>}} [options]
 * @returns une réponse dont le corps reste lisible : `ranged: false` signale que
 *   le serveur a ignoré la plage et que le flux repart de l'octet 0.
 * @returns {Promise<{status: number, headers: Record<string, string>, stream: import('node:stream').Readable,
 *   ranged: boolean, range: string}>}
 */
export async function openSegment(url, chunk, {
  transport = defaultTransport,
  ifRange = null,
  headers = {},
} = {}) {
  const range = chunkRangeHeader(chunk);
  const sent = { ...BASE_HEADERS, ...headers, range };
  if (ifRange) sent['if-range'] = ifRange;
  const response = await transport(assertUrlLength(url), { method: 'GET', headers: sent });
  const responseHeaders = normalizeHeaders(response.headers);
  const ranged = response.status === 206 && parseContentRange(responseHeaders['content-range']) !== null;
  // Le corps n'est **pas** drainé ici : un `200` en réponse à une plage est le
  // repli « fichier entier » (EX-A-08), et c'est l'appelant qui décide de le lire
  // ou de le fermer.
  return {
    status: response.status,
    headers: responseHeaders,
    stream: response.stream,
    ranged,
    range,
  };
}

/**
 * Lit un corps en tolérant une inactivité bornée (`EX-A-18`).
 *
 * En cas de silence prolongé, lève `IDLE_TIMEOUT` avec `resumeAt` : l'appelant
 * rouvre une `Range` à cet offset, sans perdre ce qui est déjà écrit.
 *
 * @param {AsyncIterable<Uint8Array>} stream
 * @param {{idleMs?: number, onChunk?: (chunk: Uint8Array, offset: number) => void}} [options]
 * @returns {Promise<{received: number, resumeAt: number}>}
 */
export async function readWithIdleTimeout(stream, {
  idleMs = IDLE_TIMEOUT_MS,
  onChunk = () => {},
  startOffset = 0,
} = {}) {
  const iterator = stream[Symbol.asyncIterator]();
  let received = 0;
  for (;;) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new HttpError(
          `inactivité > ${idleMs} ms`,
          'IDLE_TIMEOUT',
          { idleMs, received, resumeAt: startOffset + received },
        ));
      }, idleMs);
    });
    // Le minuteur perd la course dès qu'un octet arrive : on ne le laisse pas fuir.
    timeout.catch(() => {});

    /** @type {IteratorResult<Uint8Array>} */
    let result;
    try {
      result = await Promise.race([iterator.next(), timeout]);
    } catch (error) {
      if (error instanceof HttpError) {
        if (typeof iterator.return === 'function') {
          await iterator.return(undefined).catch(() => {});
        }
        throw new HttpError(error.message, error.code, {
          ...error.details,
          resumeAt: startOffset + received,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (result.done) break;
    const chunk = /** @type {Uint8Array} */ (result.value);
    onChunk(chunk, startOffset + received);
    received += chunk.byteLength;
  }
  return { received, resumeAt: startOffset + received };
}

/**
 * Décompresse un corps annoncé `gzip`, `deflate` ou `br` (`Q-C-01`).
 *
 * Un corps dont l'en-tête ment (compressé annoncé, octets bruts) n'est **pas** deviné :
 * on tente la décompression et, en cas d'échec, on rend les octets tels quels. Mieux vaut
 * un texte bizarre qu'une exception sur un serveur mal configuré.
 *
 * @param {Buffer} body
 * @param {string | undefined} encoding
 * @returns {Buffer}
 */
export function decodeBody(body, encoding) {
  const kind = String(encoding ?? '').toLowerCase().trim();
  try {
    if (kind === 'gzip' || kind === 'x-gzip') return zlib.gunzipSync(body);
    if (kind === 'deflate') return zlib.inflateSync(body);
    if (kind === 'br') return zlib.brotliDecompressSync(body);
  } catch {
    return body;
  }
  return body;
}

/**
 * Récupère une ressource textuelle (page HTML, `robots.txt`) en suivant les redirections.
 *
 * Même politique que la sonde : `Accept-Encoding: identity`, 10 sauts, URL bornée. Le
 * corps est plafonné (`maxBytes`) : une page d'un gigaoctet n'est pas une page.
 *
 * @param {string} url
 * @param {{transport?: typeof defaultTransport, headers?: Record<string, string>,
 *   maxBytes?: number, maxRedirects?: number, compression?: boolean,
 *   referer?: string | null}} [options]
 * @returns {Promise<{url: string, finalUrl: string, status: number,
 *   headers: Record<string, string>, body: string, truncated: boolean, redirects: number}>}
 */
export async function fetchText(url, {
  transport = defaultTransport,
  headers = {},
  maxBytes = 4 * 1024 * 1024,
  maxRedirects = MAX_REDIRECTS,
  compression = true,
  referer = null,
} = {}) {
  let current = assertUrlLength(url);
  let redirects = 0;
  // `Q-C-01` : une page, une playlist ou une API accepte la compression (`gzip, deflate`) ;
  // seules les requêtes de **morceaux** imposent `identity` (`EX-A-16`), parce qu'un `Range`
  // sur un corps compressé ne serait pas aligné sur les octets du fichier.
  const base = {
    ...BASE_HEADERS,
    'accept-encoding': compression ? PAGE_ENCODINGS : BASE_HEADERS['accept-encoding'],
    // `EX-C-02` : une requête de page s'annonce (agent, types acceptés).
    'user-agent': DEFAULT_USER_AGENT,
    accept: DEFAULT_ACCEPT,
    connection: 'keep-alive',
  };
  for (;;) {
    const response = await transport(current, {
      method: 'GET',
      headers: {
        ...base,
        ...(referer ? { referer } : {}),
        ...lowercaseKeys(headers),
      },
    });
    const responseHeaders = normalizeHeaders(response.headers);

    if (isRedirect(response.status)) {
      if (typeof response.stream?.destroy === 'function') response.stream.destroy();
      if (redirects >= maxRedirects) {
        throw new HttpError(
          `${redirects + 1}ᵉ redirection refusée (limite ${maxRedirects})`,
          'TOO_MANY_REDIRECTS',
          { url: current },
        );
      }
      current = assertUrlLength(resolveLocation(current, responseHeaders.location));
      redirects += 1;
      continue;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    for await (const chunk of response.stream) {
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      chunks.push(buffer);
      total += buffer.byteLength;
      if (total >= maxBytes) break;
    }
    const raw = Buffer.concat(chunks).subarray(0, maxBytes);
    const decoded = decodeBody(raw, responseHeaders['content-encoding']);
    return {
      url,
      finalUrl: current,
      status: response.status,
      headers: responseHeaders,
      body: decoded.toString('utf8'),
      encoding: responseHeaders['content-encoding'] ?? null,
      truncated: total > maxBytes,
      redirects,
    };
  }
}
