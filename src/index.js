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
  mergeResumeChunks,
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
  fetchText,
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
export {
  DEFAULT_DEPTH,
  DEFAULT_MAX_PAGES,
  PAGE_EXTENSIONS,
  USER_AGENT,
  canonicalUrl,
  classifyLink,
  documentBase,
  crawl,
  extractLinks,
  isAllowed,
  isPageUrl,
  parseCrawlDelay,
  parseRobots,
  robotsUrl,
  sameSiteHost,
  sameOrigin,
} from './crawler.js';
export {
  EMPTY_HTML,
  EMPTY_HTML_NAME,
  INDEX_NAME,
  buildSiteMap,
  disambiguate,
  enqueueEntries,
  localPathFor,
  planGrab,
  prepareGrab,
  writeEmptyHtml,
} from './grabber.js';

export {
  PLAYLIST_TYPES,
  isPlaylist,
  parseAttributes,
  parseByteRange,
  parsePlaylist,
  resolveUrl,
  selectVariant,
} from './hls.js';
export {
  MEDIA_BOXES,
  findBox,
  parseBoxes,
  parseSidx,
  readMp4Index,
} from './sidx.js';
export {
  DEFAULT_SEGMENT_EXTENSION,
  assembleMedia,
  downloadMedia,
  extensionOf,
  planMedia,
  segmentName,
} from './media.js';

export {
  CookieError,
  createCookieJar,
  defaultPath,
  domainMatches,
  loadCookieJar,
  parseSetCookie,
  pathMatches,
  saveCookieJar,
  serializeCookieJar,
  withCookies,
} from './cookies.js';
export { INDEX_WINDOW_BYTES, downloadDash } from './dash.js';

export {
  DEFAULT_ACCEPT,
  DEFAULT_USER_AGENT,
  PAGE_ENCODINGS,
  CHUNK_ENCODINGS,
  buildChunkHeaders,
  buildHeaders,
  buildPageHeaders,
  lowercaseKeys,
} from './headers.js';
export {
  FtpError,
  downloadFtp,
  openFtpSession,
  parseFtpUrl,
  parsePasvReply,
} from './ftp.js';
export {
  PROXY_TIMEOUT_MS,
  ProxyError,
  basicProxyAuth,
  createProxyTransport,
  httpConnectTunnel,
  openThroughProxy,
  parseProxyUrl,
  socks5Handshake,
} from './proxy.js';

export {
  DIRECTIVE_TYPES,
  PacError,
  createPacTransport,
  createProxyResolver,
  dnsDomainIs,
  dnsDomainLevels,
  isPlainHostName,
  localHostOrDomainIs,
  parsePac,
  parseProxyResult,
  resolveProxy,
  shExpMatch,
} from './pac.js';
export { digestProxyAuth, parseProxyChallenge } from './proxy.js';

export {
  LIST_ATTRIBUTES,
  URL_ATTRIBUTES,
  absoluteReference,
  isRewritable,
  relativeLink,
  rewriteCss,
  rewriteDocument,
  rewriteHtml,
  rewriteReference,
  siteMapFromEntries,
} from './rewrite.js';
export {
  buildReport,
  csvField,
  formatReport,
  humanBytes,
  humanDuration,
  summarizeCrawl,
  toCsv,
  toMarkdown,
} from './report.js';
export {
  DAY_NAMES,
  ScheduleError,
  createSchedule,
  isOpen,
  minutesOf,
  nextOpening,
  orderTasks,
  parseDays,
  parseTime,
  parseWindow,
  planRun,
} from './schedule.js';

export {
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  RETRYABLE_STATUSES,
  RetryError,
  isRetryableStatus,
  parseRetryAfter,
  planRetry,
  retryDelay,
} from './retry.js';

export {
  MAX_SITEMAPS,
  MAX_SITEMAP_URLS,
  decodeXmlEntities,
  discoverSitemaps,
  parseSitemapDirectives,
  parseSitemapXml,
} from './sitemap.js';
