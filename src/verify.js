/**
 * Vérification d'une aspiration existante — lot `WP-38` (`D-068`).
 *
 * Une aspiration terminée peut être **fausse** sans que personne ne le sache : un fichier
 * supprimé à la main, une restauration partielle, un disque plein qui a tronqué une écriture.
 * La file, elle, dit toujours `DONE` — elle décrit ce qui a été décidé, pas ce qui est là.
 *
 * Ce module compare donc **la file au disque**, sans réseau : il ne re-télécharge rien, il
 * ne corrige rien. Il répond à trois questions, dans cet ordre :
 *
 *  1. les fichiers que la file croit terminés sont-ils présents, et de la bonne taille ?
 *  2. ceux qui ne le sont pas existent-ils quand même (téléchargement interrompu avant
 *     promotion) ?
 *  3. y a-t-il, dans l'arborescence, des fichiers dont la file ne parle pas ?
 *
 * La troisième question est la plus utile et la plus piégeuse : elle doit ignorer les
 * fichiers de travail de l'outil (`queue.json`, projet, `empty.html`, `.xdm-part.json`),
 * sinon chaque vérification signalerait ses propres traces.
 *
 * @module verify
 */

import { readdir, readFile, stat as fsStat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { EMPTY_HTML_NAME } from './grabber.js';
import { PART_SUFFIX } from './part-file.js';
import { WORK_SUFFIX } from './promote.js';
import { QUEUE_FILE } from './task-queue.js';

/**
 * Un chemin relatif ressemble-t-il à un fichier de l'outil (et non à du contenu aspiré) ?
 *
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isToolFile(relativePath) {
  const path = relativePath.split(sep).join('/');
  if (path === QUEUE_FILE || path === EMPTY_HTML_NAME) return true;
  if (path.endsWith('.xdmspider.json')) return true;
  // Le suffixe du fichier d'état vient de `part-file.js` et celui du fichier de travail de
  // `promote.js` : les redéfinir ici créerait deux vérités qui divergeraient un jour.
  if (path.endsWith(PART_SUFFIX)) return true;
  return path.endsWith(WORK_SUFFIX);
}

/**
 * Liste les fichiers d'une arborescence, en chemins relatifs normalisés (`/`).
 *
 * Les dossiers sont parcourus récursivement ; les liens symboliques sont **suivis comme des
 * fichiers** (un lien cassé lève, et c'est une information : l'arborescence n'est pas saine).
 *
 * @param {string} rootDir
 * @returns {Promise<{files: Map<string, number>, dirs: number, errors: {path: string,
 *   message: string}[]}>} chemins relatifs → taille
 */
export async function walkTree(rootDir) {
  /** @type {Map<string, number>} */
  const files = new Map();
  /** @type {{path: string, message: string}[]} */
  const errors = [];
  let dirs = 0;

  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: relative(rootDir, dir) || '.', message: String(error?.message ?? error) });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs += 1;
        await walk(full);
        continue;
      }
      // Fichiers réguliers **et** liens symboliques : un lien est du contenu visible pour
      // l'utilisateur, donc il compte dans l'arborescence.
      try {
        const stats = await fsStat(full);
        files.set(relative(rootDir, full).split(sep).join('/'), stats.size);
      } catch (error) {
        errors.push({ path: relative(rootDir, full), message: String(error?.message ?? error) });
      }
    }
  };

  await walk(rootDir);
  return { files, dirs, errors };
}

/**
 * Compare une file au contenu du dossier cible.
 *
 * @param {{rootDir: string, tasks: object[], stat?: typeof fsStat,
 *   walk?: typeof walkTree}} options
 * Quatre listes, nommées par ce qu'elles disent :
 *  - `missing` : la file dit `DONE`, le fichier n'est pas là ;
 *  - `truncated` : le fichier est là mais sa taille ne correspond pas à celle annoncée ;
 *  - `partial` : le fichier existe alors que la tâche n'est pas terminée (écriture interrompue
 *    avant promotion) — anormal mais reprenable ;
 *  - `absent` : la tâche n'est pas terminée et rien n'a été écrit — le cas normal d'une
 *    aspiration partielle, listé pour que le compte soit complet.
 *
 * @returns {Promise<{checked: number, ok: number, missing: object[], truncated: object[],
 *   partial: object[], absent: object[], unmanaged: {path: string, size: number}[],
 *   errors: object[], totalBytes: number, diskBytes: number, ok_: boolean}>}
 */
export async function verifyGrab({ rootDir, tasks, stat = fsStat, walk = walkTree }) {
  const list = Array.isArray(tasks) ? tasks : [];
  const tree = await walk(rootDir);
  const onDisk = tree.files;

  /** @type {object[]} */
  const missing = [];
  /** @type {object[]} */
  const truncated = [];
  /** @type {object[]} */
  const partial = [];
  /** @type {object[]} */
  const absent = [];
  let ok = 0;
  let diskBytes = 0;
  const managed = new Set();

  for (const task of list) {
    const relativePath = relative(rootDir, task.target).split(sep).join('/');
    managed.add(relativePath);
    const size = onDisk.get(relativePath);
    const expected = Number.isSafeInteger(task.totalSize) && task.totalSize > 0
      ? task.totalSize
      : null;

    if (size === undefined) {
      // Un fichier attendu `DONE` et absent est le cas grave ; une tâche `PENDING` n'a
      // simplement pas encore été téléchargée, ce n'est pas une anomalie.
      if (task.state === 'DONE') missing.push({ id: task.id, url: task.url, path: relativePath });
      else absent.push({ id: task.id, state: task.state, path: relativePath });
      continue;
    }

    diskBytes += size;
    if (expected !== null && size !== expected) {
      truncated.push({
        id: task.id, url: task.url, path: relativePath, expected, found: size,
      });
      continue;
    }
    if (task.state === 'DONE') ok += 1;
    else partial.push({ id: task.id, state: task.state, path: relativePath, size, expected });
  }

  /** @type {{path: string, size: number}[]} */
  const unmanaged = [];
  for (const [path, size] of [...onDisk.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (managed.has(path) || isToolFile(path)) continue;
    unmanaged.push({ path, size });
  }

  // Le disque peut aussi contenir la carte de morceaux d'un fichier non promu : elle est
  // comptée par `walkTree` mais filtrée ici comme fichier de l'outil.
  const report = {
    checked: list.length,
    ok,
    missing,
    truncated,
    partial,
    absent,
    unmanaged,
    errors: tree.errors,
    totalBytes: list.reduce(
      (sum, task) => sum + (Number.isSafeInteger(task.totalSize) && task.totalSize > 0 ? task.totalSize : 0),
      0,
    ),
    diskBytes,
  };
  return { ...report, ok_: missing.length === 0 && truncated.length === 0 && tree.errors.length === 0 };
}

/**
 * Lit un projet d'aspiration sans le valider comme `loadProject` (qui exige un schéma) :
 * utilisé par la vérification, où un projet illisible ne doit pas empêcher de lire la file.
 *
 * @param {string} path
 * @returns {Promise<object|null>}
 */
export async function readProjectQuietly(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
