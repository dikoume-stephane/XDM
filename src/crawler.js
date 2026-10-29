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
 *  - **`robots.txt`** lu selon la RFC 9309 : groupe applicable seul, `*` et `$`, règle la
 *    plus longue, `Allow` gagne à longueur égale (`D-059`, `EX-B-17`) ;
 *  - **`Crawl-delay`** borné, appliqué entre deux vagues, `delai` explicite prioritaire
 *    (`D-060`, `EX-B-19`) ;
 *  - **élagage** (`prune`) : un motif d'élagage coupe la branche, une exclusion de projet ne
 *    fait que trier les téléchargements (`D-060`, `EX-B-20`) ;
 *  - filtres d'inclusion/exclusion réutilisés de `project.js` (masques glob) ;
 *  - exploration **parallèle bornée** (`parallelisme`, défaut 1) mais **déterministe** :
 *    vagues absorbées dans l'ordre de la file (`D-061`, `EX-B-18`) ;
 *  - **arrêt sur échecs consécutifs** (`maxErrors`) : un site muet ne se fait pas marteler
 *    (`D-063`, `EX-B-22`).
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
 * Base de résolution des liens d'une page.
 *
 * HTML permet à une page de déclarer `<base href="…">` : tous les liens **relatifs** de la
 * page se résolvent alors contre cette base, pas contre l'URL du document. Ignorer cette
 * balise fait rater une arborescence entière sur les sites qui l'utilisent (ou pire, la fait
 * télécharger au mauvais endroit). Seule la **première** balise compte (c'est la règle du
 * navigateur) et une base inexploitable est ignorée sans erreur.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {string} base absolue (l'URL de la page si la balise est absente ou invalide)
 */
export function documentBase(html, pageUrl) {
  if (typeof html !== 'string') return pageUrl;
  const match = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/i.exec(html);
  if (!match) return pageUrl;
  const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  if (raw === '') return pageUrl;
  try {
    const resolved = new URL(raw, pageUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return pageUrl;
    return resolved.href;
  } catch {
    return pageUrl;
  }
}

/**
 * Extrait les liens d'une page (`href` et `src`), résolus en absolu et dédoublonnés.
 *
 * Les URL **fragmentaires** (`#ancre`) restent relatives à la page, jamais à la base : une
 * ancre ne désigne pas un autre document.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {string[]}
 */
export function extractLinks(html, pageUrl) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const base = documentBase(html, pageUrl);
  // La balise `<base>` **déclare** la base, elle ne cite pas un fichier : son `href` ne doit
  // pas devenir un lien à télécharger (sinon chaque page aspirée produirait un faux fichier
  // qui n'existe pas sur le serveur).
  const body = html.replace(/<base\b[^>]*>/gi, '');
  const pattern = /(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;
  const seen = new Set();
  const links = [];
  for (const match of body.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    const normalized = canonicalUrl(raw, base);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

/**
 * Compile un motif `robots.txt` en expression régulière.
 *
 * RFC 9309 §2.2.2 : `*` remplace **n'importe quelle suite** de caractères et `$` **ancre la
 * fin** du motif. Le reste est littéral. Le motif porte sur `chemin + requête`, pas sur
 * l'URL entière — un `robots.txt` ne parle jamais du schéma ni de l'hôte.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function robotsRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/** Jeton de produit d'un agent (`XDM/1.0 (+grabber)` → `xdm`). */
function productToken(agent) {
  return String(agent ?? '').split(/[\s/]/)[0].toLowerCase();
}

/**
 * Lit un `robots.txt` et rend **les règles du groupe qui s'applique à notre agent**.
 *
 * Trois choix, tous explicites, parce que c'est exactement ce que la cible ne dit pas
 * (`Q-B-02` : une seule chaîne `robots` dans le binaire, sémantique non établie) :
 *
 * 1. **Groupe le plus spécifique** : les groupes nommant notre produit (`XDM`) l'emportent
 *    sur le groupe `*` ; plusieurs groupes du même nom sont **fusionnés** (RFC 9309 §2.2.1).
 * 2. **Règle la plus longue** : sur `chemin + requête`, la règle dont le motif est le plus
 *    long décide (RFC 9309 §2.2.2).
 * 3. **À longueur égale, `Allow` gagne** — c'est le RFC 9309, et c'est aussi le sens
 *    pratique : un administrateur qui écrit les deux veut autoriser l'exception.
 *    (Comportement **changé** ici : la version précédente faisait gagner `Disallow`.)
 *
 * @param {string} text contenu du fichier
 * @param {{agent?: string}} [options]
 * @returns {{pattern: string, allow: boolean}[]}
 */
export function parseRobots(text, { agent = 'XDM' } = {}) {
  if (typeof text !== 'string') return [];
  const ours = productToken(agent);

  /** @type {{agents: string[], rules: {pattern: string, allow: boolean}[]}[]} */
  const groups = [];
  /** @type {{agents: string[], rules: {pattern: string, allow: boolean}[]} | null} */
  let current = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Des `User-agent` consécutifs forment **un** groupe (plusieurs agents, mêmes règles).
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      lastWasAgent = true;
      current.agents.push(productToken(value));
      continue;
    }
    lastWasAgent = false;

    if ((field === 'allow' || field === 'disallow') && current !== null) {
      // `Disallow:` vide n'interdit rien : la ligne est ignorée (RFC 9309 §2.2.2).
      if (value === '') continue;
      current.rules.push({ pattern: value, allow: field === 'allow' });
    }
    // `crawl-delay`, `sitemap`, `host`… ne sont pas des règles d'accès : ignorés, mais lus
    // sans erreur — un `robots.txt` inconnu ne doit pas interrompre une aspiration.
  }

  const named = groups.filter((group) => group.agents.includes(ours));
  const applicable = named.length > 0 ? named : groups.filter((group) => group.agents.includes('*'));
  return applicable.flatMap((group) => group.rules);
}

/**
 * Délai d'aspiration demandé par un `robots.txt`, en secondes.
 *
 * `Crawl-delay` n'est **pas** dans la RFC 9309 : c'est une extension historique, sans
 * grammaire ni plafond. On la lit donc comme un **conseil borné** — un nombre fini de
 * secondes, sinon `null` — et le choix d'obéir appartient à l'appelant (`--delai`).
 * Le groupe retenu est le même que pour les règles, pour qu'un site ne puisse pas voir XDM
 * suivre le délai de `*` tout en ignorant celui de `XDM`.
 *
 * @param {string} text
 * @param {{agent?: string}} [options]
 * @returns {number|null} secondes, ou `null` si le site n'en demande pas
 */
export function parseCrawlDelay(text, { agent = 'XDM' } = {}) {
  if (typeof text !== 'string') return null;
  const ours = productToken(agent);
  /** @type {{agents: string[], delay: number|null}[]} */
  const groups = [];
  /** @type {{agents: string[], delay: number|null} | null} */
  let current = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], delay: null };
        groups.push(current);
      }
      lastWasAgent = true;
      current.agents.push(productToken(value));
    } else if (field === 'crawl-delay' && current !== null) {
      lastWasAgent = false;
      const seconds = Number(value);
      // Une valeur non finie ou négative est ignorée : on ne devine pas l'intention.
      if (Number.isFinite(seconds) && seconds >= 0) current.delay = seconds;
    } else {
      lastWasAgent = false;
    }
  }

  const named = groups.filter((group) => group.agents.includes(ours));
  const applicable = named.length > 0 ? named : groups.filter((group) => group.agents.includes('*'));
  const delays = applicable.map((group) => group.delay).filter((delay) => delay !== null);
  return delays.length === 0 ? null : Math.max(...delays);
}

