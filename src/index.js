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
export {
  DEFAULT_EXCLUDE_MOTIFS,
  FIRST_FILTER_ID,
  PROJECT_SUFFIX,
  addEntry,
  addFilter,
  classifyUrl,
  createProject,
  fileNameOf,
  findFilterList,
  globToRegExp,
  loadProject,
  matchesMotif,
  moveFilter,
  normalizeUrl,
  projectPath,
  removeFilter,
  saveProject,
  setFilterActive,
  splitMotif,
  validateProject,
} from "./project.js";
export {
  DEFAULT_MAX_ACTIVE,
  QUEUE_FILE,
  TASK_STATES,
  TRANSITIONS,
  activeCount,
  addTask,
  beginVerification,
  completeTask,
  createQueue,
  failTask,
  fillSlots,
  isIdle,
  loadQueue,
  pauseTask,
  queuePath,
  recoverAfterCrash,
  resumeTask,
  saveQueue,
  startNext,
  stats,
  transition,
  validateQueue,
} from "./task-queue.js";
export {
  MAX_NAME_BYTES,
  PromotionError,
  WORK_SUFFIX,
  checkReadyToPromote,
  discard,
  fileNameFromUrl,
  promote,
  sanitizeFileName,
  targetPathFor,
  workPathFor,
} from "./promote.js";
export {
  BASE_HEADERS,
  HttpError,
  IDLE_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_URL_LENGTH,
  acceptsRanges,
  announcedSize,
  assertUrlLength,
  chunkRangeHeader,
  defaultTransport,
  isRedirect,
  normalizeHeaders,
  openSegment,
  parseContentRange,
  planConnections,
  probe,
  rangeHeader,
  readWithIdleTimeout,
  resolveLocation,
  resumeRangeHeader,
} from './http-client.js';
export {
  DEFAULT_OVERLAP,
  DivergenceGuard,
  MIN_OVERLAP,
  WindowHashes,
  digest,
  overlapBefore,
  overlapKey,
  requestStart,
} from './divergence.js';
export {
  DownloadError,
  MAX_ATTEMPTS,
  MAX_SOCKETS,
  buildChunkMap,
  download,
  planWorkers,
} from './connection-loop.js';
