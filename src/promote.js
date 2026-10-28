/**
 * Nom du fichier final et promotion du fichier de travail (fiche A §3.2, §7).
 *
 * Chez IDM, la fin d'un téléchargement est une séquence de renommages
 * (`"Rename temp file %s to %s."`, `"Delete old file %s"`, annexe 14 §7) qui
 * n'a lieu **qu'après** contrôle de la carte et de la taille
 * (`"Rebuilding complete, real size = %I64d"`). XDM reproduit l'intention avec
 * une garantie plus forte : un `rename()` POSIX, atomique, après vérification.
 *
 * Le nom final est déduit de l'URL puis **assaini** : un `..` ou un séparateur
 * de chemin dans le dernier segment ne doit jamais sortir du dossier cible
 * (fiche A, `EX-A-14`).
 */

import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { intervals, progress, validateChunkMap } from "./chunk-map.js";
import { partPath, removePartFile } from "./part-file.js";

/** Préfixe du fichier de données de travail. */
export const WORK_SUFFIX = ".xdm-part";

/** Longueur maximale d'un nom de fichier produit (octets UTF-8). */
export const MAX_NAME_BYTES = 200;

/** Noms réservés DOS/Windows, insensibles à la casse et à l'extension. */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Assainit un nom de fichier : supprime toute composante de chemin, les
 * caractères de contrôle et les caractères interdits, neutralise les noms
 * réservés, borne la longueur. Ne renvoie jamais de chaîne vide.
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeFileName(raw) {
  let name = String(raw);

  // Décodage défensif : un nom peut arriver encodé (%20, %2e%2e…).
  try {
    name = decodeURIComponent(name);
  } catch {
    /* nom déjà décodé ou séquence invalide : on garde la forme brute */
  }

  // Une seule composante de chemin est retenue : la dernière. Un nom de
  // fichier n'a jamais à porter de répertoire, et « .. » ne peut donc pas
  // désigner le parent.
  const lastSegment = name.split(/[\\/]+/).filter((part) => part !== "").at(-1) ?? "";
  name = lastSegment
    .replace(/[\u0000-\u001f\u007f]/g, "") // caractères de contrôle
    .replace(/[<>:"|?*]/g, "_") // interdits Windows
    .replace(/\.{2,}/g, ".") // suites de points
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, ""); // ni point ni espace final (Windows)

  if (name === "" || name === ".") name = "download";

  const base = name.replace(/\.[^.]*$/, "");
  if (RESERVED.has(base.toLowerCase())) name = `_${name}`;

  if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
    const stem = name.slice(0, name.length - ext.length);
    let cut = stem;
    while (Buffer.byteLength(cut + ext, "utf8") > MAX_NAME_BYTES) cut = cut.slice(0, -1);
    name = `${cut || "download"}${ext}`;
  }
  return name;
}

/**
 * Déduit un nom de fichier d'une URL : dernier segment du chemin, décodé puis
 * assaini ; à défaut, le nom d'hôte, puis `download`.
 * @param {string} rawUrl
 * @returns {string}
 */
export function fileNameFromUrl(rawUrl) {
  let candidate = "";
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    // Une URL terminée par « / » désigne un répertoire : on retombe sur l'hôte.
    candidate = url.pathname.endsWith("/") ? "" : (segments.at(-1) ?? "");
    if (candidate === "") candidate = url.hostname || "download";
  } catch {
    candidate = String(rawUrl).split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  }
  return sanitizeFileName(candidate);
}

/**
 * Erreur de promotion : la carte ou le fichier ne permettent pas de livrer.
 */
export class PromotionError extends Error {
  /** @param {string} message @param {string} [reason] */
  constructor(message, reason = "invalide") {
    super(message);
    this.name = "PromotionError";
    this.reason = reason;
  }
}

/**
 * Contrôle que la carte autorise la promotion (`EX-A-11`, `EX-A-12`) :
 * carte valide, **tous** les morceaux clos, et somme des intervalles = taille.
 * @param {object} map
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkReadyToPromote(map) {
  const verdict = validateChunkMap(map);
  if (!verdict.ok) return { ok: false, errors: verdict.errors };

  const pending = intervals(map).filter((interval) => !interval.completed);
  if (pending.length > 0) {
    const ids = pending.map((interval) => interval.id).join(", ");
    return { ok: false, errors: [`morceaux non clos : ${ids}`] };
  }
  const { downloaded, total } = progress(map);
  if (downloaded !== total) {
    return { ok: false, errors: [`progression incomplète : ${downloaded}/${total}`] };
  }
  return { ok: true, errors: [] };
}

/**
 * Promeut le fichier de travail en fichier final.
 *
 * Séquence : vérifier la carte → vérifier la taille sur disque → `rename`
 * atomique → supprimer la carte. Un échec **ne supprime rien** : le fichier de
 * travail et la carte restent en place pour une reprise.
 *
 * @param {{workPath: string, target: string, map: object}} options
 * @returns {Promise<{target: string, size: number}>}
 */
export async function promote({ workPath, target, map }) {
  const ready = checkReadyToPromote(map);
  if (!ready.ok) {
    throw new PromotionError(`promotion refusée : ${ready.errors[0]}`, "carte");
  }

  let size;
  try {
    ({ size } = await stat(workPath));
  } catch (cause) {
    throw new PromotionError(`fichier de travail absent : ${workPath}`, "fichier");
  }
  if (size !== map.totalSize) {
    throw new PromotionError(
      `taille incohérente : ${size} octets sur disque, ${map.totalSize} attendus`,
      "taille",
    );
  }

  // rename() est atomique : soit l'ancien nom, soit le nouveau, jamais un
  // fichier partiel. Il écrase la cible précédente, comme "Delete old file"
  // suivi de "Rename temp file" chez IDM.
  await rename(workPath, target);
  await removePartFile(target);

  return { target, size };
}

/**
 * Nettoie un téléchargement abandonné : fichier de travail puis carte.
 * L'ordre inverse de `promote` serait une fuite de données.
 * @param {{workPath: string, target: string}} options
 * @returns {Promise<void>}
 */
export async function discard({ workPath, target }) {
  await rm(workPath, { force: true });
  await removePartFile(target);
}

/** Chemin du fichier de travail pour une cible donnée. */
export const workPathFor = (target) => `${target}${WORK_SUFFIX}`;

/** Chemin de la carte (rappel, pour les appelants). */
export { partPath };

/** Joint un dossier et un nom déjà assaini. */
export const targetPathFor = (directory, name) => join(directory, sanitizeFileName(name));
