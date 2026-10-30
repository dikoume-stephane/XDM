/**
 * Serveur de l'interface locale — lot `WP-51`.
 *
 * Une application de bureau Electron charge une page ; cette page doit bien parler à
 * quelque chose. Ce module est ce « quelque chose » : un serveur `node:http` sans
 * dépendance qui sert l'interface statique et expose l'état du gestionnaire.
 *
 * Choix explicites :
 *
 *  - **Écoute sur la boucle locale par défaut** (`127.0.0.1`). Une interface qui pilote
 *    des téléchargements arbitraires n'a rien à faire sur un réseau partagé ; l'option
 *    `--hote 0.0.0.0` existe pour les environnements d'aperçu, elle doit rester un
 *    choix explicite.
 *  - **Aucune vérification d'origine** : la page est servie par ce même serveur et
 *    l'app Electron la charge en `file://`. Les en-têtes `Host` exotiques (proxy
 *    d'aperçu) sont donc acceptés — le contraire casserait la prévisualisation sans
 *    rien protéger de plus, puisque le port n'est pas exposé par défaut.
 *  - **Un seul écrivain côté état** : toutes les mutations passent par le gestionnaire.
 *    L'API ne fait que traduire HTTP ↔ appels de méthode.
 *  - **SSE plutôt que sondage** : `GET /api/evenements` diffuse les événements du
 *    gestionnaire ; une interface qui interrogerait `/api/etat` en boucle consommerait
 *    plus pour afficher la même chose.
 *
 * @module ui-server
 *
 * Décision `D-084` : trois couches (gestionnaire, serveur, CLI), écoute locale par défaut,
 * et aucune route pour ce que le moteur ne sait pas encore faire.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as normalise, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManager, ManagerError } from './manager.js';
import { ecrireReglages, lireReglages, ReglagesError, validerReglages } from './reglages.js';
import { VerificationError } from './verification.js';
import { VERSION } from './version.js';

/** Racine des fichiers de l'interface. */
export const UI_DIR = resolve(fileURLToPath(new URL('./ui/', import.meta.url)));

/** Taille maximale d'un corps de requête JSON (une URL tient largement dedans). */
export const MAX_CORPS = 64 * 1024;

/** Battement de cœur SSE : maintient la connexion ouverte à travers les proxys. */
export const BATTEMENT_MS = 15_000;

/** Types MIME servis. Le jeu est fermé : tout le reste est refusé. */
const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

/**
 * Réponse JSON compacte.
 * @param {import('node:http').ServerResponse} res
 * @param {number} statut
 * @param {unknown} corps
 */
function json(res, statut, corps) {
  const charge = JSON.stringify(corps);
  res.writeHead(statut, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(charge),
    'cache-control': 'no-store',
  });
  res.end(charge);
}

/**
 * Lit un corps JSON borné.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function lireJson(req) {
  const morceaux = [];
  let taille = 0;
  for await (const morceau of req) {
    taille += morceau.length;
    if (taille > MAX_CORPS) {
      throw new ManagerError('corps de requête trop volumineux', 'CORPS_TROP_GRAND', { limite: MAX_CORPS });
    }
    morceaux.push(morceau);
  }
  if (taille === 0) return {};
  try {
    return JSON.parse(Buffer.concat(morceaux).toString('utf8'));
  } catch {
    throw new ManagerError('JSON invalide', 'JSON_INVALIDE');
  }
}

/**
 * Sert un fichier de l'interface, en refusant toute sortie de `UI_DIR`.
 * @param {import('node:http').ServerResponse} res
 * @param {string} racine
 * @param {string} chemin
 */
async function servirFichier(res, racine, chemin) {
  let decode;
  try {
    decode = decodeURIComponent(chemin);
  } catch {
    json(res, 400, { erreur: { code: 'CHEMIN_INVALIDE', message: 'encodage invalide' } });
    return;
  }
  // Un segment `..` est refusé avant toute normalisation : `normalize` l'absorberait
  // silencieusement en repartant de la racine, ce qui donnerait un 404 trompeur là où
  // la bonne réponse est « ce chemin sort de la racine ».
  if (decode.split(/[/\\]+/).includes('..')) {
    json(res, 403, { erreur: { code: 'HORS_RACINE', message: 'chemin refusé' } });
    return;
  }
  const relatif = normalise(decode).replace(/^([/\\])+/, '');
  const absolu = resolve(join(racine, relatif));
  if (absolu !== racine && !absolu.startsWith(`${racine}/`)) {
    json(res, 403, { erreur: { code: 'HORS_RACINE', message: 'chemin refusé' } });
    return;
  }
  let contenu;
  try {
    contenu = await readFile(absolu);
  } catch {
    json(res, 404, { erreur: { code: 'INTROUVABLE', message: `aucun fichier : ${chemin}` } });
    return;
  }
  const type = TYPES.get(extname(absolu).toLowerCase()) ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': contenu.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(contenu);
}

