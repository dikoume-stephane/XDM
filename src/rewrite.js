/**
 * Réécriture des liens d'un site aspiré — lot `WP-24`.
 *
 * Une aspersion ne sert à rien si les pages téléchargées pointent encore vers le réseau :
 * ouvrir `index.html` depuis le disque doit fonctionner **hors ligne**. Ce module remplace
 * donc les références connues du plan de site par des chemins relatifs locaux.
 *
 * **Ce que la cible ne fait pas, et qu'on assume (`D-053`).** `Q-B-01` a établi qu'il
 * n'existe aucun parseur HTML dans `IDMan.exe` : IDM ne réécrit pas les liens. La
 * réécriture est donc un **choix XDM**, pas un clonage — elle est optionnelle, et le
 * journal le dit.
 *
 * **Méthode.** Pas de DOM : un analyseur de balises volontairement simple, qui sait
 * seulement ce qui est dangereux de traverser — commentaires, `<script>`, `<style>`,
 * `srcset`. Les attributs réécrits sont `href`, `src`, `poster`, `action`, `data`,
 * `srcset`, ainsi que `url(...)` dans les feuilles de style. Une référence inconnue du
 * plan de site est **laissée intacte** : on ne fabrique jamais un lien qui n'existe pas.
 *
 * @module rewrite
 */

/** Attributs dont la valeur est une URL simple. */
export const URL_ATTRIBUTES = /** @type {const} */ (['href', 'src', 'poster', 'action', 'data', 'formaction']);

/** Attributs dont la valeur est une liste `url [descripteur], …`. */
export const LIST_ATTRIBUTES = /** @type {const} */ (['srcset']);

/**
 * Chemin relatif entre deux chemins locaux, au sens URL (toujours des `/`).
 *
 * @param {string} fromPath chemin local de la page (« docs/index.html »)
 * @param {string} toPath chemin local de la cible (« img/logo.png »)
 * @returns {string}
 */
export function relativeLink(fromPath, toPath) {
  // Lien vers soi-même : `./` plutôt que de répéter le nom du fichier, pour que
  // `page.html#ancre` reste lisible dans le HTML produit.
  if (fromPath === toPath) return './';
  const from = fromPath.split('/').filter(Boolean);
  const to = toPath.split('/').filter(Boolean);
  from.pop(); // on part du **dossier** de la page
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  const up = from.length - common;
  const parts = [...Array(up).fill('..'), ...to.slice(common)];
  const joined = parts.join('/');
  // Un lien vide (`<a href="">`) pointerait sur la page elle-même ; `./` est plus clair.
  return joined === '' ? './' : joined;
}

/**
 * Une URL est-elle déjà locale (ou non réécrite) ?
 * @param {string} reference
 * @returns {boolean}
 */
export function isRewritable(reference) {
  const value = String(reference).trim();
  if (value === '' || value.startsWith('#')) return false;
  if (/^(data|javascript|mailto|tel|blob|about):/i.test(value)) return false;
  return true;
}

/**
 * Normalise une référence en URL absolue, ou `null` si elle n'est pas résolvable.
 * @param {string} base
 * @param {string} reference
 * @returns {string | null}
 */
export function absoluteReference(base, reference) {
  try {
    return new URL(reference, base).toString();
  } catch {
    return null;
  }
}

/**
 * Réécrit une référence si elle appartient au plan de site.
 *
 * Le fragment (`#ancre`) et la requête sont conservés en suffixe : `page.html#x` doit
 * rester une ancre sur la page locale, pas disparaître.
 *
 * @param {object} options
 * @param {string} options.reference valeur brute de l'attribut
 * @param {string} options.pageUrl URL d'origine de la page
 * @param {string} options.pageLocalPath chemin local de la page
 * @param {Map<string, string> | Record<string, string>} options.siteMap
 * @returns {string | null} la nouvelle référence, ou `null` si rien ne change
 */
export function rewriteReference({ reference, pageUrl, pageLocalPath, siteMap }) {
  if (!isRewritable(reference)) return null;
  const absolute = absoluteReference(pageUrl, reference);
  if (!absolute) return null;

  const lookup = siteMap instanceof Map ? siteMap : new Map(Object.entries(siteMap));
  /** @type {string | undefined} */
  let localPath = lookup.get(absolute);
  let url = absolute;
  if (localPath === undefined) {
    // Une ancre ou une requête ne change pas la ressource : on retente sans elles.
    const candidate = new URL(absolute);
    candidate.hash = '';
    candidate.search = '';
    localPath = lookup.get(candidate.toString());
    url = candidate.toString();
  }
  if (localPath === undefined || localPath === undefined) return null;

  const target = new URL(absolute);
  const suffix = `${target.search}${target.hash}`;
  const link = relativeLink(pageLocalPath, localPath);
  return `${encodeURI(link)}${suffix}`;
}

/**
 * Réécrit les `url(...)` d'une feuille de style.
 *
 * @param {string} css
 * @param {{cssUrl: string, cssLocalPath: string, pageLocalPath?: string,
 *   siteMap: Map<string, string> | Record<string, string>}} options `cssUrl` est l'URL du
 *   fichier CSS, `pageLocalPath` le chemin de la page qui l'inclut (pour un `@import`
 *   relatif, c'est la page qui compte si le CSS est lui-même réécrit).
 * @returns {{css: string, rewritten: number}}
 */
