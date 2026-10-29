/**
 * Boucle de connexions du moteur — lot `WP-21`/`WP-22`.
 *
 * Assemble les briques déjà testées : carte de morceaux (`chunk-map`), taille de
 * morceau (`chunk-policy`), fichier de travail (`work-file`), client HTTP
 * (`http-client`) et détection de divergence (`divergence`).
 *
 * Ce que la boucle garantit, exigence par exigence :
 *  - `EX-A-07` : les morceaux libres sont distribués à des travailleurs, jamais
 *    plus que le nombre de connexions demandé ;
 *  - `EX-A-08` : un serveur sans plages ⇒ **un seul** travailleur et un morceau
 *    unique couvrant tout le fichier ;
 *  - `EX-A-09` : après une coupure, la reprise part du **dernier offset écrit**
 *    (jamais de zéro) ;
 *  - `EX-A-10` : deux vues divergentes d'une même fenêtre ⇒ repli à une
 *    connexion et reprise complète ;
 *  - `EX-A-13` : le nombre de sockets simultanées est plafonné (`maxSockets`,
 *    128 par défaut) ;
 *  - `EX-A-18` : une inactivité de 30 s rouvre la connexion au dernier octet
 *    confirmé, sans perdre le fichier.
 *
 * @module connection-loop
 */

import { chunkSizeFor } from './chunk-policy.js';
import {
  applyRollback,
  completeChunk,
  createChunkMap,
  freeChunks,
  intervals,
  mergeResumeChunks,
  progress,
  validateChunkMap,
} from './chunk-map.js';
import { DEFAULT_OVERLAP, DivergenceGuard, WindowHashes, requestStart } from './divergence.js';
import { IDLE_TIMEOUT_MS, probe, openSegment } from './http-client.js';
import { loadPartFile, savePartFile } from './part-file.js';
import { promote as promoteWork, workPathFor } from './promote.js';
import { MAX_WRITE, openWorkFile } from './work-file.js';

/** Plafond de sockets simultanées (`EX-A-13`). */
export const MAX_SOCKETS = 128;

/** Nombre de tentatives par morceau, reprises comprises (`EX-A-19`). */
export const MAX_ATTEMPTS = 3;

/**
 * Erreur de la boucle, porteuse d'un code stable.
 */
export class DownloadError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Découpe la carte en morceaux de `chunkSize`, chaînés dans l'ordre.
 *
 * Le dernier morceau peut être plus court : c'est la taille du fichier qui
 * commande, jamais l'inverse.
 *
 * @param {{url: string, target: string, totalSize: number, chunkSize: number, created?: string}} init
 * @returns {ReturnType<typeof createChunkMap>}
 */
export function buildChunkMap({ url, target, totalSize, chunkSize, created }) {
  const map = createChunkMap({ url, target, totalSize, chunkSize, created });
  /** @type {{id: number, start: number, next: number, completed: boolean}[]} */
  const chunks = [];
  let id = 0;
  for (let start = 0; start < totalSize; start += chunkSize) {
    id += 1;
    chunks.push({ id, start, next: 0, completed: false });
  }
  for (let i = 0; i < chunks.length - 1; i += 1) chunks[i].next = chunks[i + 1].id;
  map.chunks = chunks;
  const check = validateChunkMap(map);
  if (!check.ok) throw new DownloadError(`carte invalide : ${check.errors[0]}`, 'BAD_MAP');
  return map;
}

/**
 * Nombre de travailleurs effectifs : demandés, bornés par les morceaux et par le
 * plafond de sockets (`EX-A-13`).
 * @param {number} connections
 * @param {number} chunkCount
 * @param {number} maxSockets
 * @returns {number}
 */
export function planWorkers(connections, chunkCount, maxSockets = MAX_SOCKETS) {
  if (!Number.isInteger(chunkCount) || chunkCount <= 0) return 0;
  const wanted = Math.max(1, Math.floor(connections) || 1);
  return Math.max(1, Math.min(wanted, chunkCount, Math.max(1, Math.floor(maxSockets))));
}

/**
 * Lit un flux avec une échéance d'inactivité, en écrivant au fil de l'eau.
 *
 * @param {AsyncIterable<Uint8Array>} stream
 * @param {{work: {writeAt: (b: Uint8Array, o: number) => Promise<number>},
 *   offset: number, limit: number, idleMs: number, hashes?: WindowHashes,
 *   skip?: number}} options `skip` : octets de recouvrement à ne **pas** réécrire
 * @returns {Promise<{written: number, resumeAt: number, head: Uint8Array, tail: Uint8Array}>}
 */
