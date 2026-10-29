#!/usr/bin/env node
/**
 * CLI d'aspiration de site — lots `WP-23` (`D-043`), `WP-24` (`EX-B-14`, `D-053`) et
 * `WP-25` (`EX-B-15`/`EX-B-16`, `D-054`).
 *
 * `xdm-grab <url> [dossier] [--profondeur N] [--pages N] [--connexions N] [--sans-robots]
 *   [--reprendre] [--inclure MOTIF] [--sans-exclusions] [--reecrire] [--rapport F]
 *   [--planifier « lun-ven 01:00-06:00 »] [--tentatives N]
 *   [--quota-octets N | --quota-taches N] [--sortie texte|json]`
 *
 * Enchaîne, sans état caché : parcours du site (`crawler.js`) → arborescence locale et
 * `empty.html` (`grabber.js`) → file de tâches (`task-queue.js`) → téléchargements et
 * promotions (`grab-runner.js`). Le projet (`<hôte>.xdmspider.json`) et la file
 * (`queue.json`) sont écrits dans le dossier cible : une interruption se reprend.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { crawl } from '../src/crawler.js';
import { prepareGrab } from '../src/grabber.js';
import { downloadTask, executeGrab, retryFailed } from '../src/grab-runner.js';
import { fetchText } from '../src/http-client.js';
import {
  addFilter, createProject, loadProject, projectPath, saveProject, splitMotif,
} from '../src/project.js';
import { buildReport, formatReport } from '../src/report.js';
import { rewriteDocument, siteMapFromEntries } from '../src/rewrite.js';
import { createSchedule, planRun } from '../src/schedule.js';
import { createQueue, loadQueue, saveQueue } from '../src/task-queue.js';

export const USAGE = `usage : xdm-grab <url> [dossier] [--profondeur N] [--pages N] [--connexions N] [--sans-robots]
                   [--reprendre] [--inclure MOTIF] [--sans-exclusions] [--reecrire]
                   [--rapport F] [--planifier FENÊTRE]
                   [--quota-octets N | --quota-taches N] [--tentatives N] [--sortie texte|json]
  --profondeur     niveaux visités (défaut 2)
  --pages          nombre maximal de pages visitées (défaut 2000)
  --connexions     téléchargements simultanés (défaut 4)
  --sans-robots    ignorer robots.txt (déconseillé)
  --reprendre      reprendre le projet et la file déjà présents dans <dossier>, sans re-parcourir
  --inclure        motif à inclure, répétable (ex. « *.html »)
  --sans-exclusions  vider les exclusions par défaut (D-032 : l'exclusion l'emporte sur
                   l'inclusion, donc --inclure « *.html » seul ne retient aucune page)
  --reecrire       réécrire les liens HTML/CSS vers les chemins locaux (choix XDM, D-053)
  --rapport        écrire un rapport (extension .json, .csv ou .md ; Markdown par défaut)
  --planifier      n'exécuter que dans la fenêtre donnée, ex. « lun-ven 01:00-06:00 »
  --quota-octets   budget d'octets pour cette exécution
  --quota-taches   nombre de tâches pour cette exécution
  --tentatives     essais par tâche sur un statut transitoire (défaut 1 ; 429/503 respectent
                   l'en-tête Retry-After)
  --sortie         format du résumé : texte (défaut) ou json

code de sortie : 0 terminé, 1 erreur, 2 usage, 3 hors fenêtre de planification`;

export const OUTPUT_FORMATS = /** @type {const} */ (['texte', 'json']);

