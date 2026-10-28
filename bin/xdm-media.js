#!/usr/bin/env node
/**
 * CLI de flux HLS — lot `WP-26`, fiche D.
 *
 * `xdm-media <playlist.m3u8> [dossier] [--qualite N] [--segments N] [--assembler F] [--sortie json]`
 * `xdm-media <media.mp4> [dossier] --dash [--init <init.mp4>]`
 *
 * Enchaîne, sans état caché : lecture de la playlist (`hls.js`) → plan de segments
 * (`media.js`) → téléchargement de chaque segment par le moteur (`connection-loop.js`) →
 * playlist conservée sur disque, assemblage facultatif.
 *
 * Le flux chiffré (`#EXT-X-KEY`) est téléchargé **tel quel** et signalé : XDM ne déchiffre
 * rien (`D-004`). L'assemblage reste un choix explicite, parce qu'il n'a de sens que pour
 * MPEG-TS (`D-046`).
 */

import { resolve } from 'node:path';

import { downloadDash } from '../src/dash.js';
import { fetchText } from '../src/http-client.js';
import { assembleMedia, downloadMedia } from '../src/media.js';

export const USAGE = `usage : xdm-media <playlist.m3u8> [dossier] [--qualite N] [--segments N] [--assembler F] [--sortie json]
       xdm-media <media.mp4> [dossier] --dash [--init <url>]
  --qualite    débit minimal visé en bits/s (défaut : variante la plus haute)
  --segments   nombre de segments à télécharger au plus (défaut : tous)
  --assembler  assemble les fichiers téléchargés bout à bout dans F
  --dash       l'URL est un média MP4 segmenté : segments lus dans l'index sidx
  --init       URL du segment d'initialisation (mode --dash)
  --sortie     format du résumé : texte (défaut) ou json
`;

export const OUTPUT_FORMATS = /** @type {const} */ (['texte', 'json']);

/**
 * Analyse les arguments.
 * @param {string[]} argv
 * @returns {{url: string, directory: string, bandwidth: number | undefined,
 *   maxSegments: number | undefined, assemble: string | null, output: 'texte' | 'json'}}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  const options = {
    bandwidth: undefined,
    maxSegments: undefined,
    assemble: null,
    output: 'texte',
    dash: false,
    initUrl: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    const value = () => {
      i += 1;
      const raw = argv[i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`valeur invalide pour ${argument} : ${raw}`);
      }
      return parsed;
    };
    if (argument === '--qualite') options.bandwidth = value();
    else if (argument === '--segments') options.maxSegments = value();
    else if (argument === '--assembler') {
      i += 1;
      if (!argv[i]) throw new Error(`--assembler attend un fichier\n${USAGE}`);
      options.assemble = argv[i];
    } else if (argument === '--dash') options.dash = true;
    else if (argument === '--init') {
      i += 1;
      if (!argv[i]) throw new Error(`--init attend une URL\n${USAGE}`);
      options.initUrl = argv[i];
    } else if (argument === '--sortie') {
      i += 1;
      if (!OUTPUT_FORMATS.includes(argv[i])) {
        throw new Error(`format de sortie inconnu : ${argv[i]} (attendu : ${OUTPUT_FORMATS.join(' | ')})`);
      }
      options.output = argv[i];
    } else if (argument === '--aide' || argument === '--help' || argument === '-h') {
      throw new Error(USAGE);
    } else if (argument.startsWith('--')) throw new Error(`option inconnue : ${argument}\n${USAGE}`);
    else positional.push(argument);
  }
  const url = positional[0];
  if (!url) throw new Error(USAGE);
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(`URL invalide : ${url}`);
  }
  const parsed = { url, directory: positional[1] ?? '.', ...options };
  if (parsed.initUrl && !parsed.dash) {
    throw new Error(`--init n'a de sens qu'avec --dash\n${USAGE}`);
  }
  return parsed;
}

/**
 * Résumé machine d'un téléchargement de flux.
 * @param {object} result issue de `downloadMedia`, plus `assembled` éventuel
 * @returns {object}
 */
export function summarize(result) {
  return {
    playlist: result.playlistUrl,
    media: result.mediaPlaylistUrl,
    directory: result.directory,
    segments: result.segments,
    bytes: result.bytes,
    encrypted: result.encrypted,
    bandwidth: result.variant ? result.variant.bandwidth : null,
    assembled: result.assembled ?? null,
  };
}

/**
 * Point d'entrée testable.
 * @param {string[]} argv
 * @param {{log?: (line: string) => void, fetchText?: typeof fetchText,
 *   downloadFn?: Function, transport?: Function}} [deps]
 * @returns {Promise<object>} résumé
 */
export async function main(argv, {
  log = console.log,
  fetchText: read = fetchText,
  downloadFn,
  transport,
} = {}) {
  const options = parseArgs(argv);
  const { url, directory, bandwidth, maxSegments, assemble, output } = options;
  const rootDir = resolve(directory);

  if (options.dash) {
    const dash = await downloadDash({
      fileUrl: url,
      directory: rootDir,
      ...(options.initUrl ? { initUrl: options.initUrl } : {}),
      ...(maxSegments !== undefined ? { maxSegments } : {}),
      ...(transport ? { transport } : {}),
      onEvent: (event) => log(`segment ${event.index + 1} : ${event.offset}+${event.size}`),
    });
    log(`terminé : ${dash.segments.length} segment(s), ${dash.bytes} octets dans ${rootDir}`);
    return {
      playlist: url,
      media: url,
      directory: rootDir,
      segments: dash.segments.length,
      bytes: dash.bytes,
      encrypted: false,
      bandwidth: null,
      assembled: null,
      output,
    };
  }

  const result = await downloadMedia({
    playlistUrl: url,
    directory: rootDir,
    fetchText: read,
    ...(downloadFn ? { downloadFn } : {}),
    ...(transport ? { transport } : {}),
    ...(bandwidth !== undefined ? { bandwidth } : {}),
    ...(maxSegments !== undefined ? { maxSegments } : {}),
    onEvent: (event) => {
      if (event.type === 'variant') log(`variante : ${event.bandwidth} bit/s (${event.url})`);
      if (event.type === 'init') log(`initialisation : ${event.target}`);
      if (event.type === 'segment') log(`segment ${event.index + 1} : ${event.url}`);
    },
  });

  if (result.encrypted) {
    log('flux chiffré (#EXT-X-KEY) : segments téléchargés tels quels, aucun déchiffrement');
  }

  let assembled = null;
  if (assemble) {
    assembled = await assembleMedia(result.files, resolve(assemble));
    log(`assemblé : ${assembled.target} (${assembled.size} octets)`);
  }

  log(`terminé : ${result.segments} segment(s), ${result.bytes} octets dans ${rootDir}`);
  const summary = summarize({ ...result, assembled: assembled ? assembled.target : null });
  summary.output = output;
  return summary;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--sortie') && argv[argv.indexOf('--sortie') + 1] === 'json';
  const log = json ? (line) => console.error(line) : console.log;
  main(argv, { log })
    .then((summary) => {
      if (json) {
        const { output, ...rest } = summary;
        console.log(JSON.stringify(rest));
      }
    })
    .catch((error) => {
      const message = String(error?.message ?? error).trimEnd();
      console.error(`xdm-media : ${message}`);
      process.exit(message.startsWith('usage') ? 2 : 1);
    });
}
