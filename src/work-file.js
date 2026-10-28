/**
 * Fichier de travail unique, écrit **en place** (D-026, annexe 14 §5.2 et §7).
 *
 * IDM ouvre un seul `<local>.tmp` (CreateFileW en `0x156d48`), le préalloue,
 * puis chaque connexion écrit à son offset avec `SetFilePointer` + `WriteFile`.
 * XDM fait la même chose avec `pwrite` : un seul descripteur, écriture
 * positionnée, aucune écriture séquentielle implicite.
 *
 * Le rollback (§5.3) est une **troncature** : `SetFilePointer(offset validé)`
 * puis `SetEndOfFile` en `0x15ff52`, d'où `rollbackTo()` ici.
 */

import { open } from "node:fs/promises";

/** Taille d'un bloc d'écriture, borne supérieure de sûreté. */
export const MAX_WRITE = 1024 * 1024;

/**
 * @typedef {object} WorkFile
 * @property {(buffer: Uint8Array, offset: number) => Promise<number>} writeAt
 * @property {(offset: number) => Promise<void>} rollbackTo
 * @property {() => Promise<number>} size
 * @property {() => Promise<void>} close
 * @property {string} path
 */

/**
 * Ouvre le fichier de travail et le préalloue à `totalSize`.
 *
 * `fresh: false` conserve le contenu déjà écrit : c'est la reprise (`EX-A-19`),
 * où seuls les morceaux non clos doivent être redemandés.
 *
 * @param {string} path
 * @param {number} totalSize
 * @param {{fresh?: boolean}} [options]
 * @returns {Promise<WorkFile>}
 */
export async function openWorkFile(path, totalSize, { fresh = true } = {}) {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    throw new TypeError("totalSize doit être un entier strictement positif");
  }
  let handle;
  if (fresh) {
    handle = await open(path, "w+");
    // Préallocation logique : le système peut allouer paresseusement (trous).
    await handle.truncate(totalSize);
  } else {
    try {
      handle = await open(path, "r+");
      const { size } = await handle.stat();
      if (size < totalSize) await handle.truncate(totalSize);
    } catch {
      handle = await open(path, "w+");
      await handle.truncate(totalSize);
    }
  }

  return {
    path,

    /**
     * Écrit à l'offset absolu. Refuse toute écriture hors du fichier : c'est
     * l'invariant 5 de la carte (aucune écriture hors de `[0, totalSize)`).
     * @param {Uint8Array} buffer
     * @param {number} offset
     * @returns {Promise<number>} nombre d'octets écrits
     */
    async writeAt(buffer, offset) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new RangeError(`offset invalide : ${offset}`);
      }
      if (offset + buffer.byteLength > totalSize) {
        throw new RangeError(
          `écriture hors fichier : [${offset}, ${offset + buffer.byteLength}) vs ${totalSize}`,
        );
      }
      if (buffer.byteLength > MAX_WRITE) {
        throw new RangeError(`écriture trop grande : ${buffer.byteLength} > ${MAX_WRITE}`);
      }
      const { bytesWritten } = await handle.write(buffer, 0, buffer.byteLength, offset);
      return bytesWritten;
    },

    /**
     * Rollback : tronque au dernier offset confirmé (équivalent de
     * `SetEndOfFile`, `0x15ff52`). La suite du fichier est perdue et devra être
     * réécrite ; la carte, elle, est mise à jour par `applyRollback`.
     * @param {number} offset
     */
    async rollbackTo(offset) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalSize) {
        throw new RangeError(`offset de rollback hors fichier : ${offset}`);
      }
      await handle.truncate(offset);
    },

    async size() {
      const stat = await handle.stat();
      return stat.size;
    },

    async close() {
      await handle.close();
    },
  };
}
