/**
 * Réglages persistants de l'interface — lot `WP-52`, décision `D-084`/`D-085`.
 *
 * Une interface qui oublie ses réglages à chaque démarrage oblige à les ressaisir : au
 * bout de trois lancements, l'utilisateur contourne l'interface. Les réglages vivent donc
 * dans un fichier JSON unique, hors du dossier de travail, et sont relus au démarrage.
 *
 * Trois règles, chacune testée :
 *
 *  1. **Défauts explicites.** Un fichier absent n'est pas une erreur : on part des
 *     valeurs par défaut. Un fichier illisible, lui, est une erreur — le silence ferait
 *     croire que les réglages ont été appliqués.
 *  2. **Validation stricte.** Une valeur hors bornes est refusée avec le nom du champ,
 *     jamais corrigée en silence : `--actifs 0` qui deviendrait `1` ferait croire à une
 *     limite respectée.
 *  3. **`robots` n'est pas réglable.** Le respect de `robots.txt` est une contrainte de
 *     produit (`D-004`) : on peut le lire, pas le désactiver.
 *
 * @module reglages
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Nom du fichier de réglages, sous `~/.config/xdm/`. */
export const FICHIER_REGLAGES = 'reglages.json';

/** Schéma courant : une version absente ou différente est refusée, pas devinée. */
export const VERSION_REGLAGES = 1;

/** Valeurs par défaut, alignées sur celles de `xdm-ui`. */
export const DEFAUTS_REGLAGES = Object.freeze({
  version: VERSION_REGLAGES,
  dossier: './telechargements',
  connexions: 4,
  maxActifs: 2,
  theme: 'systeme',
  profondeur: 2,
  maxPages: 100,
  robots: true,
});

/** Thèmes acceptés. */
export const THEMES = /** @type {const} */ (['clair', 'sombre', 'systeme']);

/**
 * Erreur de réglages, porteuse d'un code stable.
 */
export class ReglagesError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ReglagesError';
    this.code = code;
    this.details = details;
  }
}

/** Chemin par défaut : `~/.config/xdm/reglages.json` (ou `%APPDATA%` sous Windows). */
export function cheminParDefaut() {
  const base = process.platform === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'xdm', FICHIER_REGLAGES);
}

/** Vrai si `valeur` est un entier dans `[min, max]`. */
const entierDans = (valeur, min, max) => Number.isInteger(valeur) && valeur >= min && valeur <= max;

/**
 * Valide un objet de réglages et rend une copie complète.
 *
 * Les clés inconnues sont ignorées (un fichier écrit par une version ultérieure ne doit
 * pas empêcher de démarrer), les valeurs connues sont vérifiées.
 *
 * @param {unknown} brut
 * @returns {typeof DEFAUTS_REGLAGES}
 */
export function validerReglages(brut) {
  if (brut === null || typeof brut !== 'object' || Array.isArray(brut)) {
    throw new ReglagesError('les réglages doivent être un objet JSON', 'REGLAGES_INVALIDE');
  }
  const source = /** @type {Record<string, unknown>} */ (brut);
  if (source.version !== undefined && source.version !== VERSION_REGLAGES) {
    throw new ReglagesError(
      `version de réglages inconnue : ${String(source.version)} (attendu ${VERSION_REGLAGES})`,
      'VERSION_INCONNUE',
      { version: source.version },
    );
  }
  const resultat = { ...DEFAUTS_REGLAGES };

  if (source.dossier !== undefined) {
    if (typeof source.dossier !== 'string' || source.dossier.trim() === '') {
      throw new ReglagesError('`dossier` doit être un chemin non vide', 'REGLE_INVALIDE', { champ: 'dossier' });
    }
    resultat.dossier = source.dossier.trim();
  }
  for (const [champ, min, max] of [['connexions', 1, 128], ['maxActifs', 1, 32], ['profondeur', 1, 5], ['maxPages', 1, 100_000]]) {
    if (source[champ] === undefined) continue;
    if (!entierDans(source[champ], min, max)) {
      throw new ReglagesError(
        `\`${champ}\` doit être un entier entre ${min} et ${max}`,
        'REGLE_INVALIDE',
        { champ, min, max, valeur: source[champ] },
      );
    }
    resultat[champ] = /** @type {number} */ (source[champ]);
  }
  if (source.theme !== undefined) {
    if (!THEMES.includes(/** @type {any} */ (source.theme))) {
      throw new ReglagesError(
        `\`theme\` doit être l'un de : ${THEMES.join(', ')}`,
        'REGLE_INVALIDE',
        { champ: 'theme', valeur: source.theme },
      );
    }
    resultat.theme = /** @type {any} */ (source.theme);
  }
  // `robots` est une contrainte de produit : on peut le lire, jamais le désactiver.
  if (source.robots !== undefined && source.robots !== true) {
    throw new ReglagesError(
      '`robots` ne peut pas être désactivé (D-004)',
      'ROBOTS_VERROUILLE',
      { valeur: source.robots },
    );
  }
  resultat.robots = true;
  return resultat;
}

/**
 * Lit les réglages ; rend les défauts si le fichier n'existe pas.
 *
 * @param {string} chemin
 */
export async function lireReglages(chemin = cheminParDefaut()) {
  let texte;
  try {
    texte = await readFile(chemin, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ...DEFAUTS_REGLAGES, chemin, existe: false };
    throw new ReglagesError(`réglages illisibles : ${chemin}`, 'LECTURE_IMPOSSIBLE', { chemin, cause: String(error) });
  }
  let brut;
  try {
    brut = JSON.parse(texte);
  } catch {
    throw new ReglagesError(`réglages illisibles (JSON invalide) : ${chemin}`, 'JSON_INVALIDE', { chemin });
  }
  return { ...validerReglages(brut), chemin, existe: true };
}

/**
 * Écrit les réglages de façon atomique (fichier temporaire + `rename`).
 *
 * @param {string} chemin
 * @param {unknown} brut
 */
export async function ecrireReglages(chemin, brut) {
  const valides = validerReglages(brut);
  await mkdir(dirname(chemin), { recursive: true });
  const temporaire = `${chemin}.${process.pid}.tmp`;
  await writeFile(temporaire, `${JSON.stringify(valides, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaire, chemin);
  return { ...valides, chemin, existe: true };
}
