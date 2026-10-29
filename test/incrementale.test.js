import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { download } from '../src/connection-loop.js';
import { downloadTask, retryFailedCapped } from '../src/grab-runner.js';
import { parseHeaderOption } from '../src/headers.js';
import { createProgressReporter, defaultLabel, formatProgress } from '../src/progress.js';
import { addTask, createQueue } from '../src/task-queue.js';
import { main } from '../bin/xdm-grab.js';
import { main as mainXdm, parseArgs as parseXdmArgs } from '../bin/xdm.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-inc-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Serveur conditionnel : il répond `304` si le client envoie un `If-Modified-Since` postérieur
 * à `lastModified`, `200` sinon. Il journalise les en-têtes reçus, ce qui permet de vérifier
 * que `--entete` part **aussi** avec les morceaux.
 */
async function startConditionalSite({ lastModified = new Date('2026-01-01T00:00:00Z'), body = null } = {}) {
  const content = body ?? Buffer.from('contenu distant v1');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url === '/robots.txt') {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    if (req.url === '/') {
      const page = Buffer.from('<a href="/f/doc.bin">d</a>');
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(page.length) });
      res.end(page);
      return;
    }
    if (req.headers['x-secret'] !== 'sesame') {
      res.writeHead(401, { 'content-length': '0' });
      res.end();
      return;
    }
    const since = req.headers['if-modified-since'];
    if (since && new Date(since).getTime() >= lastModified.getTime()) {
      res.writeHead(304, { 'last-modified': lastModified.toUTCString() });
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), content.length - 1);
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${content.length}`,
        'content-length': String(end - start + 1),
        'last-modified': lastModified.toUTCString(),
      });
      res.end(content.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'content-length': String(content.length),
      'last-modified': lastModified.toUTCString(),
      'accept-ranges': 'bytes',
    });
    res.end(content);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('T-A-28 : les en-têtes de l’appelant partent avec la sonde **et** les morceaux', async () => {
  const site = await startConditionalSite();
  await withTempDir(async (dir) => {
    try {
      // Sans en-tête : 401 sur la sonde, donc échec explicite.
      await assert.rejects(
        () => download(`${site.origin}/f/doc.bin`, join(dir, 'a.bin'), { connections: 1, promote: true }),
        (error) => error.code === 'HTTP_STATUS' && error.details.status === 401,
      );

      site.requests.length = 0;
      const result = await download(`${site.origin}/f/doc.bin`, join(dir, 'b.bin'), {
        connections: 2,
        promote: true,
        headers: { 'x-secret': 'sesame' },
      });
      assert.equal(result.size, Buffer.byteLength('contenu distant v1'));
      assert.equal(await readFile(join(dir, 'b.bin'), 'utf8'), 'contenu distant v1');
      // Toutes les requêtes de données portent l'en-tête, pas seulement la première.
      const data = site.requests.filter((entry) => entry.url === '/f/doc.bin');
      assert.ok(data.length >= 2, `requêtes de données : ${data.length}`);
      assert.ok(data.every((entry) => entry.headers['x-secret'] === 'sesame'),
        'un morceau sans en-tête laisserait une sonde autorisée et des plages refusées');
    } finally {
      await site.close();
    }
  });
});

test('T-A-28 : un `304` laisse le fichier intact et n’est pas une erreur', async () => {
  const site = await startConditionalSite();
  await withTempDir(async (dir) => {
    const target = join(dir, 'doc.bin');
    try {
      await writeFile(target, 'contenu local déjà là');
      const before = await stat(target);

      const result = await download(`${site.origin}/f/doc.bin`, target, {
        connections: 1,
        promote: true,
        headers: { 'x-secret': 'sesame' },
        ifModifiedSince: Date.now(),
      });
      assert.equal(result.notModified, true);
      assert.equal(await readFile(target, 'utf8'), 'contenu local déjà là', 'fichier préservé');
      assert.equal((await stat(target)).mtimeMs, before.mtimeMs, 'même date de modification');

      // Sans condition, le fichier est bien réécrit.
      const changed = await download(`${site.origin}/f/doc.bin`, target, {
        connections: 1, promote: true, headers: { 'x-secret': 'sesame' },
      });
      assert.equal(changed.notModified, undefined);
      assert.equal(await readFile(target, 'utf8'), 'contenu distant v1');
    } finally {
      await site.close();
    }
  });
});

test('T-B-45 : `--incremental` ne retélécharge pas un fichier à jour', async () => {
  const site = await startConditionalSite();
  await withTempDir(async (dir) => {
    try {
      // Première passe : le fichier arrive.
      const premier = await main(
        [`${site.origin}/`, dir, '--entete', 'X-Secret: sesame'], { log: () => {} },
      );
      assert.equal(premier.done, 1);
      const target = join(dir, 'f', 'doc.bin');
      assert.equal(await readFile(target, 'utf8'), 'contenu distant v1');
      await utimes(target, new Date(), new Date('2026-06-01T00:00:00Z'));

      const lignes = [];
      // Seconde passe incrémentale sur le même dossier : le serveur répond 304.
      const second = await main(
        [`${site.origin}/`, dir, '--entete', 'X-Secret: sesame', '--incremental'],
        { log: (line) => lignes.push(line) },
      );
      assert.equal(second.failed, 0, 'un 304 est un succès');
      assert.equal(second.done, 1);
      assert.equal(await readFile(target, 'utf8'), 'contenu distant v1');
      assert.ok(lignes.some((line) => line.includes('inchangé')), lignes.join('\n'));

      // Avec `--reprendre`, la file sur disque fait foi : les tâches `DONE` seraient
      // normalement ignorées. `--incremental` les rouvre pour reposer la question au serveur.
      const reprises = [];
      const troisieme = await main(
        [`${site.origin}/`, dir, '--reprendre', '--incremental', '--entete', 'X-Secret: sesame'],
        { log: (line) => reprises.push(line) },
      );
      assert.equal(troisieme.failed, 0);
      assert.ok(reprises.some((line) => line.includes('re-vérifié')), reprises.join('\n'));
      assert.ok(reprises.some((line) => line.includes('inchangé')), reprises.join('\n'));
      assert.equal(await readFile(target, 'utf8'), 'contenu distant v1');
    } finally {
      await site.close();
    }
  });
});

test('T-B-46 : `--tentatives-total` arrête de rejouer une tâche épuisée', () => {
  let queue = createQueue({});
  queue = addTask(queue, { url: 'http://h/a.bin', target: '/t/a.bin' }).queue;
  queue = addTask(queue, { url: 'http://h/b.bin', target: '/t/b.bin' }).queue;
  queue = {
    ...queue,
    tasks: [
      { ...queue.tasks[0], state: 'FAILED', attempts: 3, error: 'HTTP 500' },
      { ...queue.tasks[1], state: 'FAILED', attempts: 1, error: 'HTTP 503' },
    ],
  };

  const { queue: relevee, revived, exhausted } = retryFailedCapped(queue, { maxAttempts: 3 });
  assert.deepEqual(revived.map((task) => task.id), [2]);
  assert.deepEqual(exhausted.map((task) => [task.id, task.attempts, task.error]), [[1, 3, 'HTTP 500']]);
  assert.deepEqual(relevee.tasks.map((task) => task.state), ['FAILED', 'PENDING'],
    'la tâche épuisée reste en échec, avec son message');
  assert.equal(relevee.tasks[0].error, 'HTTP 500');

  // Tout ce qui n'est pas `FAILED` est ignoré : la fonction ne touche pas au reste.
  const saine = createQueue({});
  assert.deepEqual(retryFailedCapped(saine, { maxAttempts: 2 }),
    { queue: saine, revived: [], exhausted: [] });
  assert.throws(() => retryFailedCapped(saine, { maxAttempts: 0 }), /maxAttempts/);
});

test('T-B-46 : la CLI annonce les tâches au plafond d’essais', async () => {
  const site = await startConditionalSite();
  await withTempDir(async (dir) => {
    try {
      await main([`${site.origin}/`, dir, '--entete', 'X-Secret: sesame'], { log: () => {} });
      // On simule une tâche déjà échouée trois fois.
      const { loadQueue, saveQueue } = await import('../src/task-queue.js');
      const queue = await loadQueue(dir);
      const edited = {
        ...queue,
        tasks: queue.tasks.map((task) => ({ ...task, state: 'FAILED', attempts: 3, error: 'HTTP 500' })),
      };
      await saveQueue(dir, edited);

      const lignes = [];
      const result = await main(
        [`${site.origin}/`, dir, '--reprendre', '--tentatives-total', '3', '--entete', 'X-Secret: sesame'],
        { log: (line) => lignes.push(line) },
      );
      assert.equal(result.done, 0, 'rien n’est rejoué');
      assert.equal(result.failed, 1);
      assert.ok(lignes.some((line) => line.includes('plafond d’essais cumulés')), lignes.join('\n'));
    } finally {
      await site.close();
    }
  });
});

test('T-B-47 : avancement par paliers, sans inonder la sortie', () => {
  assert.equal(formatProgress({ label: 'a.zip', done: 512, total: 1024 }), 'a.zip :  50 %  512 o / 1.0 Kio');
  assert.equal(formatProgress({ label: 'b.bin', done: 512, total: null }),
    'b.bin : en cours, 512 o (taille inconnue)', 'taille inconnue ⇒ ni 0 % ni 100 %');
  assert.equal(formatProgress({ label: 'c', done: 0, total: 0 }), 'c : en cours, 0 o (taille inconnue)');
  assert.throws(() => formatProgress({ label: '', done: 1, total: 2 }), /label/);

  const lines = [];
  const reporter = createProgressReporter((line) => lines.push(line));
  const task = { id: 7, target: '/dl/sous/archive.zip' };
  assert.equal(defaultLabel(task), 'archive.zip');
  for (let done = 0; done <= 1000; done += 25) reporter.report(task, done, 1000);
  reporter.finish(task, 1000);
  assert.ok(lines.length <= 12, `paliers attendus (≤ 12), obtenus ${lines.length}`);
  assert.ok(lines.every((line) => line.startsWith('archive.zip')));
  assert.match(lines.at(-1), /100 %/);
  assert.equal(reporter.lines(), lines.length);

  // Taille inconnue : un seul message par tâche, puis silence.
  const muettes = [];
  const autre = createProgressReporter((line) => muettes.push(line));
  for (let i = 0; i < 5; i += 1) autre.report({ id: 9, target: '/x/f.bin' }, 100 * i, null);
  assert.equal(muettes.length, 1);
  autre.finish({ id: 9, target: '/x/f.bin' }, null);
  assert.equal(muettes.length, 1, 'rien à annoncer pour une taille inconnue');

  assert.throws(() => createProgressReporter(null), /log/);
  assert.throws(() => createProgressReporter(() => {}, { step: 0 }), /step/);
});

test('T-B-48 : `--verifier --sortie json` donne un audit consommable', async () => {
  await withTempDir(async (dir) => {
    let queue = createQueue({});
    queue = addTask(queue, { url: 'http://h/a.bin', target: join(dir, 'a.bin'), totalSize: 4 }).queue;
    queue = addTask(queue, { url: 'http://h/b.bin', target: join(dir, 'b.bin'), totalSize: 4 }).queue;
    queue = { ...queue, tasks: queue.tasks.map((task) => ({ ...task, state: 'DONE' })) };
    await writeFile(join(dir, 'a.bin'), 'AAAA');
    const { saveQueue } = await import('../src/task-queue.js');
    await saveQueue(dir, queue);

    const lignes = [];
    const result = await main(['http://h/', dir, '--verifier'], { log: (line) => lignes.push(line) });
    const { summarize } = await import('../bin/xdm-grab.js');
    const summary = summarize(result);
    assert.equal(summary.conforms, false);
    assert.deepEqual(summary.verify.missing, ['b.bin']);
    assert.deepEqual(summary.verify.truncated, []);
    assert.equal(summary.verify.ok, 1);
    assert.equal(summary.verify.checked, 2);
    assert.equal(summary.tasks, 2);

    // Les clés existent aussi en JSON via la CLI réelle.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const cli = fileURLToPath(new URL('../bin/xdm-grab.js', import.meta.url));
    const run = promisify(execFile)(process.execPath, [cli, 'http://h/', dir, '--verifier', '--sortie', 'json'], { encoding: 'utf8' })
      .catch((error) => ({ stdout: error.stdout }));
    const { stdout } = await run;
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.conforms, false);
    assert.deepEqual(parsed.verify.missing, ['b.bin']);
  });
});

test('T-C-22 : `xdm --entete` et `--incremental`', async () => {
  const site = await startConditionalSite();
  await withTempDir(async (dir) => {
    try {
      // Sans en-tête : 401 explicite, sans fichier écrit.
      await assert.rejects(
        () => mainXdm([`${site.origin}/f/doc.bin`, dir], { log: () => {} }),
        /statut 401/,
      );

      const premier = await mainXdm(
        [`${site.origin}/f/doc.bin`, dir, '--entete', 'X-Secret: sesame'],
        { log: () => {} },
      );
      assert.equal(await readFile(join(dir, 'doc.bin'), 'utf8'), 'contenu distant v1');
      assert.equal(premier.size, Buffer.byteLength('contenu distant v1'));

      // Le fichier local est daté après le serveur : `304`, et la CLI le dit.
      const lignes = [];
      const target = join(dir, 'doc.bin');
      await utimes(target, new Date(), new Date('2026-06-01T00:00:00Z'));
      const second = await mainXdm(
        [`${site.origin}/f/doc.bin`, dir, '--entete', 'X-Secret: sesame', '--incremental'],
        { log: (line) => lignes.push(line) },
      );
      assert.equal(second.notModified, true);
      assert.equal(second.size, null);
      assert.ok(lignes.some((line) => line.startsWith('inchangé')), lignes.join('\n'));
      assert.equal(await readFile(target, 'utf8'), 'contenu distant v1');

      assert.equal(parseXdmArgs(['http://h/f', '--entete', 'A: b']).headers.a, 'b');
      assert.throws(() => parseHeaderOption('X: a\nB: c'), /retour à la ligne/);
    } finally {
      await site.close();
    }
  });
});
