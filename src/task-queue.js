/**
 * File de tâches reprenable (fiche A §4.1, `WP-20`).
 *
 * Un seul téléchargement n'a pas d'intérêt : c'est la file qui porte les états
 * `PENDING → ACTIVE → VERIFYING → DONE | FAILED` et qui survit à un arrêt du
 * programme. Le fichier `<racine>/queue.json` joue le rôle que tient chez IDM la
 * liste des téléchargements plus la clé de registre `Software\DownloadManager`
 * (annexe 14 §5.1) : un état unique, versionné, relu au démarrage.
 *
 * Concurrence : la limite par défaut est **8** téléchargements actifs, valeur de
 * repli observée dans le binaire (`MaxConnectionsNumber`, `0x0fbe17`, `D-028`).
 */

import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

/** Nombre de téléchargements simultanés par défaut (observé : 8). */
export const DEFAULT_MAX_ACTIVE = 8;

/** États d'un téléchargement (fiche A §4.1). */
export const TASK_STATES = /** @type {const} */ ([
  "PENDING",
  "ACTIVE",
  "PAUSED",
  "VERIFYING",
  "DONE",
  "FAILED",
]);

/**
 * Transitions autorisées. Toute autre transition est refusée : c'est le point
 * où un bug d'appelant devient visible au lieu de corrompre la file.
 * @type {Record<string, string[]>}
 */
export const TRANSITIONS = {
  PENDING: ["ACTIVE", "PAUSED", "FAILED"],
  ACTIVE: ["PAUSED", "VERIFYING", "FAILED"],
  PAUSED: ["PENDING", "FAILED"],
  VERIFYING: ["DONE", "FAILED"],
  // `DONE` n'est plus strictement terminal : `--incremental` rouvre une tâche terminée pour
  // re-vérifier le fichier distant (`D-070`). Aucune autre sortie n'est ouverte.
  DONE: ["PENDING"],
  FAILED: ["PENDING"],
};

/** Fichier de file, relatif à la racine de travail. */
export const QUEUE_FILE = "queue.json";

/**
 * @typedef {object} Task
 * @property {number} id
 * @property {string} url
 * @property {string} target
 * @property {number} totalSize  `-1` tant que la taille n'est pas connue
 * @property {string} state
 * @property {number} attempts
 * @property {number|null} startedAt  epoch ms
 * @property {number} updatedAt       epoch ms
 * @property {string|null} error
 */

/**
 * @typedef {object} Queue
 * @property {number} version
 * @property {number} maxActive
 * @property {number} nextId
 * @property {Task[]} tasks
 */

/**
 * File vide.
 * @param {{maxActive?: number}} [options]
 * @returns {Queue}
 */
export function createQueue({ maxActive = DEFAULT_MAX_ACTIVE } = {}) {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new TypeError("maxActive doit être un entier ≥ 1");
  }
  return { version: 1, maxActive, nextId: 1, tasks: [] };
}

/**
 * Ajoute une tâche en fin de file (ordre d'arrivée = ordre d'exécution).
 * @param {Queue} queue
 * @param {{url: string, target: string, totalSize?: number, now?: number}} task
 * @returns {{queue: Queue, task: Task}}
 */
export function addTask(queue, { url, target, totalSize = -1, now = Date.now() }) {
  if (!url || !target) throw new TypeError("url et target requis");
  const task = {
    id: queue.nextId,
    url,
    target,
    totalSize,
    state: /** @type {const} */ ("PENDING"),
    attempts: 0,
    startedAt: null,
    updatedAt: now,
    error: null,
  };
  return {
    queue: { ...queue, nextId: queue.nextId + 1, tasks: [...queue.tasks, task] },
    task,
  };
}

/**
 * Applique une transition en vérifiant qu'elle est légale.
 * @param {Queue} queue
 * @param {number} taskId
 * @param {string} to
 * @param {(task: Task) => Task} [patch]
 * @returns {Queue}
 */
