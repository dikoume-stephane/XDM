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
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { download, DownloadError } from '../src/connection-loop.js';
import { fileNameFromUrl, targetPathFor } from '../src/promote.js';

export const USAGE = `usage : xdm <url> [dossier] [--connexions N] [--morceau TAILLE]\n`;

/**
 * Analyse les arguments. Aucune dépendance : les options reconnues sont peu
 * nombreuses et explicites.
 * @param {string[]} argv
 * @returns {{url: string, directory: string, connections?: number, chunkSize?: number}}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {{connections?: number, chunkSize?: number}} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--connexions') {
      options.connections = Number(argv[(i += 1)]);
    } else if (argument === '--morceau') {
      options.chunkSize = Number(argv[(i += 1)]);
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
 * Point d'entrée testable.
 * @param {string[]} argv
 * @param {{log?: (line: string) => void, download?: typeof download}} [deps]
 * @returns {Promise<{target: string, size: number, requests: number}>}
 */
export async function main(argv, { log = console.log, download: run = download } = {}) {
  const { url, directory, connections, chunkSize } = parseArgs(argv);
  const target = targetPathFor(resolve(directory), fileNameFromUrl(url));
  await mkdir(resolve(directory), { recursive: true });

  let lastPercent = -1;
  const result = await run(url, target, {
    connections: connections ?? 4,
    ...(chunkSize === undefined ? {} : { chunkSize }),
    promote: true,
    onProgress: ({ done, total }) => {
      const percent = Math.floor((done / total) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        log(`${percent.toString().padStart(3, ' ')} %  ${done}/${total}`);
      }
    },
  });
  log(`écrit ${result.target} (${result.size} octets, ${result.requests} requêtes)`);
  return { target: result.target, size: result.size, requests: result.requests };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof DownloadError ? error.message : String(error?.message ?? error);
    console.error(`xdm : ${message.trimEnd()}`);
    process.exit(error?.code === 'USAGE' ? 2 : 1);
  });
}
