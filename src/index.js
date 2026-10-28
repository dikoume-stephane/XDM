/**
 * Point d'entrée du socle XDM (`WP-20`).
 *
 * Le socle est volontairement sans dépendance : Node 22 + ES modules + JSDoc
 * (décision D-034). Aucun build, aucun `node_modules` requis pour les tests.
 */

export {
  DEFAULT_CHUNK_SIZE,
  applyRollback,
  chainOrder,
  completeChunk,
  createChunkMap,
  freeChunks,
  intervals,
  progress,
  validateChunkMap,
} from "./chunk-map.js";
export {
  MAX_CHUNK_SIZE,
  MIB,
  MIN_CHUNK_SIZE,
  PROFILES,
  chunkSizeFor,
  plannedChunkCount,
} from "./chunk-policy.js";
export { PART_SUFFIX, loadPartFile, partPath, removePartFile, savePartFile } from "./part-file.js";
export { MAX_WRITE, openWorkFile } from "./work-file.js";
