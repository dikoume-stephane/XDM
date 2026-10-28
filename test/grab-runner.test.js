import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CONCURRENCY,
  downloadTask,
  executeGrab,
  runQueue,
} from '../src/grab-runner.js';
import { createProject, createQueue, addTask, loadProject, loadQueue } from '../src/index.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-runner-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function queueOf(entries) {
  let queue = createQueue({});
  for (const entry of entries) {
    queue = addTask(queue, entry).queue;
  }
  return queue;
}

test('T-A-07 : la concurrence demandée est respectée, les états suivent', async () => {
  const queue = queueOf([
    { url: 'http://h/1', target: '/tmp/1' },
    { url: 'http://h/2', target: '/tmp/2' },
    { url: 'http://h/3', target: '/tmp/3' },
  ]);

  let active = 0;
  let peak = 0;
  const events = [];
  const outcome = await runQueue(queue, {
    concurrency: 2,
    onEvent: (event) => events.push(event.type),
    runTask: async (task) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { target: task.target, size: 10 };
    },
  });

  assert.equal(peak, 2);
  assert.deepEqual(outcome.stats.counts, {
    PENDING: 0,
    ACTIVE: 0,
    PAUSED: 0,
    VERIFYING: 0,
    DONE: 3,
    FAILED: 0,
  });
  assert.equal(outcome.results.length, 3);
  assert.equal(events.filter((e) => e === 'start').length, 3);
  assert.equal(events.filter((e) => e === 'done').length, 3);
  assert.equal(DEFAULT_CONCURRENCY, 8);
});

test('T-A-22 : une tâche en échec n’arrête pas les autres', async () => {
  const queue = queueOf([
    { url: 'http://h/ok1', target: '/tmp/a' },
    { url: 'http://h/ko', target: '/tmp/b' },
    { url: 'http://h/ok2', target: '/tmp/c' },
  ]);

  const outcome = await runQueue(queue, {
    concurrency: 1,
    runTask: async (task) => {
      if (task.url.endsWith('/ko')) throw new Error('serveur muet');
      return { target: task.target, size: 1 };
    },
  });

  assert.equal(outcome.stats.counts.DONE, 2);
  assert.equal(outcome.stats.counts.FAILED, 1);
  assert.deepEqual(outcome.failures, [
    { id: 2, url: 'http://h/ko', error: 'serveur muet' },
  ]);
  const failed = outcome.queue.tasks.find((t) => t.id === 2);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error, 'serveur muet');
  // Une tâche échouée peut repartir : la transition FAILED → PENDING existe.
  assert.deepEqual(outcome.queue.tasks.map((t) => t.state), ['DONE', 'FAILED', 'DONE']);
});

test('T-A-22 (suite) : arguments invalides refusés', async () => {
  const queue = createQueue({});
  await assert.rejects(() => runQueue(queue, { runTask: null }), /runTask/);
  await assert.rejects(() => runQueue(queue, { concurrency: 0 }), /concurrence/);
});

test('T-B-10 : une entrée aspirée se télécharge et se promeut réellement', async () => {
  const body = Buffer.alloc(700);
  for (let i = 0; i < body.length; i += 1) body[i] = i % 251;

  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) {
      res.writeHead(416);
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(end - start + 1),
    });
    res.end(Buffer.from(body.subarray(start, end + 1)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  await withTempDir(async (dir) => {
    const target = join(dir, 'site', 'fichier.bin');
    const queue = queueOf([{ url: `http://127.0.0.1:${port}/f`, target }]);
    try {
      const outcome = await runQueue(queue, {
        runTask: (task) => downloadTask(task, { downloadOptions: { chunkSize: 256, connections: 2 } }),
      });
      assert.equal(outcome.stats.counts.DONE, 1);
      assert.equal(outcome.results[0].size, 700);
      assert.deepEqual(await readFile(target), body);
      // Le fichier de travail et la carte ont disparu avec la promotion.
      await assert.rejects(() => readFile(`${target}.xdm-part`), /ENOENT/);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('T-B-01 : exécution complète — projet et file persistés, états des entrées à jour', async () => {
  await withTempDir(async (dir) => {
    const project = createProject({ name: 'site', rootUrl: 'http://h/' });
    const withEntries = {
      ...project,
      entries: [
        { url: 'http://h/a.zip', localPath: 'a.zip', localFileName: 'a.zip', expectedSize: -1, etat: 'en-attente', log: '' },
        { url: 'http://h/b.zip', localPath: 'b.zip', localFileName: 'b.zip', expectedSize: -1, etat: 'en-attente', log: '' },
      ],
    };
    const queue = queueOf([
      { url: 'http://h/a.zip', target: join(dir, 'a.zip') },
      { url: 'http://h/b.zip', target: join(dir, 'b.zip') },
    ]);

    const outcome = await executeGrab({
      project: withEntries,
      queue,
      projectPath: join(dir, 'site.xdmspider.json'),
      queueDir: dir,
      runTask: async (task) => {
        if (task.url.endsWith('b.zip')) throw new Error('404');
        return { target: task.target, size: 12 };
      },
    });

    assert.equal(outcome.stats.counts.DONE, 1);
    assert.equal(outcome.stats.counts.FAILED, 1);
    assert.deepEqual(outcome.project.entries.map((e) => e.etat), ['termine', 'echec']);
    assert.equal(outcome.project.entries[1].log, '404');

    const reloadedProject = await loadProject(outcome.saved.project);
    assert.deepEqual(reloadedProject.entries.map((e) => e.etat), ['termine', 'echec']);

    const reloadedQueue = await loadQueue(dir);
    assert.deepEqual(reloadedQueue.tasks.map((t) => t.state), ['DONE', 'FAILED']);

    // Les fichiers persistés sont bien sur le disque.
    const raw = await readFile(join(dir, 'site.xdmspider.json'), 'utf8');
    assert.match(raw, /"termine"/);
    await writeFile(join(dir, 'sentinelle'), 'ok');
  });
});
