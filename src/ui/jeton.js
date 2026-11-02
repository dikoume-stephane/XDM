/**
 * Jeton d'accès côté page — module sans DOM, donc testable dans Node.
 *
 * **Pourquoi ce module existe.** Le serveur protège son API par un jeton depuis `D-088`.
 * La première version échangeait `?jeton=` contre un cookie `SameSite=Strict` : pratique
 * dans un onglet, **inutilisable dans une iframe d'aperçu**, où toute requête est
 * inter-origines et où le navigateur ne renvoie donc jamais ce cookie. Résultat observé :
 * la page de connexion se réaffichait indéfiniment.
 *
 * La règle retenue est plus simple et ne dépend d'aucun stockage du navigateur :
 *
 *  1. le jeton arrive par l'URL (`?jeton=…`), ou par la mémoire de session s'il a déjà été
 *     saisi ;
 *  2. la page le range (au mieux) et **l'envoie explicitement** à chaque appel ;
 *  3. le cookie reste un confort pour un onglet classique — jamais une condition.
 *
 * Ce fichier ne touche ni `document`, ni `window` : il prend la chaîne de requête et l'objet
 * de stockage en paramètre. `test/jeton-ui.test.js` l'exerce sans navigateur.
 *
 * @module ui/jeton
 */

/** Clé de session utilisée quand le stockage du navigateur est disponible. */
export const CLE_STOCKAGE = 'xdm.jeton';

/** En-tête reconnu par le serveur (`ENTETE_JETON` dans `src/acces.js`). */
export const ENTETE = 'x-jeton';

/** Longueur minimale plausible : un jeton tiré au lancement fait 32 caractères base64url. */
export const LONGUEUR_MINIMALE = 8;

/**
 * Un jeton plausible : non vide, sans espace ni caractère de contrôle, assez long.
 * Ce n'est pas une validation cryptographique — le serveur, lui, compare à temps constant.
 *
 * @param {unknown} valeur
 * @returns {boolean}
 */
export function estPlausible(valeur) {
  return typeof valeur === 'string'
    && valeur.length >= LONGUEUR_MINIMALE
    && !/[\s\u0000-\u001f\u007f]/.test(valeur);
}

/**
 * Lit `?jeton=` dans une chaîne de requête.
 *
 * @param {string} recherche  par exemple `window.location.search`
 * @returns {string|null}
 */
export function jetonDeUrl(recherche) {
  if (typeof recherche !== 'string' || recherche === '') return null;
  const parametres = new URLSearchParams(recherche.startsWith('?') ? recherche.slice(1) : recherche);
  const valeur = parametres.get('jeton');
  return estPlausible(valeur) ? valeur : null;
}

/**
 * Adresse à appeler, jeton compris. Le serveur accepte `?jeton=` sur toute route : c'est ce
 * qui permet à `EventSource`, qui ne sait pas poser d'en-tête, de s'authentifier.
 *
 * @param {string} chemin
 * @param {string|null} jeton
 * @returns {string}
 */
export function avecJeton(chemin, jeton) {
  if (!estPlausible(jeton)) return chemin;
  const separateur = chemin.includes('?') ? '&' : '?';
  return `${chemin}${separateur}jeton=${encodeURIComponent(jeton)}`;
}

/**
 * En-têtes d'un appel, jeton compris. Les en-têtes fournis gardent la priorité.
 *
 * @param {string|null} jeton
 * @param {Record<string, string>} [entetes]
 * @returns {Record<string, string>}
 */
export function entetesJeton(jeton, entetes = {}) {
  const resultat = { ...entetes };
  if (estPlausible(jeton) && resultat[ENTETE] === undefined) resultat[ENTETE] = jeton;
  return resultat;
}

/**
 * Stockage de session, ou `null` si le navigateur le refuse (iframe verrouillée, mode privé).
 * Ne lève jamais : un stockage indisponible ne doit pas empêcher l'interface de s'ouvrir.
 *
 * @param {object} [globale]
 * @returns {{getItem: Function, setItem: Function, removeItem: Function}|null}
 */
export function stockageDisponible(globale = globalThis) {
  try {
    const stockage = globale?.sessionStorage;
    if (!stockage) return null;
    const sonde = '__xdm__';
    stockage.setItem(sonde, '1');
    stockage.removeItem(sonde);
    return stockage;
  } catch {
    return null;
  }
}

/**
 * Jeton retenu en session, s'il y en a un de valide.
 *
 * @param {object|null} stockage
 * @returns {string|null}
 */
export function jetonMemorise(stockage) {
  try {
    const valeur = stockage?.getItem(CLE_STOCKAGE);
    return estPlausible(valeur) ? valeur : null;
  } catch {
    return null;
  }
}

/**
 * Jeton effectif de la page : l'URL d'abord (c'est le plus récent), puis la session.
 *
 * @param {string} recherche
 * @param {object|null} [stockage]
 * @returns {string|null}
 */
export function jetonDeLaPage(recherche, stockage = null) {
  return jetonDeUrl(recherche) ?? jetonMemorise(stockage);
}

/**
 * Mémorise un jeton (au mieux). Renvoie `false` si le stockage refuse : la page continue
 * alors avec le jeton en mémoire vive.
 *
 * @param {object|null} stockage
 * @param {string} jeton
 * @returns {boolean}
 */
export function memoriserJeton(stockage, jeton) {
  if (!estPlausible(jeton)) return false;
  try {
    stockage?.setItem(CLE_STOCKAGE, jeton);
    return Boolean(stockage);
  } catch {
    return false;
  }
}

/**
 * Oublie le jeton (déconnexion, ou jeton refusé par le serveur).
 *
 * @param {object|null} stockage
 */
export function oublierJeton(stockage) {
  try {
    stockage?.removeItem(CLE_STOCKAGE);
  } catch {
    // Un stockage qui refuse la suppression ne doit pas faire échouer la déconnexion.
  }
}

/**
 * Chemin débarrassé du paramètre `jeton`, pour ne pas le laisser dans la barre d'adresse
 * ni dans l'historique. Les autres paramètres sont conservés.
 *
 * @param {string} recherche
 * @param {string} chemin
 * @returns {string}
 */
export function sansJetonDansUrl(recherche, chemin) {
  if (typeof recherche !== 'string' || recherche === '') return chemin;
  const parametres = new URLSearchParams(recherche.startsWith('?') ? recherche.slice(1) : recherche);
  if (!parametres.has('jeton')) {
    // Rien à retirer : les autres paramètres sont rendus tels quels, pas effacés.
    const conserve = parametres.toString();
    return conserve === '' ? chemin : `${chemin}?${conserve}`;
  }
  parametres.delete('jeton');
  const reste = parametres.toString();
  return reste === '' ? chemin : `${chemin}?${reste}`;
}
