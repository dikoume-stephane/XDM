#!/usr/bin/env node
/**
 * Interface locale de XDM — lot `WP-51`.
 *
 * `xdm-ui [--port N] [--hote ADRESSE] [--dossier DIR] [--connexions N] [--actifs N]`
 *
 * Cette CLI ne télécharge rien elle-même : elle ouvre le serveur de l'interface
 * (`src/ui-server.js`), qui pilote le gestionnaire (`src/manager.js`), qui appelle le
 * moteur (`src/connection-loop.js`). Trois couches, trois responsabilités — le jour où
 * Electron remplace le navigateur, seule la première change.
 *
 * L'écoute est **locale par défaut** : une interface qui lance des téléchargements ne
 * doit pas être joignable depuis le réseau sans qu'on l'ait demandé. `--hote 0.0.0.0`
 * existe pour les environnements d'aperçu, et le message de démarrage rappelle alors
 * que l'exposition est volontaire.
 *
 * Décision `D-084` : l'écoute reste locale par défaut ; l'exposition au réseau est un choix
 * explicite, annoncé au démarrage.
 */

import { resolve } from 'node:path';

import { startUiServer } from '../src/ui-server.js';
import { VERSION } from '../src/version.js';

export const USAGE = `usage : xdm-ui [--port N] [--hote ADRESSE] [--dossier DIR] [--connexions N] [--actifs N]
  --port        port d'écoute (défaut 8100 ; 0 = port libre choisi par le système)
  --hote        adresse d'écoute (défaut 127.0.0.1 ; 0.0.0.0 expose l'interface au réseau)
  --dossier     dossier de destination des fichiers (défaut ./telechargements)
  --connexions  connexions parallèles par téléchargement (défaut 4)
  --actifs      téléchargements simultanés (défaut 2)
  --aide, -h    afficher cette aide et sortir (code 0)
  --version, -V afficher la version et sortir (code 0)
`;

/** Options par défaut, exportées pour que les tests n'inventent pas de valeurs. */
export const DEFAUTS = Object.freeze({ port: 8100, hote: '127.0.0.1', dossier: './telechargements', connexions: 4, actifs: 2 });

/**
 * Analyse les arguments.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = { ...DEFAUTS, aide: false, version: false };
  const entiers = new Map([
    ['--port', 'port'],
    ['--connexions', 'connexions'],
    ['--actifs', 'actifs'],
  ]);
  const textes = new Map([
    ['--hote', 'hote'],
    ['--dossier', 'dossier'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--aide' || argument === '-h') {
      options.aide = true;
      continue;
    }
    if (argument === '--version' || argument === '-V') {
      options.version = true;
      continue;
    }
    if (entiers.has(argument)) {
      const valeur = argv[i + 1];
      if (valeur === undefined || valeur.startsWith('-')) {
        throw new TypeError(`${argument} attend un entier`);
      }
      if (!/^\d+$/.test(valeur)) throw new TypeError(`${argument} attend un entier`);
      const nombre = Number(valeur);
      if (argument === '--port' && nombre > 65535) throw new RangeError('--port doit être <= 65535');
      if ((argument === '--connexions' || argument === '--actifs') && nombre < 1) {
        throw new RangeError(`${argument} doit être >= 1`);
      }
      options[entiers.get(argument)] = nombre;
      i += 1;
      continue;
    }
    if (textes.has(argument)) {
      const valeur = argv[i + 1];
      if (valeur === undefined || valeur.startsWith('-')) {
        throw new TypeError(`${argument} attend une valeur`);
      }
      options[textes.get(argument)] = valeur;
      i += 1;
      continue;
    }
    throw new TypeError(`option inconnue : ${argument}`);
  }
  return options;
}

/**
 * Démarre l'interface.
 *
 * @param {string[]} argv
 * @param {{log?: (ligne: string) => void, demarrer?: typeof startUiServer}} [contexte]
 */
export async function main(argv, { log = (ligne) => console.log(ligne), demarrer = startUiServer } = {}) {
  const options = parseArgs(argv);
  if (options.aide) {
    log(USAGE.trimEnd());
    return null;
  }
  if (options.version) {
    log(`xdm-ui ${VERSION}`);
    return null;
  }
  const serveur = await demarrer({
    port: options.port,
    hote: options.hote,
    dossier: resolve(options.dossier),
    connexions: options.connexions,
    maxActifs: options.actifs,
  });
  log(`interface : ${serveur.url}`);
  log(`dossier   : ${resolve(options.dossier)}`);
  if (options.hote === '0.0.0.0') {
    log('attention : écoute sur 0.0.0.0 — toute machine du réseau peut piloter cette interface');
  }
  return serveur;
}

/** Attend un signal d'arrêt puis ferme proprement (SSE comprises). */
export async function attendreArret(serveur) {
  if (!serveur) return;
  await new Promise((resoudre) => {
    const stop = () => resoudre(undefined);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await serveur.fermer();
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((serveur) => attendreArret(serveur))
    .catch((error) => {
      const message = error && error.message ? error.message : String(error);
      console.error(`xdm-ui : ${message.trimEnd()}`);
      process.exit(2);
    });
}