export function rewriteCss(css, { cssUrl, cssLocalPath, siteMap }) {
  let rewritten = 0;
  const output = String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, reference) => {
    const next = rewriteReference({
      reference,
      pageUrl: cssUrl,
      pageLocalPath: cssLocalPath,
      siteMap,
    });
    if (next === null) return match;
    rewritten += 1;
    return `url(${quote}${next}${quote})`;
  });
  return { css: output, rewritten };
}

/**
 * Réécrit une liste `srcset` (`a.png 1x, b.png 2x`).
 *
 * @param {string} value
 * @param {object} context
 * @returns {{value: string, rewritten: number}}
 */
function rewriteSrcset(value, context) {
  let rewritten = 0;
  const parts = String(value).split(',').map((item) => {
    const trimmed = item.trim();
    if (trimmed === '') return item;
    const [reference, ...descriptors] = trimmed.split(/\s+/);
    const next = rewriteReference({ reference, ...context });
    if (next === null) return trimmed;
    rewritten += 1;
    return [next, ...descriptors].join(' ');
  });
  return { value: parts.join(', '), rewritten };
}

/**
 * Réécrit les liens d'une page HTML.
 *
 * Les blocs `<script>…</script>`, `<style>…</style>`, `<pre>…</pre>` et les commentaires
 * sont **laissés tels quels** : le contenu d'un script n'est pas du HTML, et réécrire
 * une chaîne à l'intérieur d'un script casserait le code (on le signale dans `skipped`).
 *
 * @param {string} html
 * @param {{pageUrl: string, pageLocalPath: string,
 *   siteMap: Map<string, string> | Record<string, string>,
 *   attributes?: readonly string[]}} options
 * @returns {{html: string, rewritten: number, skipped: string[]}}
 */
export function rewriteHtml(html, {
  pageUrl,
  pageLocalPath,
  siteMap,
  attributes = [...URL_ATTRIBUTES, ...LIST_ATTRIBUTES],
}) {
  const source = String(html);
  const lookup = siteMap instanceof Map ? siteMap : new Map(Object.entries(siteMap));
  const context = { pageUrl, pageLocalPath, siteMap: lookup };
  const skipped = [];
  let rewritten = 0;

  // Découpage grossier : on isole les zones qu'il ne faut pas toucher.
  const guarded = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<pre\b[^>]*>[\s\S]*?<\/pre>/gi;
  let output = '';
  let cursor = 0;
  /** @type {{start: number, end: number, text: string}[]} */
  const zones = [];
  for (const match of source.matchAll(guarded)) {
    zones.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }

  const rewriteSegment = (segment) => segment.replace(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g,
    (whole, name, _quoted, double, single) => {
      const attribute = name.toLowerCase();
      if (!attributes.includes(attribute)) return whole;
      const value = double ?? single ?? '';
      if (attribute === 'srcset') {
        const result = rewriteSrcset(value, context);
        if (result.rewritten === 0) return whole;
        rewritten += result.rewritten;
        return `${name}="${result.value}"`;
      }
      const next = rewriteReference({ reference: value, ...context });
      if (next === null) return whole;
      rewritten += 1;
      return `${name}="${next}"`;
    },
  );

  for (const zone of zones) {
    output += rewriteSegment(source.slice(cursor, zone.start));
    if (/^<(script|style|pre)\b/i.test(zone.text)) skipped.push(zone.text.slice(0, 40));
    output += zone.text;
    cursor = zone.end;
  }
  output += rewriteSegment(source.slice(cursor));

  // `url(...)` dans un attribut `style="…"`.
  output = output.replace(/style\s*=\s*"([^"]*)"/gi, (whole, css) => {
    const result = rewriteCss(css, { cssUrl: pageUrl, cssLocalPath: pageLocalPath, siteMap: lookup });
    if (result.rewritten === 0) return whole;
    rewritten += result.rewritten;
    return `style="${result.css}"`;
  });

  return { html: output, rewritten, skipped };
}

/**
 * Réécrit une page ou une feuille de style selon son extension.
 *
 * @param {string} text
 * @param {{pageUrl: string, pageLocalPath: string,
 *   siteMap: Map<string, string> | Record<string, string>}} options
 * @returns {{text: string, rewritten: number, skipped: string[]}}
 */
export function rewriteDocument(text, options) {
  const isCss = /\.css$/i.test(options.pageLocalPath);
  const isHtml = /\.html?$/i.test(options.pageLocalPath);
  if (!isCss && !isHtml) return { text, rewritten: 0, skipped: [] };
  if (isCss) {
    // Une feuille de style se réécrit par rapport à **sa propre** URL : `rewriteCss` nomme
    // ce paramètre `cssUrl`, alors que `rewriteDocument` reçoit un `pageUrl` générique.
    const { pageUrl, pageLocalPath, siteMap } = options;
    const result = rewriteCss(text, { cssUrl: pageUrl, cssLocalPath: pageLocalPath, siteMap });
    return { text: result.css, rewritten: result.rewritten, skipped: [] };
  }
  const result = rewriteHtml(text, options);
  return { text: result.html, rewritten: result.rewritten, skipped: result.skipped };
}

/**
 * Table `URL absolue → chemin local` à partir d'entrées de plan de site.
 *
 * @param {Array<{url: string, localPath: string}>} entries
 * @returns {Map<string, string>}
 */
export function siteMapFromEntries(entries) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const entry of entries ?? []) {
    if (entry?.url && entry?.localPath) map.set(entry.url, entry.localPath);
  }
  return map;
}