export function transition(queue, taskId, to, patch = (task) => task) {
  const index = queue.tasks.findIndex((t) => t.id === taskId);
  if (index < 0) throw new Error(`tâche inconnue : ${taskId}`);
  const current = queue.tasks[index];
  if (!TRANSITIONS[current.state]?.includes(to)) {
    throw new Error(`transition interdite : ${current.state} → ${to} (tâche ${taskId})`);
  }
  const next = patch({ ...current, state: to });
  return { ...queue, tasks: queue.tasks.map((t, i) => (i === index ? next : t)) };
}

/** Nombre de tâches actuellement actives. */
export const activeCount = (queue) => queue.tasks.filter((t) => t.state === "ACTIVE").length;

/** Vrai si aucune tâche n'attend et aucune n'est active. */
export const isIdle = (queue) =>
  queue.tasks.every((t) => t.state === "DONE" || t.state === "FAILED");

/**
 * Passe à `ACTIVE` la prochaine tâche en attente, tant que la limite n'est pas
 * atteinte. Renvoie aussi la tâche démarrée (ou `null`).
 *
 * `accept` restreint les candidates : c'est ainsi que la **planification** (`D-054`)
 * n'exécute que les tâches qu'un budget autorise, sans retirer les autres de la file
 * (elles restent `PENDING` pour l'exécution suivante). Le prédicat filtre, il ne trie pas.
 *
 * @param {Queue} queue
 * @param {number} [now]
 * @param {((task: Task) => boolean)|null} [accept]
 * @returns {{queue: Queue, started: Task|null}}
 */
export function startNext(queue, now = Date.now(), accept = null) {
  if (activeCount(queue) >= queue.maxActive) return { queue, started: null };
  if (accept !== null && typeof accept !== "function") {
    throw new TypeError("startNext : `accept` doit être une fonction ou null");
  }
  const candidate = queue.tasks.find((t) => t.state === "PENDING" && (accept === null || accept(t)));
  if (!candidate) return { queue, started: null };

  const next = transition(queue, candidate.id, "ACTIVE", (task) => ({
    ...task,
    attempts: task.attempts + 1,
    startedAt: now,
    updatedAt: now,
    error: null,
  }));
  return { queue: next, started: next.tasks.find((t) => t.id === candidate.id) ?? null };
}

/**
 * Remplit la file jusqu'à la limite : équivalent de la montée en charge
 * progressive observée (« Optional connections, connecting... », annexe 14 §6).
 * @param {Queue} queue
 * @param {number} [now]
 * @returns {Queue}
 */
export function fillSlots(queue, now = Date.now()) {
  let current = queue;
  for (;;) {
    const { queue: next, started } = startNext(current, now);
    if (!started) return next;
    current = next;
  }
}

/** @param {Queue} queue @param {number} taskId @param {number} [now] */
export const pauseTask = (queue, taskId, now = Date.now()) =>
  transition(queue, taskId, "PAUSED", (task) => ({ ...task, updatedAt: now }));

/** @param {Queue} queue @param {number} taskId @param {number} [now] */
export const resumeTask = (queue, taskId, now = Date.now()) =>
  transition(queue, taskId, "PENDING", (task) => ({ ...task, updatedAt: now }));

/** @param {Queue} queue @param {number} taskId @param {number} [now] */
export const beginVerification = (queue, taskId, now = Date.now()) =>
  transition(queue, taskId, "VERIFYING", (task) => ({ ...task, updatedAt: now }));

/** @param {Queue} queue @param {number} taskId @param {number} [now] */
/**
 * @param {Queue} queue
 * @param {number} taskId
 * @param {number} [now]
 * @param {object} [patch] champs mesurés pendant le transfert (ex. `totalSize`)
 * @returns {Queue}
 */
export const completeTask = (queue, taskId, now = Date.now(), patch = {}) =>
  transition(queue, taskId, "DONE", (task) => ({ ...task, ...patch, updatedAt: now }));

