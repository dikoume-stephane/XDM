/**
 * Affichage de l'avancement d'un téléchargement — lot `WP-39` (`D-070`).
 *
 * Une aspiration de 205 Mio muette pendant 40 s ressemble à un blocage. Le moteur connaît
 * l'avancement (`onProgress`), mais un affichage naïf (une ligne par octet) noierait le
 * terminal et ralentirait le transfert plus qu'il ne le renseigne. D'où deux règles :
 *
 *  1. **par palier** : on n'écrit qu'au franchissement d'un multiple de `step` pour cent,
 *     et à l'achèvement — 10 paliers par fichier, pas 10 000 ;
 *  2. **format court et stable** : le nom local, le pourcentage et l'avancement en octets,
 *     alignés pour qu'un `tail -f` reste lisible.
 *
 * Le module est pur : il ne décide pas *où* écrire (stdout, stderr, fichier), il rend une
 * ligne quand il y a quelque chose à dire et `null` sinon. C'est ce qui le rend testable.
 *
 * @module progress
 */

import { humanBytes } from './report.js';

/**
 * Ligne d'avancement, ou `null` s'il n'y a rien à dire.
 *
 * @param {{label: string, done: number, total: number|null, state?: string}} input
 * @returns {string|null}
 */
export function formatProgress({ label, done, total, state = 'en cours' }) {
  if (typeof label !== 'string' || label === '') throw new TypeError('formatProgress : `label` requis');
  if (!Number.isFinite(done) || done < 0) return null;
  // Une taille inconnue ne se traduit pas en pourcentage : ni 0 % ni 100 %, `n/a` (`EX-B-15`).
  if (!Number.isFinite(total) || total <= 0) {
    return `${label} : ${state}, ${humanBytes(done)} (taille inconnue)`;
  }
  const percent = Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
  return `${label} : ${String(percent).padStart(3, ' ')} %  ${humanBytes(done)} / ${humanBytes(total)}`;
}

/**
 * Fabrique un rapporteur d'avancement à paliers.
 *
 * @param {(line: string) => void} log
 * @param {{step?: number, label?: (task: object) => string}} [options]
 * @returns {{report: (task: object, done: number, total: number|null) => void,
 *   finish: (task: object, total: number|null) => void, lines: () => number}}
 */
export function createProgressReporter(log, { step = 10, label = defaultLabel } = {}) {
  if (typeof log !== 'function') throw new TypeError('createProgressReporter : `log` requis');
  if (!Number.isInteger(step) || step < 1 || step > 100) {
    throw new RangeError('createProgressReporter : `step` doit être un entier entre 1 et 100');
  }
  /** @type {Map<number, number>} dernier palier annoncé, par tâche */
  const lastStep = new Map();
  /** @type {Set<number>} tâches dont les 100 % ont déjà été écrits */
  const finished = new Set();
  let lines = 0;

  const emit = (text) => {
    if (text === null) return;
    log(text);
    lines += 1;
  };

  return {
    report(task, done, total) {
      const name = label(task);
      if (!Number.isFinite(total) || total <= 0) {
        // Taille inconnue : un seul message, au premier appel, puis silence.
        if (!lastStep.has(task.id)) {
          lastStep.set(task.id, -1);
          emit(formatProgress({ label: name, done, total }));
        }
        return;
      }
      const percent = Math.min(100, Math.floor((done / total) * 100));
      const palier = Math.floor(percent / step);
      const previous = lastStep.get(task.id) ?? -1;
      if (palier <= previous) return;
      lastStep.set(task.id, palier);
      if (percent >= 100) finished.add(task.id);
      emit(formatProgress({ label: name, done, total }));
    },
    finish(task, total) {
      lastStep.delete(task.id);
      // Le palier final a déjà écrit « 100 % » : ne pas le répéter juste après.
      if (finished.delete(task.id)) return;
      if (!Number.isFinite(total) || total <= 0) return;
      emit(formatProgress({
        label: defaultLabel(task), done: total, total, state: 'terminé',
      }));
    },
    lines: () => lines,
  };
}

/** Nom court d'une tâche : son chemin cible, sans les dossiers intermédiaires. */
export function defaultLabel(task) {
  const target = String(task?.target ?? task?.url ?? 'tâche');
  return target.split(/[\\/]/).filter(Boolean).at(-1) ?? target;
}
