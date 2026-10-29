/**
 * Plans de site (`sitemap.xml`) et directives `Sitemap:` — lot `WP-35` (`D-065`).
 *
 * Un grabber qui ne lit que les liens d'une page rate tout ce qu'aucune page ne cite : les
 * fichiers publiés uniquement dans un plan de site (archives, PDF, médias). La RFC 9309 §2.2.3
 * et le protocole `sitemaps.org` donnent les deux points d'entrée, et XDM les lit :
 *
 *  1. la directive `Sitemap: <url>` d'un `robots.txt` (déjà lue, jusqu'ici ignorée) ;
 *  2. `/sitemap.xml` à la racine, si le `robots.txt` n'en déclare aucun.
 *
 * Deux limites assumées, parce qu'un plan de site est une **prétention** et non une preuve :
 * un index (`<sitemapindex>`) est suivi **un seul niveau** (pas de récursion sans fin), et le
 * nombre de plans et d'URL est plafonné. Ce qui n'est pas lu est **compté**, jamais deviné.
 *
 * Aucune dépendance : expressions régulières et `URL` (stdlib).
 *
 * @module sitemap
 */

/** Plafond du nombre de plans de site consultés pour une aspiration. */
export const MAX_SITEMAPS = 8;

/** Plafond du nombre d'URL tirées des plans de site. */
export const MAX_SITEMAP_URLS = 5000;

/**
 * Décode les entités XML qu'un plan de site contient réellement.
 *
 * Seules les cinq entités XML prédéfinies sont traitées : une entité inconnue reste telle
 * quelle, ce qui vaut mieux que de l'effacer en silence (l'URL serait alors fausse).
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Lit un plan de site (ou un index de plans de site).
 *
 * Le format est du XML, mais on ne l'analyse **pas** comme du XML : une bibliothèque XML
 * ajouterait une dépendance pour lire un seul élément (`<loc>`), et les plans de site réels
 * contiennent assez d'écarts (encodage, espaces, commentaires) pour qu'un analyseur strict
 * refuse des fichiers que les moteurs acceptent. On extrait `<loc>` avec ses variantes
 * d'espacement, et on distingue les deux racines par la présence de `<sitemapindex`.
 *
 * @param {string} text contenu du fichier
 * @returns {{urls: string[], sitemaps: string[], kind: 'urlset'|'sitemapindex'|'inconnu'}}
 */
export function parseSitemapXml(text) {
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') return { urls: [], sitemaps: [], kind: 'inconnu' };
  const isIndex = /<sitemapindex\b/i.test(raw);
  const isUrlset = /<urlset\b/i.test(raw);
  const kind = isIndex ? 'sitemapindex' : isUrlset ? 'urlset' : 'inconnu';
  if (kind === 'inconnu') return { urls: [], sitemaps: [], kind };

  /** @type {string[]} */
  const locs = [];
  for (const match of raw.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)) {
    const value = decodeXmlEntities(match[1]).replace(/\s+/g, ' ').trim();
    if (value === '') continue;
    locs.push(value);
  }
  // Un `<loc>` n'a de sens que résolu : `<loc>/fichier.zip</loc>` est relatif au plan, pas
  // au document qui l'a cité — on laisse donc l'appelant fournir la base, ici on rend brut.
  return kind === 'sitemapindex'
    ? { urls: [], sitemaps: locs, kind }
    : { urls: locs, sitemaps: [], kind };
}

/**
 * Directives `Sitemap:` d'un `robots.txt` (RFC 9309 §2.2.3 : elles ne dépendent d'aucun
 * groupe d'agent, elles valent pour tout le fichier).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseSitemapDirectives(text) {
  if (typeof text !== 'string') return [];
  /** @type {string[]} */
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/#.*$/, '').trim();
    const match = /^sitemap\s*:\s*(\S+)\s*$/i.exec(cleaned);
    if (match) found.push(match[1]);
  }
  return found;
}

/** Normalise une URL de plan de site ; `null` si elle n'est pas exploitable. */
function absolute(raw, base) {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Découvre les URL déclarées par les plans de site d'une origine.
 *
 * @param {{startUrl: string, fetchPage: (url: string) => Promise<{status: number, body: string}>,
 *   robotsText?: string|null, fallback?: boolean, maxSitemaps?: number,
 *   maxUrls?: number, sameOrigin?: boolean}} options
 * @returns {Promise<{urls: string[], sitemaps: string[], failed: {url: string, reason: string}[],
 *   truncated: boolean}>}
 */
export async function discoverSitemaps({
  startUrl,
  fetchPage,
  robotsText = null,
  fallback = true,
  maxSitemaps = MAX_SITEMAPS,
  maxUrls = MAX_SITEMAP_URLS,
  sameOrigin = true,
}) {
  if (typeof fetchPage !== 'function') throw new TypeError('discoverSitemaps : `fetchPage` requis');
  const origin = new URL(startUrl).origin;
  const declared = parseSitemapDirectives(robotsText ?? '')
    .map((raw) => absolute(raw, startUrl))
    .filter((url) => url !== null);
  /** @type {string[]} */
  const queue = [...new Set(declared)];
  const consulted = [];
  /** @type {{url: string, reason: string}[]} */
  const failed = [];
  /** @type {string[]} */
  const urls = [];
  const seen = new Set();
  let truncated = false;

  if (queue.length === 0 && fallback) queue.push(`${origin}/sitemap.xml`);

  while (queue.length > 0) {
    if (consulted.length >= maxSitemaps) {
      truncated = true;
      break;
    }
    const url = /** @type {string} */ (queue.shift());
    if (consulted.includes(url)) continue;
    consulted.push(url);
    let response;
    try {
      response = await fetchPage(url);
    } catch (error) {
      failed.push({ url, reason: String(error?.message ?? error) });
      continue;
    }
    if (!response || response.status < 200 || response.status >= 300) {
      // Un `404` sur `/sitemap.xml` n'est pas une erreur : c'est l'absence de plan de site.
      failed.push({ url, reason: `statut ${response?.status ?? 0}` });
      continue;
    }
    const parsed = parseSitemapXml(response.body);
    if (parsed.kind === 'inconnu') {
      failed.push({ url, reason: 'format inconnu' });
      continue;
    }
    for (const child of parsed.sitemaps) {
      const childUrl = absolute(child, url);
      // Un index ne mène qu'à des plans de la **même origine** quand on reste sur le site.
      if (childUrl === null) continue;
      if (sameOrigin && new URL(childUrl).origin !== origin) continue;
      if (!consulted.includes(childUrl) && !queue.includes(childUrl)) queue.push(childUrl);
    }
    for (const raw of parsed.urls) {
      const target = absolute(raw, url);
      if (target === null) continue;
      if (sameOrigin && new URL(target).origin !== origin) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      if (urls.length >= maxUrls) {
        truncated = true;
        break;
      }
      urls.push(target);
    }
    if (truncated) break;
  }

  return { urls, sitemaps: consulted, failed, truncated };
}