/**
 * Crée le serveur de l'interface.
 *
 * @param {{
 *   manager?: ReturnType<typeof createManager>,
 *   racine?: string,
 *   dossier?: string,
 *   connexions?: number,
 *   maxActifs?: number,
 * }} [options]
 */
export function createUiServer({
  manager,
  racine = UI_DIR,
  dossier,
  connexions,
  maxActifs,
  reglages = null,
  ecrire = ecrireReglages,
} = {}) {
  const gestionnaire =
    manager ??
    createManager({
      ...(dossier ? { dossier } : {}),
      ...(connexions ? { connexions } : {}),
      ...(maxActifs ? { maxActifs } : {}),
    });

  /** Réglages persistants de cette instance (null si l'appelant n'en fournit pas). */
  let courant = reglages ?? null;

  /** Connexions SSE ouvertes, fermées à l'arrêt du serveur. */
  const flux = new Set();

  const serveur = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const chemin = url.pathname;
    const methode = req.method ?? 'GET';

    try {
      // ---------- API ----------
      if (chemin === '/api/etat') {
        if (methode !== 'GET') return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
        return json(res, 200, { version: VERSION, ...gestionnaire.etat() });
      }

      if (chemin === '/api/taches') {
        if (methode === 'GET') return json(res, 200, { taches: gestionnaire.taches() });
        if (methode === 'POST') {
          const corps = await lireJson(req);
          const tache = gestionnaire.ajouter({ url: corps.url, nom: corps.nom });
          return json(res, 201, { tache });
        }
        return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
      }

      const detail = /^\/api\/taches\/([^/]+)$/.exec(chemin);
      if (detail) {
        const id = decodeURIComponent(detail[1]);
        if (methode === 'DELETE') {
          const tache = gestionnaire.retirer(id);
          return json(res, 200, { tache });
        }
        return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
      }

      if (chemin === '/api/demarrer') {
        if (methode !== 'POST') return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
        // On ne bloque pas la réponse : l'interface suit l'avancement par SSE.
        gestionnaire.demarrer().catch(() => {});
        return json(res, 202, { demarre: true });
      }

      if (chemin === '/api/reglages') {
        if (methode === 'GET') {
          return json(res, 200, {
            reglages: courant ?? { dossier: gestionnaire.etat().dossier, connexions: gestionnaire.etat().connexions, maxActifs: gestionnaire.etat().maxActifs },
          });
        }
        if (methode === 'PATCH' || methode === 'PUT') {
          const corps = await lireJson(req);
          const fusion = { ...(courant ?? {}), ...corps };
          const valides = validerReglages(fusion);
          if (courant && courant.chemin) {
            courant = await ecrire(courant.chemin, valides);
          } else {
            courant = { ...valides };
          }
          gestionnaire.configurer({
            dossier: valides.dossier,
            connexions: valides.connexions,
            maxActifs: valides.maxActifs,
          });
          return json(res, 200, { reglages: courant });
        }
        return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
      }

      if (chemin === '/api/aspirations') {
        if (methode === 'GET') return json(res, 200, { aspirations: gestionnaire.aspirations() });
        if (methode === 'POST') {
          const corps = await lireJson(req);
          const aspiration = gestionnaire.aspirer({
            url: corps.url,
            ...(corps.profondeur !== undefined ? { profondeur: corps.profondeur } : {}),
            ...(corps.maxPages !== undefined ? { maxPages: corps.maxPages } : {}),
            // Parité avec `xdm-grab` (`WP-54`) : filtres, sous-domaines, explorations
            // simultanées et réécriture des liens passent par la même validation.
            ...(corps.inclure !== undefined ? { inclure: corps.inclure } : {}),
            ...(corps.exclure !== undefined ? { exclure: corps.exclure } : {}),
            ...(corps.sousDomaines !== undefined ? { sousDomaines: corps.sousDomaines } : {}),
            ...(corps.paralleles !== undefined ? { paralleles: corps.paralleles } : {}),
            ...(corps.reecrire !== undefined ? { reecrire: corps.reecrire } : {}),
          });
          return json(res, 202, { aspiration });
        }
        return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
      }

      if (chemin === '/api/verifications') {
        if (methode !== 'POST') return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
        const corps = await lireJson(req);
        const rapport = await gestionnaire.verifier(corps.dossier !== undefined ? { dossier: corps.dossier } : {});
        return json(res, 200, { rapport });
      }

      if (chemin === '/api/journal') {
        if (methode !== 'GET') return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
        return json(res, 200, { entrees: gestionnaire.journal() });
      }

      if (chemin === '/api/historique') {
        if (methode !== 'GET') return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
        return json(res, 200, { entrees: gestionnaire.historique() });
      }

      if (chemin === '/api/evenements') {
        if (methode !== 'GET') return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`retry: 2000\n\n`);
        // Instantané initial : un client qui se reconnecte ne repart pas d'un écran vide.
        res.write(`event: etat\ndata: ${JSON.stringify(gestionnaire.etat())}\n\n`);
        const envoyer = (evenement) => {
          res.write(`event: ${evenement.type}\ndata: ${JSON.stringify(evenement)}\n\n`);
        };
        const desabonner = gestionnaire.abonner(envoyer);
        const battement = setInterval(() => res.write(': battement\n\n'), BATTEMENT_MS);
        battement.unref?.();
        flux.add(res);
        const fermer = () => {
          clearInterval(battement);
          desabonner();
          flux.delete(res);
        };
        req.on('close', fermer);
        res.on('close', fermer);
        return undefined;
      }

      if (chemin.startsWith('/api/')) {
        return json(res, 404, { erreur: { code: 'ROUTE_INCONNUE', message: chemin } });
      }

      // ---------- Interface ----------
      if (methode !== 'GET' && methode !== 'HEAD') {
        return json(res, 405, { erreur: { code: 'METHODE_REFUSEE' } });
      }
      return await servirFichier(res, resolve(racine), chemin === '/' ? '/index.html' : chemin);
    } catch (error) {
      if (error instanceof ReglagesError) {
        return json(res, 400, { erreur: { code: error.code, message: error.message, ...error.details } });
      }
      if (error instanceof VerificationError) {
        const statut = error.code === 'DOSSIER_ABSENT' || error.code === 'FILE_ABSENTE' ? 404 : error.code === 'FILE_ILLISIBLE' ? 409 : 400;
        return json(res, statut, { erreur: { code: error.code, message: error.message, ...error.details } });
      }
      if (error instanceof ManagerError) {
        const statut =
          error.code === 'TACHE_INCONNUE' || error.code === 'HORS_RACINE'
            ? 404
            : error.code === 'TACHE_ACTIVE' || error.code === 'NOM_DEJA_PRIS'
              ? 409
              : error.code === 'CORPS_TROP_GRAND'
                ? 413
                : 400;
        return json(res, statut, { erreur: { code: error.code, message: error.message, ...error.details } });
      }
      return json(res, 500, { erreur: { code: 'ERREUR_INTERNE', message: String(error && error.message ? error.message : error) } });
    }
  });

  /** Ferme les flux SSE puis le serveur. */
  async function fermer() {
    for (const res of flux) {
      try {
        res.end();
      } catch {
        /* la connexion est déjà partie */
      }
    }
    flux.clear();
    await new Promise((resoudre) => serveur.close(() => resoudre(undefined)));
  }

  return { serveur, manager: gestionnaire, fermer };
}

/**
 * Démarre le serveur et rend l'URL réelle (le port `0` demande un port libre).
 *
 * @param {{port?: number, hote?: string} & Parameters<typeof createUiServer>[0]} [options]
 */
export async function startUiServer({ port = 8100, hote = '127.0.0.1', ...reste } = {}) {
  const { serveur, manager, fermer } = createUiServer(reste);
  await new Promise((resoudre, rejeter) => {
    serveur.once('error', rejeter);
    serveur.listen(port, hote, () => {
      serveur.off('error', rejeter);
      resoudre(undefined);
    });
  });
  const adresse = serveur.address();
  const portReel = typeof adresse === 'object' && adresse ? adresse.port : port;
  const hoteAffiche = hote === '0.0.0.0' ? '127.0.0.1' : hote;
  return {
    serveur,
    manager,
    fermer,
    port: portReel,
    hote,
    url: `http://${hoteAffiche}:${portReel}/`,
  };
}
