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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { crawl } from './crawler.js';
import { executeGrab } from './grab-runner.js';
import { prepareGrab } from './grabber.js';
import { fetchText } from './http-client.js';
import { addFilter, createProject, projectPath, splitMotif } from './project.js';
import { rewriteDocument, siteMapFromEntries } from './rewrite.js';
import { createQueue, loadQueue, saveQueue } from './task-queue.js';

/** Profondeur par défaut, comme la CLI (`D-039`). */
export const PROFONDEUR_DEFAUT = 2;

/** Plafond de pages par défaut : au-delà, une aspiration n'est plus une vérification. */
export const PAGES_DEFAUT = 100;

/** Explorations simultanées autorisées (`WP-54`) : au-delà, on martèle le serveur d'autrui. */
export const PARALLELES_MAX = 8;

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
 * Clé de comparaison de chemins, indépendante du séparateur de la plateforme.
 *
 * @param {string} chemin
 * @returns {string}
 */
function cleChemin(chemin) {
  return String(chemin).replace(/\\/g, '/');
}

/**
 * Valide une liste de motifs de filtre.
 *
 * Un motif vide est refusé plutôt qu'ignoré : `--exclure ""` qui ne filtre rien donne
 * l'illusion d'une exclusion.
 *
 * @param {unknown} valeur
 * @param {string} nom
 * @returns {string[]}
 */
export function normaliserMotifs(valeur, nom) {
  if (valeur === undefined || valeur === null) return [];
  if (!Array.isArray(valeur)) {
    throw new AspirationError(`${nom} : tableau de motifs attendu`, 'MOTIFS_INVALIDES', { champ: nom });
  }
  return valeur.map((motif) => {
    if (typeof motif !== 'string' || motif.trim() === '') {
      throw new AspirationError(`${nom} : motif vide refusé`, 'MOTIF_INVALIDE', { champ: nom });
    }
    return motif.trim();
  });
}

/**
 * Filtres actifs d'un projet, sous la forme attendue par `crawl`.
 *
 * @param {{filters: {include: object[], exclude: object[]}}} projet
 * @returns {{include: string[], exclude: string[]}}
 */
export function filtresDuProjet(projet) {
  const motifs = (liste) =>
    (projet.filters[liste] ?? [])
      .filter((filtre) => filtre.actif !== false)
      .flatMap((filtre) => splitMotif(filtre.motif));
  return { include: motifs('include'), exclude: motifs('exclude') };
}

/**
 * Réécrit les liens des pages HTML et CSS téléchargées pour qu'elles s'ouvrent en local.
 *
 * Une erreur de lecture n'interrompt pas l'aspiration : la réécriture est un confort de
 * consultation, pas une condition de succès — un fichier absent est déjà compté par la file.
 *
 * @param {{rootDir: string, entries: Array<{url: string, localPath: string}>}} options
 * @returns {Promise<{reecrits: number, tailles: Map<string, number>}>}
 */
export async function reecrireLiens({ rootDir, entries }) {
  const siteMap = siteMapFromEntries(entries ?? []);
  let reecrits = 0;
  /** Taille réelle des fichiers modifiés : la file doit suivre, sinon la vérification
   *  signalerait « tronqué » un fichier simplement réécrit (constaté en essai réel). */
  const tailles = new Map();
  for (const entree of entries ?? []) {
    if (!/\.(html?|css)$/i.test(entree.localPath)) continue;
    const fichier = join(rootDir, entree.localPath);
    let source;
    try {
      source = await readFile(fichier, 'utf8');
    } catch {
      continue;
    }
    const resultat = rewriteDocument(source, {
      pageUrl: entree.url,
      pageLocalPath: entree.localPath,
      siteMap,
    });
    if (resultat.rewritten > 0) {
      try {
        await writeFile(fichier, resultat.text, 'utf8');
        reecrits += resultat.rewritten;
        // La file enregistre le **chemin absolu** de la cible : la clé suit, sinon
        // l'alignement ne trouve aucune tâche (défaut vu au premier essai).
        tailles.set(cleChemin(join(rootDir, entree.localPath)), Buffer.byteLength(resultat.text, 'utf8'));
      } catch {
        /* fichier en lecture seule : on continue, le total dira ce qui a été fait */
      }
    }
  }
  return { reecrits, tailles };
}

