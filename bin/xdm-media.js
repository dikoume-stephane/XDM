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
 *
 * L'authentification est **celle du transport** (`EX-D-11`, `D-075`) : `--entete`, `--cookies`
 * et `--proxy` composent un seul transport, passé à la playlist, à l'init et à **chaque**
 * segment. Un flux qui exige un jeton sur ses segments ne s'ouvre donc pas « à moitié ».
 */

import { resolve } from 'node:path';

import { createCookieJar, loadCookieJar, saveCookieJar, withCookies } from '../src/cookies.js';
import { downloadDash } from '../src/dash.js';
import { parseHeaderOption, withHeaders } from '../src/headers.js';
import { defaultTransport, fetchText } from '../src/http-client.js';
import { assembleMedia, downloadMedia } from '../src/media.js';
import { createProxyTransport, parseProxyUrl } from '../src/proxy.js';
import { VERSION } from '../src/version.js';

export const USAGE = `usage : xdm-media <playlist.m3u8> [dossier] [--qualite N] [--segments N] [--assembler F]
                   [--entete "Nom: valeur"] [--cookies F] [--proxy URL] [--sortie json]
                   [--aide | --version]
       xdm-media <media.mp4> [dossier] --dash [--init <url>]
  --qualite    débit minimal visé en bits/s (défaut : variante la plus haute)
  --segments   nombre de segments à télécharger au plus (défaut : tous)
  --assembler  assemble les fichiers téléchargés bout à bout dans F
  --dash       l'URL est un média MP4 segmenté : segments lus dans l'index sidx
  --init       URL du segment d'initialisation (mode --dash)
  --entete     en-tête HTTP envoyé à la playlist **et** à chaque segment, répétable
               (ex. « Authorization: Bearer … ») ; validation partagée avec les autres CLI
  --cookies    magasin de cookies (JSON) : lu au départ, écrit à la fin — un jeton posé par
               la playlist sert ensuite aux segments
  --proxy      proxy http, https ou socks5 pour la playlist et les segments
  --sortie     format du résumé : texte (défaut) ou json
  --aide, -h       afficher cette aide et sortir (code 0)
  --version, -V    afficher la version et sortir (code 0)
`;

export const OUTPUT_FORMATS = /** @type {const} */ (['texte', 'json']);

/**
 * Analyse les arguments.
 * @param {string[]} argv
 * @returns {{url: string, directory: string, bandwidth: number | undefined,
 *   maxSegments: number | undefined, assemble: string | null, output: 'texte' | 'json',
 *   headers: Record<string, string>, cookies: string | null, proxy: string | undefined}}
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
    headers: {},
    cookies: null,
    proxy: undefined,
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
    else if (argument === '--entete') {
      i += 1;
      if (!argv[i]) throw new Error(`--entete attend « Nom: valeur »\n${USAGE}`);
      const { name, value: headerValue } = parseHeaderOption(argv[i]);
      options.headers[name] = headerValue;
    } else if (argument === '--cookies') {
      i += 1;
      if (!argv[i]) throw new Error(`--cookies attend un fichier\n${USAGE}`);
      options.cookies = argv[i];
    } else if (argument === '--proxy') {
      i += 1;
      if (!argv[i]) throw new Error(`--proxy attend une URL\n${USAGE}`);
      // Refus **local** : un proxy illisible ne doit pas se découvrir au premier segment.
      try {
        parseProxyUrl(argv[i]);
      } catch (error) {
        throw new Error(`proxy invalide : ${error?.message ?? error}\n${USAGE}`);
      }
      options.proxy = argv[i];
    } else if (argument === '--init') {
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
  // Un troisième argument positionnel était ignoré en silence : `xdm-media a.m3u8 dir b.m3u8`
  // téléchargeait `a.m3u8` et laissait croire que `b.m3u8` avait été traité (`D-077`).
  if (positional.length > 2) {
    throw new Error(`trop d'arguments : ${positional.slice(2).join(' ')}\n${USAGE}`);
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
  // `--aide` et `--version` répondent **sans** URL et sans réseau, en code 0 : demander de
  // l'aide ne commence pas par une erreur d'usage (`D-082`). Cette CLI répondait 2 et 1.
  if (argv.includes('--version') || argv.includes('-V')) {
    log(`xdm-media ${VERSION} (Node ${process.version})`);
    return { version: VERSION, output: 'texte' };
  }
  if (argv.includes('--aide') || argv.includes('--help') || argv.includes('-h')) {
    log(USAGE.trimEnd());
    return { help: true, output: 'texte' };
  }
  const options = parseArgs(argv);
  const {
    url, directory, bandwidth, maxSegments, assemble, output, headers, cookies, proxy,
  } = options;
  const rootDir = resolve(directory);

  // Un **seul** transport pour la playlist, l'init et les segments (`D-075`) : proxy, en-têtes
  // et cookies doivent valoir partout, sinon un flux protégé ne s'ouvre qu'à moitié.
  const proxyTransport = proxy ? createProxyTransport(parseProxyUrl(proxy)) : null;
  const jar = cookies ? (await loadCookieJar(cookies)).jar : null;
  // L'en-tête voyage avec le transport, donc la playlist, l'init et **chaque** segment le
  // portent, y compris ceux qui n'ont pas de `BYTERANGE` (`D-075`).
  const baseTransport = withHeaders(proxyTransport ?? defaultTransport, headers);
  const mediaTransport = jar ? withCookies(baseTransport, jar) : baseTransport;
  const flushCookies = async () => {
    if (!cookies || !jar) return;
    // `saveCookieJar` rend `{path, saved}` : lire `count` affichait « undefined cookie(s) ».
    const { path, saved } = await saveCookieJar(jar, cookies);
    if (output !== 'json') log(`cookies  : ${path} (${saved} cookie(s))`);
  };
  // La lecture de playlist passe par `fetchText`, qui prend un transport : c'est le même, donc
  // un `Set-Cookie` posé par la playlist est déjà dans le magasin quand les segments partent.
  const readPlaylist = (target) => read(target, { transport: mediaTransport });

  if (options.dash) {
    const dash = await downloadDash({
      fileUrl: url,
      directory: rootDir,
      ...(options.initUrl ? { initUrl: options.initUrl } : {}),
      ...(maxSegments !== undefined ? { maxSegments } : {}),
      ...(transport ? { transport } : { transport: mediaTransport }),
      onEvent: (event) => log(`segment ${event.index + 1} : ${event.offset}+${event.size}`),
    });
    await flushCookies();
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
    fetchText: readPlaylist,
    ...(downloadFn ? { downloadFn } : {}),
    ...(transport ? { transport } : { transport: mediaTransport }),
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

  await flushCookies();
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
