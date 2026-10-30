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

import { estBoucleLocale, genererJeton } from '../src/acces.js';
import { cheminParDefaut, lireReglages } from '../src/reglages.js';
import { startUiServer } from '../src/ui-server.js';
import { VERSION } from '../src/version.js';

export const USAGE = `usage : xdm-ui [--port N] [--hote ADRESSE] [--dossier DIR] [--connexions N] [--actifs N]
  --port        port d'écoute (défaut 8100 ; 0 = port libre choisi par le système)
  --hote        adresse d'écoute (défaut 127.0.0.1 ; 0.0.0.0 expose l'interface au réseau)
  --dossier     dossier de destination des fichiers (défaut ./telechargements)
  --connexions  connexions parallèles par téléchargement (défaut 4)
  --actifs      téléchargements simultanés (défaut 2)
  --reglages    fichier de réglages JSON (défaut ~/.config/xdm/reglages.json)
  --jeton       jeton d'accès (défaut : tiré au lancement si --hote sort de la boucle locale)
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
  const options = { ...DEFAUTS, aide: false, version: false, explicites: [] };
  // Les options réellement passées sont mémorisées : sans cela, une valeur par défaut
  // écraserait silencieusement le fichier de réglages de l'utilisateur.
  const explicites = new Set();
  const entiers = new Map([
    ['--port', 'port'],
    ['--connexions', 'connexions'],
    ['--actifs', 'actifs'],
  ]);
  const textes = new Map([
    ['--hote', 'hote'],
    ['--dossier', 'dossier'],
    ['--reglages', 'reglages'],
    ['--jeton', 'jeton'],
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
      explicites.add(entiers.get(argument));
      i += 1;
      continue;
    }
    if (textes.has(argument)) {
      const valeur = argv[i + 1];
      if (valeur === undefined || valeur.startsWith('-')) {
        throw new TypeError(`${argument} attend une valeur`);
      }
      options[textes.get(argument)] = valeur;
      explicites.add(textes.get(argument));
      i += 1;
      continue;
    }
    throw new TypeError(`option inconnue : ${argument}`);
  }
  options.explicites = [...explicites];
  return options;
}

/**
 * Démarre l'interface.
 *
 * @param {string[]} argv
 * @param {{log?: (ligne: string) => void, demarrer?: typeof startUiServer}} [contexte]
 */
export async function main(argv, {
  log = (ligne) => console.log(ligne),
  demarrer = startUiServer,
  lire = lireReglages,
} = {}) {
  const options = parseArgs(argv);
  if (options.aide) {
    log(USAGE.trimEnd());
    return null;
  }
  if (options.version) {
    log(`xdm-ui ${VERSION}`);
    return null;
  }
  // Priorité : option de ligne de commande > fichier de réglages > valeur par défaut.
  const chemin = options.reglages ?? cheminParDefaut();
  let enregistres = null;
  try {
    enregistres = await lire(chemin);
  } catch (error) {
    // Un fichier de réglages cassé ne doit pas empêcher de démarrer **si** l'appelant a
    // tout précisé en ligne de commande ; sinon, l'erreur est la seule réponse honnête.
    if (options.explicites.length === 0) throw error;
  }
  const explicite = (cle) => options.explicites.includes(cle);
  const dossier = resolve(explicite('dossier') ? options.dossier : enregistres?.dossier ?? options.dossier);
  const connexions = explicite('connexions') ? options.connexions : enregistres?.connexions ?? options.connexions;
  const actifs = explicite('actifs') ? options.actifs : enregistres?.maxActifs ?? options.actifs;

  // Hors de la boucle locale, l'interface est joignable par le réseau : elle n'ouvre pas
  // sans jeton (`D-088`). Sur la boucle locale, le jeton reste optionnel — l'imposer
  // partout ferait payer à tout le monde le prix d'une exposition choisie.
  const autoJeton = !estBoucleLocale(options.hote);
  const jeton = options.jeton ?? (autoJeton ? genererJeton() : null);

  const serveur = await demarrer({
    port: options.port,
    hote: options.hote,
    dossier,
    connexions,
    maxActifs: actifs,
    reglages: enregistres,
    jeton,
  });
  log(`interface : ${serveur.url}`);
  log(`dossier   : ${dossier}`);
  if (enregistres) log(`reglages  : ${enregistres.chemin ?? chemin}${enregistres.existe ? '' : ' (absent, valeurs par défaut)'}`);
  if (jeton) {
    log(`jeton     : ${jeton}${autoJeton && !options.jeton ? ' (tiré au lancement, valable pour ce processus)' : ''}`);
    log(`ouvrir    : ${serveur.url}?jeton=${encodeURIComponent(jeton)}`);
  }
  if (options.hote === '0.0.0.0') {
    log('attention : écoute sur 0.0.0.0 — le jeton ci-dessus est la seule serrure');
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
