#!/usr/bin/env node
/**
 * CLI minimale de XDM — lot `WP-22`.
 *
 * `xdm <url> [dossier] [options]`
 *
 * Elle ne fait que trois choses : déduire un nom de fichier sûr de l'URL
 * (`D-037`), télécharger (`D-038`/`D-039`), puis promouvoir si et seulement si
 * la carte est complète et la taille conforme (`EX-A-12`). Toute erreur sort en
 * code 1 avec un message court.
 *
 * Le schéma de l'URL choisit le transport (`EX-C-06`, `EX-C-07`) : `ftp:` passe par
 * `src/ftp.js` (séquence `CWD`→`TYPE I`→`SIZE`→`REST`→`RETR`, mode passif obligatoire),
 * tout le reste par le moteur HTTP. Un schéma inconnu est refusé **avant** tout accès
 * réseau, avec la liste de ce qui est accepté.
 */

import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { download, DownloadError } from '../src/connection-loop.js';
import { parseHeaderOption } from '../src/headers.js';
import { probe } from '../src/http-client.js';
import { downloadFtp, parseFtpUrl } from '../src/ftp.js';
import { fileNameFromDisposition, fileNameFromUrl, targetPathFor } from '../src/promote.js';
import { parseProxyUrl, createProxyTransport } from '../src/proxy.js';

export const USAGE = `usage : xdm <url> [dossier] [--connexions N] [--morceau TAILLE] [--proxy URL]
                   [--entete "Nom: valeur"] [--incremental] [--sans-reprise] [--nom FICHIER]
                   [--sortie texte|json] [--aide | --version]
  --connexions     connexions parallèles (défaut 8)
  --morceau        taille de morceau en octets (1–10 Mio)
  --proxy          proxy http, https ou socks5 pour le transfert (et pour la sonde)
  --entete         en-tête HTTP envoyé à chaque requête (sonde **et** morceaux), répétable,
                   ex. « Authorization: Bearer … » ; validation partagée avec xdm-grab
  --incremental    si le fichier local existe, demander If-Modified-Since : un 304 le laisse
                   intact et sort en code 0 (le fichier était déjà à jour)
  --sans-reprise   repartir de zéro même si une carte de morceaux existe (la reprise est le
                   comportement par défaut ; une carte d'une autre URL est toujours ignorée)
  --nom            nom du fichier local ; sans lui, le nom vient de l'URL ou, à défaut
                   d'extension, de l'en-tête Content-Disposition du serveur
  --sortie         texte (défaut) ou json : un objet unique sur stdout, progression sur stderr
  --aide, -h       afficher cette aide et sortir (code 0)
  --version, -V    afficher la version et sortir (code 0)
  le schéma de l'URL choisit le transport : http, https, ftp\n`;

/** Schémas acceptés, et le transport associé. */
export const SCHEMES = Object.freeze({ http: 'http', https: 'http', ftp: 'ftp' });

/** Version annoncée par `--version` (celle du paquet). */
export const VERSION = '0.1.0';

