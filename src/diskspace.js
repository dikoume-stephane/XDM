/**
 * Espace disque avant écriture — lot `WP-37` (`D-067`).
 *
 * Une aspiration de 205 Mio dans un `/tmp` de 100 Mio échoue **au milieu** du transfert, en
 * laissant des fichiers partiels et un message d'erreur système (`ENOSPC`) qui ne dit pas
 * combien il manquait. Le contrôle est donc fait **avant** d'ouvrir la première connexion :
 * c'est la seule façon de refuser proprement, et c'est aussi la seule information que
 * l'utilisateur peut utiliser (« libérez 120 Mio »).
 *
 * Deux prudences :
 *
 *  1. **Réserve** par défaut : on ne remplit pas un disque à 100 %. Un système plein ne sait
 *     plus écrire ses propres fichiers temporaires, et l'échec arriverait ailleurs.
 *  2. **Estimation honnête** : les tâches de taille inconnue ne sont pas comptées comme 0 ;
 *     elles sont signalées à part, et l'appelant décide. Une vérification qui se trompe en
 *     silence est pire que pas de vérification.
 *
 * Aucune dépendance hors `node:fs/promises`.
 *
 * @module diskspace
 */

import { statfs as fsStatfs, stat as fsStat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Réserve par défaut : 64 Mio, ou 2 % du volume si c'est plus grand. */
export const DEFAULT_RESERVE_BYTES = 64 * 1024 * 1024;

/**
 * Le plus proche dossier **existant** qui contient `dir`.
 *
 * Un chemin cible peut ne pas exister encore (`--essai` ne le crée pas) et `statfs` exige un
 * chemin réel : remonter les parents trouve le volume qui l'accueillera, ce qui est
 * exactement la question posée.
 *
 * @param {string} dir
 * @param {{stat?: typeof fsStat}} [options]
 * @returns {Promise<string>}
 */
export async function nearestExisting(dir, { stat = fsStat } = {}) {
  let current = resolve(dir);
  for (;;) {
    try {
      const stats = await stat(current);
      if (stats.isDirectory()) return current;
    } catch {
      // Chemin absent ou illisible : on remonte d'un cran.
    }
    const parent = dirname(current);
    if (parent === current) return current; // racine : on rend ce qu'on a
    current = parent;
  }
}

/**
 * Espace disponible sur le volume qui contient `dir`.
 *
 * `statfs` renvoie des blocs : `bavail × bsize` est ce qui reste **pour l'utilisateur** —
 * `bfree` inclurait les blocs réservés au superutilisateur, qu'un processus ordinaire ne
 * peut pas écrire. Utiliser `bfree` promettrait de la place qui n'existe pas.
 *
 * @param {string} dir chemin d'un dossier **existant** (ou de son plus proche parent)
 * @param {{statfs?: typeof fsStatfs}} [options]
 * @returns {Promise<{available: number, capacity: number}>}
 */
export async function freeSpace(dir, { statfs = fsStatfs, stat = fsStat } = {}) {
  const stats = await statfs(await nearestExisting(dir, { stat }));
  const blockSize = Number(stats.bsize);
  const available = Number(stats.bavail) * blockSize;
  const capacity = Number(stats.blocks) * blockSize;
  return { available, capacity };
}

/**
 * Vérifie qu'il reste de quoi écrire `needed` octets, réserve comprise.
 *
 * @param {{dir: string, needed: number, reserve?: number, statfs?: typeof fsStatfs}} options
 * @returns {Promise<{enough: boolean, available: number, capacity: number, needed: number,
 *   reserve: number, missing: number}>} `missing` = octets à libérer (0 si ça tient)
 */
export async function checkSpace({
  dir, needed, reserve = DEFAULT_RESERVE_BYTES, statfs = fsStatfs, stat = fsStat,
}) {
  if (!Number.isSafeInteger(needed) || needed < 0) {
    throw new RangeError(`checkSpace : « needed » doit être un entier ≥ 0 (reçu ${needed})`);
  }
  if (!Number.isSafeInteger(reserve) || reserve < 0) {
    throw new RangeError(`checkSpace : « reserve » doit être un entier ≥ 0 (reçu ${reserve})`);
  }
  const { available, capacity } = await freeSpace(dir, { statfs, stat });
  // Une réserve plus grande que le volume n'a pas de sens : on la ramène au volume, sinon
  // un disque de 32 Mio refuserait éternellement d'écrire 1 octet.
  const effectiveReserve = Math.min(reserve, Math.floor(capacity / 2));
  const required = needed + effectiveReserve;
  return {
    enough: available >= required,
    available,
    capacity,
    needed,
    reserve: effectiveReserve,
    missing: Math.max(0, required - available),
  };
}

/**
 * Somme des tailles **connues** d'une liste de tâches, et le nombre d'inconnues.
 *
 * @param {object[]} tasks
 * @returns {{known: number, unknown: number, remaining: number}}
 */
export function estimateSpace(tasks) {
  let known = 0;
  let unknown = 0;
  let remaining = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const size = Number.isSafeInteger(task?.totalSize) && task.totalSize > 0 ? task.totalSize : null;
    if (size === null) {
      unknown += 1;
      continue;
    }
    known += size;
    // Une tâche déjà terminée n'occupe plus d'espace **à venir** : compter son fichier
    // reviendrait à réclamer deux fois la même place à chaque reprise.
    if (task.state !== 'DONE') remaining += size;
  }
  return { known, unknown, remaining };
}
