/**
 * Vérification d'un dossier téléchargé, exposée à l'interface — lot `WP-52`.
 *
 * `src/verify.js` compare une file (`queue.json`) au disque ; `src/report.js` en fait un
 * rapport. Ce module est le seul chaînon manquant : il **charge** la file du dossier
 * demandé, appelle la vérification, et rend un objet que l'écran peut afficher — sans
 * jamais lire ni écrire ailleurs que dans le dossier choisi.
 *
 * Trois refus explicites, parce qu'un dossier vide ne doit pas ressembler à un dossier
 * conforme :
 *
 *  - dossier absent → `DOSSIER_ABSENT` ;
 *  - dossier sans `queue.json` → `FILE_ABSENTE` (rien n'a été téléchargé ici) ;
 *  - file illisible ou invalide → `FILE_ILLISIBLE` (le fichier existe mais ne se relit pas).
 *
 * Le code de sortie suit la CLI (`bin/xdm-grab.js --verifier`) : `1` si des fichiers
 * annoncés terminés manquent ou sont tronqués, `0` sinon. `D-084` interdit d'inventer un
 * troisième verdict dans l'interface.
 *
 * @module verification
 */

import { stat } from 'node:fs/promises';

import { buildVerifyReport } from './report.js';
import { loadQueue } from './task-queue.js';
import { verifyGrab } from './verify.js';

/**
 * Erreur de vérification, porteuse d'un code stable pour l'API.
 */
export class VerificationError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
    this.details = details;
  }
}

/** Étiquettes d'anomalie telles que l'écran les affiche. */
export const LIBELLES_ANOMALIE = Object.freeze({
  MANQUANT: 'manquant',
  TRONQUÉ: 'tronqué',
  PARTIEL: 'partiel',
  ABSENT: 'absent',
  'HORS FILE': 'hors file',
});

/**
 * Vérifie un dossier de téléchargement.
 *
 * @param {{
 *   dossier: string,
 *   maintenant?: () => number,
 *   chargerFile?: typeof loadQueue,
 *   verifier?: typeof verifyGrab,
 * }} options
 */
export async function verifierDossier({
  dossier,
  maintenant = Date.now,
  chargerFile = loadQueue,
  verifier = verifyGrab,
} = {}) {
  if (typeof dossier !== 'string' || dossier.trim() === '') {
    throw new VerificationError('dossier requis', 'DOSSIER_MANQUANT');
  }
  let info;
  try {
    info = await stat(dossier);
  } catch {
    throw new VerificationError(`dossier introuvable : ${dossier}`, 'DOSSIER_ABSENT', { dossier });
  }
  if (!info.isDirectory()) {
    throw new VerificationError(`ce n'est pas un dossier : ${dossier}`, 'DOSSIER_INVALIDE', { dossier });
  }

  let file;
  try {
    file = await chargerFile(dossier);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new VerificationError(
        `aucune file de téléchargement dans ${dossier} (queue.json absent)`,
        'FILE_ABSENTE',
        { dossier },
      );
    }
    throw new VerificationError(
      `file de téléchargement illisible dans ${dossier} : ${error && error.message ? error.message : String(error)}`,
      'FILE_ILLISIBLE',
      { dossier },
    );
  }

  const debut = maintenant();
  const etat = await verifier({ rootDir: dossier, tasks: file.tasks });
  const rapport = buildVerifyReport({
    rootDir: dossier,
    verify: etat,
    tasks: file.tasks,
    startedAt: debut,
    finishedAt: maintenant(),
  });

  const bloquantes = rapport.counts.MANQUANT + rapport.counts['TRONQUÉ'];
  return {
    dossier,
    // Le verdict suit le code de sortie, pas le champ interne `conforms` : une tâche
    // `ABSENT` (pas encore téléchargée) n'est pas une anomalie, alors que le rapport de la
    // CLI la compte comme « pas conforme » (`EX-B-40`). L'interface ne peut pas afficher
    // deux vérités pour le même dossier.
    conformes: bloquantes === 0,
    codeSortie: bloquantes === 0 ? 0 : 1,
    total: rapport.total,
    ok: rapport.done,
    anomalies: bloquantes,
    compteurs: {
      verifies: rapport.total,
      conformes: rapport.done,
      manquants: rapport.counts.MANQUANT,
      tronques: rapport.counts['TRONQUÉ'],
      partiels: rapport.counts.PARTIEL,
      absents: rapport.counts.ABSENT,
      horsFile: rapport.counts['HORS FILE'],
    },
    octets: { disque: rapport.verification.diskBytes ?? 0, attendus: rapport.verification.totalBytes ?? 0 },
    entrees: rapport.entries.map((entree) => ({
      ...entree,
      libelle: LIBELLES_ANOMALIE[entree.state] ?? String(entree.state).toLowerCase(),
    })),
  };
}