/**
 * Échec : la tâche reste en `FAILED` et peut être remise en attente à la main
 * (`resumeTask`), ce qui conserve la carte de morceaux sur disque.
 * @param {Queue} queue @param {number} taskId @param {string} reason @param {number} [now]
 */
export const failTask = (queue, taskId, reason, now = Date.now()) =>
  transition(queue, taskId, "FAILED", (task) => ({ ...task, error: reason, updatedAt: now }));

/**
 * Au démarrage : les tâches restées `ACTIVE` (arrêt brutal) repassent en
 * `PENDING` sans perdre leur compteur de tentatives.
 * @param {Queue} queue
 * @param {number} [now]
 * @returns {Queue}
 */
export function recoverAfterCrash(queue, now = Date.now()) {
  return {
    ...queue,
    tasks: queue.tasks.map((task) =>
      task.state === "ACTIVE"
        ? { ...task, state: "PENDING", startedAt: null, updatedAt: now, error: "interrompu" }
        : task,
    ),
  };
}

/**
 * Statistiques dérivées (jamais persistées).
 * @param {Queue} queue
 */
export function stats(queue) {
  const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
  for (const task of queue.tasks) counts[task.state] += 1;
  const pendingBytes = queue.tasks
    .filter((t) => t.totalSize > 0 && t.state !== "DONE")
    .reduce((sum, t) => sum + t.totalSize, 0);
  return { total: queue.tasks.length, counts, pendingBytes };
}

/**
 * Vérifie la cohérence d'une file relue du disque.
 * @param {unknown} queue
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateQueue(queue) {
  const errors = [];
  if (!queue || typeof queue !== "object") return { ok: false, errors: ["file absente"] };
  const q = /** @type {Queue} */ (queue);
  if (!Number.isSafeInteger(q.maxActive) || q.maxActive < 1) errors.push("maxActive invalide");
  if (!Array.isArray(q.tasks)) return { ok: false, errors: ["tasks n'est pas un tableau"] };

  const ids = new Set();
  let maxId = 0;
  for (const task of q.tasks) {
    if (!Number.isSafeInteger(task.id) || task.id <= 0) errors.push(`id invalide : ${task.id}`);
    if (ids.has(task.id)) errors.push(`id dupliqué : ${task.id}`);
    ids.add(task.id);
    if (Number.isSafeInteger(task.id)) maxId = Math.max(maxId, task.id);
    if (!TASK_STATES.includes(/** @type {any} */ (task.state))) {
      errors.push(`état inconnu (${task.id}) : ${task.state}`);
    }
    if (task.state === "ACTIVE" && typeof task.startedAt !== "number") {
      errors.push(`tâche active sans date de début (${task.id})`);
    }
  }
  if (!Number.isSafeInteger(q.nextId) || q.nextId <= maxId) {
    errors.push(`nextId (${q.nextId}) doit dépasser le plus grand id (${maxId})`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Écrit la file de façon atomique.
 * @param {string} directory
 * @param {Queue} queue
 * @returns {Promise<string>}
 */
export async function saveQueue(directory, queue) {
  const { ok, errors } = validateQueue(queue);
  if (!ok) throw new Error(`file refusée à l'écriture : ${errors[0]}`);

  const path = join(directory, QUEUE_FILE);
  const temporary = join(directory, `.${process.pid}.tmp.queue`);
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(`${JSON.stringify(queue, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return path;
}

/**
 * Relit la file ; une file incohérente est refusée.
 * @param {string} directory
 * @returns {Promise<Queue>}
 */
export async function loadQueue(directory) {
  const path = join(directory, QUEUE_FILE);
  const text = await readFile(path, "utf8");
  let queue;
  try {
    queue = JSON.parse(text);
  } catch (cause) {
    throw new Error(`file illisible (JSON invalide) : ${path}`, { cause });
  }
  const { ok, errors } = validateQueue(queue);
  if (!ok) throw new Error(`file rejetée : ${errors[0]}`);
  return queue;
}

/** Chemin du fichier de file (utile aux tests et à l'IHM). */
export const queuePath = (directory) => join(directory, QUEUE_FILE);