/**
 * Analyse les arguments de la ligne de commande.
 * @param {string[]} argv
 * @returns {{url: string, directory: string, depth: number, maxPages: number,
 *   connections: number, robots: boolean, resume: boolean,
 *   output: 'texte' | 'json'}}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  const options = {
    depth: 2,
    maxPages: 2000,
    connections: 4,
    robots: true,
    resume: false,
    output: 'texte',
    rewrite: false,
    include: [],
    noExclude: false,
    report: null,
    window: null,
    quotaBytes: null,
    quotaTasks: null,
    attempts: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    const value = () => {
      i += 1;
      const raw = argv[i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`valeur invalide pour ${argument} : ${raw}`);
      }
      return parsed;
    };
    if (argument === '--profondeur') options.depth = value();
    else if (argument === '--pages') options.maxPages = value();
    else if (argument === '--connexions') options.connections = value();
    else if (argument === '--sans-robots') options.robots = false;
    else if (argument === '--reprendre') options.resume = true;
    else if (argument === '--reecrire') options.rewrite = true;
    else if (argument === '--sans-exclusions') options.noExclude = true;
    else if (argument === '--inclure') {
      i += 1;
      if (!argv[i]) throw new Error(`--inclure attend un motif\n${USAGE}`);
      options.include.push(argv[i]);
    }
    else if (argument === '--rapport') {
      i += 1;
      if (!argv[i]) throw new Error(`--rapport attend un fichier\n${USAGE}`);
      options.report = argv[i];
    } else if (argument === '--planifier') {
      i += 1;
      if (!argv[i]) throw new Error(`--planifier attend une fenêtre\n${USAGE}`);
      options.window = argv[i];
    } else if (argument === '--quota-octets') options.quotaBytes = value();
    else if (argument === '--quota-taches') options.quotaTasks = value();
    else if (argument === '--tentatives') options.attempts = value();
    else if (argument === '--sortie') {
      i += 1;
      const format = argv[i];
      if (!OUTPUT_FORMATS.includes(format)) {
        throw new Error(`format de sortie inconnu : ${format} (attendu : ${OUTPUT_FORMATS.join(' | ')})`);
      }
      options.output = format;
    }
    else if (argument === '--aide' || argument === '--help' || argument === '-h') {
      throw new Error(USAGE);
    } else if (argument.startsWith('--')) throw new Error(`option inconnue : ${argument}\n${USAGE}`);
    else positional.push(argument);
  }
  const url = positional[0];
  if (!url) throw new Error(USAGE);
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(`URL invalide : ${url}`);
  }
  return { url, directory: positional[1] ?? '.', ...options };
}

/**
 * Filtres actifs d'un projet, au format attendu par le parcours.
 * @param {object} project
 * @returns {{include: string[], exclude: string[]}}
 */
export function filtersOf(project) {
  const active = (list) => project.filters[list]
    .filter((filter) => filter.actif)
    .flatMap((filter) => splitMotif(filter.motif));
  return { include: active('include'), exclude: active('exclude') };
}

/** Le fichier existe-t-il ? (sans lever) */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Résumé machine d'une exécution : ce qu'un script peut consommer (pas de file entière).
 * @param {{pages: number, retained: number, done: number, failed: number, directory: string,
 *   project: object, queue: object}} result
 * @returns {{url: string, directory: string, pages: number, retained: number,
 *   done: number, failed: number, tasks: number}}
 */
export function summarize(result) {
  return {
    url: result.project.rootUrl,
    directory: result.directory,
    pages: result.pages,
    retained: result.retained,
    done: result.done,
    failed: result.failed,
    tasks: result.queue.tasks.length,
    started: result.started ?? true,
    rewritten: result.rewritten ?? 0,
    report: result.report ?? null,
  };
}

/**
 * Le format de sortie demandé, sans valider les autres options.
 * @param {string[]} argv
 * @returns {'texte' | 'json'}
 */
export function outputFormat(argv) {
  const index = argv.indexOf('--sortie');
  return index >= 0 && argv[index + 1] === 'json' ? 'json' : 'texte';
}

