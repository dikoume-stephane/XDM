/**
 * Aspiration de site — parcours et classement des liens (domaine B, lot `WP-11`).
 *
 * Statut des règles : **Décision XDM** (`D-041`), et non restitution d'IDM. Le moteur
 * d'exploration d'`IDMan.exe` n'est pas localisable dans le module (0 référence code aux
 * conteneurs `IDMSPIDER_STRUCT_SPL`/`RL`/`LI2`, annexe 12 §6) : XDM définit donc son
 * parcours et le documente.
 *
 * Règles retenues :
 *  - **BFS par niveau** : une file FIFO, la profondeur `depth` compte les niveaux *visités*
 *    (`depth = 1` ⇒ seule la page de départ) ;
 *  - `depth` par défaut = **2** ;
 *  - **dédoublonnage** par URL normalisée (fragment retiré, hôte en minuscules, barre finale
 *    retirée hors racine) ;
 *  - **même origine** par défaut : un lien vers un autre hôte est *signalé*, pas suivi ;
 *  - **`robots.txt`** respecté : règle la plus longue, `Disallow` l'emporte à égalité ;
 *  - filtres d'inclusion/exclusion réutilisés de `project.js` (masques glob) ;
 *  - une seule connexion à la fois : le parcours ne parallélise pas (`EX-B-13`), les
 *    téléchargements qu'il produit, eux, sont multi-connexions (`WP-22`).
 *
 * Aucune dépendance : `URL` (stdlib) et `project.js`.
 *
 * @module crawler
 */

import { matchesMotif } from './project.js';

/** Profondeur par défaut, en niveaux visités. */
export const DEFAULT_DEPTH = 2;

/** Plafond de pages visitées pour une aspiration. */
export const DEFAULT_MAX_PAGES = 2000;

/** Agent annoncé aux serveurs. */
export const USER_AGENT = 'XDM/0.1 (+aspirateur de site)';

const SKIPPED_SCHEMES = /^(mailto|javascript|data|tel|ftp|file):/i;

/** Extensions considérées comme des pages (le reste est un fichier à télécharger). */
export const PAGE_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'jsp', 'cgi', '',
]);

/**
 * Normalise une URL pour le dédoublonnage (`EX-B-09`).
 * @param {string} raw
 * @param {string} [base]
 * @returns {string | null} `null` si l'URL n'est pas exploitable
 */
export function canonicalUrl(raw, base) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || value.startsWith('#') || SKIPPED_SCHEMES.test(value)) return null;
  let url;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  let href = url.href;
  if (url.pathname !== '/' && href.endsWith('/')) href = href.slice(0, -1);
  return href;
}

/**
 * Même origine (schéma + hôte + port), condition par défaut de l'aspiration.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameOrigin(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin;
  } catch {
    return false;
  }
}

/**
 * Une URL désigne-t-elle une page à explorer (et non un fichier à télécharger) ?
 *
 * Sans cette distinction, l'aspirateur « visiterait » chaque `.zip` comme s'il contenait
 * des liens : une requête gaspillée par fichier, et un compteur de pages faux.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isPageUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  if (pathname.endsWith('/')) return true;
  const name = pathname.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return true;
  return PAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Extrait les liens d'une page (`href` et `src`), résolus en absolu et dédoublonnés.
 * @param {string} html
 * @param {string} pageUrl
 * @returns {string[]}
 */
export function extractLinks(html, pageUrl) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const pattern = /(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;
  const seen = new Set();
  const links = [];
  for (const match of html.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    const normalized = canonicalUrl(raw, pageUrl);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

/**
 * Analyse un `robots.txt` pour l'agent XDM (et le groupe `*`).
 * @param {string} text
 * @returns {{pattern: string, allow: boolean}[]}
 */
export function parseRobots(text) {
  if (typeof text !== 'string') return [];
  /** @type {{pattern: string, allow: boolean}[]} */
  const rules = [];
  let applies = false;
  let inGroup = false;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      // Un nouveau bloc commence : les règles précédentes ne s'appliquent plus.
      if (!lastWasAgent) applies = false;
      lastWasAgent = true;
      inGroup = true;
      if (value === '*' || value.toLowerCase() === 'xdm') applies = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'allow' || field === 'disallow') {
      inGroup = true;
      if (!applies || value === '') continue;
      rules.push({ pattern: value, allow: field === 'allow' });
    }
  }
  return rules;
}

/**
 * Traduit un motif `robots.txt` en expression régulière ancrée au début du chemin.
 * @param {string} pattern
 * @returns {RegExp}
 */
function robotsRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}`);
}

/**
 * Une URL est-elle autorisée ? Règle la plus longue, `Disallow` prioritaire à égalité.
 * @param {string} url
 * @param {{pattern: string, allow: boolean}[]} rules
 * @returns {boolean}
 */
export function isAllowed(url, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let target;
  try {
    const parsed = new URL(url);
    target = `${parsed.pathname}${parsed.search}`;
  } catch {
    return true;
  }
  let best = null;
  for (const rule of rules) {
    if (!robotsRegExp(rule.pattern).test(target)) continue;
    const length = rule.pattern.length;
    if (best === null || length > best.length || (length === best.length && !rule.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best === null ? true : best.allow;
}

/**
 * Une URL est-elle retenue par les filtres du projet ? (`EX-B-03`, `EX-B-05`)
 * @param {string} url
 * @param {{include?: string[], exclude?: string[]}} [filters]
 * @returns {{retained: boolean, reason: string}}
 */
export function classifyLink(url, { include = [], exclude = [] } = {}) {
  const excluded = exclude.find((motif) => matchesMotif(motif, url));
  if (excluded) return { retained: false, reason: `exclusion:${excluded}` };
  if (include.length === 0) return { retained: true, reason: 'aucun filtre' };
  const included = include.find((motif) => matchesMotif(motif, url));
  if (included) return { retained: true, reason: `inclusion:${included}` };
  return { retained: false, reason: 'hors inclusion' };
}

/**
 * Chemin du `robots.txt` d'une origine.
 * @param {string} url
 * @returns {string}
 */
export function robotsUrl(url) {
  return `${new URL(url).origin}/robots.txt`;
}

/**
 * Aspire un site, niveau par niveau.
 *
 * `fetchPage` est **injecté** : `(url) => Promise<{status, body, headers?}>`. Le parcours
 * ne fait aucune I/O lui-même, ce qui le rend testable sans réseau et réutilisable avec le
 * client HTTP du moteur.
 *
 * @param {string} startUrl
 * @param {{fetchPage: (url: string) => Promise<{status: number, body: string}>,
 *   depth?: number, maxPages?: number, filters?: {include?: string[], exclude?: string[]},
 *   sameSite?: boolean, robots?: boolean, onPage?: (page: object) => void}} options
 * @returns {Promise<{start: string, pages: object[], retained: object[], skipped: object[],
 *   errors: object[], fetched: number}>}
 */
export async function crawl(startUrl, {
  fetchPage,
  depth = DEFAULT_DEPTH,
  maxPages = DEFAULT_MAX_PAGES,
  filters = {},
  sameSite = true,
  robots = true,
  onPage = () => {},
} = {}) {
  if (typeof fetchPage !== 'function') {
    throw new TypeError('crawl : `fetchPage` est requis');
  }
  const start = canonicalUrl(startUrl);
  if (start === null) throw new TypeError(`crawl : URL de départ invalide (${startUrl})`);
  if (!Number.isInteger(depth) || depth < 1) throw new RangeError('crawl : profondeur ≥ 1');

  /** @type {{pattern: string, allow: boolean}[]} */
  let rules = [];
  if (robots) {
    try {
      const response = await fetchPage(robotsUrl(start));
      if (response && response.status >= 200 && response.status < 300) {
        rules = parseRobots(response.body);
      }
    } catch {
      rules = []; // robots.txt inaccessible ⇒ rien n'est interdit
    }
  }

  /** @type {object[]} */
  const pages = [];
  /** @type {{url: string, depth: number, reason: string}[]} */
  const skipped = [];
  /** @type {{url: string, status: number}[]} */
  const errors = [];
  /** @type {Map<string, {url: string, depth: number}>} */
  const retained = new Map();
  const visited = new Set();
  /** File FIFO : l'ordre de visite est celui des niveaux (`D-041`). */
  const queue = [{ url: start, depth: 1 }];

  while (queue.length > 0 && pages.length < maxPages) {
    const node = queue.shift();
    if (visited.has(node.url)) continue;
    visited.add(node.url);

    if (robots && !isAllowed(node.url, rules)) {
      skipped.push({ url: node.url, depth: node.depth, reason: 'robots.txt' });
      continue;
    }

    let response;
    try {
      response = await fetchPage(node.url);
    } catch (error) {
      errors.push({ url: node.url, status: 0, message: String(error?.message ?? error) });
      continue;
    }
    const page = { url: node.url, depth: node.depth, status: response.status };
    pages.push(page);
    onPage(page);

    if (response.status < 200 || response.status >= 300) {
      errors.push({ url: node.url, status: response.status });
      continue;
    }

    for (const link of extractLinks(response.body, node.url)) {
      if (sameSite && !sameOrigin(link, start)) {
        skipped.push({ url: link, depth: node.depth + 1, reason: 'hors site' });
        continue;
      }
      const verdict = classifyLink(link, filters);
      if (verdict.retained) {
        if (!retained.has(link)) retained.set(link, { url: link, depth: node.depth + 1 });
      } else {
        skipped.push({ url: link, depth: node.depth + 1, reason: verdict.reason });
      }
      if (node.depth < depth && isPageUrl(link) && !visited.has(link)) {
        queue.push({ url: link, depth: node.depth + 1 });
      }
    }
  }

  return {
    start,
    pages,
    retained: [...retained.values()],
    skipped,
    errors,
    fetched: pages.length,
  };
}
