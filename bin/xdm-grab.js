#!/usr/bin/env node
/**
 * CLI d'aspiration de site — lot `WP-23`.
 *
 * `xdm-grab <url> [dossier] [--profondeur N] [--pages N] [--connexions N] [--sans-robots]
 *   [--reprendre] [--sortie texte|json]`
 *
 * Enchaîne, sans état caché : parcours du site (`crawler.js`) → arborescence locale et
 * `empty.html` (`grabber.js`) → file de tâches (`task-queue.js`) → téléchargements et
 * promotions (`grab-runner.js`). Le projet (`<hôte>.xdmspider.json`) et la file
 * (`queue.json`) sont écrits dans le dossier cible : une interruption se reprend.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { crawl } from '../src/crawler.js';
import { prepareGrab } from '../src/grabber.js';
import { downloadTask, executeGrab, retryFailed } from '../src/grab-runner.js';
import { fetchText } from '../src/http-client.js';
import { createProject, loadProject, projectPath, splitMotif } from '../src/project.js';
import { createQueue, loadQueue } from '../src/task-queue.js';

export const USAGE = `usage : xdm-grab <url> [dossier] [--profondeur N] [--pages N] [--connexions N] [--sans-robots]
                   [--reprendre] [--sortie texte|json]
  --profondeur  niveaux visités (défaut 2)
  --pages       nombre maximal de pages visitées (défaut 2000)
  --connexions  téléchargements simultanés (défaut 4)
  --sans-robots ignorer robots.txt (déconseillé)
  --reprendre   reprendre le projet et la file déjà présents dans <dossier>, sans re-parcourir
  --sortie      format du résumé : texte (défaut) ou json
`;

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
    depth: 2, maxPages: 2000, connections: 4, robots: true, resume: false, output: 'texte',
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
  const { url, directory, depth, maxPages, connections, robots, resume } = parseArgs(argv);
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

  // Tâche d'exécution : celle du test si elle existe, sinon le téléchargement réel avec
  // les options demandées, sinon le comportement par défaut du runner.
  const effectiveRunTask = runTask
    ?? (Object.keys(downloadOptions).length > 0
      ? (task) => downloadTask(task, { downloadOptions })
      : undefined);

  const outcome = await executeGrab({
    project: plan.project,
    queue: plan.queue,
    projectPath: projectPath(rootDir, plan.project.name),
    queueDir: rootDir,
    concurrency: connections,
    ...(effectiveRunTask ? { runTask: effectiveRunTask } : {}),
  });

  log(`téléchargés : ${outcome.stats.counts.DONE} / ${outcome.stats.total}`);
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
    })
    .catch((error) => {
      const message = String(error?.message ?? error).trimEnd();
      console.error(`xdm-grab : ${message}`);
      process.exit(message.startsWith('usage') ? 2 : 1);
    });
}
