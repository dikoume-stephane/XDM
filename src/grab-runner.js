/**
 * Exécution d'un plan d'aspiration : de la file de tâches aux fichiers sur disque
 * (lot `WP-23`).
 *
 * Trois pièces déjà testées s'assemblent ici, sans logique dupliquée :
 *  - la **file** (`task-queue.js`) décide *ce qui* tourne et dans quel ordre ;
 *  - le **téléchargement** (`connection-loop.js`) fait le travail réseau et laisse un
 *    fichier de travail vérifiable ;
 *  - la **promotion** (`promote.js`) livre le fichier final, seulement si la carte est
 *    complète et la taille conforme.
 *
 * Le point délicat est le **respect des états** : une tâche ne passe à `DONE` qu'après
 * être passée par `VERIFYING`, jamais directement depuis `ACTIVE` — c'est la leçon du test
 * `T-A-05` (`D-036`). Un échec ne bloque pas les autres : la tâche devient `FAILED` avec
 * son message, le reste continue.
 *
 * Aucune dépendance : `node:fs/promises` et les modules du dépôt.
 *
 * @module grab-runner
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { download } from './connection-loop.js';
import { saveProject } from './project.js';
import {
  saveQueue, stats, startNext, beginVerification, completeTask, failTask, transition,
} from './task-queue.js';

/** Nombre maximal de tâches actives par défaut (`EX-A-07`, défaut 8). */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Tâche par défaut : télécharger puis promouvoir.
 *
 * @param {{id: number, url: string, target: string}} task
 * @param {{downloadOptions?: object, download?: typeof download}} [options]
 * @returns {Promise<{target: string, size: number, requests: number}>}
 */
export async function downloadTask(task, { downloadOptions = {}, download: run = download } = {}) {
  // L'arborescence du site peut être profonde : le dossier cible d'une entrée
  // (`rootDir/a/b/c.zip`) n'existe pas encore au moment de la promotion.
  await mkdir(dirname(task.target), { recursive: true });
  const result = await run(task.url, task.target, { promote: true, ...downloadOptions });
  return { target: result.target, size: result.size, requests: result.requests };
}

/**
 * Remet les tâches en échec dans la file, pour une reprise explicite.
 *
 * Une reprise ne doit pas rejouer les tâches `DONE` (le fichier est déjà promu) : seules
 * les tâches `FAILED` redeviennent `PENDING`, leur message d'erreur effacé. `FAILED →
 * PENDING` est la seule transition arrière autorisée par la machine à états (`D-036`).
 *
 * @param {object} queue
 * @param {number} [now]
 * @returns {object} une **nouvelle** file (les transitions de `task-queue.js` sont pures)
 */
export function retryFailed(queue, now = Date.now()) {
  let current = queue;
  for (const task of queue.tasks) {
    if (task.state === 'FAILED') {
      current = transition(current, task.id, 'PENDING', (entry) => ({
        ...entry, error: null, updatedAt: now,
      }));
    }
  }
  return current;
}

/**
 * Exécute une file jusqu'à épuisement des tâches `PENDING`.
 *
 * @param {object} queue
 * @param {{runTask?: (task: object) => Promise<object>, concurrency?: number,
 *   onEvent?: (event: {type: string, task: object, result?: object, error?: string}) => void}}
 *   [options]
 * @returns {Promise<{queue: object, results: object[], failures: object[], stats: object}>}
 */
export async function runQueue(queue, {
  runTask = (task) => downloadTask(task),
  concurrency = DEFAULT_CONCURRENCY,
  onEvent = () => {},
} = {}) {
  if (typeof runTask !== 'function') throw new TypeError('runQueue : `runTask` requis');
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('runQueue : concurrence ≥ 1');
  }

  let current = queue;
  /** @type {object[]} */
  const results = [];
  /** @type {object[]} */
  const failures = [];
  /** @type {Set<Promise<unknown>>} */
  const inFlight = new Set();

  const launch = () => {
    while (inFlight.size < concurrency) {
      const { queue: next, started } = startNext(current);
      if (!started) return;
      current = next;
      onEvent({ type: 'start', task: started });
      const promise = (async () => {
        try {
          const result = await runTask(started);
          current = beginVerification(current, started.id);
          current = completeTask(current, started.id);
          results.push({ id: started.id, url: started.url, ...result });
          onEvent({ type: 'done', task: started, result });
        } catch (error) {
          const message = String(error?.message ?? error);
          current = failTask(current, started.id, message);
          failures.push({ id: started.id, url: started.url, error: message });
          onEvent({ type: 'failed', task: started, error: message });
        } finally {
          inFlight.delete(promise);
        }
      })();
      inFlight.add(promise);
    }
  };

  launch();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    launch();
  }

  return { queue: current, results, failures, stats: stats(current) };
}

/**
 * Chaîne complète : plan d'aspiration, exécution, persistance du projet et de la file.
 *
 * Le projet et la file sont écrits **après** l'exécution, en un seul passage : une
 * interruption laisse l'état précédent intact (écritures atomiques de `project.js` et
 * `task-queue.js`), jamais un fichier à moitié réécrit.
 *
 * @param {{project: object, queue: object, projectPath: string, queueDir: string,
 *   runTask?: (task: object) => Promise<object>, concurrency?: number,
 *   onEvent?: (event: object) => void}} options
 * @returns {Promise<{project: object, queue: object, results: object[], failures: object[],
 *   stats: object, saved: {project: string, queue: string}}>}
 */
export async function executeGrab({
  project,
  queue,
  projectPath,
  queueDir,
  runTask,
  concurrency = DEFAULT_CONCURRENCY,
  onEvent,
}) {
  const outcome = await runQueue(queue, {
    ...(runTask ? { runTask } : {}),
    concurrency,
    ...(onEvent ? { onEvent } : {}),
  });

  // Les états des entrées du projet suivent ceux de leurs tâches.
  const byUrl = new Map(outcome.queue.tasks.map((task) => [task.url, task.state]));
  const updatedProject = {
    ...project,
    entries: project.entries.map((entry) => {
      const state = byUrl.get(entry.url);
      if (state === undefined) return entry;
      return {
        ...entry,
        etat: state === 'DONE' ? 'termine' : state === 'FAILED' ? 'echec' : 'en-attente',
        log: state === 'FAILED'
          ? (outcome.failures.find((failure) => failure.url === entry.url)?.error ?? entry.log)
          : entry.log,
      };
    }),
  };

  const savedProject = await saveProject(projectPath, updatedProject);
  const savedQueue = await saveQueue(queueDir, outcome.queue);

  return {
    project: updatedProject,
    queue: outcome.queue,
    results: outcome.results,
    failures: outcome.failures,
    stats: outcome.stats,
    saved: { project: savedProject, queue: savedQueue },
  };
}
