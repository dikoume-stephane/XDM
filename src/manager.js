/**
 * Gestionnaire de transferts du socle applicatif — lot `WP-51`.
 *
 * L'interface ne parle jamais au moteur directement : elle parle à ce gestionnaire, qui
 * possède l'état des transferts, la file d'attente, le journal et l'historique. Trois
 * raisons, toutes vérifiables par les tests :
 *
 *  1. **Un seul écrivain.** Deux écrans qui lanceraient chacun leur téléchargement
 *     écriraient dans le même fichier de travail ; ici, une tâche n'a qu'un exécutant.
 *  2. **La progression est un flux, pas un sondage.** Le moteur pousse `onProgress` ;
 *     le gestionnaire le traduit en événements datés que le serveur diffuse (SSE). Une
 *     interface qui interrogerait l'état toutes les 50 ms afficherait la même chose en
 *     consommant cent fois plus.
 *  3. **Le passé reste lisible.** Une tâche terminée ou en échec quitte la file et
 *     rejoint l'historique avec son code de sortie — les mêmes codes que la CLI
 *     (`0` succès, `1` échec), pour que l'interface ne réinvente pas les verdicts.
 *
 * Limite assumée et documentée (décision `D-084`) : le moteur (`connection-loop`) ne
 * connaît pas l'interruption coopérative. On peut donc retirer une tâche **en attente**,
 * pas interrompre un transfert en cours. Un transfert interrompu par l'arrêt du
 * processus reprend au lancement suivant grâce au fichier `.part`, mais il n'existe pas
 * encore de bouton « pause » honnête pendant l'exécution — l'interface ne l'affiche donc
 * pas.
 *
 * @module manager
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { executerAspiration } from './aspiration.js';
import { download } from './connection-loop.js';
import { humanBytes } from './report.js';
import { fileNameFromUrl } from './promote.js';
import { verifierDossier } from './verification.js';

/** États d'une tâche, alignés sur le vocabulaire de l'interface (français). */
export const ETATS = /** @type {const} */ ([
  'attente',
  'en_cours',
  'termine',
  'echec',
]);

/** Intervalle minimal entre deux événements de progression d'une même tâche. */
export const PROGRESSION_MS = 200;

/** Taille maximale d'un fichier de travail suivie par l'interface, en octets. */
export const DOSSIER_PAR_DEFAUT = 'telechargements';

/**
 * Erreur du gestionnaire, porteuse d'un code stable pour l'API.
 */
export class ManagerError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ManagerError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Vérifie qu'une chaîne est une URL http(s) exploitable.
 *
 * On n'accepte que `http:` et `https:` : laisser passer `file:` donnerait à une page web
 * un accès au disque, et `ftp:` demanderait un transport que ce lot ne câble pas.
 *
 * @param {unknown} valeur
 * @returns {URL}
 */
export function analyserUrl(valeur) {
  if (typeof valeur !== 'string' || valeur.trim() === '') {
    throw new ManagerError('URL requise', 'URL_MANQUANTE');
  }
  let url;
  try {
    url = new URL(valeur.trim());
  } catch {
    throw new ManagerError(`URL invalide : ${valeur}`, 'URL_INVALIDE', { url: valeur });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ManagerError(
      `schéma refusé : ${url.protocol} (http et https seulement)`,
      'SCHEMA_REFUSE',
      { protocole: url.protocol },
    );
  }
  return url;
}

/**
 * Nom local libre dans `dossier`, dérivé de l'URL.
 *
 * Deux URL peuvent désigner le même nom (`/a/rapport.pdf` et `/b/rapport.pdf`) : sans
 * suffixe, la seconde écraserait la première. Le suffixe part de `-2`, comme un
 * gestionnaire de fichiers.
 *
 * @param {string} url
 * @param {string} dossier
 * @param {Set<string>} pris
 * @returns {string}
 */
