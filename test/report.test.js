import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReport,
  csvField,
  formatReport,
  humanBytes,
  humanDuration,
  summarizeCrawl,
  toCsv,
  toMarkdown,
} from '../src/report.js';
import { createProject } from '../src/project.js';
import { addTask, completeTask, createQueue, beginVerification, failTask, startNext } from '../src/task-queue.js';

/** File de test : une tâche finie, une en échec, une en attente. */
function sampleQueue() {
  let queue = createQueue({});
  // `addTask` rend `{queue, task}` : la file est réaffectée à chaque ajout.
  queue = addTask(queue, { url: 'http://h/a.zip', target: '/tmp/a.zip', totalSize: 2048 }).queue;
  queue = addTask(queue, { url: 'http://h/b.zip', target: '/tmp/b.zip', totalSize: -1 }).queue;
  queue = addTask(queue, { url: 'http://h/c.zip', target: '/tmp/c.zip', totalSize: 512 }).queue;

  queue = startNext(queue).queue;
  queue = beginVerification(queue, 1);
  queue = completeTask(queue, 1);

  queue = startNext(queue).queue;
  queue = failTask(queue, 2, '404 introuvable');
  return queue;
}

test('T-B-27 : le rapport compte sans rien inventer', () => {
  const project = createProject({ name: 'h', rootUrl: 'http://h/', depth: 2 });
  const report = buildReport({
    project: { ...project, entries: [{ url: 'http://h/a.zip' }, { url: 'http://h/b.zip' }, { url: 'http://h/c.zip' }] },
    queue: sampleQueue(),
    startedAt: 1_000,
    finishedAt: 61_000,
  });

  assert.equal(report.url, 'http://h/');
  assert.equal(report.total, 3);
  assert.equal(report.done, 1);
  assert.equal(report.failed, 1);
  assert.deepEqual(report.counts, { PENDING: 1, ACTIVE: 0, PAUSED: 0, VERIFYING: 0, DONE: 1, FAILED: 1 });
  assert.deepEqual(report.bytes, { known: 2560, unknown: 1 });
  assert.equal(report.progress, 33.3);
  assert.equal(report.durationMs, 60_000);
  assert.deepEqual(report.errors, [{ url: 'http://h/b.zip', message: '404 introuvable' }]);
  assert.equal(report.entries[1].size, null, 'taille inconnue reste nulle');
});

test('T-B-27 : file vide — progression inconnue, pas 0 % ni 100 %', () => {
  const report = buildReport({ queue: createQueue({}) });
  assert.equal(report.total, 0);
  assert.equal(report.progress, null);
  assert.equal(report.durationMs, null);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.bytes, { known: 0, unknown: 0 });
});

test('T-B-27 : tentatives et reprises tracées', () => {
  const queue = sampleQueue();
  const withAttempts = {
    ...queue,
    tasks: queue.tasks.map((task) => (task.state === 'DONE' ? { ...task, attempts: 3 } : task)),
  };
  const report = buildReport({ queue: withAttempts, siteMap: { 'http://h/a.zip': 'a.zip' } });
  assert.deepEqual(report.slowest, [
    { url: 'http://h/a.zip', attempts: 3 },
    { url: 'http://h/b.zip', attempts: 1 },
  ]);
  assert.equal(report.reuses, 1, 'une URL déjà connue du plan de site');
});

test('T-B-27 : formats lisibles', () => {
  assert.equal(humanBytes(0), '0 o');
  assert.equal(humanBytes(2048), '2.0 Kio');
  assert.equal(humanBytes(1024 * 1024 * 3), '3.0 Mio');
  assert.equal(humanBytes(-1), '—');
  assert.equal(humanDuration(4_000), '4 s');
  assert.equal(humanDuration(65_000), '1 min 05 s');
  assert.equal(humanDuration(3_900_000), '1 h 05 min');
  assert.equal(csvField('simple'), 'simple');
  assert.equal(csvField('a;b'), '"a;b"');
  assert.equal(csvField('dit "oui"'), '"dit ""oui"""');
  assert.equal(csvField(null), '');
});