/**
 * Point d'entrée testable.
 * @param {string[]} argv
 * @param {{log?: (line: string) => void, fetchPage?: (url: string) => Promise<object>,
 *   downloadOptions?: object, runTask?: (task: object) => Promise<object>}} [deps]
 * @returns {Promise<{project: object, queue: object, pages: number, retained: number,
 *   done: number, failed: number, directory: string}>}
 */
export async function main(argv, {
  log = console.log,
  fetchPage = (url) => fetchText(url),
  downloadOptions = {},
  runTask,
} = {}) {
  const options = parseArgs(argv);
  const { url, directory, depth, maxPages, connections, robots, resume } = options;
  const rootDir = resolve(directory);
  await mkdir(rootDir, { recursive: true });

  /** @type {URL} */
  const parsed = new URL(url);
  /** @type {{project: object, queue: object, pages: number, retained: number}} */
  let plan;
  if (resume) {
    // Reprise : le projet et la file sur disque font foi ; on ne re-parcourt pas le site.
    const saved = projectPath(rootDir, parsed.hostname || 'site');
    const project = await loadProject(saved);
    const queue = await loadQueue(rootDir);
    log(`reprise de ${saved} : ${queue.tasks.length} tâche(s), ${project.entries.length} entrée(s)`);
    plan = { project, queue, pages: 0, retained: project.entries.length };
  } else {
    let project = createProject({
      name: parsed.hostname || 'site',
      rootUrl: url,
      depth,
    });
    // La profondeur du projet suit l'option : deux sources de vérité seraient un piège.
    project = { ...project, depth };
    // L'exclusion l'emporte (D-032) : pour aspirer réellement des pages, il faut vider les
    // exclusions par défaut *avant* d'ajouter les inclusions.
    if (options.noExclude) project = { ...project, filters: { ...project.filters, exclude: [] } };
    for (const motif of options.include) project = addFilter(project, 'include', motif);

    log(`parcours de ${url} (profondeur ${depth}, ${maxPages} pages au plus)`);
    const found = await crawl(url, {
      fetchPage,
      depth,
      maxPages,
      filters: filtersOf(project),
      robots,
    });
    log(`${found.fetched} page(s) visitée(s), ${found.retained.length} fichier(s) retenu(s)`);
    plan = {
      ...(await prepareGrab({
        project,
        queue: createQueue({}),
        retained: found.retained,
        rootDir,
      })),
      pages: found.fetched,
      retained: found.retained.length,
    };
  }
  // Reprise : une tâche laissée en échec (coupure, 404 passager) redevient candidate.
  if (resume) plan.queue = retryFailed(plan.queue);

  // Planification (`WP-25`) : hors fenêtre, on ne télécharge rien et on le dit.
  // Une fenêtre **ou** un quota suffit à planifier : sans fenêtre, tout est ouvert.
  const scheduled = options.window !== null
    || options.quotaBytes !== null
    || options.quotaTasks !== null;
  const schedule = scheduled
    ? createSchedule({
      windows: options.window ? [options.window] : [],
      quota: {
        ...(options.quotaBytes !== null ? { bytes: options.quotaBytes } : {}),
        ...(options.quotaTasks !== null ? { tasks: options.quotaTasks } : {}),
      },
    })
    : null;
  const start = new Date();
  /** @type {ReturnType<typeof planRun> | null} */
  const planRunOutcome = schedule ? planRun({ queue: plan.queue, schedule, now: start }) : null;
  if (planRunOutcome && !planRunOutcome.open) {
    // Le plan est **persisté** même hors fenêtre : l'aspiration est planifiée, pas perdue.
    await saveProject(projectPath(rootDir, plan.project.name), plan.project);
    await saveQueue(rootDir, plan.queue);
    log(`hors fenêtre (${options.window}) — prochaine ouverture : ${planRunOutcome.waitUntil?.toISOString() ?? 'jamais'}`);
    return {
      project: plan.project,
      queue: plan.queue,
      pages: plan.pages,
      retained: plan.retained,
      done: 0,
      failed: 0,
      directory: rootDir,
      started: false,
      waitUntil: planRunOutcome.waitUntil ? planRunOutcome.waitUntil.toISOString() : null,
      report: null,
      rewritten: 0,
    };
  }

  // Tâche d'exécution : celle du test si elle existe, sinon le téléchargement réel avec
  // les options demandées, sinon le comportement par défaut du runner.
  const effectiveRunTask = runTask
    ?? (Object.keys(downloadOptions).length > 0
      ? (task) => downloadTask(task, { downloadOptions })
      : undefined);

  // Le quota ne retire aucune tâche : les non retenues restent `PENDING`.
  const only = planRunOutcome ? new Set(planRunOutcome.selected.map((task) => task.id)) : null;

  const outcome = await executeGrab({
    project: plan.project,
    queue: plan.queue,
    projectPath: projectPath(rootDir, plan.project.name),
    queueDir: rootDir,
    concurrency: connections,
    only,
    maxAttempts: options.attempts,
    ...(effectiveRunTask ? { runTask: effectiveRunTask } : {}),
  });

  log(`téléchargés : ${outcome.stats.counts.DONE} / ${outcome.stats.total}`);

  // Réécriture des liens (`WP-24`) : seulement pour les documents HTML/CSS réellement
  // présents sur disque. Un fichier absent n'est pas réécrit, il est compté.
  let rewritten = 0;
  if (options.rewrite) {
    const map = siteMapFromEntries(plan.entries ?? []);
    for (const entry of plan.entries ?? []) {
      if (!/\.(html?|css)$/i.test(entry.localPath)) continue;
      const file = join(rootDir, entry.localPath);
      if (!(await exists(file))) continue;
      const source = await readFile(file, 'utf8');
      const result = rewriteDocument(source, {
        pageUrl: entry.url,
        pageLocalPath: entry.localPath,
        siteMap: map,
      });
      if (result.rewritten > 0) {
        await writeFile(file, result.text, 'utf8');
        rewritten += result.rewritten;
      }
    }
    log(`liens réécrits : ${rewritten}`);
  }

  // Rapport (`WP-25`) : écrit sur disque, format déduit de l'extension.
  let reportPath = null;
  if (options.report) {
    const report = buildReport({
      project: outcome.project,
      queue: outcome.queue,
      startedAt: start.getTime(),
      finishedAt: Date.now(),
      siteMap: siteMapFromEntries(plan.entries ?? []),
    });
    reportPath = resolve(options.report);
    const format = reportPath.endsWith('.json') ? 'json'
      : reportPath.endsWith('.csv') ? 'csv' : 'markdown';
    await writeFile(reportPath, formatReport(report, format), 'utf8');
    log(`rapport  : ${reportPath}`);
  }
  if (outcome.failures.length > 0) {
    for (const failure of outcome.failures) log(`  échec ${failure.url} : ${failure.error}`);
  }
  log(`projet   : ${outcome.saved.project}`);
  log(`file     : ${outcome.saved.queue}`);

  return {
    project: outcome.project,
    queue: outcome.queue,
    pages: plan.pages,
    retained: plan.retained,
    done: outcome.stats.counts.DONE,
    failed: outcome.stats.counts.FAILED,
    directory: rootDir,
    started: true,
    waitUntil: null,
    report: reportPath,
    rewritten,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const json = outputFormat(argv) === 'json';
  // En JSON, stdout ne contient que l'objet : la progression part sur stderr.
  const log = json ? (line) => console.error(line) : console.log;
  main(argv, { log })
    .then((result) => {
      if (json) console.log(JSON.stringify(summarize(result)));
      if (result.started === false) process.exitCode = 3;
    })
    .catch((error) => {
      const message = String(error?.message ?? error).trimEnd();
      console.error(`xdm-grab : ${message}`);
      process.exit(message.startsWith('usage') ? 2 : 1);
    });
}