/**
 * Analyse les arguments. Aucune dépendance : les options reconnues sont peu
 * nombreuses et explicites.
 * @param {string[]} argv
 * @returns {{url: string, directory: string, connections?: number, chunkSize?: number,
 *   proxy?: string, name?: string, output: 'texte'|'json', resume: boolean}}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {{connections?: number, chunkSize?: number, proxy?: string, name?: string,
   *   output: 'texte'|'json', headers: Record<string, string>, incremental: boolean,
   *   resume: boolean}} */
  const options = { headers: {}, incremental: false, resume: true, output: /** @type {'texte'|'json'} */ ('texte') };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--connexions') {
      options.connections = Number(argv[(i += 1)]);
    } else if (argument === '--morceau') {
      options.chunkSize = Number(argv[(i += 1)]);
    } else if (argument === '--incremental') {
      options.incremental = true;
    } else if (argument === '--sans-reprise') {
      options.resume = false;
    } else if (argument === '--nom') {
      i += 1;
      if (!argv[i]) throw new DownloadError(`--nom attend un nom de fichier\n${USAGE}`, 'USAGE');
      options.name = argv[i];
    } else if (argument === '--sortie') {
      i += 1;
      if (argv[i] !== 'texte' && argv[i] !== 'json') {
        throw new DownloadError(`--sortie attend « texte » ou « json »\n${USAGE}`, 'USAGE');
      }
      options.output = argv[i];
    } else if (argument === '--entete') {
      i += 1;
      if (!argv[i]) throw new DownloadError(`--entete attend « Nom: valeur »\n${USAGE}`, 'USAGE');
      const { name, value } = parseHeaderOption(argv[i]);
      options.headers[name] = value;
    } else if (argument === '--proxy') {
      i += 1;
      if (!argv[i]) throw new DownloadError(`--proxy attend une URL\n${USAGE}`, 'USAGE');
      // Validation **locale** : un proxy illisible se refuse ici, pas au milieu d'un
      // téléchargement quand la première connexion échoue (`D-071`).
      try {
        parseProxyUrl(argv[i]);
      } catch (error) {
        throw new DownloadError(`proxy invalide : ${error?.message ?? error}`, 'USAGE');
      }
      options.proxy = argv[i];
    } else if (argument === '--aide' || argument === '--help' || argument === '-h') {
      throw new DownloadError(USAGE, 'USAGE');
    } else if (argument.startsWith('--')) {
      throw new DownloadError(`option inconnue : ${argument}\n${USAGE}`, 'USAGE');
    } else {
      positional.push(argument);
    }
  }
  const url = positional[0];
  if (!url) throw new DownloadError(USAGE, 'USAGE');
  if (options.connections !== undefined && !Number.isInteger(options.connections)) {
    throw new DownloadError('--connexions attend un entier', 'USAGE');
  }
  if (options.chunkSize !== undefined && !Number.isInteger(options.chunkSize)) {
    throw new DownloadError('--morceau attend un entier (octets)', 'USAGE');
  }
  return {
    url,
    directory: positional[1] ?? '.',
    ...options,
  };
}

/**
 * Transport à utiliser pour une URL, ou une erreur explicite.
 *
 * Le refus est **local** : on ne tente pas une connexion pour découvrir que `mailto:` n'est
 * pas un protocole de transfert de fichier.
 *
 * @param {string} url
 * @returns {'http'|'ftp'}
 */
export function transportFor(url) {
  let protocol;
  try {
    protocol = new URL(url).protocol.replace(':', '').toLowerCase();
  } catch {
    throw new DownloadError(`URL invalide : ${url}\n${USAGE}`, 'USAGE');
  }
  const transport = SCHEMES[protocol];
  if (!transport) {
    throw new DownloadError(
      `schéma non pris en charge : ${protocol}: (attendu : http, https, ftp)`,
      'USAGE',
    );
  }
  return /** @type {'http'|'ftp'} */ (transport);
}

/** Nom de fichier d'une URL FTP : la dernière composante du chemin, sans requête. */
function ftpFileName(url) {
  const parsed = parseFtpUrl(url);
  return parsed.path.split('/').filter(Boolean).at(-1) ?? 'index';
}

/**
 * Point d'entrée testable.
 * @param {string[]} argv
 * @param {{log?: (line: string) => void, download?: typeof download,
 *   downloadFtp?: typeof downloadFtp}} [deps]
 * @returns {Promise<{target: string, size: number|null, requests: number,
 *   notModified?: boolean}|null>} `null` pour `--aide`/`--version` (rien n'a été téléchargé,
 *   et ce n'est pas une erreur)
 */