test('T-B-27 : export CSV — une ligne par tâche, séparateur point-virgule', () => {
  const report = buildReport({ queue: sampleQueue() });
  const csv = toCsv(report);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4, 'entête + trois tâches');
  assert.equal(lines[0], 'id;etat;url;cible;octets;tentatives;erreur');
  assert.match(lines[1], /^1;DONE;http:\/\/h\/a\.zip;/);
  assert.equal(lines[2], '2;FAILED;http://h/b.zip;/tmp/b.zip;;1;404 introuvable');
  assert.ok(csv.endsWith('\n'));
});

test('T-B-27 : export Markdown — états, échecs, tentatives', () => {
  const report = buildReport({
    project: { rootUrl: 'http://h/', entries: [{}, {}] },
    queue: sampleQueue(),
    startedAt: 0,
    finishedAt: 2_000,
  });
  const markdown = toMarkdown(report);
  assert.match(markdown, /^# Rapport d’aspiration/);
  assert.match(markdown, /- \*\*Site\*\* : http:\/\/h\//);
  assert.match(markdown, /- \*\*Tâches\*\* : 3 \(1 terminées, 1 en échec\)/);
  assert.match(markdown, /\| FAILED \| 1 \|/);
  assert.match(markdown, /## Échecs/);
  assert.match(markdown, /`http:\/\/h\/b\.zip` \| 404 introuvable/);
  assert.match(markdown, /- \*\*Durée\*\* : 2 s/);
});

test('T-B-27 : formatReport refuse un format inconnu', () => {
  const report = buildReport({ queue: sampleQueue() });
  assert.doesNotThrow(() => JSON.parse(formatReport(report, 'json')));
  assert.match(formatReport(report, 'csv'), /^id;etat/);
  assert.match(formatReport(report, 'md'), /^# Rapport/);
  assert.throws(() => formatReport(report, 'xls'), /format de rapport inconnu/);
});

test('T-B-35 : le rapport dit pourquoi un fichier manque (diagnostic d’exploration)', () => {
  const crawlResult = {
    fetched: 4,
    retained: [{ url: 'http://h/a.zip' }, { url: 'http://h/b.zip' }],
    skipped: [
      { url: 'http://h/prive/1.html', depth: 2, reason: 'élagage:*/prive/*' },
      { url: 'http://h/prive/2.html', depth: 2, reason: 'élagage:*/prive/*' },
      { url: 'http://h/secret.html', depth: 2, reason: 'robots.txt' },
      { url: 'http://autre/1.zip', depth: 3, reason: 'hors site' },
    ],
    errors: [{ url: 'http://h/p.html', status: 500 }],
    delay: 2,
    parallelisme: 3,
    stopped: 'erreurs',
  };
  const report = buildReport({ queue: { tasks: [] }, crawl: crawlResult });

  assert.equal(report.diagnostics.pagesVisited, 4);
  assert.equal(report.diagnostics.retained, 2);
  assert.equal(report.diagnostics.stopped, 'erreurs');
  assert.equal(report.diagnostics.delay, 2);
  assert.equal(report.diagnostics.parallelisme, 3);
  // Motifs ordonnés par nombre décroissant : le plus fréquent d'abord.
  assert.deepEqual(Object.entries(report.diagnostics.skipped), [
    ['élagage:*/prive/*', 2],
    ['robots.txt', 1],
    ['hors site', 1],
  ]);
  assert.deepEqual(report.diagnostics.examples['élagage:*/prive/*'],
    ['http://h/prive/1.html', 'http://h/prive/2.html']);
  assert.equal(report.diagnostics.failedPages.length, 1);

  // Sans parcours (reprise), il n'y a pas de diagnostic inventé.
  assert.equal(buildReport({ queue: { tasks: [] } }).diagnostics, null);
  assert.equal(summarizeCrawl(null), null);

  // Markdown : une section « Exploration » avec le tableau des motifs.
  const markdown = formatReport(report, 'markdown');
  assert.match(markdown, /## Exploration/);
  assert.match(markdown, /`élagage:\*\/prive\/\*`|élagage:\*\/prive\/\*/);
  assert.match(markdown, /\| robots\.txt \| 1 \|/);

  // CSV : le tableau reste importable, les motifs passent en commentaires `#`.
  const csv = formatReport(report, 'csv');
  const lines = csv.trimEnd().split('\n');
  assert.ok(lines[0].startsWith('id;etat;url'), 'entête de tableau inchangée');
  assert.ok(lines.some((line) => line.startsWith('# élagage')), 'motifs en commentaires');
});
