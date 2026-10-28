/**
 * Aspiration : de l'URL au fichier local, et du fichier retenu à la file de
 * téléchargement (domaine B, lot `WP-11`).
 *
 * Trois responsabilités, dans cet ordre :
 *  1. **arborescence locale** (`EX-B-11`) : le chemin d'une URL reproduit celui du site,
 *     relativement à la racine du projet, chaque segment étant assaini ;
 *  2. **entrée de projet** (`EX-B-06`) : URL, chemin local, nom de fichier, taille
 *     attendue, état, journal — le schéma observé chez IDM (annexe 12 §2) ;
 *  3. **promotion** (`EX-B-10`) : chaque entrée retenue devient une tâche de la file
 *     ordinaire, donc hérite de *toutes* les exigences du moteur (`EX-A-*`).
 *
 * Règles de chemin : **Décision XDM** (`D-042`), l'algorithme d'IDM n'étant pas dans le
 * module analysé (`D-041`).
 *
 * Aucune dépendance : `node:fs/promises`, `node:path`, et les modules du dépôt.
 *
 * @module grabber
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { addEntry } from './project.js';
import { sanitizeFileName } from './promote.js';
import { addTask } from './task-queue.js';

/** Nom de la page de remplacement écrite dans le dossier cible (`EX-B-12`). */
export const EMPTY_HTML_NAME = 'empty.html';

/** Contenu exact observé dans IDM (annexe 13 §4, `0xd1ed0`). */
export const EMPTY_HTML = '<HTML><BODY> </BODY></HTML>';

/** Nom de fichier retenu pour une URL qui désigne un répertoire. */
export const INDEX_NAME = 'index.html';

/**
 * Décode un segment d'URL sans jamais lever : un `%` orphelin reste littéral.
 * @param {string} segment
 * @returns {string}
 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * répertoire de base d'une URL racine (`/site` et `/site/` donnent `/site/`).
 * @param {URL} root
 * @returns {string}
 */
function basePath(root) {
  const path = root.pathname;
  return path.endsWith('/') ? path : `${path.slice(0, path.lastIndexOf('/') + 1)}`;
}

/**
 * Chemin local relatif d'une URL, ou `null` si elle est hors du site.
 *
 * `/a/b/c.zip` sous la racine `http://h/` donne `a/b/c.zip` ; une URL de répertoire
 * (`…/docs/`) donne `docs/index.html`. La requête (`?…`) n'entre pas dans le chemin :
 * deux URL qui ne diffèrent que par elle entrent en collision et sont départagées par
 * `buildSiteMap`.
 *
 * @param {string} rootUrl URL de départ du projet
 * @param {string} url URL d'un fichier retenu
 * @returns {string | null}
 */
export function localPathFor(rootUrl, url) {
  let root;
  let target;
  try {
    root = new URL(rootUrl);
    target = new URL(url);
  } catch {
    return null;
  }
  if (root.origin !== target.origin) return null;

  const base = basePath(root);
  const path = target.pathname;
  const relative = path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, '');

  const segments = relative
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => sanitizeFileName(decodeSegment(segment)));

  if (path.endsWith('/') || segments.length === 0) segments.push(INDEX_NAME);

  return posix.join(...segments);
}

/**
 * Ajoute un suffixe à un chemin déjà occupé, avant l'extension.
 * @param {string} localPath
 * @param {number} index
 * @returns {string}
 */
export function disambiguate(localPath, index) {
  const directory = posix.dirname(localPath);
  const file = posix.basename(localPath);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const extension = dot > 0 ? file.slice(dot) : '';
  const name = `${stem}-${index}${extension}`;
  return directory === '.' ? name : posix.join(directory, name);
}

/**
 * Construit le plan de fichiers locaux d'une aspiration.
 *
 * @param {string} rootUrl
 * @param {Array<{url: string, depth?: number}>} retained
 * @returns {{entries: Array<{url: string, localPath: string, localFileName: string,
 *   depth: number}>, collisions: Array<{url: string, localPath: string, withUrl: string}>,
 *   skipped: Array<{url: string, raison: string}>}}
 */
