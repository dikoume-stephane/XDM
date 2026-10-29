/**
 * Statistiques et rapport d'une aspiration — lot `WP-25`, exigence `EX-B-15` (`D-053`).
 *
 * Le rapport répond à trois questions, dans cet ordre : **qu'a-t-on voulu**, **qu'a-t-on
 * obtenu**, **qu'a-t-on raté**. Il se calcule à partir du projet (les entrées) et de la
 * file (les états), sans relire le disque : ce qui n'est pas dans la file n'a pas été
 * traité, et le rapport doit le dire plutôt que de le supposer.
 *
 * Trois formats, un seul contenu : objet (pour un script), CSV (pour un tableur),
 * Markdown (pour une revue). Aucun format n'invente de valeur : une taille inconnue reste
 * `null`, un pourcentage sans dénominateur reste `null` (`0 / 0` n'est pas `100 %`).
 *
 * @module report
 */

/** Débit lisible (`1,2 Mio/s`), sans unité binaire implicite trompeuse. */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Kio', 'Mio', 'Gio', 'Tio'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

/** Durée lisible (`2 min 05 s`). */
export function humanDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * Agrège projet et file en un rapport sérialisable.
 *
 * Le troisième bloc, `diagnostics`, vient du **parcours** et non de la file : il répond à la
 * question qu'un rapport de téléchargements ne peut pas traiter — « pourquoi ce fichier n'est
 * il pas là ? » (page bloquée par `robots.txt`, branche élaguée, hors profondeur, hors site).
 * Il est absent (`null`) quand l'exécution n'a pas parcouru — une reprise n'explore pas.
 *
 * @param {{project?: object, queue: object, startedAt?: number, finishedAt?: number,
 *   siteMap?: Map<string, string> | Record<string, string>, crawl?: object|null}} input
 * @returns {{generatedAt: string, url: string | null, pages: number,
 *   counts: Record<string, number>, total: number, done: number, failed: number,
 *   bytes: {known: number, unknown: number}, errors: {url: string, message: string}[],
 *   slowest: {url: string, attempts: number}[], durationMs: number | null,
 *   progress: number | null, reuses: number, entries: object[],
 *   diagnostics: object|null}}
 */
export function buildReport({
  project = null, queue, startedAt, finishedAt, siteMap = null, crawl = null,
}) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  /** @type {Record<string, number>} */
  const counts = { PENDING: 0, ACTIVE: 0, PAUSED: 0, VERIFYING: 0, DONE: 0, FAILED: 0 };
  for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;

  const total = tasks.length;
  const done = counts.DONE ?? 0;
  const failed = counts.FAILED ?? 0;

  const lookup = siteMap instanceof Map ? siteMap : new Map(Object.entries(siteMap ?? {}));
  const errors = tasks
    .filter((task) => task.state === 'FAILED')
    .map((task) => ({ url: task.url, message: task.error ?? 'erreur inconnue' }));

  const attemptsOf = (task) => (Number.isInteger(task.attempts) ? task.attempts : 0);
  const slowest = [...tasks]
    .sort((a, b) => attemptsOf(b) - attemptsOf(a))
    .slice(0, 5)
    .map((task) => ({ url: task.url, attempts: attemptsOf(task) }))
    .filter((item) => item.attempts > 0);

  const durationMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt - startedAt)
    : null;

  return {
    generatedAt: new Date(finishedAt ?? Date.now()).toISOString(),
    url: project?.rootUrl ?? null,
    pages: project?.entries?.length ?? 0,
    counts,
    total,
    done,
    failed,
    bytes: {
      known: tasks.reduce((sum, task) => sum + (task.totalSize > 0 ? task.totalSize : 0), 0),
      unknown: tasks.filter((task) => !(task.totalSize > 0)).length,
    },
    errors,
    slowest,
    durationMs,
    // Un taux sans dénominateur est `null` : il ne se confond pas avec 0 % ni avec 100 %.
    progress: total === 0 ? null : Math.round((done / total) * 1000) / 10,
    reuses: tasks.filter((task) => lookup.has(task.url)).length,
    diagnostics: summarizeCrawl(crawl),
    entries: tasks.map((task) => ({
      id: task.id,
      url: task.url,
      target: task.target,
      state: task.state,
      size: task.totalSize > 0 ? task.totalSize : null,
      attempts: attemptsOf(task),
      error: task.error ?? null,
    })),
  };
}

/**
 * Synthèse du parcours pour le rapport.
 *
 * Les motifs de rejet sont **comptés**, pas listés en vrac : un rapport qui déverse 2 000
 * liens « hors site » n'apprend rien. On garde les trois premiers exemples par motif, et le
 * total — de quoi vérifier une hypothèse (« mes fichiers sont tous exclus par `*.zip` »).
 *
 * @param {object|null|undefined} crawl résultat de `crawl()` (ou `null` si pas de parcours)
 * @returns {object|null}
 */
