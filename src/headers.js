/**
 * En-têtes de requête — fiche C (`EX-C-02`).
 *
 * Le binaire d'IDM envoie `User-Agent: %s`, `Accept: %s`, `Referer: %s`, un `Cookie`
 * (`Set-Cookie` lu en retour) et `Accept-Encoding` (voir `Q-C-01`). Ce module construit
 * cet ensemble **une seule fois** pour que tous les transports l'utilisent, au lieu de le
 * recomposer à chaque appel.
 *
 * Deux règles de composition, et elles comptent :
 *  - les en-têtes de l'appelant **gagnent** sur les valeurs par défaut (un appelant qui
 *    impose une langue ou un `Referer` précis n'est pas écrasé) ;
 *  - les en-têtes sont sensibles à la casse d'usage : on écrit `User-Agent`, pas
 *    `user-agent`, parce que certains serveurs (et tous les journaux) s'y fient.
 *
 * @module headers
 */

/**
 * Agent XDM. Il **s'annonce pour ce qu'il est** : usurper IDM serait une contrefaçon
 * d'identité, et la cible est justement ce qu'on ne copie pas (`D-004`).
 */
export const DEFAULT_USER_AGENT = 'XDM/1.0 (+grabber)';

/** Ce qu'IDM accepte par défaut pour une page (types déclarés dans le binaire). */
export const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** Encodages acceptés quand la réponse n'est pas téléchargée par morceaux (`Q-C-01`). */
export const PAGE_ENCODINGS = 'gzip, deflate';

/** Encodage imposé aux requêtes de morceaux (`EX-A-16`, `Range` non aligné sinon). */
export const CHUNK_ENCODINGS = 'identity';

/**
 * Compose les en-têtes d'une requête.
 *
 * @param {{userAgent?: string, accept?: string, referer?: string | null,
 *   cookie?: string | null, encoding?: string, overrides?: Record<string, string>}}
 *   [options]
 * @returns {Record<string, string>}
 */
export function buildHeaders({
  userAgent = DEFAULT_USER_AGENT,
  accept = DEFAULT_ACCEPT,
  referer = null,
  cookie = null,
  encoding = PAGE_ENCODINGS,
  overrides = {},
} = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    'User-Agent': userAgent,
    Accept: accept,
    'Accept-Encoding': encoding,
    Connection: 'keep-alive',
  };
  if (referer) headers.Referer = referer;
  if (cookie) headers.Cookie = cookie;
  return { ...headers, ...lowercaseKeys(overrides) };
}

/**
 * Met les clés en minuscules, sans perdre les valeurs.
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
export function lowercaseKeys(headers = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * En-têtes pour un téléchargement par morceaux : `identity` et rien d'autre.
 * @param {{cookie?: string | null, overrides?: Record<string, string>}} [options]
 * @returns {Record<string, string>}
 */
export function buildChunkHeaders({ cookie = null, overrides = {} } = {}) {
  return buildHeaders({ encoding: CHUNK_ENCODINGS, cookie, overrides });
}

/**
 * En-têtes pour une page, une playlist ou une API : compression acceptée.
 * @param {{referer?: string | null, cookie?: string | null,
 *   overrides?: Record<string, string>}} [options]
 * @returns {Record<string, string>}
 */
export function buildPageHeaders({ referer = null, cookie = null, overrides = {} } = {}) {
  return buildHeaders({ encoding: PAGE_ENCODINGS, referer, cookie, overrides });
}