/**
 * Une URL est-elle autorisée par ces règles ?
 *
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
    if (best === null || length > best.length || (length === best.length && rule.allow)) {
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
 * `parallelisme` borne le nombre de requêtes simultanées (`Q-B-05` : la cible ne dit pas si
 * son crawl est parallèle ; XDM en fait un paramètre explicite). Le parcours reste **par
 * vagues** : chaque vague prend au plus `parallelisme` URL dans la file, les interroge en
 * parallèle, puis absorbe les résultats **dans l'ordre de la file** — l'ordre des pages, des
 * entrées retenues et des motifs d'exclusion ne dépend donc pas du hasard du réseau.
 *
 * @param {{fetchPage: (url: string) => Promise<{status: number, body: string}>,
 *   depth?: number, maxPages?: number, filters?: {include?: string[], exclude?: string[]},
 *   sameSite?: boolean, robots?: boolean, parallelisme?: number, prune?: string[],
 *   maxErrors?: number|null,
 *   delai?: number|null, sleep?: (ms: number) => Promise<void>,
 *   onPage?: (page: object) => void}} options
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
  parallelisme = 1,
  prune = [],
  maxErrors = null,
  delai = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onPage = () => {},
} = {}) {
  if (typeof fetchPage !== 'function') {
    throw new TypeError('crawl : `fetchPage` est requis');
  }
  const start = canonicalUrl(startUrl);
  if (start === null) throw new TypeError(`crawl : URL de départ invalide (${startUrl})`);
  if (!Number.isInteger(depth) || depth < 1) throw new RangeError('crawl : profondeur ≥ 1');
  if (!Number.isInteger(parallelisme) || parallelisme < 1) {
    throw new RangeError('crawl : `parallelisme` ≥ 1');
  }
  if (delai !== null && (!Number.isFinite(delai) || delai < 0)) {
    throw new RangeError('crawl : `delai` ≥ 0 (secondes)');
  }
  if (maxErrors !== null && (!Number.isInteger(maxErrors) || maxErrors < 1)) {
    throw new RangeError('crawl : `maxErrors` ≥ 1 (ou null)');
  }

  /** @type {{pattern: string, allow: boolean}[]} */
  let rules = [];
  /** @type {number|null} */
  let robotDelay = null;
  if (robots) {
    try {
      const response = await fetchPage(robotsUrl(start));
      if (response && response.status >= 200 && response.status < 300) {
        rules = parseRobots(response.body);
        robotDelay = parseCrawlDelay(response.body);
      }
    } catch {
      rules = []; // robots.txt inaccessible ⇒ rien n'est interdit
    }
  }

  // Le délai explicite (`--delai`) l'emporte sur celui du site : c'est le seul moyen de
  // ralentir **davantage** que demandé, et de rester maître quand le site se tait.
  const effectiveDelay = delai === null ? (robotDelay ?? 0) : delai;

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

  /** Échecs consécutifs (remis à zéro par une page lue) : garde-fou `maxErrors`. */
  let consecutiveErrors = 0;

  /** Absorbe la réponse d'une page : pages, erreurs, liens retenus, file. */
  const absorb = (node, outcome) => {
    if (!outcome.ok) {
      consecutiveErrors += 1;
      errors.push({
        url: node.url,
        status: 0,
        message: String(outcome.error?.message ?? outcome.error),
      });
      return;
    }
    const response = outcome.response;
    const page = { url: node.url, depth: node.depth, status: response.status };
    pages.push(page);
    onPage(page);

    if (response.status < 200 || response.status >= 300) {
      consecutiveErrors += 1;
      errors.push({ url: node.url, status: response.status });
      return;
    }
    consecutiveErrors = 0;

    for (const link of extractLinks(response.body, node.url)) {
      if (sameSite && !sameOrigin(link, start)) {
        skipped.push({ url: link, depth: node.depth + 1, reason: 'hors site' });
        continue;
      }
      // **Élagage** : un motif d'élagage coupe la branche, il ne se contente pas de retenir
      // le lien. C'est la différence avec une exclusion de téléchargement — une page exclue
      // des téléchargements est souvent une page qu'on doit quand même parcourir pour
      // atteindre ses voisines ; une branche élaguée n'est même pas demandée (`D-060`).
      const pruned = prune.find((motif) => matchesMotif(motif, link));
      if (pruned) {
        skipped.push({ url: link, depth: node.depth + 1, reason: `élagage:${pruned}` });
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
  };

  /** Première vague : rien n'a encore été demandé, inutile d'attendre avant elle. */
  let waveIndex = 0;

  /** @type {'épuisement'|'plafond'|'erreurs'} */
  let stopReason = 'épuisement';

  while (queue.length > 0 && pages.length < maxPages) {
    // Arrêt sur échecs consécutifs : au-delà de `maxErrors`, on ne demande plus rien. Un
    // fichier manquant isolé ne déclenche rien (le compteur repart à zéro) ; un site qui
    // répond `500` à tout s'arrête au bout de N requêtes au lieu d'être martelé (`D-063`).
    if (maxErrors !== null && consecutiveErrors >= maxErrors) {
      stopReason = 'erreurs';
      break;
    }
    // Constitution de la vague : robots.txt et dédoublonnage sont décidés ici, en série,
    // pour qu'une URL ne soit jamais demandée deux fois même si deux vagues se chevauchent.
    /** @type {{url: string, depth: number}[]} */
    const wave = [];
    while (wave.length < parallelisme && queue.length > 0 && pages.length + wave.length < maxPages) {
      const node = queue.shift();
      if (visited.has(node.url)) continue;
      visited.add(node.url);

      if (robots && !isAllowed(node.url, rules)) {
        skipped.push({ url: node.url, depth: node.depth, reason: 'robots.txt' });
        continue;
      }

      // La page de départ est retenue **si les filtres la retiennent** — mais seulement quand
      // une inclusion est déclarée : sans inclusion, le comportement historique (une page de
      // départ n'est aspirée que si une autre page la lie) est conservé, car la racine n'a pas
      // d'extension et échapperait aux exclusions par défaut (`*.html`).
      if (node.depth === 1 && isPageUrl(node.url) && (filters.include ?? []).length > 0) {
        const verdict = classifyLink(node.url, filters);
        if (verdict.retained) retained.set(node.url, { url: node.url, depth: 0 });
      }
      wave.push(node);
    }
    if (wave.length === 0) continue;

    // `Crawl-delay` sépare **deux requêtes** : on attend donc entre deux vagues, jamais
    // avant la première ni après la dernière (le crawl ne se prolonge pas d'un délai mort).
    if (waveIndex > 0 && effectiveDelay > 0) await sleep(effectiveDelay * 1000);
    waveIndex += 1;

    const outcomes = await Promise.all(wave.map((node) => fetchPage(node.url).then(
      (response) => ({ ok: true, response }),
      (error) => ({ ok: false, error }),
    )));
    for (let index = 0; index < wave.length; index += 1) absorb(wave[index], outcomes[index]);
  }

  // Le plafond de pages n'est pas un épuisement de la file : le rapport doit pouvoir dire
  // **pourquoi** le parcours s'est arrêté, sinon un site tronqué ressemble à un site fini.
  if (stopReason === 'épuisement' && queue.length > 0) stopReason = 'plafond';

  return {
    start,
    pages,
    retained: [...retained.values()],
    skipped,
    errors,
    fetched: pages.length,
    delay: effectiveDelay,
    stopped: stopReason,
    consecutiveErrors,
  };
}
