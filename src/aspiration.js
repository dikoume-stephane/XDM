/**
 * Aspiration de site pilotée par l'interface — lot `WP-52`.
 *
 * Les briques existent depuis `WP-23` (`crawl`), `WP-24` (`prepareGrab`) et `WP-25`
 * (`executeGrab`) ; ce module n'en invente aucune. Il assemble la séquence que suit
 * `bin/xdm-grab.js`, avec deux différences imposées par l'interface :
 *
 *  1. **Un dossier par aspiration.** La file (`queue.json`) et le projet (`.gsd`) sont
 *     écrits dans un sous-dossier propre (`<racine>/<hôte>-<horodatage>`). Sans cela,
 *     deux aspirations dans le même dossier écraseraient la même file, et la vérification
 *     d'un téléchargement simple lirait une file d'aspiration.
 *  2. **La progression est un rappel.** Le parcours signale chaque page retenue, la file
 *     signale chaque tâche démarrée/terminée : l'interface n'a rien à sonder.
 *
 * `robots.txt` est toujours respecté (`D-004`) : le paramètre n'existe pas, ce n'est pas
 * un oubli.
 *
 * @module aspiration
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { crawl } from './crawler.js';
import { executeGrab } from './grab-runner.js';
import { prepareGrab } from './grabber.js';
import { fetchText } from './http-client.js';
import { createProject, projectPath } from './project.js';
import { createQueue } from './task-queue.js';

/** Profondeur par défaut, comme la CLI (`D-039`). */
export const PROFONDEUR_DEFAUT = 2;

/** Plafond de pages par défaut : au-delà, une aspiration n'est plus une vérification. */
export const PAGES_DEFAUT = 100;

/**
 * Erreur d'aspiration, porteuse d'un code stable.
 */
export class AspirationError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'AspirationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Nom de dossier sûr, dérivé de l'hôte et de l'horodatage.
 *
 * L'hôte vient d'une URL : il peut contenir des caractères interdits par le système de
 * fichiers (`:`, `?`, `*` sous Windows). On ne garde que `[a-z0-9.-]`.
 *
 * @param {string} url
 * @param {number} horodatage
 */
export function nomDossier(url, horodatage = Date.now()) {
  let hote = 'site';
  try {
    hote = new URL(url).hostname || 'site';
  } catch {
    hote = 'site';
  }
  const sur = hote.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
  const date = new Date(horodatage);
  const partie = Number.isNaN(date.getTime())
    ? String(horodatage)
    : date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${sur}-${partie}`;
}

/**
 * Exécute une aspiration complète : parcours → plan → file → téléchargement.
 *
 * @param {{
 *   url: string,
 *   racine: string,
 *   profondeur?: number,
 *   maxPages?: number,
 *   delai?: number|null,
 *   maintenant?: () => number,
 *   fetchPage?: (url: string, init?: object) => Promise<object>,
 *   onEtape?: (etape: {phase: string, pages?: number, retenus?: number, tache?: object}) => void,
 *   onEvent?: (evenement: object) => void,
 * }} options
 */
export async function executerAspiration({
  url,
  racine,
  profondeur = PROFONDEUR_DEFAUT,
  maxPages = PAGES_DEFAUT,
  delai = null,
  maintenant = Date.now,
  fetchPage = (adresse, init = {}) => fetchText(adresse, { headers: init.headers ?? {} }),
  onEtape = () => {},
  onEvent = () => {},
} = {}) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new AspirationError('URL requise', 'URL_MANQUANTE');
  }
  let analysee;
  try {
    analysee = new URL(url.trim());
  } catch {
    throw new AspirationError(`URL invalide : ${url}`, 'URL_INVALIDE', { url });
  }
  if (analysee.protocol !== 'http:' && analysee.protocol !== 'https:') {
    throw new AspirationError(`schéma refusé : ${analysee.protocol}`, 'SCHEMA_REFUSE', { protocole: analysee.protocol });
  }
  if (!Number.isInteger(profondeur) || profondeur < 1 || profondeur > 5) {
    throw new AspirationError('profondeur : entier de 1 à 5', 'PROFONDEUR_INVALIDE', { profondeur });
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100_000) {
    throw new AspirationError('pages maximum : entier de 1 à 100 000', 'PAGES_INVALIDE', { maxPages });
  }

  const horodatage = maintenant();
  const dossier = nomDossier(analysee.href, horodatage);
  const rootDir = join(racine, dossier);
  await mkdir(rootDir, { recursive: true });

  const project = createProject({ name: dossier, rootUrl: analysee.href, depth: profondeur });

  onEtape({ phase: 'parcours', pages: 0, retenus: 0 });
  const trouve = await crawl(analysee.href, {
    fetchPage,
    depth: profondeur,
    maxPages,
    robots: true,
    ...(delai !== null ? { delai } : {}),
    onPage: (page) => {
      if (page && page.retained) onEtape({ phase: 'parcours', pages: page.fetched ?? 0, retenus: page.retained });
    },
  });
  onEtape({ phase: 'plan', pages: trouve.fetched, retenus: trouve.retained.length });

  const plan = await prepareGrab({
    project,
    queue: createQueue({}),
    retained: trouve.retained,
    rootDir,
  });
  const total = plan.queue.tasks.length;
  // Le compte est tenu ici, pas à la fin : l'écran doit voir 3/10 pendant le
  // téléchargement, pas 0/0 puis 10/10 (`D-085`).
  let termines = 0;
  let echecs = 0;
  onEtape({ phase: 'telechargement', pages: trouve.fetched, retenus: trouve.retained.length, taches: total, termines });

  const resultat = await executeGrab({
    project: plan.project,
    queue: plan.queue,
    projectPath: projectPath(rootDir, plan.project.name),
    queueDir: rootDir,
    onEvent: (evenement) => {
      if (evenement && evenement.task) {
        if (evenement.type === 'done') termines += 1;
        if (evenement.type === 'failed') echecs += 1;
        onEtape({
          phase: 'tache',
          taches: total,
          termines,
          echecs,
          tache: { url: evenement.task.url, etat: evenement.type },
        });
      }
      onEvent(evenement);
    },
  });
  onEtape({ phase: 'fini', pages: trouve.fetched, retenus: trouve.retained.length });

  return {
    url: analysee.href,
    dossier: rootDir,
    nom: plan.project.name,
    pages: trouve.fetched,
    retenus: trouve.retained.length,
    taches: total,
    termines,
    echecs: resultat.failures.length,
    // Une aspiration est terminée quand toutes ses tâches sont terminées : un échec
    // partiel se voit dans le code de sortie, pas dans un silence.
    codeSortie: resultat.failures.length === 0 && termines === total ? 0 : 1,
    echecsDetail: resultat.failures.slice(0, 20).map((echec) => ({
      url: echec.url,
      message: echec.error ?? null,
    })),
  };
}
