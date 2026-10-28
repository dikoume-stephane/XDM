/**
 * Modèle de projet d'aspiration et ses filtres (fiche B §3, `WP-20`).
 *
 * Deux règles observées chez IDM structurent ce module :
 *
 *  - **D-032** : un filtre ne porte **pas** sa portée. Le binaire ne stocke que
 *    `{CString nom, CString motif, int id, BYTE actif}` (16 octets, prouvé par
 *    `CArray<IDM_SPIDERFILTER>::SetAtGrow` en `0xc2bc0`) ; l'inclusion ou
 *    l'exclusion est portée par la **collection** (deux clés de registre, deux
 *    tableaux).
 *  - **D-033** : les identifiants viennent d'un compteur persistant qui démarre
 *    à **100** (valeur de repli observée en `0xc2cc9`).
 *
 * Contrairement à IDM, le projet est un fichier `<nom>.xdmspider.json` et non
 * un `.gsd` binaire suivi d'un miroir dans le registre (annexe 11 §1).
 */

import { open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Premier identifiant attribué à un filtre (observé : `mov edi, 0x64`). */
export const FIRST_FILTER_ID = 100;

/** Suffixe du fichier de projet. */
export const PROJECT_SUFFIX = ".xdmspider.json";

/**
 * Exclusion par défaut du grabber IDM, telle qu'écrite dans le binaire
 * (`0x2a9fb0`, 66 octets) : onze masques, séparés par des virgules.
 */
export const DEFAULT_EXCLUDE_MOTIFS = [
  "*.html",
  "*.htm",
  "*.js",
  "*.css",
  "*.gif",
  "*.jpg",
  "*.jpeg",
  "*.jpe",
  "*.bmp",
  "*.png",
  "*.tif",
];

/** @typedef {"include"|"exclude"} FilterList */

/**
 * @typedef {object} Filter
 * @property {number} id
 * @property {string} motif
 * @property {boolean} actif
 */

/**
 * @typedef {object} Project
 * @property {number} version
 * @property {number} id
 * @property {string} name
 * @property {string} rootUrl
 * @property {number} depth
 * @property {number} nextFilterId
 * @property {{include: Filter[], exclude: Filter[]}} filters
 * @property {Array<object>} sitemap
 * @property {Array<object>} entries
 * @property {object|null} planification
 */

/**
 * Normalise une URL pour comparaison : casse d'hôte et chemin vide neutralisés.
 * Une URL invalide est renvoyée telle quelle (le projet reste modifiable).
 * @param {string} raw
 * @returns {string}
 */
export function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return String(raw).trim();
  }
}

/**
 * Crée un projet avec l'exclusion par défaut déjà installée, comme le fait IDM
 * à la création d'un projet (les onze masques ci-dessus).
 * @param {{id?: number, name: string, rootUrl: string, depth?: number}} init
 * @returns {Project}
 */
export function createProject({ id = 1, name, rootUrl, depth = 2 }) {
  if (!name || typeof name !== "string") throw new TypeError("name requis");
  if (!rootUrl || typeof rootUrl !== "string") throw new TypeError("rootUrl requis");
  if (!Number.isSafeInteger(depth) || depth < 0) throw new TypeError("depth doit être un entier ≥ 0");

  return {
    version: 1,
    id,
    name,
    rootUrl: normalizeUrl(rootUrl),
    depth,
    nextFilterId: FIRST_FILTER_ID + 1,
    filters: {
      include: [],
      exclude: [{ id: FIRST_FILTER_ID, motif: DEFAULT_EXCLUDE_MOTIFS.join(","), actif: true }],
    },
    sitemap: [],
    entries: [],
    planification: null,
  };
}

/**
 * Ajoute un filtre à une liste. L'identifiant vient du compteur du projet
 * (D-033) : il n'est jamais recyclé, même après suppression.
 * @param {Project} project
 * @param {FilterList} list
 * @param {string} motif
 * @returns {Project}
 */
export function addFilter(project, list, motif) {
  if (list !== "include" && list !== "exclude") throw new TypeError(`liste inconnue : ${list}`);
  if (typeof motif !== "string" || motif.trim() === "") throw new TypeError("motif vide");
  const id = project.nextFilterId;
  return {
    ...project,
    nextFilterId: id + 1,
    filters: {
      ...project.filters,
      [list]: [...project.filters[list], { id, motif: motif.trim(), actif: true }],
    },
  };
}

