/**
 * Téléchargement d'un flux HLS segment par segment — lot `WP-26`, fiche D.
 *
 * Le principe vient de la fiche D (`EX-D-02`→`EX-D-05`) : une playlist HLS n'est pas un
 * fichier mais une **liste de fichiers**. XDM télécharge donc chaque segment comme un
 * fichier ordinaire, avec le moteur existant (`connection-loop.js` : plages, reprise,
 * promotion), puis laisse les segments sur disque et, sur demande, les assemble.
 *
 * Deux points de méthode :
 *  - **aucun déchiffrement** : une playlist protégée (`#EXT-X-KEY`) est téléchargée telle
 *    quelle et signalée `encrypted: true` (`D-004`, `EX-D-10`) ;
 *  - **l'assemblage est un choix, pas une évidence** : concaténer des segments MPEG-TS
 *    donne un fichier valide, concaténer des fragments fMP4 sans leur init ne donne rien.
 *    `assembleMedia` fait donc un simple `cat`, et le mode fMP4 n'est jamais assemblé
 *    automatiquement (`D-046`).
 *
 * @module media
 */

import { appendFile, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { download as downloadFile } from './connection-loop.js';
import { openSegment } from './http-client.js';
import { parsePlaylist, selectVariant } from './hls.js';

/** Extension par défaut d'un segment quand l'URL n'en donne pas. */
export const DEFAULT_SEGMENT_EXTENSION = '.ts';

/**
 * Extension à donner à un fichier local d'après l'URL distante.
 * @param {string} url
 * @param {string} fallback
 * @returns {string}
 */
export function extensionOf(url, fallback = DEFAULT_SEGMENT_EXTENSION) {
  try {
    const path = new URL(url).pathname;
    const match = /\.([a-z0-9]{2,5})$/i.exec(path);
    return match ? `.${match[1].toLowerCase()}` : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Nom local d'un segment : `segment-00001.ts`, index sur 5 chiffres.
 * @param {number} index 0-based
 * @param {string} extension
 * @returns {string}
 */
export function segmentName(index, extension = DEFAULT_SEGMENT_EXTENSION) {
  return `segment-${String(index + 1).padStart(5, '0')}${extension}`;
}

/**
 * Plan de téléchargement d'une playlist média déjà analysée.
 *
 * @param {ReturnType<typeof parsePlaylist>} playlist
 * @param {{segmentExtension?: string}} [options]
 * @returns {{segments: {index: number, name: string, url: string, duration: number,
 *     byteRange: {length: number, offset: number | null} | null, sequence: number,
 *     discontinuity: boolean}[],
 *   init: {name: string, url: string, byteRange: {length: number, offset: number | null} | null} | null,
 *   encrypted: boolean, discontinuityAt: number[], totalDuration: number}}
 */
export function planMedia(playlist, { segmentExtension } = {}) {
  if (playlist.type !== 'media') {
    throw new Error('planMedia : playlist média attendue (pas une playlist maître)');
  }
  const extension = segmentExtension
    ?? (playlist.map ? '.m4s' : DEFAULT_SEGMENT_EXTENSION);
  return {
    segments: playlist.segments.map((segment) => ({
      index: segment.index,
      name: segmentName(segment.index, extensionOf(segment.url, extension)),
      url: segment.url,
      duration: segment.duration,
      byteRange: segment.byteRange,
      sequence: segment.sequence,
      discontinuity: segment.discontinuity,
    })),
    init: playlist.map
      ? {
        name: `init${extensionOf(playlist.map.url, '.mp4')}`,
        url: playlist.map.url,
        byteRange: playlist.map.byteRange,
      }
      : null,
    encrypted: playlist.segments.some((segment) => segment.key && segment.key.method !== 'NONE'),
    discontinuityAt: playlist.segments
      .filter((segment) => segment.discontinuity)
      .map((segment) => segment.index),
    totalDuration: playlist.segments.reduce((sum, segment) => sum + (segment.duration || 0), 0),
  };
}

/**
 * Télécharge une ressource (ou une plage d'octets) jusqu'à un fichier local.
 *
 * Utilise `openSegment` pour honorer `#EXT-X-BYTERANGE` : un segment peut être une plage
 * d'un fichier plus gros (`EX-D-05`), et le moteur de morceaux ne sait télécharger qu'un
 * fichier entier.
 *
 * @param {string} url
 * @param {string} target
 * @param {{byteRange?: {length: number, offset: number | null} | null, transport?: Function}} [options]
 * @returns {Promise<number>} nombre d'octets écrits
 */
async function fetchToFile(url, target, { byteRange = null, transport } = {}) {
  if (!byteRange) throw new Error('fetchToFile : plage attendue');
  const start = byteRange.offset ?? 0;
  const segment = await openSegment(url, { start, size: byteRange.length },
    { ...(transport ? { transport } : {}) });
  const handle = await open(target, 'w');
  let written = 0;
  try {
    for await (const chunk of segment.stream) {
      if (written >= byteRange.length) break;
      const usable = chunk.subarray(0, byteRange.length - written);
      await handle.write(usable, 0, usable.length, written);
      written += usable.length;
    }
  } finally {
    await handle.close();
  }
  if (written !== byteRange.length) {
    await rm(target, { force: true });
    throw new Error(`segment tronqué : ${written} / ${byteRange.length} octets`);
  }
  return written;
}

/**
 * Télécharge un flux HLS complet dans un dossier.
 *
 * @param {{playlistUrl: string, directory: string,
 *   fetchText?: (url: string) => Promise<{body: string} | string>,
 *   downloadFn?: (url: string, target: string, options?: object) => Promise<object>,
 *   transport?: Function, bandwidth?: number, maxSegments?: number,
 *   onEvent?: (event: {type: string} & Record<string, unknown>) => void}} options
 * @returns {Promise<{directory: string, playlistUrl: string, mediaPlaylistUrl: string,
 *   variant: object | null, playlist: object, plan: object,
 *   files: string[], bytes: number, segments: number, encrypted: boolean}>}
 */
export async function downloadMedia({
  playlistUrl,
  directory,
  fetchText,
  downloadFn = downloadFile,
  transport,
  bandwidth,
  maxSegments,
  onEvent = () => {},
}) {
  if (typeof fetchText !== 'function') throw new TypeError('downloadMedia : `fetchText` requis');
  await mkdir(directory, { recursive: true });

  const read = async (url) => {
    const answer = await fetchText(url);
    // Une playlist répondue en `401`/`404` donnait « #EXTM3U attendu » : le vrai problème
    // (authentification refusée, URL morte) était remplacé par un message de format (`D-075`).
    if (answer && typeof answer === 'object' && Number.isInteger(answer.status)
      && (answer.status < 200 || answer.status >= 300)) {
      throw new Error(`playlist ${url} : statut ${answer.status}`);
    }
    return typeof answer === 'string' ? answer : answer.body;
  };

  const masterText = await read(playlistUrl);
  let playlist = parsePlaylist(masterText, { baseUrl: playlistUrl });
  let variant = null;
  let mediaPlaylistUrl = playlistUrl;
  let mediaText = masterText;

  if (playlist.type === 'master') {
    variant = selectVariant(playlist, bandwidth === undefined ? {} : { bandwidth });
    if (!variant) throw new Error(`aucune variante exploitable dans ${playlistUrl}`);
    mediaPlaylistUrl = variant.url;
    onEvent({ type: 'variant', url: mediaPlaylistUrl, bandwidth: variant.bandwidth });
    mediaText = await read(mediaPlaylistUrl);
    playlist = parsePlaylist(mediaText, { baseUrl: mediaPlaylistUrl });
  }

  const plan = planMedia(playlist);
  const limited = maxSegments === undefined
    ? plan
    : { ...plan, segments: plan.segments.slice(0, maxSegments) };

  // La playlist d'origine est conservée : sans elle, le dossier n'est plus reproductible.
  await writeFile(join(directory, 'index.m3u8'), mediaText, 'utf8');

  /** @type {string[]} */
  const files = [];
  let bytes = 0;

  if (limited.init) {
    const target = join(directory, limited.init.name);
    onEvent({ type: 'init', url: limited.init.url, target });
    bytes += limited.init.byteRange
      ? await fetchToFile(limited.init.url, target, {
        byteRange: limited.init.byteRange,
        ...(transport ? { transport } : {}),
      })
      : await downloadAndMeasure(limited.init.url, target, downloadFn, transport);
    files.push(target);
  }

  for (const segment of limited.segments) {
    const target = join(directory, segment.name);
    onEvent({
      type: 'segment', index: segment.index, url: segment.url, target,
      discontinuity: segment.discontinuity,
    });
    bytes += segment.byteRange
      ? await fetchToFile(segment.url, target, {
        byteRange: segment.byteRange,
        ...(transport ? { transport } : {}),
      })
      : await downloadAndMeasure(segment.url, target, downloadFn, transport);
    files.push(target);
  }

  return {
    directory,
    playlistUrl,
    mediaPlaylistUrl,
    variant,
    playlist,
    plan: limited,
    files,
    bytes,
    segments: limited.segments.length,
    encrypted: plan.encrypted,
  };
}

/**
 * Téléchargement d'un fichier entier par le moteur, avec mesure des octets.
 *
 * Le transport doit suivre **tous** les segments, pas seulement ceux qui portent un
 * `#EXT-X-BYTERANGE` (`D-075`). Il était perdu ici : un flux derrière un proxy ou derrière un
 * jeton se téléchargeait donc en direct, ce qui donnait des segments en `403` inexplicables
 * — et, sans proxy, une fuite de la requête hors du tunnel demandé.
 *
 * @param {string} url
 * @param {string} target
 * @param {Function} downloadFn
 * @param {Function} [transport]
 * @returns {Promise<number>}
 */
async function downloadAndMeasure(url, target, downloadFn, transport) {
  const result = await downloadFn(url, target, {
    promote: true,
    connections: 1,
    ...(transport ? { transport } : {}),
  });
  const size = result?.size;
  if (typeof size === 'number') return size;
  const { stat } = await import('node:fs/promises');
  return (await stat(target)).size;
}

/**
 * Assemble des fichiers bout à bout (`cat`) dans un fichier unique.
 *
 * Volontairement bête : la validité du résultat dépend du conteneur, et c'est à
 * l'appelant de savoir ce qu'il assemble (`D-046`).
 *
 * @param {string[]} files
 * @param {string} target
 * @returns {Promise<{target: string, size: number}>}
 */
export async function assembleMedia(files, target) {
  if (files.length === 0) throw new Error('assembleMedia : aucun fichier à assembler');
  await writeFile(target, Buffer.alloc(0));
  for (const file of files) {
    const { readFile } = await import('node:fs/promises');
    await appendFile(target, await readFile(file));
  }
  const { stat } = await import('node:fs/promises');
  return { target, size: (await stat(target)).size };
}
