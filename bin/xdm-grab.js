#!/usr/bin/env node
/**
 * CLI d'aspiration de site — lots `WP-23` (`D-043`), `WP-24` (`EX-B-14`, `D-053`) et
 * `WP-25` (`EX-B-15`/`EX-B-16`, `D-054`).
 *
 * `xdm-grab <url> [dossier] [--profondeur N] [--pages N] [--connexions N] [--sans-robots]
 *   [--reprendre] [--inclure MOTIF] [--exclure MOTIF] [--sans-exclusions] [--paralleles N]
 *   [--delai SECONDES] [--arret-erreurs N] [--entete "Nom: valeur"] [--essai]
 *   [--sitemap] [--sous-domaines] [--taille-max T] [--espace-min T] [--incremental]
 *   [--progression] [--verifier] [--sortie json]
 *   [--aide] [--version]
 *   [--reecrire] [--rapport F]
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

import { crawl, robotsUrl } from '../src/crawler.js';
import { prepareGrab } from '../src/grabber.js';
import {
  downloadTask, executeGrab, listOrphans, recoverOrphans, reopenDone, retryFailed,
  retryFailedCapped,
} from '../src/grab-runner.js';
import { checkSpace, estimateSpace } from '../src/diskspace.js';
import { parseSize } from '../src/size.js';
import { createProgressReporter } from '../src/progress.js';
import { verifyGrab } from '../src/verify.js';
import { fetchText } from '../src/http-client.js';
import {
  addFilter, createProject, loadProject, projectPath, saveProject, splitMotif,
} from '../src/project.js';
import { createCookieJar, loadCookieJar, saveCookieJar, withCookies } from '../src/cookies.js';
import { defaultTransport } from '../src/http-client.js';
import { parseHeaderOption } from '../src/headers.js';
import { buildReport, formatReport, summarizeCrawl } from '../src/report.js';
import { rewriteDocument, siteMapFromEntries } from '../src/rewrite.js';
import { createSchedule, planRun } from '../src/schedule.js';
import { createQueue, loadQueue, saveQueue } from '../src/task-queue.js';
import { discoverSitemaps } from '../src/sitemap.js';

/** Version annoncée par `--version` (celle du paquet). */
export const VERSION = '0.1.0';

