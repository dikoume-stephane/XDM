/**
 * Cookies de session pour les transports — fiche C (`EX-C-04`).
 *
 * Le binaire d'IDM montre `Set-Cookie:` (annexe 15 §2.1) sans dire la portée retenue
 * (`Q-C-02`). XDM applique donc les règles du **RFC 6265**, explicitement, et rien de plus :
 * domaine, chemin, expiration, `Secure`. Pas de `SameSite` (sans navigateur), pas de
 * `HttpOnly` côté client (nous *sommes* le client : la valeur est légitimement lisible).
 *
 * Le magasin est **en mémoire** : une aspiration est une session. La persistance des
 * cookies relèverait d'un secret à protéger (`D-004` : rien de sensible n'est stocké).
 *
 * @module cookies
 */

/** Durée d'un cookie sans `Max-Age` ni `Expires` : le temps de la session. */
export const SESSION_COOKIE = -1;

/**
 * Découpe un en-tête `Set-Cookie`.
 *
 * @param {string} header
 * @returns {{name: string, value: string, domain: string | null, path: string | null,
 *   maxAge: number | null, expires: number | null, secure: boolean,
 *   httpOnly: boolean, hostOnly: boolean} | null}
 */
export function parseSetCookie(header) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const [pair, ...attributes] = header.split(';');
  const equals = pair.indexOf('=');
  if (equals <= 0) return null;
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  if (!name) return null;

  /** @type {any} */
  const cookie = {
    name,
    value,
    domain: null,
    path: null,
    maxAge: null,
    expires: null,
    secure: false,
    httpOnly: false,
    hostOnly: true,
  };

  for (const attribute of attributes) {
    const separator = attribute.indexOf('=');
    const key = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const raw = separator < 0 ? '' : attribute.slice(separator + 1).trim();
    if (key === 'domain' && raw) {
      cookie.domain = raw.replace(/^\./, '').toLowerCase();
      cookie.hostOnly = false;
    }
    else if (key === 'path' && raw.startsWith('/')) cookie.path = raw;
    else if (key === 'max-age') {
      // Secondes relatives : c'est le magasin qui les convertit, avec *son* horloge.
      const seconds = Number(raw);
      if (Number.isFinite(seconds)) cookie.maxAge = Math.trunc(seconds);
    } else if (key === 'expires') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) cookie.expires = parsed;
    } else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
  }
  return cookie;
}

/**
 * Chemin par défaut d'un cookie : le dossier de l'URL demandée (RFC 6265 §5.1.4).
 * @param {string} pathname
 * @returns {string}
 */
export function defaultPath(pathname) {
  if (!pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');
  return last <= 0 ? '/' : pathname.slice(0, last);
}

/**
 * Le domaine du cookie couvre-t-il l'hôte demandé ?
 * @param {string} host
 * @param {string} domain
 * @returns {boolean}
 */
export function domainMatches(host, domain) {
  if (host === domain) return true;
  return host.endsWith(`.${domain}`);
}

/**
 * Le chemin du cookie couvre-t-il le chemin demandé ? (RFC 6265 §5.1.4)
 * @param {string} requestPath
 * @param {string} cookiePath
 * @returns {boolean}
 */
export function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/**
 * Magasin de cookies en mémoire.
 *
 * @param {{now?: () => number}} [options] horloge injectable, pour tester l'expiration
 * @returns {{store: (url: string, headers: Record<string, string>) => object[],
 *   cookieHeader: (url: string) => string | null, apply: (url: string,
 *   headers?: Record<string, string>) => Record<string, string>, size: () => number,
 *   all: () => object[], clear: () => void}}
 */
export function createCookieJar({ now = Date.now } = {}) {
  /** @type {Map<string, any>} clé : domaine|chemin|nom */
  const cookies = new Map();
  const keyOf = (cookie) => `${cookie.domain}|${cookie.path}|${cookie.name}`;

  const purge = () => {
    const stamp = now();
    for (const [key, cookie] of cookies) {
      if (cookie.expires !== null && cookie.expires <= stamp) cookies.delete(key);
    }
  };

  const store = (url, headers) => {
    const target = new URL(url);
    const host = target.hostname.toLowerCase();
    const raw = headers['set-cookie'] ?? headers['Set-Cookie'];
    if (!raw) return [];
    const lines = Array.isArray(raw) ? raw : String(raw).split(/,(?=[^;]+=)/);
    /** @type {object[]} */
    const stored = [];
    for (const line of lines) {
      const cookie = parseSetCookie(line);
      if (!cookie) continue;
      const domain = cookie.domain ?? host;
      // Un `Domain` qui ne couvre pas l'hôte émetteur est refusé (RFC 6265 §5.3.6).
      if (cookie.domain && !domainMatches(host, cookie.domain)) continue;
      const expiry = cookie.maxAge !== null
        ? now() + cookie.maxAge * 1000
        : cookie.expires;
      const record = {
        ...cookie,
        domain,
        path: cookie.path ?? defaultPath(target.pathname),
        expires: expiry,
        created: now(),
      };
      if (expiry !== null && expiry <= now()) {
        cookies.delete(keyOf(record));
        continue;
      }
      cookies.set(keyOf(record), record);
      stored.push(record);
    }
    return stored;
  };

  const matching = (url) => {
    purge();
    const target = new URL(url);
    const host = target.hostname.toLowerCase();
    const path = target.pathname || '/';
    /** @type {any[]} */
    const found = [];
    for (const cookie of cookies.values()) {
      // Cookie d'hôte (sans attribut `Domain`) : jamais envoyé à un sous-domaine.
      if (cookie.hostOnly ? host !== cookie.domain : !domainMatches(host, cookie.domain)) continue;
      if (!pathMatches(path, cookie.path)) continue;
      if (cookie.secure && target.protocol !== 'https:') continue;
      found.push(cookie);
    }
    // Les chemins les plus spécifiques d'abord, puis la date de création.
    found.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    return found;
  };

  const cookieHeader = (url) => {
    const found = matching(url);
    if (found.length === 0) return null;
    return found.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  };

  return {
    store,
    cookieHeader,
    apply(url, headers = {}) {
      const header = cookieHeader(url);
      if (!header) return { ...headers };
      return { ...headers, cookie: headers.cookie ? `${headers.cookie}; ${header}` : header };
    },
    size: () => {
      purge();
      return cookies.size;
    },
    all: () => [...cookies.values()],
    clear: () => cookies.clear(),
  };
}

/**
 * Enveloppe un transport pour qu'il porte les cookies de la session.
 *
 * La réponse est observée **avant** d'être rendue : `Set-Cookie` est enregistré, puis les
 * en-têtes sont rendus tels quels (l'appelant ne doit pas voir de cookie dans ses en-têtes).
 *
 * @param {(url: string, options?: object) => Promise<{status: number,
 *   headers: Record<string, string>, stream: unknown}>} transport
 * @param {ReturnType<typeof createCookieJar>} jar
 * @returns {typeof transport}
 */
export function withCookies(transport, jar) {
  return async (url, options = {}) => {
    const request = { ...options, headers: jar.apply(url, options.headers ?? {}) };
    const response = await transport(url, request);
    if (response && response.headers) jar.store(url, response.headers);
    return response;
  };
}