export function buildSiteMap(rootUrl, retained) {
  /** @type {Map<string, string>} */
  const byPath = new Map();
  const entries = [];
  const collisions = [];
  const skipped = [];

  for (const item of retained ?? []) {
    const url = typeof item === 'string' ? item : item?.url;
    if (typeof url !== 'string') continue;
    const base = localPathFor(rootUrl, url);
    if (base === null) {
      skipped.push({ url, raison: 'hors du site' });
      continue;
    }
    let localPath = base;
    if (byPath.has(localPath)) {
      // Même chemin pour deux URL : on garde le premier et on suffixe le suivant.
      if (byPath.get(localPath) === url) continue; // doublon exact : rien à faire
      let index = 2;
      let candidate = disambiguate(base, index);
      while (byPath.has(candidate)) {
        index += 1;
        candidate = disambiguate(base, index);
      }
      collisions.push({ url, localPath: candidate, withUrl: byPath.get(localPath) });
      localPath = candidate;
    }
    byPath.set(localPath, url);
    entries.push({
      url,
      localPath,
      localFileName: posix.basename(localPath),
      depth: typeof item === 'object' && item?.depth !== undefined ? item.depth : 0,
    });
  }

  return { entries, collisions, skipped };
}

/**
 * Inscrit les fichiers retenus dans le projet (`EX-B-06`).
 *
 * Ne duplique jamais une URL déjà présente : `addEntry` est idempotent et signale
 * l'absence d'ajout.
 *
 * @param {object} project
 * @param {Array<object>} entries sortie de `buildSiteMap`
 * @returns {{project: object, added: object[], alreadyPresent: string[]}}
 */
export function planGrab(project, entries) {
  let next = project;
  const added = [];
  const alreadyPresent = [];
  for (const entry of entries) {
    const result = addEntry(next, {
      url: entry.url,
      localPath: entry.localPath,
      localFileName: entry.localFileName,
      expectedSize: entry.expectedSize ?? -1,
    });
    next = result.project;
    if (result.added) added.push(entry);
    else alreadyPresent.push(entry.url);
  }
  return { project: next, added, alreadyPresent };
}

/**
 * Transforme des entrées de projet en tâches de téléchargement (`EX-B-10`).
 *
 * Les tâches sont des tâches **ordinaires** : même file, mêmes états, mêmes exigences
 * `EX-A-*` que celles créées à la main. La cible est `rootDir/localPath`.
 *
 * @param {object} queue
 * @param {Array<{url: string, localPath: string, expectedSize?: number}>} entries
 * @param {string} rootDir
 * @returns {{queue: object, tasks: object[]}}
 */
export function enqueueEntries(queue, entries, rootDir) {
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError('enqueueEntries : rootDir requis');
  }
  let next = queue;
  const tasks = [];
  for (const entry of entries) {
    const result = addTask(next, {
      url: entry.url,
      target: join(rootDir, entry.localPath),
      totalSize: entry.expectedSize ?? -1,
    });
    next = result.queue;
    tasks.push(result.task);
  }
  return { queue: next, tasks };
}

/**
 * Écrit `empty.html` dans le dossier cible (`EX-B-12`).
 *
 * Le fichier est **créé s'il manque**, jamais écrasé : il appartient à l'utilisateur
 * autant qu'à l'aspirateur. Le contenu est exactement celui observé chez IDM.
 *
 * @param {string} directory
 * @returns {Promise<{path: string, written: boolean}>}
 */
export async function writeEmptyHtml(directory) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, EMPTY_HTML_NAME);
  try {
    // `wx` échoue si le fichier existe : c'est la garantie de non-écrasement.
    await writeFile(path, EMPTY_HTML, { encoding: 'utf8', flag: 'wx' });
    return { path, written: true };
  } catch (error) {
    if (error?.code === 'EEXIST') return { path, written: false };
    throw error;
  }
}

/**
 * Chaîne complète d'une aspiration : plan → projet → file → `empty.html`.
 *
 * @param {{project: object, queue: object, retained: Array<object>, rootDir: string,
 *   emptyHtml?: boolean}} options
 * @returns {Promise<{project: object, queue: object, entries: object[], tasks: object[],
 *   collisions: object[], skipped: object[], emptyHtml: {path: string, written: boolean} | null}>}
 */
export async function prepareGrab({
  project,
  queue,
  retained,
  rootDir,
  emptyHtml = true,
}) {
  const map = buildSiteMap(project.rootUrl, retained);
  const planned = planGrab(project, map.entries);
  const enqueued = enqueueEntries(queue, planned.added, rootDir);
  const marker = emptyHtml ? await writeEmptyHtml(rootDir) : null;
  return {
    project: planned.project,
    queue: enqueued.queue,
    entries: planned.added,
    tasks: enqueued.tasks,
    collisions: map.collisions,
    skipped: map.skipped,
    emptyHtml: marker,
  };
}