/**
 * Déplace un filtre d'une liste à l'autre **sans changer sa forme** : c'est la
 * démonstration de D-032 (la portée n'appartient pas au filtre).
 * @param {Project} project
 * @param {number} filterId
 * @param {FilterList} to
 * @returns {Project}
 */
export function moveFilter(project, filterId, to) {
  const from = filterId === undefined ? null : findFilterList(project, filterId);
  if (!from) throw new Error(`filtre inconnu : ${filterId}`);
  if (from === to) return project;
  const filter = project.filters[from].find((f) => f.id === filterId);
  return {
    ...project,
    filters: {
      ...project.filters,
      [from]: project.filters[from].filter((f) => f.id !== filterId),
      [to]: [...project.filters[to], filter],
    },
  };
}

/**
 * @param {Project} project
 * @param {number} filterId
 * @returns {FilterList|null}
 */
export function findFilterList(project, filterId) {
  for (const list of /** @type {FilterList[]} */ (["include", "exclude"])) {
    if (project.filters[list].some((f) => f.id === filterId)) return list;
  }
  return null;
}

/**
 * Active ou désactive un filtre (champ `+0xC` de la structure observée).
 * @param {Project} project
 * @param {number} filterId
 * @param {boolean} actif
 * @returns {Project}
 */
export function setFilterActive(project, filterId, actif) {
  const list = findFilterList(project, filterId);
  if (!list) throw new Error(`filtre inconnu : ${filterId}`);
  return {
    ...project,
    filters: {
      ...project.filters,
      [list]: project.filters[list].map((f) => (f.id === filterId ? { ...f, actif } : f)),
    },
  };
}

/**
 * Supprime un filtre. Le compteur n'est pas décrémenté (identifiants stables).
 * @param {Project} project
 * @param {number} filterId
 * @returns {Project}
 */
export function removeFilter(project, filterId) {
  const list = findFilterList(project, filterId);
  if (!list) return project;
  return {
    ...project,
    filters: { ...project.filters, [list]: project.filters[list].filter((f) => f.id !== filterId) },
  };
}

/**
 * Un motif peut contenir plusieurs masques séparés par des virgules — c'est la
 * forme des onze masques par défaut observés en `0x2a9fb0`.
 * @param {string} motif
 * @returns {string[]}
 */
export function splitMotif(motif) {
  return String(motif)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Compile un masque glob (`*`, `?`) en expression régulière, ancrée.
 * Tout le reste est échappé : `*.png` ne doit pas accepter `xapng`.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, "i");
}

/**
 * Teste une URL contre un motif (liste de masques acceptée).
 * @param {string} motif
 * @param {string} url
 * @returns {boolean}
 */
export function matchesMotif(motif, url) {
  const name = fileNameOf(url);
  return splitMotif(motif).some((glob) => {
    const re = globToRegExp(glob);
    return re.test(name) || re.test(url);
  });
}

/**
 * Dernier segment d'une URL, sans requête ni ancre.
 * @param {string} url
 * @returns {string}
 */
export function fileNameOf(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? decodeURIComponent(segments.at(-1)) : "";
  } catch {
    return String(url).split("/").filter(Boolean).at(-1) ?? "";
  }
}

/**
 * Décide du sort d'une URL selon les filtres **actifs** du projet.
 *
 * Ordre observé côté IDM : l'exclusion l'emporte sur l'inclusion (le dialogue
 * « Filters » présente l'exclusion comme un veto). Une URL qui n'apparaît dans
 * aucune liste n'est pas retenue par défaut.
 * @param {Project} project
 * @param {string} url
 * @returns {"include"|"exclude"|"none"}
 */
export function classifyUrl(project, url) {
  const active = (list) => project.filters[list].filter((f) => f.actif);
  if (active("exclude").some((f) => matchesMotif(f.motif, url))) return "exclude";
  if (active("include").some((f) => matchesMotif(f.motif, url))) return "include";
  return "none";
}