export function summarizeCrawl(crawl) {
  if (!crawl || typeof crawl !== 'object') return null;
  const skipped = Array.isArray(crawl.skipped) ? crawl.skipped : [];
  /** @type {Record<string, number>} */
  const byReason = {};
  /** @type {Record<string, string[]>} */
  const examples = {};
  for (const item of skipped) {
    const reason = String(item.reason ?? 'inconnu');
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    const list = examples[reason] ?? (examples[reason] = []);
    if (list.length < 3 && typeof item.url === 'string') list.push(item.url);
  }
  return {
    pagesVisited: Number.isInteger(crawl.fetched) ? crawl.fetched : 0,
    retained: Array.isArray(crawl.retained) ? crawl.retained.length : 0,
    stopped: crawl.stopped ?? 'épuisement',
    delay: typeof crawl.delay === 'number' ? crawl.delay : 0,
    parallelisme: Number.isInteger(crawl.parallelisme) ? crawl.parallelisme : null,
    robots: crawl.robots ?? null,
    skipped: Object.fromEntries(Object.entries(byReason).sort(([, a], [, b]) => b - a)),
    examples,
    failedPages: Array.isArray(crawl.errors) ? crawl.errors.slice(0, 20) : [],
  };
}

/** Échappement CSV (guillemets doublés, champ encadré si nécessaire). */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Rapport en CSV — séparateur `;` et entête explicite (tableur français).
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string}
 */
export function toCsv(report) {
  const header = ['id', 'etat', 'url', 'cible', 'octets', 'tentatives', 'erreur'];
  const lines = [header.join(';')];
  for (const entry of report.entries) {
    lines.push([
      entry.id, entry.state, entry.url, entry.target, entry.size, entry.attempts, entry.error,
    ].map(csvField).join(';'));
  }
  // Les diagnostics ne sont pas des lignes de tâches : ils sortent en commentaires `#` après
  // le tableau, ce qui laisse le CSV importable tel quel.
  if (report.diagnostics) {
    const reasons = Object.entries(report.diagnostics.skipped);
    if (reasons.length > 0) {
      lines.push('');
      lines.push('# motif;liens');
      for (const [reason, count] of reasons) lines.push(`# ${csvField(reason)};${count}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Rapport en Markdown — lisible en revue, sans table large.
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string}
 */
export function toMarkdown(report) {
  const lines = [];
  lines.push('# Rapport d’aspiration');
  lines.push('');
  lines.push(`- **Site** : ${report.url ?? '—'}`);
  lines.push(`- **Généré le** : ${report.generatedAt}`);
  lines.push(`- **Entrées du projet** : ${report.pages}`);
  lines.push(`- **Tâches** : ${report.total} (${report.done} terminées, ${report.failed} en échec)`);
  lines.push(`- **Progression** : ${report.progress === null ? '—' : `${report.progress} %`}`);
  lines.push(`- **Volume annoncé** : ${humanBytes(report.bytes.known)}`
    + (report.bytes.unknown > 0 ? ` (+ ${report.bytes.unknown} de taille inconnue)` : ''));
  if (report.durationMs !== null) lines.push(`- **Durée** : ${humanDuration(report.durationMs)}`);
  lines.push('');
  lines.push('## États');
  lines.push('');
  lines.push('| État | Nombre |');
  lines.push('|---|---|');
  for (const [state, count] of Object.entries(report.counts)) lines.push(`| ${state} | ${count} |`);

  if (report.diagnostics) {
    const d = report.diagnostics;
    lines.push('');
    lines.push('## Exploration');
    lines.push('');
    lines.push(`- **Pages visitées** : ${d.pagesVisited}`);
    lines.push(`- **Fichiers retenus** : ${d.retained}`);
    lines.push(`- **Arrêt** : ${d.stopped}`);
    if (d.delay > 0) lines.push(`- **Délai entre vagues** : ${d.delay} s`);
    if (d.parallelisme !== null) lines.push(`- **Requêtes simultanées** : ${d.parallelisme}`);
    const reasons = Object.entries(d.skipped);
    if (reasons.length === 0) {
      lines.push('- **Liens écartés** : aucun');
    } else {
      lines.push('');
      lines.push('| Motif de rejet | Liens | Exemple |');
      lines.push('|---|---|---|');
      for (const [reason, count] of reasons) {
        const example = (d.examples[reason] ?? [])[0] ?? '—';
        lines.push(`| ${reason.replace(/\|/g, '\\|')} | ${count} | \`${example}\` |`);
      }
    }
  }

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('## Échecs');
    lines.push('');
    lines.push('| URL | Message |');
    lines.push('|---|---|');
    for (const error of report.errors) {
      lines.push(`| \`${error.url}\` | ${error.message.replace(/\|/g, '\\|')} |`);
    }
  }

  if (report.slowest.length > 0) {
    lines.push('');
    lines.push('## Plus de tentatives');
    lines.push('');
    lines.push('| URL | Tentatives |');
    lines.push('|---|---|');
    for (const item of report.slowest) lines.push(`| \`${item.url}\` | ${item.attempts} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Le rapport en objet, JSON, CSV ou Markdown. */
export function formatReport(report, format = 'json') {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  if (format === 'csv') return toCsv(report);
  if (format === 'markdown' || format === 'md') return toMarkdown(report);
  throw new Error(`format de rapport inconnu : ${format} (attendu : json | csv | markdown)`);
}