export function nomLibre(url, dossier, pris) {
  const base = fileNameFromUrl(url);
  if (!pris.has(base)) return base;
  const point = base.lastIndexOf('.');
  const racine = point > 0 ? base.slice(0, point) : base;
  const extension = point > 0 ? base.slice(point) : '';
  let n = 2;
  while (pris.has(`${racine}-${n}${extension}`)) n += 1;
  return `${racine}-${n}${extension}`;
}

/**
 * Crée un gestionnaire de transferts.
 *
 * @param {{
 *   dossier?: string,
 *   connexions?: number,
 *   maxActifs?: number,
 *   telecharger?: Function,
 *   maintenant?: () => number,
 *   nommer?: (url: string, dossierActuel: string) => string,
 *   maxJournal?: number,
 * }} [options]
 */
export function createManager({
  dossier = DOSSIER_PAR_DEFAUT,
  connexions = 4,
  maxActifs = 2,
  telecharger = download,
  maintenant = Date.now,
  maxJournal = 500,
} = {}) {
  if (typeof dossier !== 'string' || dossier === '') {
    throw new TypeError('createManager : `dossier` requis');
  }
  if (!Number.isInteger(connexions) || connexions < 1) {
    throw new RangeError('createManager : `connexions` doit être un entier >= 1');
  }
  if (!Number.isInteger(maxActifs) || maxActifs < 1) {
    throw new RangeError('createManager : `maxActifs` doit être un entier >= 1');
  }
  if (typeof telecharger !== 'function') {
    throw new TypeError('createManager : `telecharger` doit être une fonction');
  }

  /** @type {any[]} */
  const taches = [];
  /** @type {any[]} */
  const historique = [];
  /** @type {any[]} */
  const aspirations = [];
  /** @type {any} */
  let derniereVerification = null;
  /** @type {any[]} */
  let journal = [];
  /** @type {Set<(evenement: any) => void>} */
  const abonnes = new Set();
  /** @type {Set<Promise<void>>} */
  const executions = new Set();
  const nomsPris = new Set();
  let sequence = 0;
  let journalSequence = 0;
  let compteurId = 0;
  let compteurAspiration = 0;

  /** Identifiant stable d'événement, strictement croissant. */
  const idEvenement = () => (sequence += 1);

  /**
   * Ajoute une entrée de journal et la diffuse.
   * @param {'info'|'succes'|'attention'|'erreur'} niveau
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  function journaliser(niveau, message, extra = {}) {
    journalSequence += 1;
    const entree = {
      seq: journalSequence,
      date: new Date(maintenant()).toISOString(),
      niveau,
      source: 'xdm',
      message,
      ...extra,
    };
    journal.push(entree);
    if (journal.length > maxJournal) journal = journal.slice(-maxJournal);
    publier({ type: 'journal', entree });
    return entree;
  }

  /**
   * Diffuse un événement à tous les abonnés. Un abonné fautif ne casse pas les autres :
   * l'interface peut planter, le téléchargement doit continuer.
   * @param {Record<string, any>} evenement
   */
  function publier(evenement) {
    const instant = maintenant();
    const complet = { id: idEvenement(), date: new Date(instant).toISOString(), ...evenement };
    for (const abonne of abonnes) {
      try {
        abonne(complet);
      } catch {
        abonnes.delete(abonne);
      }
    }
  }

  /** Vue publique d'une tâche (sans les champs internes d'exécution). */
  const vue = (tache) => ({
    id: tache.id,
    url: tache.url,
    nom: tache.nom,
    cible: tache.cible,
    etat: tache.etat,
    taille: tache.taille,
    fait: tache.fait,
    vitesse: tache.vitesse,
    debut: tache.debut,
    fin: tache.fin,
    erreur: tache.erreur,
    codeSortie: tache.codeSortie,
  });

  /**
   * Ajoute une URL à la file.
   *
   * Rien n'est téléchargé ici : `ajouter` ne fait qu'enregistrer une intention. C'est
   * `demarrer` qui ouvre des connexions, ce qui permet à l'interface d'afficher une
   * file cohérente avant d'avoir consommé de la bande passante.
   *
   * @param {{url: string, nom?: string}} entree
   */
  function ajouter({ url, nom } = {}) {
    const analysee = analyserUrl(url);
    const choisi = typeof nom === 'string' && nom.trim() !== '' ? nom.trim() : nomLibre(analysee.href, dossier, nomsPris);
    if (nomsPris.has(choisi)) {
      throw new ManagerError(`nom déjà utilisé : ${choisi}`, 'NOM_DEJA_PRIS', { nom: choisi });
    }
    nomsPris.add(choisi);
    const tache = {
      id: `T-${(compteurId += 1)}`,
      url: analysee.href,
      nom: choisi,
      cible: join(dossier, choisi),
      etat: 'attente',
      taille: null,
      fait: 0,
      vitesse: 0,
      debut: null,
      fin: null,
      erreur: null,
      codeSortie: null,
      _demande: null,
    };
    taches.push(tache);
    journaliser('info', `ajouté à la file : ${choisi}`, { tache: tache.id });
    publier({ type: 'ajout', tache: vue(tache) });
    return vue(tache);
  }

  /** Nombre de tâches réellement en cours. */
  const actives = () => taches.filter((t) => t.etat === 'en_cours').length;

  /**
   * Exécute une tâche : le seul endroit qui appelle le moteur.
   * @param {any} tache
   */
  async function executer(tache) {
    // L'état bascule **avant** le premier `await` : `pomper` s'appuie sur cette transition
    // synchrone pour ne pas relancer la même tâche en boucle.
    tache.etat = 'en_cours';
    tache.debut = maintenant();
    tache.erreur = null;
    journaliser('info', `démarrage : ${tache.nom}`, { tache: tache.id });
    publier({ type: 'demarrage', tache: vue(tache) });

    // Le dossier de destination peut ne pas exister : c'est le cas normal au premier
    // lancement. Le créer ici plutôt que dans chaque appelant évite un `ENOENT` sur le
    // fichier `.part` — défaut vu en essai réel, avant que l'interface ne soit livrée.
    await mkdir(dirname(tache.cible), { recursive: true });

    let dernierFait = 0;
    let dernierTemps = tache.debut;

    try {
      const resultat = await telecharger(tache.url, tache.cible, {
        connections: connexions,
        promote: true,
        onProgress: ({ done, total }) => {
          const instant = maintenant();
          tache.fait = done;
          if (Number.isFinite(total) && total > 0) tache.taille = total;
          // Débit lissé sur la fenêtre écoulée, jamais négatif (reprise, repli).
          const deltaOctets = done - dernierFait;
          const deltaTemps = instant - dernierTemps;
          if (deltaTemps > 0 && deltaOctets >= 0) {
            tache.vitesse = Math.round((deltaOctets / deltaTemps) * 1000);
            dernierFait = done;
            dernierTemps = instant;
          }
          // Palier : au plus un événement toutes les 200 ms par tâche. Sans ce garde-fou,
          // un transfert rapide enverrait des milliers de messages pour un affichage
          // identique à l'œil (`D-084`).
          if (instant - (tache._dernierEnvoi ?? 0) >= PROGRESSION_MS) {
            tache._dernierEnvoi = instant;
            publier({ type: 'progression', tache: vue(tache) });
          }
        },
      });

      tache.etat = 'termine';
      tache.codeSortie = 0;
      tache.fin = maintenant();
      if (resultat && Number.isFinite(resultat.size)) tache.taille = resultat.size;
      if (tache.taille !== null) tache.fait = tache.taille;
      tache.vitesse = 0;
      // Durée lisible : les millisecondes comptent pour un petit fichier, et « en 1 s »
      // pour 71 ms donnerait une précision fausse.
      const ecoule = Math.max(0, tache.fin - tache.debut);
      const dureeTexte = ecoule < 1000 ? `${ecoule} ms` : `${Math.round(ecoule / 1000)} s`;
      journaliser('succes', `${tache.nom} terminé — ${humanBytes(tache.fait)} en ${dureeTexte}`, { tache: tache.id });
      publier({ type: 'termine', tache: vue(tache) });
      archiver(tache);
    } catch (error) {
      tache.etat = 'echec';
      tache.codeSortie = 1;
      tache.fin = maintenant();
      tache.vitesse = 0;
      tache.erreur = {
        message: error && error.message ? error.message : String(error),
        code: error && error.code ? error.code : 'ECHEC',
      };
      journaliser('erreur', `${tache.nom} : ${tache.erreur.message}`, { tache: tache.id, code: tache.erreur.code });
      publier({ type: 'echec', tache: vue(tache) });
      archiver(tache);
    }
  }

  /**
   * Sort une tâche de la file pour l'historique.
   * @param {any} tache
   */
  function archiver(tache) {
    const index = taches.indexOf(tache);
    if (index >= 0) taches.splice(index, 1);
    tache._demande = null;
    historique.unshift({
      id: tache.id,
      nom: tache.nom,
      url: tache.url,
      cible: tache.cible,
      etat: tache.etat,
      taille: tache.taille,
      fait: tache.fait,
      debut: tache.debut,
      fin: tache.fin,
      duree: tache.debut !== null && tache.fin !== null ? tache.fin - tache.debut : null,
      codeSortie: tache.codeSortie,
      erreur: tache.erreur,
    });
    if (historique.length > 200) historique.length = 200;
  }

  /** Remplit les créneaux libres, dans l'ordre de la file. */
  function pomper() {
    while (actives() < maxActifs) {
      const suivante = taches.find((t) => t.etat === 'attente');
      if (!suivante) break;
      const execution = executer(suivante);
      executions.add(execution);
      execution.finally(() => {
        executions.delete(execution);
        pomper();
      });
    }
  }

  /**
   * Démarre les tâches en attente, dans les limites de `maxActifs`.
   * @returns {Promise<void>} résolue quand toutes les tâches lancées sont finies
   */
  async function demarrer() {
    pomper();
    // Une tâche peut en lancer une autre en se terminant : on attend tant qu'il en reste.
    while (executions.size > 0) await Promise.all([...executions]);
  }

  /**
   * Retire une tâche **en attente**. Retirer une tâche en cours est refusé : le moteur
   * n'a pas d'interruption coopérative (`D-084`).
   * @param {string} id
   */
  function retirer(id) {
    const tache = taches.find((t) => t.id === id);
    if (!tache) throw new ManagerError(`tâche inconnue : ${id}`, 'TACHE_INCONNUE', { id });
    if (tache.etat !== 'attente') {
      throw new ManagerError(`tâche ${id} non retirable dans l'état ${tache.etat}`, 'TACHE_ACTIVE', { id, etat: tache.etat });
    }
    taches.splice(taches.indexOf(tache), 1);
    nomsPris.delete(tache.nom);
    journaliser('attention', `retiré de la file : ${tache.nom}`, { tache: tache.id });
    publier({ type: 'retrait', tache: vue(tache) });
    return vue(tache);
  }

  /**
   * Applique de nouveaux réglages de session (dossier, connexions, actifs).
   * Les tâches déjà lancées gardent leurs paramètres : un changement de dossier ne
   * déplace pas un fichier en cours d'écriture (`D-084`).
   *
   * @param {{dossier?: string, connexions?: number, maxActifs?: number}} patch
   */
  function configurer({ dossier: nouveauDossier, connexions: nouvelles, maxActifs: nouveaux } = {}) {
    if (nouveauDossier !== undefined) {
      if (typeof nouveauDossier !== 'string' || nouveauDossier.trim() === '') {
        throw new ManagerError('`dossier` doit être un chemin non vide', 'REGLE_INVALIDE', { champ: 'dossier' });
      }
      dossier = nouveauDossier.trim();
    }
    if (nouvelles !== undefined) {
      if (!Number.isInteger(nouvelles) || nouvelles < 1 || nouvelles > 128) {
        throw new ManagerError('`connexions` doit être un entier entre 1 et 128', 'REGLE_INVALIDE', { champ: 'connexions' });
      }
      connexions = nouvelles;
    }
    if (nouveaux !== undefined) {
      if (!Number.isInteger(nouveaux) || nouveaux < 1 || nouveaux > 32) {
        throw new ManagerError('`maxActifs` doit être un entier entre 1 et 32', 'REGLE_INVALIDE', { champ: 'maxActifs' });
      }
      maxActifs = nouveaux;
    }
    journaliser('info', `réglages appliqués : dossier ${dossier}, ${connexions} connexion(s), ${maxActifs} actif(s)`);
    publier({ type: 'reglages', reglages: { dossier, connexions, maxActifs } });
    return { dossier, connexions, maxActifs };
  }

  /** Compteurs affichés en en-tête et dans la barre d'état. */
  function compteurs() {
    const enAttente = taches.filter((t) => t.etat === 'attente').length;
    const enCours = taches.filter((t) => t.etat === 'en_cours').length;
    const debits = taches.reduce((total, t) => total + (t.etat === 'en_cours' ? t.vitesse : 0), 0);
    return {
      attente: enAttente,
      enCours,
      historique: historique.length,
      debit: debits,
      journal: journal.length,
    };
  }

  /** Instantané complet, tel que le consomme `GET /api/etat`. */
  const etat = () => ({
    dossier,
    connexions,
    maxActifs,
    compteurs: compteurs(),
    taches: taches.map(vue),
    aspirations: aspirations.slice(0, 20).map(vueAspiration),
    historique: historique.slice(0, 50),
  });


  /** Vue publique d'une aspiration. */
  const vueAspiration = (aspiration) => ({
    id: aspiration.id,
    url: aspiration.url,
    dossier: aspiration.dossier,
    etat: aspiration.etat,
    phase: aspiration.phase,
    pages: aspiration.pages,
    retenus: aspiration.retenus,
    taches: aspiration.taches,
    termines: aspiration.termines,
    echecs: aspiration.echecs,
    debut: aspiration.debut,
    fin: aspiration.fin,
    codeSortie: aspiration.codeSortie,
    erreur: aspiration.erreur,
  });

  /**
   * Lance une aspiration en tâche de fond. Rend immédiatement : l'écran suit la
   * progression par les événements, comme pour un téléchargement.
   *
   * @param {{url: string, profondeur?: number, maxPages?: number}} demande
   */
  function aspirer({ url, profondeur = 2, maxPages = 100 } = {}) {
    const analysee = analyserUrl(url);
    if (!Number.isInteger(profondeur) || profondeur < 1 || profondeur > 5) {
      throw new ManagerError('profondeur : entier de 1 à 5', 'PROFONDEUR_INVALIDE', { profondeur });
    }
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100_000) {
      throw new ManagerError('pages maximum : entier de 1 à 100 000', 'PAGES_INVALIDE', { maxPages });
    }
    const aspiration = {
      id: `A-${(compteurAspiration += 1)}`,
      url: analysee.href,
      dossier: null,
      etat: 'en_cours',
      phase: 'parcours',
      pages: 0,
      retenus: 0,
      taches: 0,
      termines: 0,
      echecs: 0,
      debut: maintenant(),
      fin: null,
      codeSortie: null,
      erreur: null,
    };
    aspirations.unshift(aspiration);
    journaliser('info', `aspiration démarrée : ${analysee.href}`, { aspiration: aspiration.id });
    publier({ type: 'aspiration', aspiration: vueAspiration(aspiration) });

    const execution = executerAspiration({
      url: analysee.href,
      racine: join(dossier, 'aspirations'),
      profondeur,
      maxPages,
      maintenant,
      onEtape: (etape) => {
        if (typeof etape.pages === 'number') aspiration.pages = etape.pages;
        if (typeof etape.retenus === 'number') aspiration.retenus = etape.retenus;
        if (typeof etape.taches === 'number') aspiration.taches = etape.taches;
        if (typeof etape.termines === 'number') aspiration.termines = etape.termines;
        if (typeof etape.echecs === 'number') aspiration.echecs = etape.echecs;
        if (etape.phase) aspiration.phase = etape.phase === 'tache' ? 'telechargement' : etape.phase;
        publier({ type: 'aspiration', aspiration: vueAspiration(aspiration) });
      },
    })
      .then((resultat) => {
        aspiration.etat = 'termine';
        aspiration.fin = maintenant();
        aspiration.dossier = resultat.dossier;
        aspiration.pages = resultat.pages;
        aspiration.retenus = resultat.retenus;
        aspiration.taches = resultat.taches;
        aspiration.termines = resultat.termines;
        aspiration.echecs = resultat.echecs;
        aspiration.codeSortie = resultat.codeSortie;
        journaliser(
          resultat.codeSortie === 0 ? 'succes' : 'attention',
          `aspiration ${resultat.codeSortie === 0 ? 'terminée' : 'partielle'} : ${resultat.termines}/${resultat.taches} fichier(s), ${resultat.pages} page(s)`,
          { aspiration: aspiration.id },
        );
        publier({ type: 'aspiration', aspiration: vueAspiration(aspiration) });
        historique.unshift({
          id: aspiration.id,
          nom: `Aspiration ${resultat.nom}`,
          url: analysee.href,
          cible: resultat.dossier,
          etat: resultat.codeSortie === 0 ? 'termine' : 'echec',
          taille: null,
          fait: null,
          debut: aspiration.debut,
          fin: aspiration.fin,
          duree: aspiration.fin - aspiration.debut,
          codeSortie: resultat.codeSortie,
          erreur: null,
        });
      })
      .catch((error) => {
        aspiration.etat = 'echec';
        aspiration.fin = maintenant();
        aspiration.codeSortie = 1;
        aspiration.erreur = {
          message: error && error.message ? error.message : String(error),
          code: error && error.code ? error.code : 'ECHEC',
        };
        journaliser('erreur', `aspiration : ${aspiration.erreur.message}`, { aspiration: aspiration.id });
        publier({ type: 'aspiration', aspiration: vueAspiration(aspiration) });
      });
    executions.add(execution);
    execution.finally(() => executions.delete(execution));
    return vueAspiration(aspiration);
  }

  /**
   * Vérifie un dossier (file ↔ disque). Asynchrone et borné : la vérification lit le
   * disque, elle ne doit pas bloquer une réponse HTTP plus longtemps que nécessaire.
   *
   * @param {{dossier?: string}} [demande]
   */
  async function verifier({ dossier: cible } = {}) {
    const raccourci = typeof cible === 'string' && cible.trim() !== '' ? cible.trim() : dossier;
    const rapport = await verifierDossier({ dossier: raccourci, maintenant });
    derniereVerification = rapport;
    journaliser(
      rapport.codeSortie === 0 ? 'succes' : 'attention',
      `vérification de ${raccourci} : ${rapport.ok}/${rapport.total} conforme(s), ${rapport.anomalies} anomalie(s)`,
      { verification: raccourci },
    );
    return rapport;
  }

  return {
    ajouter,
    demarrer,
    retirer,
    etat,
    compteurs,
    journal: () => journal.slice(),
    historique: () => historique.slice(),
    taches: () => taches.map(vue),
    aspirer,
    aspirations: () => aspirations.map(vueAspiration),
    configurer,
    verifier,
    derniereVerification: () => derniereVerification,
    /** Abonne un observateur ; renvoie la fonction de désabonnement. */
    abonner(abonne) {
      abonnes.add(abonne);
      return () => abonnes.delete(abonne);
    },
    /** Arrête d'accepter de nouvelles tâches et attend la fin des executions en cours. */
    async fermer() {
      await Promise.all([...executions]);
    },
  };
}