/**
 * Aligne la taille attendue des tâches sur la taille réelle des fichiers réécrits.
 *
 * La réécriture change la longueur d'une page (un lien absolu devient relatif). Sans cette
 * mise à jour, `queue.json` décrit un fichier qui n'existe plus tel quel et la vérification
 * annonce « tronqué » — c'est exactement le défaut trouvé en essai réel après `WP-54`.
 *
 * @param {{rootDir: string, tailles: Map<string, number>}} options
 * @returns {Promise<number>} nombre de tâches mises à jour
 */
export async function alignerTailles({ rootDir, tailles }) {
  if (!tailles || tailles.size === 0) return 0;
  const file = await loadQueue(rootDir);
  let modifiees = 0;
  const tasks = file.tasks.map((tache) => {
    const taille = tailles.get(cleChemin(tache.target));
    if (taille === undefined || tache.totalSize === taille) return tache;
    modifiees += 1;
    return { ...tache, totalSize: taille, updatedAt: Date.now() };
  });
  if (modifiees > 0) await saveQueue(rootDir, { ...file, tasks });
  return modifiees;
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
 *   inclure?: string[],
 *   exclure?: string[],
 *   sousDomaines?: boolean,
 *   paralleles?: number,
 *   reecrire?: boolean,
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
  inclure = [],
  exclure = [],
  sousDomaines = false,
  paralleles = 1,
  reecrire = false,
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
  const motifsInclus = normaliserMotifs(inclure, 'inclure');
  const motifsExclus = normaliserMotifs(exclure, 'exclure');
  if (!Number.isInteger(paralleles) || paralleles < 1 || paralleles > PARALLELES_MAX) {
    throw new AspirationError(
      `explorations simultanées : entier de 1 à ${PARALLELES_MAX}`,
      'PARALLELES_INVALIDE',
      { paralleles },
    );
  }
  if (typeof sousDomaines !== 'boolean' || typeof reecrire !== 'boolean') {
    throw new AspirationError('sous-domaines et réécriture : booléens attendus', 'OPTION_INVALIDE');
  }

  const horodatage = maintenant();
  const dossier = nomDossier(analysee.href, horodatage);
  const rootDir = join(racine, dossier);
  await mkdir(rootDir, { recursive: true });

  let project = createProject({ name: dossier, rootUrl: analysee.href, depth: profondeur });
  // Le gabarit de projet arrive avec un filtre d'exclusion par défaut qui vise les médias
  // (`*.html`, `*.css`…), hérité du mode « ne récupérer que les fichiers » d'IDM. Une
  // aspiration de site veut le contraire : on repart d'un projet **sans filtre** et on
  // n'inscrit que les motifs saisis. Ce que la file dit est ce qui a filtré.
  project = { ...project, filters: { include: [], exclude: [] } };
  // Les motifs sont enregistrés dans le projet **avant** le parcours : ce que l'interface
  // affiche dans l'écran Site Grabber est ce qui a réellement filtré.
  for (const motif of motifsInclus) project = addFilter(project, 'include', motif);
  for (const motif of motifsExclus) project = addFilter(project, 'exclude', motif);

  onEtape({ phase: 'parcours', pages: 0, retenus: 0 });
  const trouve = await crawl(analysee.href, {
    fetchPage,
    depth: profondeur,
    maxPages,
    robots: true,
    filters: filtresDuProjet(project),
    subdomains: sousDomaines,
    parallelisme: paralleles,
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
  let reecrits = 0;
  if (reecrire) {
    onEtape({ phase: 'reecriture', pages: trouve.fetched, retenus: trouve.retained.length });
    const reecriture = await reecrireLiens({ rootDir, entries: plan.entries });
    reecrits = reecriture.reecrits;
    await alignerTailles({ rootDir, tailles: reecriture.tailles });
  }
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
    // Filtres effectivement appliqués et liens réécrits : l'écran peut le dire, au lieu de
    // laisser croire que « profondeur 2 » décrit tout ce qui a été fait.
    inclure: motifsInclus,
    exclure: motifsExclus,
    sousDomaines,
    paralleles,
    reecrits,
    echecsDetail: resultat.failures.slice(0, 20).map((echec) => ({
      url: echec.url,
      message: echec.error ?? null,
    })),
  };
}