async function pumpSegment(stream, { work, offset, limit, idleMs, hashes, skip = 0 }) {
  const iterator = stream[Symbol.asyncIterator]();
  let written = 0;
  let tail = new Uint8Array(0);
  /** Fenêtre de tête, conservée pour la vérification de recouvrement. */
  let head = new Uint8Array(0);
  let remainingSkip = skip;
  while (written < limit) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const idle = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new DownloadError(
          `inactivité > ${idleMs} ms`,
          'IDLE_TIMEOUT',
          { resumeAt: offset + written },
        ));
      }, idleMs);
    });
    idle.catch(() => {});

    /** @type {IteratorResult<Uint8Array>} */
    let step;
    try {
      step = await Promise.race([iterator.next(), idle]);
    } catch (error) {
      // Abandon sans attendre : `return()` sur une réponse encore ouverte peut ne
      // jamais se résoudre si le serveur se tait. `destroy()` coupe la socket.
      if (typeof (/** @type {any} */ (stream).destroy) === 'function') {
        /** @type {any} */ (stream).destroy();
      } else if (typeof iterator.return === 'function') {
        iterator.return(undefined).catch(() => {});
      }
      if (error instanceof DownloadError) throw error;
      throw new DownloadError(String(error?.message ?? error), 'SEGMENT_FAILED', {
        resumeAt: offset + written,
      });
    } finally {
      clearTimeout(timer);
    }
    if (step.done) break;

    const raw = Buffer.from(step.value.buffer, step.value.byteOffset, step.value.byteLength);
    if (raw.byteLength === 0) continue;
    if (head.byteLength === 0) head = Uint8Array.from(raw.subarray(0, MAX_WRITE));
    // Les premiers octets peuvent être la fenêtre de recouvrement déjà écrite.
    let received = raw;
    if (remainingSkip > 0) {
      const drop = Math.min(remainingSkip, received.byteLength);
      remainingSkip -= drop;
      received = received.subarray(drop);
      if (received.byteLength === 0) continue;
    }
    if (hashes) hashes.update(received);
    tail = received;
    for (let done = 0; done < received.byteLength; done += MAX_WRITE) {
      const slice = received.subarray(done, Math.min(done + MAX_WRITE, received.byteLength));
      await work.writeAt(slice, offset + written + done);
    }
    written += received.byteLength;
  }
  if (typeof iterator.return === 'function') await iterator.return(undefined).catch(() => {});
  return {
    written,
    resumeAt: offset + written,
    head: Uint8Array.from(head),
    tail: Uint8Array.from(tail),
  };
}

/**
 * Télécharge `url` dans le fichier de travail de `target`.
 *
 * Ne promeut **pas** le fichier : la promotion est une décision séparée
 * (`promote.js`, `EX-A-12`).
 *
 * @param {string} url
 * @param {string} target chemin final visé
 * @param {{transport?: Function, connections?: number, maxSockets?: number,
 *   profile?: 'default'|'fine'|'coarse', chunkSize?: number, idleMs?: number,
 *   overlap?: number, maxAttempts?: number, ifRange?: string | null,
 *   onProgress?: (state: {done: number, total: number}) => void}} [options]
 * @returns {Promise<{target: string, workPath: string, size: number, connections: number,
 *   chunkSize: number, requests: number, restarts: number, divergence: boolean,
 *   attempts: number}>}
 */