export const USAGE = `usage : xdm-grab <url> [dossier] [--profondeur N] [--pages N] [--connexions N] [--sans-robots]
                   [--reprendre] [--inclure MOTIF] [--exclure MOTIF] [--sans-exclusions]
                   [--paralleles N] [--delai SECONDES] [--arret-erreurs N]
                   [--entete "Nom: valeur"] [--essai] [--sitemap] [--sous-domaines]
                   [--taille-max TAILLE] [--espace-min TAILLE] [--incremental]
                   [--progression] [--verifier]
                   [--reecrire] [--rapport F] [--planifier FENÊTRE]
                   [--quota-octets N | --quota-taches N] [--tentatives N] [--sortie texte|json]
  --profondeur     niveaux visités (défaut 2)
  --pages          nombre maximal de pages visitées (défaut 2000)
  --connexions     téléchargements simultanés (défaut 4)
  --sans-robots    ignorer robots.txt (déconseillé)
  --reprendre      reprendre le projet et la file déjà présents dans <dossier>, sans re-parcourir ;
                   relève aussi les tâches laissées en cours par un arrêt brutal (suppose
                   qu'aucune autre exécution ne travaille dans ce dossier)
  --inclure        motif à inclure, répétable (ex. « *.html »)
  --exclure        motif à exclure, répétable — l'emporte sur l'inclusion (D-032)
  --delai          secondes entre deux vagues de requêtes ; 0 pour ignorer le Crawl-delay
                   du site, une valeur explicite l'emporte toujours sur celui-ci
  --arret-erreurs  arrêter le parcours après N pages en échec consécutif (défaut : jamais)
  --entete         en-tête HTTP envoyé à chaque requête (pages et fichiers), répétable,
                   ex. « Authorization: Bearer … » ; les en-têtes du moteur (Range,
                   If-Range) restent prioritaires
  --essai          parcourir et montrer le plan (pages, fichiers, volume) sans rien écrire
                   ni télécharger — le dossier cible n'est même pas créé
  --sitemap        partir aussi des plans de site : directives « Sitemap: » du robots.txt,
                   sinon /sitemap.xml ; les URL listées passent les mêmes contrôles
  --sous-domaines  accepter les sous-domaines du site de départ (jamais un domaine tiers)
  --taille-max     refuser un fichier plus gros que cette taille (500K, 1,5M, 2G ; unités
                   binaires) — refus après la sonde, avant tout octet écrit
  --espace-min     exiger au moins cette taille libre en plus des fichiers prévus ;
                   vérifié avant la première connexion (défaut : 64 Mio)
  --verifier       vérifier une aspiration existante (file ↔ disque) sans aucun accès réseau ;
                   code 1 si un fichier manque ou est tronqué (les fichiers hors file sont
                   signalés sans faire échouer : ils peuvent être légitimes)
  --aide, -h       afficher cette aide et sortir (code 0)
  --version, -V    afficher la version et sortir (code 0)
  --paralleles     pages explorées simultanément (défaut 1, déterministe)
  --sans-exclusions  vider les exclusions par défaut (D-032 : l'exclusion l'emporte sur
                   l'inclusion, donc --inclure « *.html » seul ne retient aucune page)
  --reecrire       réécrire les liens HTML/CSS vers les chemins locaux (choix XDM, D-053)
  --rapport        écrire un rapport (extension .json, .csv, .html ou .md ; Markdown par défaut)
  --planifier      n'exécuter que dans la fenêtre donnée, ex. « lun-ven 01:00-06:00 »
  --quota-octets   budget d'octets pour cette exécution
  --quota-taches   nombre de tâches pour cette exécution
  --cookies        magasin de cookies persistant (relu au démarrage, réécrit à la fin ;
                   seuls les cookies datés sont conservés, fichier en 0600 — D-062)
  --tentatives     essais par tâche sur un statut transitoire (défaut 1 ; 429/503 respectent
                   l'en-tête Retry-After)
  --tentatives-total  nombre total d'essais cumulés, toutes exécutions confondues : au-delà,
                   une tâche en échec n'est plus rejouée par --reprendre
  --incremental    si un fichier local existe, demander If-Modified-Since : un 304 le laisse
                   intact et compte comme terminé
  --progression    afficher l'avancement de chaque fichier (%, octets) sur la sortie d'erreur
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
    exclude: [],
    noExclude: false,
    parallelisme: 1,
    delay: null,
    maxErrors: null,
    headers: {},
    dryRun: false,
    sitemap: false,
    subdomains: false,
    maxSize: null,
    minSpace: null,
    verify: false,
    incremental: false,
    totalAttempts: null,
    progress: false,
    help: false,
    version: false,
    report: null,
    window: null,
    quotaBytes: null,
    quotaTasks: null,
    attempts: 1,
    cookies: null,
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
    else if (argument === '--paralleles') options.parallelisme = value();
    else if (argument === '--inclure') {
      i += 1;
      if (!argv[i]) throw new Error(`--inclure attend un motif\n${USAGE}`);
      options.include.push(argv[i]);
    }
    else if (argument === '--exclure') {
      i += 1;
      if (!argv[i]) throw new Error(`--exclure attend un motif\n${USAGE}`);
      options.exclude.push(argv[i]);
    }
    else if (argument === '--arret-erreurs') options.maxErrors = value();
    else if (argument === '--essai') options.dryRun = true;
    else if (argument === '--sitemap') options.sitemap = true;
    else if (argument === '--sous-domaines') options.subdomains = true;
    else if (argument === '--verifier') options.verify = true;
    else if (argument === '--incremental') options.incremental = true;
    else if (argument === '--progression') options.progress = true;
    else if (argument === '--tentatives-total') options.totalAttempts = value();
    else if (argument === '--taille-max') {
      i += 1;
      if (argv[i] === undefined) throw new Error(`--taille-max attend une taille\n${USAGE}`);
      try {
        options.maxSize = parseSize(argv[i]);
      } catch (error) {
        throw new Error(`valeur invalide pour --taille-max : ${argv[i]} (${error.message})`);
      }
    } else if (argument === '--espace-min') {
      i += 1;
      if (argv[i] === undefined) throw new Error(`--espace-min attend une taille\n${USAGE}`);
      try {
        options.minSpace = parseSize(argv[i]);
      } catch (error) {
        throw new Error(`valeur invalide pour --espace-min : ${argv[i]} (${error.message})`);
      }
    }
    else if (argument === '--aide' || argument === '-h') options.help = true;
    else if (argument === '--version' || argument === '-V') options.version = true;
    else if (argument === '--entete') {
      i += 1;
      if (!argv[i]) throw new Error(`--entete attend « Nom: valeur »\n${USAGE}`);
      const { name, value: headerValue } = parseHeader(argv[i]);
      options.headers[name] = headerValue;
    }
    else if (argument === '--delai') {
      i += 1;
      const raw = argv[i];
      if (raw === undefined) throw new Error(`--delai attend un nombre de secondes\n${USAGE}`);
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`valeur invalide pour --delai : ${raw}`);
      }
      options.delay = seconds;
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
    else if (argument === '--cookies') {
      i += 1;
      if (!argv[i]) throw new Error(`--cookies attend un fichier\n${USAGE}`);
      options.cookies = argv[i];
    }
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
 * En-tête `Nom: valeur` — la validation vit dans `src/headers.js` (`D-069`), pour que les
 * deux CLI appliquent exactement la même règle.
 *
 * @param {string} raw
 * @returns {{name: string, value: string}}
 */
export function parseHeader(raw) {
  return parseHeaderOption(raw);
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
    url: result.project?.rootUrl ?? null,
    directory: result.directory,
    pages: result.pages,
    retained: result.retained,
    done: result.done,
    failed: result.failed,
    tasks: result.queue.tasks.length,
    started: result.started ?? true,
    dryRun: result.dryRun ?? false,
    interrupted: result.interrupted ?? false,
    blocked: result.blocked ?? null,
    // `--verifier` en JSON (`D-070`) : les compteurs et les listes, sans les objets de tâche
    // entiers — un script veut savoir *combien* et *lesquels*, pas relire toute la file.
    ...(result.verify
      ? {
        conforms: result.conforms ?? null,
        verify: {
          checked: result.verify.checked,
          ok: result.verify.ok,
          missing: result.verify.missing.map((item) => item.path),
          truncated: result.verify.truncated.map((item) => item.path),
          partial: result.verify.partial.map((item) => item.path),
          unmanaged: result.verify.unmanaged.map((item) => item.path),
          errors: result.verify.errors.map((item) => item.path),
        },
      }
      : {}),
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
 *   downloadOptions?: object, runTask?: (task: object) => Promise<object>,
 *   signal?: {aborted: boolean}|null, statfs?: Function|null}} [deps]
 * @returns {Promise<{project: object, queue: object, pages: number, retained: number,
 *   done: number, failed: number, directory: string}>}
 */
export async function main(argv, {
  log = console.log,
  // Le défaut **transmet** les en-têtes qu'on lui donne : une enveloppe qui les ignore
  // (cookies, `--entete`) croit envoyer une session qu'elle n'envoie pas (`D-063`).
  fetchPage: injectedFetchPage = (url, init = {}) => fetchText(url, { headers: init.headers ?? {} }),
  downloadOptions: injectedDownloadOptions = {},
  runTask,
  signal = null,
  statfs = null,
} = {}) {
  // `--aide` et `--version` répondent **sans** exiger d'URL : demander de l'aide ne doit pas
  // commencer par une erreur d'usage (et le cas est testé).
  if (argv.includes('--version') || argv.includes('-V')) {
    log(`xdm-grab ${VERSION} (Node ${process.version})`);
    return { version: VERSION, project: null, queue: { tasks: [] }, pages: 0, retained: 0,
      done: 0, failed: 0, directory: resolve(argv[1] ?? '.'), started: false };
  }
  if (argv.includes('--aide') || argv.includes('-h')) {
    log(USAGE);
    return { help: true, project: null, queue: { tasks: [] }, pages: 0, retained: 0,
      done: 0, failed: 0, directory: resolve(argv[1] ?? '.'), started: false };
  }

  const options = parseArgs(argv);
  let fetchPage = injectedFetchPage;
  let downloadOptions = injectedDownloadOptions;
  const { url, directory, depth, maxPages, connections, robots, resume } = options;
  const rootDir = resolve(directory);

  // `--verifier` (`D-068`) : on lit ce qui existe, on n'écrit rien et on ne contacte personne.
  // Placé **avant** la création du dossier : vérifier une aspiration absente ne doit pas la
  // créer, sinon la vérification fabrique ce qu'elle prétend constater.
  if (options.verify) {
    const tasks = await loadQueue(rootDir).then((queue) => queue.tasks).catch(() => null);
    if (tasks === null) {
      log(`vérification : aucune file dans ${rootDir} — rien à vérifier`);
      return {
        verify: { checked: 0, ok_: false, missing: [], truncated: [], unmanaged: [] },
        project: null,
        queue: { tasks: [] },
        pages: 0,
        retained: 0,
        done: 0,
        failed: 0,
        directory: rootDir,
        started: false,
        report: null,
        rewritten: 0,
      };
    }
    const result = await verifyGrab({ rootDir, tasks });
    log(`vérification de ${rootDir} : ${result.checked} tâche(s), ${result.ok} conforme(s)`);
    log(`  octets annoncés : ${result.totalBytes}, octets sur disque : ${result.diskBytes}`);
    for (const item of result.missing) log(`  MANQUANT  ${item.path} (${item.url})`);
    for (const item of result.truncated) {
      log(`  TRONQUÉ   ${item.path} : ${item.found} octets au lieu de ${item.expected}`);
    }
    for (const item of result.partial) {
      log(`  PARTIEL   ${item.path} (état ${item.state}, ${item.size} octets)`);
    }
    if (result.unmanaged.length > 0) {
      log(`  hors file : ${result.unmanaged.length} fichier(s) `
        + `(${result.unmanaged.slice(0, 5).map((file) => file.path).join(', ')}`
        + `${result.unmanaged.length > 5 ? ', …' : ''})`);
    }
    for (const error of result.errors) log(`  ILLISIBLE ${error.path} : ${error.message}`);
    log(result.ok_ ? 'vérification : conforme' : 'vérification : ÉCART DÉTECTÉ (code 1)');
    return {
      verify: result,
      project: null,
      queue: { tasks },
      pages: tasks.length,
      retained: tasks.length,
      done: result.ok,
      failed: result.missing.length + result.truncated.length,
      directory: rootDir,
      started: false,
      conforms: result.ok_,
      report: null,
      rewritten: 0,
    };
  }

  // `--essai` ne crée **rien** : un essai qui laisse un dossier derrière lui n'est pas un
  // essai, c'est une aspiration partielle (`D-064`).
  if (!options.dryRun) await mkdir(rootDir, { recursive: true });

  // `--cookies` : le magasin survit à l'interruption. Sans l'option, la session reste en
  // mémoire — comportement historique, et le seul qui ne laisse rien sur le disque (`D-062`).
  const cookiePath = options.cookies === null ? null : resolve(options.cookies);
  const jar = cookiePath === null
    ? createCookieJar()
    : (await loadCookieJar(cookiePath)).jar;
  if (cookiePath !== null) log(`cookies : ${jar.size()} cookie(s) relus depuis ${cookiePath}`);

  // Le magasin sert **toujours** dans l'exécution courante : une session qui pose un cookie
  // puis protège un fichier doit fonctionner sans option. `--cookies` n'ajoute que la
  // **persistance** d'une exécution à l'autre (`D-062`).
  const userHeaders = options.headers;
  /** Ajoute `--entete` sans jamais écraser un en-tête du moteur (`Range`, `If-Range`). */
  const withUserHeaders = (transport) => (
    Object.keys(userHeaders).length === 0
      ? transport
      : (url, init = {}) => transport(url, {
        ...init,
        headers: { ...userHeaders, ...(init.headers ?? {}) },
      })
  );

  const plainFetch = withUserHeaders(fetchPage);
  fetchPage = async (url, init = {}) => {
    const response = await plainFetch(url, { ...init, headers: jar.apply(url, init.headers ?? {}) });
    if (response?.headers) jar.store(url, response.headers);
    return response;
  };

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
    // L'exclusion est posée **après** la remise à zéro, sinon `--sans-exclusions --exclure x`
    // perdrait x ; elle l'emporte sur l'inclusion au moment du tri (`D-032`).
    for (const motif of options.exclude) project = addFilter(project, 'exclude', motif);

    // Plans de site (`D-065`) : lus **avant** le parcours, pour que leurs URL soient des
    // amorces. Le `robots.txt` est lu ici s'il faut ses directives `Sitemap:` — et transmis
    // au parcours pour ne pas le demander deux fois.
    let seeds = [];
    let robotsText = null;
    if (options.sitemap) {
      try {
        const response = await fetchPage(robotsUrl(url));
        if (response && response.status >= 200 && response.status < 300) robotsText = response.body;
      } catch {
        robotsText = null; // robots.txt absent : le plan de site reste cherché à la racine
      }
      const plans = await discoverSitemaps({ startUrl: url, fetchPage, robotsText });
      seeds = plans.urls;
      log(`plans de site : ${plans.sitemaps.length} consulté(s), ${seeds.length} URL`
        + `${plans.truncated ? ' (plafond atteint)' : ''}`);
      for (const failure of plans.failed) {
        log(`  plan ignoré ${failure.url} : ${failure.reason}`);
      }
    }

    log(`parcours de ${url} (profondeur ${depth}, ${maxPages} pages au plus)`);
    const found = await crawl(url, {
      fetchPage,
      depth,
      maxPages,
      filters: filtersOf(project),
      robots,
      parallelisme: options.parallelisme,
      maxErrors: options.maxErrors,
      // `--exclure` élague : la branche n'est pas demandée, et rien de ce qu'elle cite
      // n'entre dans la file (`D-060`).
      prune: options.exclude,
      delai: options.delay,
      attempts: options.attempts,
      seeds,
      robotsText,
      subdomains: options.subdomains,
      signal,
    });
    if (found.delay > 0) log(`délai entre vagues : ${found.delay} s`);
    if (found.retries > 0) log(`reprises pendant le parcours : ${found.retries}`);
    if (found.seeds.offered > 0) {
      log(`amorces : ${found.seeds.queued} retenue(s), ${found.seeds.rejected} écartée(s)`);
    }
    log(`${found.fetched} page(s) visitée(s), ${found.retained.length} fichier(s) retenu(s)`);
    plan = {
      ...(await prepareGrab({
        project,
        queue: createQueue({}),
        retained: found.retained,
        rootDir,
        // Un essai ne dépose même pas `empty.html` : il montre, il n'écrit pas.
        emptyHtml: !options.dryRun,
      })),
      pages: found.fetched,
      retained: found.retained.length,
      crawl: found,
    };
  }
  // Reprise : une tâche laissée en échec (coupure, 404 passager) redevient candidate, et une
  // tâche laissée **en cours** par un arrêt brutal (SIGKILL, coupure de courant) aussi —
  // sinon elle ne serait jamais reprise, `startNext` ne regardant que les `PENDING`
  // (`D-067`). Une reprise suppose donc qu'aucune autre exécution ne travaille dans ce
  // dossier : c'est écrit dans l'aide.
  if (resume) {
    const orphans = listOrphans(plan.queue);
    if (orphans.length > 0) {
      log(`reprise : ${orphans.length} tâche(s) interrompue(s) brutalement, remises en attente`);
    }
    plan.queue = recoverOrphans(plan.queue).queue;
    const reprise = options.totalAttempts === null
      ? { queue: retryFailed(plan.queue), exhausted: [] }
      : retryFailedCapped(plan.queue, { maxAttempts: options.totalAttempts });
    plan.queue = reprise.queue;
    if (reprise.exhausted.length > 0) {
      // Une tâche qui a déjà consommé tout son crédit d'essais n'est **pas** rejouée, et le
      // message dit pourquoi : la relancer en boucle ferait passer un site cassé pour un
      // réseau capricieux (`D-070`).
      log(`reprise : ${reprise.exhausted.length} tâche(s) au plafond d’essais cumulés, non rejouée(s)`);
      for (const task of reprise.exhausted.slice(0, 5)) {
        log(`  ${task.url} : ${task.attempts} essai(s), ${task.error ?? 'sans message'}`);
      }
    }
  }

  // Interruption tombée pendant le parcours : le plan est **enregistré** (pour `--reprendre`)
  // et rien n'est téléchargé. Sortir sans sauver laisserait un dossier à moitié écrit.
  if (signal?.aborted) {
    await saveProject(projectPath(rootDir, plan.project.name), plan.project);
    await saveQueue(rootDir, plan.queue);
    if (cookiePath !== null) await saveCookieJar(jar, cookiePath);
    log(`interrompu pendant le parcours : ${plan.queue.tasks.length} tâche(s) enregistrée(s), rien n’a été téléchargé`);
    return {
      project: plan.project,
      queue: plan.queue,
      pages: plan.pages,
      retained: plan.retained,
      done: 0,
      failed: 0,
      directory: rootDir,
      started: false,
      interrupted: true,
      stopped: plan.crawl?.stopped ?? 'interrompu',
      report: null,
      rewritten: 0,
    };
  }

  if (options.dryRun) {
    // Le plan est **montré**, pas exécuté : aucun fichier, aucun projet, aucune file.
    const tasks = plan.queue.tasks;
    log(`essai : ${plan.pages} page(s) visitée(s), ${tasks.length} fichier(s) prévu(s)`);
    for (const task of tasks.slice(0, 20)) log(`  ${task.url} → ${task.target}`);
    if (tasks.length > 20) log(`  … et ${tasks.length - 20} autre(s)`);
    if (plan.crawl?.stopped && plan.crawl.stopped !== 'épuisement') {
      log(`essai : parcours arrêté par « ${plan.crawl.stopped} »`);
    }
    const diagnostics = summarizeCrawl(plan.crawl ?? null);
    if (diagnostics && Object.keys(diagnostics.skipped).length > 0) {
      const motifs = Object.entries(diagnostics.skipped)
        .map(([reason, count]) => `${reason} × ${count}`).join(', ');
      log(`essai : liens écartés — ${motifs}`);
    }
    if (options.report) log('essai : rapport non écrit (aucune écriture en mode essai)');
    return {
      project: plan.project,
      queue: plan.queue,
      pages: plan.pages,
      retained: plan.retained,
      done: 0,
      failed: 0,
      directory: rootDir,
      started: false,
      dryRun: true,
      report: null,
      rewritten: 0,
      diagnostics: summarizeCrawl(plan.crawl ?? null),
    };
  }

  /** Réécrit le magasin après une exécution, quel qu'en soit le résultat. */
  const flushCookies = async () => {
    if (cookiePath === null) return null;
    const saved = await saveCookieJar(jar, cookiePath);
    log(`cookies : ${saved.saved} cookie(s) conservés`);
    return saved.path;
  };

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
    await flushCookies();
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

  // Les téléchargements doivent voir la même session que l'exploration, sinon un fichier
  // protégé par cookie échoue alors que la page qui le cite vient d'être lue.
  downloadOptions = {
    transport: withUserHeaders(withCookies(defaultTransport, jar)),
    ...(options.maxSize !== null ? { maxSize: options.maxSize } : {}),
    ...(options.incremental ? { incremental: true } : {}),
    ...downloadOptions,
  };

  // Espace disque (`D-067`) : refus **avant** la première connexion, avec un chiffre à
  // libérer. Les tâches de taille inconnue sont annoncées à part, jamais comptées comme zéro.
  const space = estimateSpace(plan.queue.tasks);
  const spaceCheck = await checkSpace({
    dir: rootDir,
    needed: space.remaining,
    ...(options.minSpace !== null ? { reserve: options.minSpace } : {}),
    ...(statfs ? { statfs } : {}),
  });
  if (!spaceCheck.enough) {
    log(`espace insuffisant dans ${rootDir} : ${spaceCheck.missing} octet(s) à libérer `
      + `(disponible ${spaceCheck.available}, requis ${spaceCheck.needed + spaceCheck.reserve})`);
    await saveProject(projectPath(rootDir, plan.project.name), plan.project);
    await saveQueue(rootDir, plan.queue);
    return {
      project: plan.project,
      queue: plan.queue,
      pages: plan.pages,
      retained: plan.retained,
      done: 0,
      failed: 0,
      directory: rootDir,
      started: false,
      blocked: 'espace',
      space: spaceCheck,
      report: null,
      rewritten: 0,
    };
  }
  if (space.unknown > 0) {
    log(`espace : ${space.unknown} fichier(s) de taille inconnue non comptés dans l'estimation`);
  }

  // Aspiration incrémentale (`D-070`) : une tâche `DONE` n'est pas un fait définitif, c'est
  // un fait daté. Celles dont le fichier est encore sur disque sont rouvertes et reposées au
  // serveur avec `If-Modified-Since` : `304` ⇒ fichier intact et tâche re-`DONE`, `200` ⇒
  // fichier modifié réécrit. Sans cette réouverture, une seconde aspiration ne vérifierait
  // jamais rien — les tâches étant déjà terminées, le serveur ne serait même pas interrogé.
  if (options.incremental) {
    const ids = [];
    for (const task of plan.queue.tasks) {
      if (task.state !== 'DONE') continue;
      try {
        const stats = await stat(task.target);
        if (stats.isFile() && stats.size > 0) ids.push(task.id);
      } catch {
        // Fichier disparu du disque : la tâche sera traitée comme neuve, pas re-vérifiée.
      }
    }
    const rouvertes = reopenDone(plan.queue, ids);
    plan.queue = rouvertes.queue;
    if (rouvertes.reopened.length > 0) {
      log(`incrémental : ${rouvertes.reopened.length} fichier(s) déjà présent(s) re-vérifié(s)`);
    }
  }

  // Avancement (`--progression`, `D-070`) : le rapporteur n'écrit qu'aux paliers de 10 %.
  // Il passe par `log`, donc en JSON il reste sur stderr avec le reste de la progression.
  const progress = options.progress && !runTask ? createProgressReporter(log) : null;
  const effectiveDownloadOptions = progress
    ? {
      ...downloadOptions,
      onProgress: (event) => {
        const task = progressTask;
        if (task) progress.report(task, event.done, event.total);
        if (task && Number.isFinite(event.total) && event.done >= event.total) {
          progress.finish(task, event.total);
        }
      },
    }
    : downloadOptions;
  /** Tâche en cours de téléchargement (le transport ne la connaît pas). */
  let progressTask = null;

  // Tâche d'exécution : celle du test si elle existe, sinon le téléchargement réel avec
  // les options demandées, sinon le comportement par défaut du runner.
  const effectiveRunTask = runTask
    ?? (Object.keys(effectiveDownloadOptions).length > 0
      ? (task) => {
        if (progress) progressTask = task;
        return downloadTask(task, { downloadOptions: effectiveDownloadOptions })
          .finally(() => { if (progress) progressTask = null; });
      }
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
    // Ctrl-C : on termine les tâches en vol, on n'en démarre plus (`D-066`).
    ...(signal ? { shouldStop: () => signal.aborted === true } : {}),
    // Un `304` est un succès silencieux : le dire, sinon un fichier « non téléchargé » et un
    // fichier « déjà à jour » se ressemblent dans la sortie (`D-070`).
    onEvent: (event) => {
      if (event.type === 'done' && event.result?.notModified) {
        log(`inchangé ${event.task.url} (304 : le fichier local est à jour)`);
      }
    },
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

  await flushCookies();

  // Rapport (`WP-25`) : écrit sur disque, format déduit de l'extension.
  let reportPath = null;
  if (options.report) {
    const report = buildReport({
      project: outcome.project,
      queue: outcome.queue,
      startedAt: start.getTime(),
      finishedAt: Date.now(),
      siteMap: siteMapFromEntries(plan.entries ?? []),
      crawl: plan.crawl ?? null,
    });
    reportPath = resolve(options.report);
    const format = reportPath.endsWith('.json') ? 'json'
      : reportPath.endsWith('.csv') ? 'csv'
        : /\.[ch]tml$/.test(reportPath) ? 'html' : 'markdown';
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
    interrupted: signal?.aborted === true,
    stopped: plan.crawl?.stopped ?? null,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const demandes = argv.filter((argument) => ['--aide', '-h', '--version', '-V'].includes(argument));
  const json = outputFormat(argv) === 'json' && demandes.length === 0;
  // En JSON, stdout ne contient que l'objet : la progression part sur stderr.
  const log = json ? (line) => console.error(line) : console.log;

  // Ctrl-C (`D-066`) : première interruption = arrêt coopératif (les tâches en vol finissent,
  // la file est sauvegardée) ; seconde = sortie immédiate, pour ne pas piéger l'utilisateur
  // dans une attente. `process.exit(130)` est la convention shell « tué par SIGINT ».
  const signal = { aborted: false };
  process.on('SIGINT', () => {
    if (signal.aborted) process.exit(130);
    signal.aborted = true;
    console.error('xdm-grab : interruption demandée — fin de la tâche en cours ; '
      + 'Ctrl-C à nouveau pour quitter tout de suite');
  });

  main(argv, { log, signal })
    .then((result) => {
      if (json) console.log(JSON.stringify(summarize(result)));
      if (result.interrupted) {
        process.exitCode = 130;
        console.error('xdm-grab : interrompu — la file et le projet sont à jour ; '
          + '« --reprendre » continuera');
        return;
      }
      // Code 3 = « hors fenêtre de planification » : un essai n'est pas un rendez-vous manqué,
      // et une aide ou une version encore moins.
      if (result.conforms === false) process.exitCode = 1;
      else if (result.blocked === 'espace') process.exitCode = 1;
      else if (result.started === false && result.dryRun !== true
        && result.help !== true && result.version === undefined
        && result.verify === undefined) process.exitCode = 3;
    })
    .catch((error) => {
      const message = String(error?.message ?? error).trimEnd();
      console.error(`xdm-grab : ${message}`);
      process.exit(message.startsWith('usage') ? 2 : 1);
    });
}
