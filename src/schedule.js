/**
 * Planification d'une aspiration — lot `WP-25`.
 *
 * Deux idées, et rien de plus : **quand** on a le droit de télécharger, et **combien**.
 * Le calendrier est une liste de fenêtres locales (`lun-ven 01:00-06:00`), le quota est un
 * budget d'octets et de tâches par exécution. Aucun démon, aucune minuterie : l'appelant
 * demande « peut-on commencer maintenant, et avec quelles tâches ? », le module répond.
 *
 * **Pourquoi pas de cron.** Un ordonnanceur intégré devrait survivre aux redémarrages, donc
 * persister son état et gérer les fuseaux : c'est un produit à part entière. Ici, la file
 * est déjà persistée (`queue.json`) ; la planification se recalcule à chaque démarrage,
 * ce qui la rend déterministe et testable sans horloge simulée (`D-054`).
 *
 * **Heures locales.** Les fenêtres sont lues dans le fuseau de la machine, comme le fait
 * un utilisateur qui écrit « la nuit ». Le dire vaut mieux que de prétendre à l'universel.
 *
 * @module schedule
 */

/** Jours abrégés, index `Date.getDay()` (0 = dimanche). */
export const DAY_NAMES = /** @type {const} */ (['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam']);

/** Erreur de planification, porteuse d'un code stable. */
export class ScheduleError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Développe un motif de jours : `lun-ven`, `sam,dim`, `*`.
 * @param {string} raw
 * @returns {number[]} jours (0 = dimanche)
 */
export function parseDays(raw) {
  const text = String(raw ?? '*').trim().toLowerCase();
  if (text === '*' || text === 'tous' || text === 'all') return [0, 1, 2, 3, 4, 5, 6];
  /** @type {Set<number>} */
  const days = new Set();
  const indexOf = (name) => {
    // Un jour peut s'écrire `6`, `dim` ou `dimanche` : on garde la forme la plus courte.
    if (/^[0-6]$/.test(name)) return Number(name);
    const found = DAY_NAMES.indexOf(/** @type {any} */ (name.slice(0, 3)));
    if (found < 0) throw new ScheduleError(`jour inconnu : ${name}`, 'BAD_DAY', { day: name });
    return found;
  };
  for (const part of text.split(',')) {
    const item = part.trim();
    if (item === '') continue;
    const range = /^([a-z]+)-([a-z]+)$/.exec(item);
    if (range) {
      const from = indexOf(range[1]);
      const to = indexOf(range[2]);
      // `ven-lun` traverse le week-end : on avance modulo 7.
      for (let day = from; ; day = (day + 1) % 7) {
        days.add(day);
        if (day === to) break;
      }
      continue;
    }
    days.add(indexOf(item));
  }
  if (days.size === 0) throw new ScheduleError(`aucun jour dans « ${raw} »`, 'BAD_DAY', { raw });
  return [...days].sort((a, b) => a - b);
}

/**
 * Lit `HH:MM` en minutes depuis minuit.
 * @param {string} raw
 * @returns {number}
 */
export function parseTime(raw) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (!match) throw new ScheduleError(`heure invalide : ${raw}`, 'BAD_TIME', { time: raw });
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) {
    throw new ScheduleError(`heure hors limites : ${raw}`, 'BAD_TIME', { time: raw });
  }
  return hours * 60 + minutes;
}

/**
 * Analyse une fenêtre `lun-ven 01:00-06:00`, ou un objet déjà analysé.
 *
 * Une fenêtre qui se termine **avant** de commencer traverse minuit
 * (`22:00-02:00` = 22 h → 2 h le lendemain).
 *
 * @param {string | {days?: string | number[], start: string, end: string}} raw
 * @returns {{days: number[], start: number, end: number, wrap: boolean}}
 */
