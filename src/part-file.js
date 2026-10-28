/**
 * Persistance de la carte de morceaux — `<cible>.xdm-part.json` (D-024, D-030).
 *
 * Remplace la clé de registre `Software\DownloadManager\<id>\ChList` utilisée
 * par IDM. Écriture **atomique** : fichier temporaire, `fsync`, `rename`. Une
 * coupure laisse donc soit l'ancienne carte, soit la nouvelle, jamais un
 * mélange (fiche A, `EX-A-12`).
 */

import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { validateChunkMap } from "./chunk-map.js";

/** Suffixe du fichier de carte. */
export const PART_SUFFIX = ".xdm-part.json";

/**
 * Chemin du fichier annexe pour une cible donnée.
 * @param {string} target
 * @returns {string}
 */
export function partPath(target) {
  return `${target}${PART_SUFFIX}`;
}

/**
 * Écrit la carte de façon atomique.
 * @param {string} target chemin du fichier final
 * @param {object} map carte à persister
 * @returns {Promise<string>} chemin écrit
 */
export async function savePartFile(target, map) {
  const { ok, errors } = validateChunkMap(map);
  if (!ok) throw new Error(`carte refusée à l'écriture : ${errors[0]}`);

  const destination = partPath(target);
  const temporary = join(dirname(destination), `.${process.pid}.tmp.part`);
  const payload = `${JSON.stringify(map, null, 2)}\n`;

  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  return destination;
}

/**
 * Relit la carte. Une carte invalide est **rejetée** (D-030) : aucune réparation
 * silencieuse, l'appelant doit demander une confirmation avant de repartir de zéro.
 * @param {string} target
 * @returns {Promise<object>} carte validée
 */
export async function loadPartFile(target) {
  const path = partPath(target);
  const text = await readFile(path, "utf8");
  let map;
  try {
    map = JSON.parse(text);
  } catch (cause) {
    throw new Error(`carte illisible (JSON invalide) : ${path}`, { cause });
  }
  const { ok, errors } = validateChunkMap(map);
  if (!ok) throw new Error(`carte rejetée : ${errors[0]}`);
  return map;
}

/**
 * Supprime la carte (après promotion du fichier final).
 * @param {string} target
 * @returns {Promise<void>}
 */
export async function removePartFile(target) {
  try {
    await unlink(partPath(target));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
}