export async function main(argv, {
  log = console.log,
  logErreur = console.error,
  download: run = download,
  downloadFtp: runFtp = downloadFtp,
} = {}) {
  // `--aide`/`--version` répondent sans URL ni réseau : demander de l'aide ne commence pas
  // par une erreur d'usage.
  if (argv.includes('--version') || argv.includes('-V')) {
    log(`xdm ${VERSION} (Node ${process.version})`);
    return null;
  }
  if (argv.includes('--aide') || argv.includes('-h')) {
    log(USAGE.trimEnd());
    return null;
  }
  const {
    url, directory, connections, chunkSize, proxy, headers, incremental, resume, name, output,
  } = parseArgs(argv);
  const transport = transportFor(url);
  // En JSON, stdout ne porte **que** l'objet : la progression et les messages partent sur la
  // sortie d'erreur, sinon le premier `% ` casse le `JSON.parse` de l'appelant (`D-073`).
  const json = output === 'json';
  const progressLog = json ? logErreur : log;
  const note = json ? logErreur : log;
  const finish = (result) => {
    if (json) log(JSON.stringify(result));
    return result;
  };

  if (transport === 'ftp') {
    // `SIZE` peut manquer : la taille vaut alors `null`, et on ne l'invente pas.
    const target = targetPathFor(resolve(directory), name ?? ftpFileName(url));
    await mkdir(resolve(directory), { recursive: true });
    const result = await runFtp(url, target, {
      ...(proxy ? { proxy } : {}),
      onEvent: (event) => {
        if (event.type === 'size') progressLog(`taille distante : ${event.size ?? 'inconnue'}`);
        if (event.type === 'resume') progressLog(`reprise à l’octet ${event.restartAt}`);
      },
    });
    note(`écrit ${result.target} (${result.bytes} octets, FTP)`);
    return finish({ url, target: result.target, size: result.bytes, requests: 1 });
  }

  // Proxy HTTP (`D-071`) : `--proxy` était documenté et appliqué au seul FTP ; il enveloppe
  // désormais la sonde **et** les morceaux, puisque les deux passent par le même transport.
  const proxyTransport = proxy ? createProxyTransport(parseProxyUrl(proxy)) : null;
  const callTransport = proxyTransport ?? undefined;
  const requestHeaders = { ...headers };

  let fileName = name ?? fileNameFromUrl(url);
  if (!name && !fileName.includes('.')) {
    // Un nom sans extension (« download?id=3 ») ne dit pas ce que le fichier est : demander
    // au serveur ce qu'il annonce, une fois, avant d'ouvrir la cible (`D-072`).
    try {
      const info = await probe(url, {
        ...(callTransport ? { transport: callTransport } : {}),
        headers: requestHeaders,
      });
      const suggested = fileNameFromDisposition(info.contentDisposition);
      if (suggested) fileName = suggested;
    } catch {
      // Sonde en échec : le nom de l'URL reste, et l'erreur réelle viendra du téléchargement.
    }
  }

  const target = targetPathFor(resolve(directory), fileName);
  await mkdir(resolve(directory), { recursive: true });

  // Un fichier déjà à jour n'est pas réécrit : `--incremental` compare la date locale à
  // celle du serveur (`If-Modified-Since`) et sort en succès sur `304` (`D-070`).
  let ifModifiedSince = null;
  if (incremental) {
    try {
      const stats = await stat(target);
      if (stats.isFile() && stats.size > 0) ifModifiedSince = stats.mtimeMs;
    } catch {
      // Pas de fichier local : rien à comparer, le téléchargement a lieu.
    }
  }

  let lastPercent = -1;
  const result = await run(url, target, {
    connections: connections ?? 4,
    ...(chunkSize === undefined ? {} : { chunkSize }),
    ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
    ...(ifModifiedSince !== null ? { ifModifiedSince } : {}),
    ...(callTransport ? { transport: callTransport } : {}),
    // Reprise (`D-071`) : elle est **par défaut** dans le moteur (la carte
    // `<cible>.xdm-part.json` désigne les morceaux déjà écrits). `--sans-reprise` la coupe,
    // pour repartir d'un fichier propre quand la carte ne mérite plus confiance.
    ...(resume ? {} : { resume: false }),
    promote: true,
    onProgress: ({ done, total }) => {
      const percent = Math.floor((done / total) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        progressLog(`${percent.toString().padStart(3, ' ')} %  ${done}/${total}`);
      }
    },
  });
  // Une carte refusée se dit (`D-071`), avec sa raison : sinon « ça a repris » et « ça a
  // recommencé » se ressemblent, et le second cas coûte des gigaoctets.
  if (result.resumeDropped) {
    const raison = result.resumeDropped === 'url' ? 'carte d’une autre URL'
      : result.resumeDropped === 'validateur' ? 'ressource modifiée depuis la carte'
        : 'taille différente de celle de la carte';
    note(`reprise ignorée (${raison}) : lecture complète`);
  }
  if (result.notModified) {
    note(`inchangé ${result.target} (304 : le fichier local est à jour)`);
    return finish({ url, target: result.target, size: null, requests: result.requests, notModified: true });
  }
  note(`écrit ${result.target} (${result.size} octets, ${result.requests} requêtes)`);
  return finish({
    url,
    target: result.target,
    size: result.size,
    requests: result.requests,
    ...(result.resumeDropped ? { resumeDropped: result.resumeDropped } : {}),
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof DownloadError ? error.message : String(error?.message ?? error);
    console.error(`xdm : ${message.trimEnd()}`);
    process.exit(error?.code === 'USAGE' ? 2 : 1);
  });
}
