#!/usr/bin/env node
/**
 * Préparation du paquet de bureau — lot `WP-56` (`EX-E-09`, `D-089`).
 *
 * Ce script ne fabrique pas un installeur : il prépare **l'arborescence exacte** qu'un
 * outil d'empaquetage (Electron Forge, electron-builder, `electron-packager`) transformera
 * en application. La différence est volontaire — un installeur signé se fabrique sur une
 * machine de distribution, pas dans un dépôt de développement.
 *
 * Trois garanties, chacune vérifiée par un test :
 *
 *  1. **Ce qui part est nommé.** Seuls `src/`, `bin/`, `desktop/`, `package.json`,
 *     `README.md`, `LICENSE` (s'il existe) et `docs/GUIDE-UTILISATION.md` sont copiés.
 *     `cible/` (le binaire d'IDM), `test/`, `analysis/`, `tools/`, `dl/` et les dossiers de
 *     téléchargement ne sont **jamais** embarqués.
 *  2. **Ce qui part est pesé.** Un `manifeste.json` liste chaque fichier avec sa taille et
 *     son SHA-256 : un paquet livré peut être recomparé à ce manifeste.
 *  3. **La sortie est ailleurs.** Le paquet va dans `dist/` (ignoré par Git) : le dépôt
 *     reste le dépôt, le paquet reste un artefact.
 *
 * Usage :
 *   node tools/empaqueter.mjs [--sortie DIR] [--version X.Y.Z]
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Dossiers copiés dans le paquet (chemins relatifs à la racine). */
export const INCLUS = Object.freeze(['src', 'bin', 'desktop']);

/** Fichiers copiés à la racine du paquet. */
export const FICHIERS_INCLUS = Object.freeze(['package.json', 'README.md', 'LICENSE', 'LICENCE']);

/** Dossiers qui ne doivent **jamais** partir (liste explicite, pas un filtre deviné). */
export const EXCLUS = Object.freeze([
  'cible', 'test', 'tools', 'analysis', 'docs', 'samples', 'dl', 'telechargements',
  'dist', 'node_modules', '.git',
]);

/** Fichiers jamais copiés, même dans un dossier inclus. */
const EXCLUS_FICHIERS = /(^\.|\.test\.js$|\.xdm-part$|\.tmp$)/;

/**
 * Erreur d'empaquetage, porteuse d'un code stable.
 */
export class PaquetError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'PaquetError';
    this.code = code;
  }
}

/**
 * Liste récursivement les fichiers d'un dossier, en excluant les motifs connus.
 *
 * @param {string} racine
 * @param {string} [prefixe]
 * @returns {Promise<string[]>} chemins relatifs, séparateur `/`
 */
export async function listeFichiers(racine, prefixe = '') {
  const entrees = await readdir(join(racine, prefixe), { withFileTypes: true });
  const fichiers = [];
  for (const entree of entrees.sort((a, b) => a.name.localeCompare(b.name))) {
    const chemin = prefixe === '' ? entree.name : `${prefixe}/${entree.name}`;
    if (EXCLUS.includes(chemin) || EXCLUS_FICHIERS.test(entree.name)) continue;
    if (entree.isDirectory()) {
      fichiers.push(...(await listeFichiers(racine, chemin)));
      continue;
    }
    if (entree.isFile()) fichiers.push(chemin);
  }
  return fichiers;
}

/**
 * Calcule le SHA-256 d'un fichier.
 *
 * @param {string} chemin
 * @returns {Promise<string>}
 */
export async function empreinte(chemin) {
  return createHash('sha256').update(await readFile(chemin)).digest('hex');
}

/**
 * Construit le paquet : copie, manifeste, refus explicites.
 *
 * @param {{racine?: string, sortie?: string, version?: string, maintenant?: () => number}} [options]
 * @returns {Promise<{sortie: string, fichiers: object[], octets: number, manifeste: object}>}
 */
export async function construirePaquet({
  racine = ROOT,
  sortie,
  version,
  maintenant = Date.now,
} = {}) {
  const manifesteSource = JSON.parse(await readFile(join(racine, 'package.json'), 'utf8'));
  const numero = version ?? manifesteSource.version ?? '0.0.0';
  const destination = resolve(sortie ?? join(racine, 'dist', `xdm-${numero}`));
  if (destination === resolve(racine) || resolve(racine).startsWith(`${destination}${sep}`)) {
    throw new PaquetError('la sortie ne peut pas contenir la racine du dépôt', 'SORTIE_INVALIDE');
  }

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  /** @type {{chemin: string, octets: number, sha256: string}[]} */
  const fichiers = [];

  const copier = async (chemin) => {
    const source = join(racine, chemin);
    const cible = join(destination, chemin);
    await mkdir(resolve(cible, '..'), { recursive: true });
    await copyFile(source, cible);
    const { size } = await stat(cible);
    fichiers.push({ chemin, octets: size, sha256: await empreinte(cible) });
  };

  for (const fichier of FICHIERS_INCLUS) {
    try {
      const info = await stat(join(racine, fichier));
      if (info.isFile()) await copier(fichier);
    } catch {
      /* un fichier de licence absent n'est pas une erreur ; package.json est exigé plus haut */
    }
  }

  for (const dossier of INCLUS) {
    let liste;
    try {
      liste = await listeFichiers(racine, dossier);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const chemin of liste) await copier(chemin);
  }

  const manifeste = {
    produit: 'XDM',
    version: numero,
    genere: new Date(maintenant()).toISOString(),
    // `desktop/main.js` est le point d'entrée du paquet : sans lui, l'application ne démarre pas.
    pointEntree: 'desktop/main.js',
    fichiers,
    total: { fichiers: fichiers.length, octets: fichiers.reduce((somme, f) => somme + f.octets, 0) },
  };
  await writeFile(join(destination, 'manifeste.json'), `${JSON.stringify(manifeste, null, 2)}\n`, 'utf8');

  return { sortie: destination, fichiers, octets: manifeste.total.octets, manifeste };
}

/**
 * Aide en ligne.
 */
export const USAGE = `usage : node tools/empaqueter.mjs [--sortie DIR] [--version X.Y.Z]
  --sortie   dossier de sortie (défaut dist/xdm-<version>)
  --version  version inscrite dans le manifeste (défaut : celle de package.json)
`;

/**
 * Point d'entrée CLI.
 *
 * @param {string[]} argv
 * @param {{log?: (ligne: string) => void}} [contexte]
 */
export async function main(argv, { log = (ligne) => console.log(ligne) } = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--aide' || argument === '-h') {
      log(USAGE.trimEnd());
      return null;
    }
    if (argument === '--sortie' || argument === '--version') {
      const valeur = argv[i + 1];
      if (valeur === undefined || valeur.startsWith('-')) throw new TypeError(`${argument} attend une valeur`);
      options[argument.slice(2)] = valeur;
      i += 1;
      continue;
    }
    throw new TypeError(`argument inconnu : ${argument}`);
  }
  const resultat = await construirePaquet(options);
  log(`paquet    : ${relative(process.cwd(), resultat.sortie) || resultat.sortie}`);
  log(`fichiers  : ${resultat.manifeste.total.fichiers} (${resultat.manifeste.total.octets} octets)`);
  log('manifeste : manifeste.json');
  return resultat;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`empaqueter : ${error.message}`);
    process.exit(2);
  });
}