export function parseWindow(raw) {
  if (typeof raw !== 'string') {
    return parseWindow(`${Array.isArray(raw.days) ? raw.days.join(',') : (raw.days ?? '*')} ${raw.start}-${raw.end}`);
  }
  const match = /^\s*(\S+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(raw);
  if (!match) throw new ScheduleError(`fenêtre invalide : « ${raw} »`, 'BAD_WINDOW', { window: raw });
  const start = parseTime(match[2]);
  const end = parseTime(match[3]);
  if (start === end) {
    throw new ScheduleError(`fenêtre vide : « ${raw} »`, 'BAD_WINDOW', { window: raw });
  }
  return { days: parseDays(match[1]), start, end, wrap: end < start };
}

/**
 * Construit un calendrier.
 *
 * @param {{windows?: (string | object)[], quota?: {bytes?: number, tasks?: number}}} [options]
 * @returns {{windows: ReturnType<typeof parseWindow>[], quota: {bytes: number | null,
 *   tasks: number | null}}}
 */
export function createSchedule({ windows = [], quota = {} } = {}) {
  const parsed = windows.map(parseWindow);
  const bytes = quota.bytes === undefined || quota.bytes === null ? null : Number(quota.bytes);
  const tasks = quota.tasks === undefined || quota.tasks === null ? null : Number(quota.tasks);
  if (bytes !== null && (!Number.isFinite(bytes) || bytes < 0)) {
    throw new ScheduleError('quota d’octets invalide', 'BAD_QUOTA', { bytes });
  }
  if (tasks !== null && (!Number.isInteger(tasks) || tasks < 0)) {
    throw new ScheduleError('quota de tâches invalide', 'BAD_QUOTA', { tasks });
  }
  return { windows: parsed, quota: { bytes, tasks } };
}

/** Minutes depuis minuit d'une date (heure locale). */
export const minutesOf = (date) => date.getHours() * 60 + date.getMinutes();

/**
 * Le calendrier est-il ouvert à cet instant ? Sans fenêtre, il est **toujours** ouvert :
 * ne pas planifier est le cas par défaut, pas une porte fermée.
 *
 * @param {ReturnType<typeof createSchedule> | null} schedule
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isOpen(schedule, now = new Date()) {
  if (!schedule || schedule.windows.length === 0) return true;
  const minutes = minutesOf(now);
  const day = now.getDay();
  return schedule.windows.some((window) => {
    if (window.wrap) {
      // `22:00-02:00` : ouvert le soir du jour J et la nuit du jour J+1.
      if (window.days.includes(day) && minutes >= window.start) return true;
      return window.days.includes((day + 6) % 7) && minutes < window.end;
    }
    return window.days.includes(day) && minutes >= window.start && minutes < window.end;
  });
}

/**
 * Prochain instant d'ouverture (ou `now` si déjà ouvert).
 *
 * @param {ReturnType<typeof createSchedule> | null} schedule
 * @param {Date} [now]
 * @returns {Date | null} `null` si le calendrier n'ouvre jamais
 */
export function nextOpening(schedule, now = new Date()) {
  if (!schedule || schedule.windows.length === 0) return new Date(now.getTime());
  if (isOpen(schedule, now)) return new Date(now.getTime());
  // On avance minute par minute sur une semaine : borné, lisible, sans arithmétique de
  // fuseau à maintenir. 10 080 itérations au pire.
  const probe = new Date(now.getTime());
  probe.setSeconds(0, 0);
  for (let step = 0; step < 7 * 24 * 60; step += 1) {
    probe.setTime(probe.getTime() + 60_000);
    if (isOpen(schedule, probe)) return probe;
  }
  return null;
}

/**
 * Ordonne les tâches à exécuter.
 *
 * Trois critères, dans cet ordre : **état** (les reprises avant les nouveautés — elles ont
 * déjà coûté du temps), **priorité** explicite (`priority`, plus petit d'abord), puis
 * **taille** (les petits d'abord : ils libèrent les créneaux et donnent un signal rapide).
 *
 * @param {object[]} tasks
 * @param {{by?: 'priority' | 'size' | 'url'}} [options]
 * @returns {object[]} nouvelle liste, la file n'est pas modifiée
 */
export function orderTasks(tasks, { by = 'priority' } = {}) {
  const stateRank = { PAUSED: 0, PENDING: 1, FAILED: 2 };
  const copy = [...tasks];
  copy.sort((a, b) => {
    const rankA = stateRank[a.state] ?? 9;
    const rankB = stateRank[b.state] ?? 9;
    if (rankA !== rankB) return rankA - rankB;
    if (by === 'url') return String(a.url).localeCompare(String(b.url));
    if (by === 'size') {
      const sizeA = a.totalSize > 0 ? a.totalSize : Number.POSITIVE_INFINITY;
      const sizeB = b.totalSize > 0 ? b.totalSize : Number.POSITIVE_INFINITY;
      if (sizeA !== sizeB) return sizeA - sizeB;
      return String(a.url).localeCompare(String(b.url));
    }
    const priorityA = Number.isInteger(a.priority) ? a.priority : 0;
    const priorityB = Number.isInteger(b.priority) ? b.priority : 0;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const sizeA = a.totalSize > 0 ? a.totalSize : Number.POSITIVE_INFINITY;
    const sizeB = b.totalSize > 0 ? b.totalSize : Number.POSITIVE_INFINITY;
    if (sizeA !== sizeB) return sizeA - sizeB;
    return String(a.url).localeCompare(String(b.url));
  });
  return copy;
}

/**
 * Décide ce qui peut tourner maintenant.
 *
 * @param {{queue: object, schedule?: ReturnType<typeof createSchedule> | null,
 *   now?: Date, by?: 'priority' | 'size' | 'url'}} input
 * @returns {{open: boolean, waitUntil: Date | null, selected: object[],
 *   skipped: object[], reason: string, quota: {bytes: number | null, tasks: number | null}}}
 */
export function planRun({ queue, schedule = null, now = new Date(), by = 'priority' }) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const open = isOpen(schedule, now);
  const quota = schedule?.quota ?? { bytes: null, tasks: null };

  if (!open) {
    return {
      open: false,
      waitUntil: nextOpening(schedule, now),
      selected: [],
      skipped: [],
      reason: 'hors fenêtre de planification',
      quota,
    };
  }

  const candidates = orderTasks(tasks.filter((task) => task.state === 'PENDING'
    || task.state === 'PAUSED'
    || task.state === 'FAILED'), { by });

  /** @type {object[]} */
  const selected = [];
  /** @type {object[]} */
  const skipped = [];
  let bytes = 0;
  for (const task of candidates) {
    if (quota.tasks !== null && selected.length >= quota.tasks) {
      skipped.push({ ...task, reason: 'quota de tâches atteint' });
      continue;
    }
    const size = task.totalSize > 0 ? task.totalSize : 0;
    if (quota.bytes !== null && task.totalSize <= 0) {
      // Une tâche de taille inconnue ne peut pas être budgétée : elle est reportée, pas
      // devinée à zéro (ce qui dépasserait le quota en silence).
      skipped.push({ ...task, reason: 'taille inconnue : reportée' });
      continue;
    }
    if (quota.bytes !== null && bytes + size > quota.bytes) {
      skipped.push({ ...task, reason: 'quota d’octets atteint' });
      continue;
    }
    bytes += size;
    selected.push(task);
  }

  return {
    open: true,
    waitUntil: null,
    selected,
    skipped,
    reason: selected.length === 0 ? 'aucune tâche éligible' : 'prêt',
    quota,
  };
}