export async function download(url, target, {
  transport,
  connections = 4,
  maxSockets = MAX_SOCKETS,
  profile = 'default',
  chunkSize,
  idleMs = IDLE_TIMEOUT_MS,
  overlap = DEFAULT_OVERLAP,
  maxAttempts = MAX_ATTEMPTS,
  ifRange = null,
  resume = true,
  promote = false,
  maxSize = null,
  onProgress = () => {},
} = {}) {
  const capabilities = await probe(url, transport ? { transport } : {});
  if (capabilities.size === null) {
    throw new DownloadError(
      `taille inconnue pour ${capabilities.finalUrl}`,
      'UNKNOWN_SIZE',
      { url },
    );
  }
  const size = capabilities.size;
  // Plafond de taille (`D-067`) : refusé **après la sonde, avant tout octet écrit**. Un
  // serveur qui annonce 4 Gio alors qu'on visait un PDF de 2 Mio ne doit pas remplir le disque
  // avant qu'on s'en aperçoive ; et le fichier local ne doit pas exister à moitié.
  if (maxSize !== null && size > maxSize) {
    throw new DownloadError(
      `fichier trop volumineux : ${size} octets (plafond ${maxSize})`,
      'TOO_LARGE',
      { url: capabilities.finalUrl, size, maxSize },
    );
  }
  const single = capabilities.acceptRanges !== true;
  const effectiveConnections = single
    ? 1
    : Math.max(1, Math.min(Math.floor(connections) || 1, Math.floor(maxSockets) || 1));
  const effectiveChunkSize = single
    ? size
    : Math.max(1, Math.min(chunkSize ?? chunkSizeFor(size, { profile }), size));

  const workPath = workPathFor(target);
  /** @type {ReturnType<typeof createChunkMap> | null} */
  let resumedMap = null;
  if (resume) {
    try {
      const existing = /** @type {any} */ (await loadPartFile(target));
      if (existing.totalSize === size) {
        // `A-21` : les morceaux de reprise adjacents sont recollés avant de servir.
        resumedMap = mergeResumeChunks(existing);
      }
    } catch {
      // Pas de carte, carte illisible ou invalide : on repart d'une carte neuve.
      resumedMap = null;
    }
  }
  // `EX-C-03` : en reprise, on renvoie le validateur **enregistré dans la carte**, pas
  // celui de la sonde — la sonde voit déjà le nouveau fichier, elle ne peut donc pas
  // détecter un changement survenu entre deux exécutions.
  const storedValidator = resumedMap
    ? (resumedMap.etag ?? resumedMap.lastModified ?? null)
    : null;
  const remoteValidator = capabilities.etag ?? capabilities.lastModified ?? null;
  let discarded = false;
  if (storedValidator && remoteValidator && storedValidator !== remoteValidator) {
    // Le fichier a changé pendant l'interruption : la carte acquise est périmée.
    resumedMap = null;
    discarded = true;
  }
  const validator = ifRange ?? (resumedMap !== null ? storedValidator : null);
  const work = await openWorkFile(workPath, size, { fresh: resumedMap === null });
  const stats = { requests: 0, restarts: discarded ? 1 : 0, divergence: false, attempts: 0 };
  const guard = new DivergenceGuard({ overlap });

  try {
    const freshMap = (chunkSize) => ({
      ...buildChunkMap({
        url,
        target,
        totalSize: size,
        chunkSize,
        created: new Date(0).toISOString(),
      }),
      // Le validateur est la mémoire de la reprise (`EX-C-03`).
      ...(remoteValidator ? { etag: capabilities.etag ?? undefined, lastModified: capabilities.lastModified ?? undefined } : {}),
    });
    let map = resumedMap ?? freshMap(effectiveChunkSize);
    // Les écritures de carte sont sérialisées : une seule écriture atomique à la
    // fois, et la dernière écrite reflète l'état le plus récent.
    let saving = Promise.resolve();
    const persist = (current) => {
      saving = saving.then(() => savePartFile(target, current)).catch(() => {});
      return saving;
    };
    await persist(map);

    const fetchChunk = async (id) => {
      let interval = intervals(map).find((i) => i.id === id);
      let cursor = interval.start;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        stats.attempts += 1;
        const requestFrom = requestStart(cursor, overlap);
        const segment = await openSegment(
          capabilities.finalUrl,
          { start: requestFrom, size: interval.end - requestFrom },
          { ...(transport ? { transport } : {}), ifRange: validator },
        );
        stats.requests += 1;

        // Une reprise qui reçoit `200` alors qu'elle demandait une plage au milieu du
        // fichier est une reprise invalide : mieux vaut tout reprendre que tout mélanger.
        if (segment.ranged !== true && resumedMap !== null && cursor > 0) {
          throw new DownloadError('ressource modifiée : redémarrage complet', 'RESTART', {
            url: capabilities.finalUrl,
            cursor,
            etag: capabilities.etag,
          });
        }

        if (segment.ranged !== true || single) {
          // Pas de plage : le flux couvre tout le fichier depuis 0.
          const hashes = new WindowHashes(overlap);
          const outcome = await pumpSegment(segment.stream, {
            work,
            offset: 0,
            limit: size,
            idleMs,
            hashes,
          });
          if (outcome.written !== size) {
            throw new DownloadError(
              `flux incomplet : ${outcome.written}/${size}`,
              'SHORT_BODY',
              { written: outcome.written, size },
            );
          }
          guard.recordTrail(size, outcome.tail);
          for (const chunk of intervals(map)) map = completeChunk(map, chunk.id);
          await persist(map);
          onProgress({ done: progress(map).downloaded, total: size });
          return;
        }

        const hashes = new WindowHashes(overlap);
        let outcome;
        try {
          outcome = await pumpSegment(segment.stream, {
            work,
            offset: cursor,
            limit: interval.end - cursor,
            idleMs,
            hashes,
            skip: cursor - requestFrom,
          });
        } catch (error) {
          // Une inactivité (`IDLE_TIMEOUT`) et une coupure de socket (`SEGMENT_FAILED`) sont
          // la même situation vue de la carte : le morceau n'est pas clos, mais les octets
          // déjà écrits sont bons. On rouvre la plage à `resumeAt` et on réessaie dans la
          // limite des tentatives — un incident réseau ne doit pas condamner une tâche que
          // la file devrait ensuite rejouer à la main.
          const recoverable = error instanceof DownloadError
            && (error.code === 'IDLE_TIMEOUT' || error.code === 'SEGMENT_FAILED');
          if (recoverable) {
            stats.restarts += 1;
            const resumeAt = /** @type {number} */ (error.details.resumeAt);
            if (resumeAt > cursor) {
              cursor = resumeAt;
              map = applyRollback(map, id, cursor);
              interval = intervals(map).find((i) => i.id === id);
            }
            continue;
          }
          throw error;
        }

        if (outcome.written < interval.end - cursor) {
          cursor = outcome.resumeAt;
          map = applyRollback(map, id, cursor);
          interval = intervals(map).find((i) => i.id === id);
          continue;
        }

        // Cohérence des fenêtres de recouvrement (`EX-A-10`) : la tête de ce que
        // la connexion a vu avant `interval.start` doit être identique à la traîne
        // que le morceau précédent a écrite.
        if (requestFrom < interval.start) {
          const status = guard.recordLead(
            interval.start,
            outcome.head.subarray(0, interval.start - requestFrom),
          );
          if (status === 'divergent') {
            throw new DownloadError('divergence de contenu entre connexions', 'DIVERGENT', {
              conflict: guard.firstConflict,
            });
          }
        }
        if (guard.recordTrail(interval.end, outcome.tail) === 'divergent') {
          throw new DownloadError('divergence de contenu entre connexions', 'DIVERGENT', {
            conflict: guard.firstConflict,
          });
        }

        map = completeChunk(map, id);
        await persist(map);
        onProgress({ done: progress(map).downloaded, total: size });
        return;
      }
      throw new DownloadError(
        `morceau ${id} : ${maxAttempts} tentatives épuisées`,
        'ATTEMPTS_EXHAUSTED',
        { id, cursor },
      );
    };

    /** Morceaux réservés par un travailleur mais pas encore clos. */
    const inFlight = new Set();
    /** Réservation synchrone : deux travailleurs ne peuvent pas viser le même morceau. */
    const claim = () => {
      const free = freeChunks(map).filter((c) => !inFlight.has(c.id));
      if (free.length === 0) return null;
      inFlight.add(free[0].id);
      return free[0];
    };

    const runPool = async (workers) => {
      await Promise.all(
        Array.from({ length: workers }, async () => {
          for (;;) {
            const claimed = claim();
            if (!claimed) return;
            try {
              await fetchChunk(claimed.id);
            } finally {
              inFlight.delete(claimed.id);
            }
          }
        }),
      );
    };

    let restarted = false;
    for (;;) {
      try {
        await runPool(planWorkers(effectiveConnections, map.chunks.length, maxSockets));
        break;
      } catch (error) {
        if (!(error instanceof DownloadError)) throw error;
        if (error.code === 'DIVERGENT' && !stats.divergence) {
          // Repli à une connexion (`EX-A-10`, `D-025`) : on repart d'un morceau unique.
          stats.divergence = true;
          guard.divergent = false;
          guard.windows.clear();
          map = freshMap(size);
          await persist(map);
          continue;
        }
        if (error.code === 'RESTART' && !restarted) {
          // `EX-C-03` : la ressource a changé sous la reprise. On repart d'une carte
          // neuve ; toutes les plages seront réécrites, aucune ligne n'est mélangée.
          restarted = true;
          stats.restarts += 1;
          resumedMap = null;
          guard.divergent = false;
          guard.windows.clear();
          map = freshMap(effectiveChunkSize);
          await persist(map);
          continue;
        }
        throw error;
      }
    }

    const finalProgress = progress(map);
    if (finalProgress.downloaded !== size) {
      throw new DownloadError(
        `téléchargement incomplet : ${finalProgress.downloaded}/${size}`,
        'INCOMPLETE',
        { downloaded: finalProgress.downloaded, size },
      );
    }
    let promotedPath = null;
    if (promote) {
      const done = await promoteWork({ workPath, target, map });
      promotedPath = done.target;
    }
    return {
      target,
      workPath,
      size,
      connections: stats.divergence ? 1 : effectiveConnections,
      chunkSize: stats.divergence ? size : effectiveChunkSize,
      requests: stats.requests,
      restarts: stats.restarts,
      divergence: stats.divergence,
      attempts: stats.attempts,
      resumed: resumedMap !== null,
      promoted: promotedPath,
    };
  } finally {
    await work.close();
  }
}