/**
 * Vérifie les cinq invariants de la fiche B §3.
 * @param {unknown} project
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProject(project) {
  const errors = [];
  if (!project || typeof project !== "object") return { ok: false, errors: ["projet absent"] };
  const p = /** @type {Project} */ (project);

  if (!Number.isSafeInteger(p.id) || p.id <= 0) errors.push("id de projet invalide");
  if (typeof p.name !== "string" || p.name.trim() === "") errors.push("name requis");
  if (typeof p.rootUrl !== "string" || p.rootUrl === "") errors.push("rootUrl requis");
  if (!Number.isSafeInteger(p.depth) || p.depth < 0) errors.push("depth invalide");
  if (!p.filters || typeof p.filters !== "object") {
    errors.push("filters absent");
    return { ok: false, errors };
  }

  const ids = new Set();
  let maxId = 0;
  for (const list of /** @type {FilterList[]} */ (["include", "exclude"])) {
    const filters = p.filters[list];
    if (!Array.isArray(filters)) {
      errors.push(`liste ${list} absente`);
      continue;
    }
    for (const f of filters) {
      if (!Number.isSafeInteger(f.id) || f.id <= 0) errors.push(`id de filtre invalide : ${f.id}`);
      if (ids.has(f.id)) errors.push(`id de filtre dupliqué : ${f.id}`);
      ids.add(f.id);
      if (Number.isSafeInteger(f.id)) maxId = Math.max(maxId, f.id);
      if (typeof f.motif !== "string" || f.motif.trim() === "") errors.push(`motif vide (${f.id})`);
      if (typeof f.actif !== "boolean") errors.push(`actif non booléen (${f.id})`);
      if (Object.hasOwn(f, "scope")) errors.push(`filtre ${f.id} porte une portée (D-032)`);
    }
  }
  if (!Number.isSafeInteger(p.nextFilterId) || p.nextFilterId <= maxId) {
    errors.push(`nextFilterId (${p.nextFilterId}) doit dépasser le plus grand id (${maxId})`);
  }

  const urls = new Set();
  for (const entry of p.entries ?? []) {
    const url = normalizeUrl(entry.url);
    if (urls.has(url)) errors.push(`entrée dupliquée : ${url}`);
    urls.add(url);
  }

  for (const node of p.sitemap ?? []) {
    if (!Number.isSafeInteger(node.profondeur) || node.profondeur > p.depth) {
      errors.push(`nœud au-delà de la profondeur ${p.depth} : ${String(node.url)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Ajoute une entrée retenue. Une URL déjà présente n'est pas ajoutée deux fois
 * (invariant 3) et le booléen de retour dit si l'entrée est nouvelle.
 * @param {Project} project
 * @param {{url: string, localPath?: string, localFileName?: string, expectedSize?: number}} entry
 * @returns {{project: Project, added: boolean}}
 */
export function addEntry(project, entry) {
  const url = normalizeUrl(entry.url);
  if (project.entries.some((e) => normalizeUrl(e.url) === url)) {
    return { project, added: false };
  }
  const added = {
    url,
    localPath: entry.localPath ?? "",
    localFileName: entry.localFileName ?? fileNameOf(url),
    expectedSize: entry.expectedSize ?? -1,
    etat: "en-attente",
    log: "",
  };
  return { project: { ...project, entries: [...project.entries, added] }, added: true };
}

/**
 * Chemin du fichier de projet pour un nom donné.
 * @param {string} directory
 * @param {string} name
 * @returns {string}
 */
export function projectPath(directory, name) {
  return join(directory, `${name}${PROJECT_SUFFIX}`);
}

/**
 * Écrit le projet de façon atomique (même schéma que la carte de morceaux).
 * @param {string} path
 * @param {Project} project
 * @returns {Promise<string>}
 */
export async function saveProject(path, project) {
  const { ok, errors } = validateProject(project);
  if (!ok) throw new Error(`projet refusé à l'écriture : ${errors[0]}`);

  const temporary = join(dirname(path), `.${process.pid}.tmp.project`);
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(`${JSON.stringify(project, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return path;
}

/**
 * Relit un projet ; un projet invalide est refusé (aucune réparation muette).
 * @param {string} path
 * @returns {Promise<Project>}
 */
export async function loadProject(path) {
  const text = await readFile(path, "utf8");
  let project;
  try {
    project = JSON.parse(text);
  } catch (cause) {
    throw new Error(`projet illisible (JSON invalide) : ${path}`, { cause });
  }
  const { ok, errors } = validateProject(project);
  if (!ok) throw new Error(`projet rejeté : ${errors[0]}`);
  return project;
}
