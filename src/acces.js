/**
 * Jeton d'accès à l'interface locale — lot `WP-55` (`EX-E-08`, `D-088`).
 *
 * `D-084` avait choisi une écoute **locale** par défaut, avec `--hote 0.0.0.0` comme
 * échappatoire assumée pour les environnements d'aperçu. Cette échappatoire a un défaut
 * évident : quiconque joint le port peut faire télécharger n'importe quoi à la machine.
 *
 * Ce module apporte la serrure, sans compte ni mot de passe stocké :
 *
 *  1. **Un secret par lancement**, tiré par `crypto.randomBytes` (192 bits), jamais
 *     devinable, affiché une seule fois au démarrage.
 *  2. **Comparaison à temps constant** : `timingSafeEqual` sur des tampons de longueur
 *     égale, pour ne pas laisser fuir le préfixe correct par le temps de réponse.
 *  3. **Trois façons de le présenter**, une seule vérité : `Authorization: Bearer`,
 *     en-tête `x-jeton`, ou `?jeton=` une fois — l'échange pose un cookie `HttpOnly` pour
 *     que `EventSource` (qui ne sait pas poser d'en-tête) continue de fonctionner.
 *  4. **Aucune trace écrite** : le jeton vit en mémoire du processus, il n'est jamais
 *     journalisé ni écrit sur disque.
 *
 * @module acces
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** En-tête alternatif, pratique pour `curl`. */
export const ENTETE_JETON = 'x-jeton';

/** Nom du cookie de session locale. */
export const COOKIE_JETON = 'xdm_jeton';

/** Durée de vie du cookie : la session de travail, pas plus. */
export const DUREE_COOKIE = 12 * 60 * 60;

/**
 * Erreur d'accès, porteuse d'un code stable.
 */
export class AccesError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'AccesError';
    this.code = code;
  }
}

/**
 * Tire un jeton neuf.
 *
 * @param {number} [octets]
 * @returns {string} base64url, sans caractère à échapper dans une URL
 */
export function genererJeton(octets = 24) {
  if (!Number.isInteger(octets) || octets < 16) {
    throw new RangeError('un jeton fait au moins 16 octets');
  }
  return randomBytes(octets).toString('base64url');
}

/**
 * Indique si une adresse d'écoute reste sur la machine.
 *
 * @param {string} hote
 * @returns {boolean}
 */
export function estBoucleLocale(hote) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(hote).toLowerCase());
}

/**
 * Compare deux jetons en temps constant.
 *
 * Deux longueurs différentes répondent `false` sans comparer : la longueur d'un jeton n'est
 * pas un secret (elle est fixe ici).
 *
 * @param {unknown} fourni
 * @param {string} attendu
 * @returns {boolean}
 */
export function jetonValide(fourni, attendu) {
  if (typeof fourni !== 'string' || typeof attendu !== 'string' || attendu === '') return false;
  const a = Buffer.from(fourni);
  const b = Buffer.from(attendu);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Extrait le jeton d'une requête, par ordre de préférence.
 *
 * @param {{headers?: Record<string, unknown>, url?: URL|string}} requete
 * @returns {string|null}
 */
export function extraireJeton({ headers = {}, url } = {}) {
  const autorisation = headers.authorization;
  if (typeof autorisation === 'string') {
    const [schema, valeur] = autorisation.split(' ');
    if (schema?.toLowerCase() === 'bearer' && valeur) return valeur;
  }
  const entete = headers[ENTETE_JETON];
  if (typeof entete === 'string' && entete !== '') return entete;
  const cible = typeof url === 'string' ? new URL(url, 'http://localhost') : url;
  const parametre = cible?.searchParams?.get('jeton');
  if (typeof parametre === 'string' && parametre !== '') return parametre;
  return jetonDuCookie(headers.cookie);
}

/**
 * Lit le jeton dans l'en-tête `Cookie`.
 *
 * @param {unknown} enteteCookie
 * @returns {string|null}
 */
export function jetonDuCookie(enteteCookie) {
  if (typeof enteteCookie !== 'string' || enteteCookie === '') return null;
  for (const morceau of enteteCookie.split(';')) {
    const [nom, ...reste] = morceau.trim().split('=');
    if (nom === COOKIE_JETON) {
      const valeur = decodeURIComponent(reste.join('='));
      return valeur === '' ? null : valeur;
    }
  }
  return null;
}

/**
 * En-tête `Set-Cookie` qui installe le jeton de session.
 *
 * `HttpOnly` : la page n'a pas besoin de le lire, `fetch` et `EventSource` l'envoient seuls.
 * `SameSite=Strict` : une page tierce ne peut pas déclencher d'appel authentifié.
 *
 * @param {string} jeton
 * @param {{securise?: boolean}} [options]
 * @returns {string}
 */
export function cookieDeJeton(jeton, { securise = false } = {}) {
  const attributs = [
    `${COOKIE_JETON}=${encodeURIComponent(jeton)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${DUREE_COOKIE}`,
  ];
  if (securise) attributs.push('Secure');
  return attributs.join('; ');
}

/**
 * En-tête qui **efface** le cookie (déconnexion, ou jeton refusé).
 *
 * @returns {string}
 */
export function effacerCookie() {
  return `${COOKIE_JETON}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
