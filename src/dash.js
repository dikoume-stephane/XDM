/**
 * Téléchargement d'un média MP4 segmenté par son index `sidx` — `WP-26`, fiche D
 * (`EX-D-08`).
 *
 * **Pas de manifeste** : `H-19` établit qu'IDM ne parse pas de `MPD` ; XDM suit la même
 * ligne (`D-047`). L'entrée est donc un **fichier** (ou deux : init + média) et l'index
 * `sidx` qu'il contient décrit les sous-segments : offsets et tailles absolus, calculés par
 * `src/sidx.js`. On télécharge ensuite chaque plage par `Range`, avec `openSegment`.
 *
 * Ce que ce module ne fait pas : ni déchiffrement (aucun DRM, `D-004`), ni fusion des
 * segments en un fichier lisible (un `moov` fragmenté ne se concatène pas comme des TS).
 * Il laisse l'init et les segments côte à côte, ce qui est la seule forme honnête.
 *
 * @module dash
 */

import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultTransport, openSegment } from './http-client.js';
import { parseBoxes, parseSidx } from './sidx.js';

/** Fenêtre lue pour trouver l'index : suffisante pour `ftyp`+`moov`+`sidx` d'un en-tête. */
export const INDEX_WINDOW_BYTES = 64 * 1024;

/**
 * Lit un flux jusqu'à `maxBytes`, en fermant proprement.
 * @param {AsyncIterable<Buffer>} stream
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readStream(stream, maxBytes) {
  /** @type {Buffer[]} */
  const parts = [];
  let total = 0;
  for await (const chunk of stream) {
    const usable = chunk.subarray(0, Math.max(0, maxBytes - total));
    if (usable.length > 0) {
      parts.push(Buffer.from(usable));
      total += usable.length;
    }
    if (total >= maxBytes) break;
  }
  return Buffer.concat(parts, total);
}

/**
 * Télécharge une plage d'octets dans un fichier.
 * @param {string} url
 * @param {string} target
 * @param {number} start
 * @param {number} size
 * @param {{transport?: Function}} [options]
 * @returns {Promise<number>} octets écrits
 */
async function fetchRange(url, target, start, size, { transport } = {}) {
  const segment = await openSegment(url, { start, size }, { ...(transport ? { transport } : {}) });
  if (segment.ranged !== true) {
    // Un serveur sans plages ne permet pas le téléchargement segmenté : on le dit.
    segment.stream?.destroy?.();
    throw new Error(`le serveur ne gère pas les plages : ${url}`);
  }
  const handle = await open(target, 'w');
  let written = 0;
  try {
    for await (const chunk of segment.stream) {
      if (written >= size) break;
      const usable = chunk.subarray(0, size - written);
      await handle.write(usable, 0, usable.length, written);
      written += usable.length;
    }
  } finally {
    await handle.close();
  }
  if (written !== size) throw new Error(`plage incomplète : ${written} / ${size} pour ${target}`);
  return written;
}

/**
 * Télécharge un média segmenté décrit par son `sidx`.
 *
 * @param {{fileUrl: string, directory: string, initUrl?: string | null,
 *   transport?: Function, maxSegments?: number,
 *   segmentExtension?: string, onEvent?: (event: object) => void}} options
 * @returns {Promise<{directory: string, fileUrl: string, initUrl: string | null,
 *   init: string | null, segments: {index: number, name: string, offset: number,
 *     size: number, duration: number}[],
 *   bytes: number, files: string[], timescale: number}>}
 */
export async function downloadDash({
  fileUrl,
  directory,
  initUrl = null,
  transport,
  maxSegments,
  segmentExtension = '.m4s',
  onEvent = () => {},
}) {
  await mkdir(directory, { recursive: true });

  // 1. L'en-tête : on lit juste assez pour trouver `ftyp`/`moov`/`sidx`.
  const head = await openSegment(fileUrl, { start: 0, size: INDEX_WINDOW_BYTES },
    { ...(transport ? { transport } : {}) });
  if (head.ranged !== true) {
    head.stream?.destroy?.();
    throw new Error(`le serveur ne gère pas les plages : ${fileUrl}`);
  }
  const buffer = await readStream(head.stream, INDEX_WINDOW_BYTES);
  const boxes = parseBoxes(buffer);
  const sidxBox = boxes.find((box) => box.type === 'sidx');
  if (!sidxBox) {
    throw new Error(`aucun index sidx dans les ${buffer.length} premiers octets de ${fileUrl}`);
  }
  if (sidxBox.dataEnd > buffer.length) {
    throw new Error(`index sidx tronqué dans la fenêtre de ${buffer.length} octets`);
  }
  const index = parseSidx(buffer, sidxBox);

  /** @type {string[]} */
  const files = [];
  let bytes = 0;

  // 2. Segment d'initialisation : URL séparée, ou tout ce qui précède le `sidx`.
  let init = null;
  if (initUrl) {
    // URL d'initialisation séparée : un GET ordinaire, sans plage.
    init = join(directory, 'init.mp4');
    const response = await (transport ?? defaultTransport)(initUrl, {
      method: 'GET',
      headers: { 'accept-encoding': 'identity' },
    });
    const body = await readStream(response.stream, Number.MAX_SAFE_INTEGER);
    const handle = await open(init, 'w');
    try {
      await handle.write(body, 0, body.length, 0);
    } finally {
      await handle.close();
    }
    bytes += body.length;
  } else if (sidxBox.offset > 0) {
    init = join(directory, 'init.mp4');
    bytes += await fetchRange(fileUrl, init, 0, sidxBox.offset, { ...(transport ? { transport } : {}) });
  }
  if (init) files.push(init);

  // 3. Sous-segments : offsets et tailles viennent de l'index, jamais d'une heuristique.
  const selected = maxSegments === undefined
    ? index.segments
    : index.segments.slice(0, maxSegments);
  const segments = [];
  for (const segment of selected) {
    const name = `segment-${String(segment.index + 1).padStart(5, '0')}${segmentExtension}`;
    const target = join(directory, name);
    onEvent({ type: 'segment', index: segment.index, offset: segment.offset, size: segment.size });
    bytes += await fetchRange(fileUrl, target, segment.offset, segment.size,
      { ...(transport ? { transport } : {}) });
    files.push(target);
    segments.push({ ...segment, name });
  }

  return {
    directory,
    fileUrl,
    initUrl,
    init,
    segments,
    bytes,
    files,
    timescale: index.timescale,
  };
}
