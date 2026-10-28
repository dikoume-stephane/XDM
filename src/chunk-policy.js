/**
 * Politique de taille de morceau (D-029, annexe 14 §5.4).
 *
 * Observé chez IDM : la taille n'est pas une constante mais une fonction de la
 * classe de téléchargement et de la taille du fichier, puis un encadrement.
 * `0x1559e0` rend trois paliers selon la branche de la table d'octets :
 *
 *   branche A (15 classes) : 1 MiB si fichier ≤ 512 Mio, sinon 5 MiB
 *   branche B ( 9 classes) : 5 MiB si fichier ≤ 2 Gio,   sinon 10 MiB
 *   défaut    (147 classes) : 2 MiB si fichier ≤ 512 Mio, sinon 10 MiB
 *
 * puis l'appelant (`0x155bd0`) borne le résultat à [1 MiB, 10 MiB].
 */

export const MIB = 1024 * 1024;
export const MIN_CHUNK_SIZE = 1 * MIB;
export const MAX_CHUNK_SIZE = 10 * MIB;

/** Seuils observés sur la taille du fichier. */
export const THRESHOLD_512_MIB = 512 * MIB;
export const THRESHOLD_2_GIB = 2048 * MIB;

/** @typedef {"default"|"fine"|"coarse"} ChunkProfile */

/**
 * Paliers par profil, tels que lus dans les trois gestionnaires de `0x1559e0`.
 * @type {Record<ChunkProfile, {threshold: number, small: number, large: number}>}
 */
export const PROFILES = {
  /** 147 classes sur 171 : le cas courant. */
  default: { threshold: THRESHOLD_512_MIB, small: 2 * MIB, large: 10 * MIB },
  /** 15 classes : découpage plus fin (branche A). */
  fine: { threshold: THRESHOLD_512_MIB, small: 1 * MIB, large: 5 * MIB },
  /** 9 classes : découpage plus grossier (branche B). */
  coarse: { threshold: THRESHOLD_2_GIB, small: 5 * MIB, large: 10 * MIB },
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Taille de morceau pour un fichier de `totalSize` octets.
 * @param {number} totalSize taille du fichier, en octets (> 0)
 * @param {{profile?: ChunkProfile, min?: number, max?: number}} [options]
 * @returns {number}
 */
export function chunkSizeFor(totalSize, options = {}) {
  const { profile = "default", min = MIN_CHUNK_SIZE, max = MAX_CHUNK_SIZE } = options;
  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    throw new TypeError("totalSize doit être un nombre strictement positif");
  }
  if (min > max) throw new RangeError("min > max");
  const tier = PROFILES[profile];
  if (!tier) throw new RangeError(`profil inconnu : ${profile}`);

  const raw = totalSize <= tier.threshold ? tier.small : tier.large;
  return clamp(raw, min, max);
}

/**
 * Nombre de morceaux visé pour un fichier : au moins 1, et jamais plus que ce
 * que la taille plancher permet (inutile de créer des morceaux vides).
 * @param {number} totalSize
 * @param {number} chunkSize
 * @returns {number}
 */
export function plannedChunkCount(totalSize, chunkSize) {
  if (totalSize <= 0 || chunkSize <= 0) throw new TypeError("tailles strictement positives attendues");
  return Math.max(1, Math.ceil(totalSize / chunkSize));
}
