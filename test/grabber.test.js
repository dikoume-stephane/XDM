import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EMPTY_HTML,
  EMPTY_HTML_NAME,
  INDEX_NAME,
  buildSiteMap,
  disambiguate,
  enqueueEntries,
  localPathFor,
  planGrab,
  prepareGrab,
  writeEmptyHtml,
} from '../src/grabber.js';
import { createProject, createQueue, loadProject, saveProject, projectPath } from '../src/index.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-grabber-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('T-B-11 : l’arborescence locale reproduit celle du site', () => {
  assert.equal(localPathFor('http://h/', 'http://h/a/b/c.zip'), 'a/b/c.zip');
  assert.equal(localPathFor('http://h/index.html', 'http://h/docs/x.pdf'), 'docs/x.pdf');
  assert.equal(localPathFor('http://h/site/', 'http://h/site/a/b.zip'), 'a/b.zip');
  assert.equal(localPathFor('http://h/', 'http://h/docs/'), `docs/${INDEX_NAME}`);
  assert.equal(localPathFor('http://h/', 'http://h/'), INDEX_NAME);
  assert.equal(localPathFor('http://h/', 'http://h/a%20b/c%20d.txt'), 'a b/c d.txt');
  assert.equal(localPathFor('http://h/', 'http://h/a?x=1'), 'a');
  // Hors du site : pas de chemin local.
  assert.equal(localPathFor('http://h/', 'http://autre/x'), null);
  assert.equal(localPathFor('http://h/', 'pas une url'), null);
  // Un segment dangereux ne peut pas sortir du dossier cible.
  const escaped = localPathFor('http://h/', 'http://h/../../etc/passwd');
  assert.equal(escaped.includes('..'), false);
  assert.equal(disambiguate('a/b/c.zip', 2), 'a/b/c-2.zip');
  assert.equal(disambiguate('index.html', 2), 'index-2.html');
});

test('T-B-11 (suite) : collisions de chemin départagées, ordre déterministe', () => {
  const { entries, collisions, skipped } = buildSiteMap('http://h/', [
    { url: 'http://h/a', depth: 1 },
    { url: 'http://h/a?x=1', depth: 1 },
    { url: 'http://h/a', depth: 1 },
    { url: 'http://autre/b', depth: 1 },
  ]);
  assert.deepEqual(entries.map((e) => [e.url, e.localPath]), [
    ['http://h/a', 'a'],
    ['http://h/a?x=1', 'a-2'],
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].withUrl, 'http://h/a');
  assert.deepEqual(skipped, [{ url: 'http://autre/b', raison: 'hors du site' }]);
  assert.deepEqual(buildSiteMap('http://h/', []), { entries: [], collisions: [], skipped: [] });
});

test('T-B-06 : une entrée porte les six champs observés', () => {
  const project = createProject({ name: 'site', rootUrl: 'http://h/' });
  const { entries } = buildSiteMap('http://h/', [{ url: 'http://h/a/b.zip', depth: 2 }]);
  const result = planGrab(project, entries);
  const entry = result.project.entries.at(-1);
  assert.equal(entry.url, 'http://h/a/b.zip');
  assert.equal(entry.localPath, 'a/b.zip');
  assert.equal(entry.localFileName, 'b.zip');
  assert.equal(entry.expectedSize, -1);
  assert.equal(entry.etat, 'en-attente');
  assert.equal(entry.log, '');
  // Idempotence : replanifier ne duplique pas.
  const again = planGrab(result.project, entries);
  assert.equal(again.added.length, 0);
  assert.deepEqual(again.alreadyPresent, ['http://h/a/b.zip']);
});

test('T-B-10 : chaque entrée devient une tâche de téléchargement ordinaire', () => {
  const queue = createQueue({});
  const { entries } = buildSiteMap('http://h/', [
    { url: 'http://h/a.zip' },
    { url: 'http://h/docs/b.pdf' },
  ]);
  const { queue: next, tasks } = enqueueEntries(queue, entries, '/tmp/site');
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.target), [
    join('/tmp/site', 'a.zip'),
    join('/tmp/site', 'docs/b.pdf'),
  ]);
  assert.ok(tasks.every((t) => t.state === 'PENDING'));
  assert.ok(tasks.every((t) => t.totalSize === -1));
  assert.deepEqual(next.tasks.map((t) => t.id), tasks.map((t) => t.id));
  assert.throws(() => enqueueEntries(queue, entries, ''), /rootDir/);
});

test('T-B-12 : `empty.html` — contenu exact, jamais écrasé', async () => {
  await withTempDir(async (dir) => {
    const first = await writeEmptyHtml(dir);
    assert.equal(first.path, join(dir, EMPTY_HTML_NAME));
    assert.equal(first.written, true);
    assert.equal(await readFile(first.path, 'utf8'), EMPTY_HTML);
    assert.equal(EMPTY_HTML, '<HTML><BODY> </BODY></HTML>');

    await writeFile(first.path, 'contenu utilisateur', 'utf8');
    const second = await writeEmptyHtml(dir);
    assert.equal(second.written, false);
    assert.equal(await readFile(first.path, 'utf8'), 'contenu utilisateur');
    assert.deepEqual((await readdir(dir)).sort(), [EMPTY_HTML_NAME]);
  });
});

test('T-B-01 : le projet reste un seul artefact, reprise possible ailleurs', async () => {
  await withTempDir(async (dir) => {
    const project = createProject({ name: 'site', rootUrl: 'http://h/' });
    const { entries } = buildSiteMap('http://h/', [{ url: 'http://h/a.zip' }]);
    const planned = planGrab(project, entries).project;

    const path = projectPath(dir, 'site');
    await saveProject(path, planned);
    assert.deepEqual((await readdir(dir)).sort(), ['site.xdmspider.json']);

    const reloaded = await loadProject(path);
    assert.deepEqual(reloaded.entries, planned.entries);
    assert.equal(reloaded.rootUrl, 'http://h/');
    // L'artefact suffit : aucune autre donnée n'est nécessaire pour reprendre.
    const { queue } = enqueueEntries(createQueue({}), reloaded.entries.map((e) => ({
      url: e.url,
      localPath: e.localPath,
    })), join(dir, 'sortie'));
    assert.equal(queue.tasks.length, 1);
  });
});

test('T-B-10 (chaîne) : plan complet — projet, file et dossier prêts', async () => {
  await withTempDir(async (dir) => {
    const project = createProject({ name: 'site', rootUrl: 'http://h/' });
    const queue = createQueue({ maxActive: 2 });
    const retained = [
      { url: 'http://h/a.zip', depth: 1 },
      { url: 'http://h/docs/b.pdf', depth: 2 },
      { url: 'http://autre/c.zip', depth: 2 },
    ];
    const result = await prepareGrab({ project, queue, retained, rootDir: dir });

    assert.equal(result.tasks.length, 2);
    assert.equal(result.project.entries.length, 2);
    assert.deepEqual(result.skipped, [{ url: 'http://autre/c.zip', raison: 'hors du site' }]);
    assert.equal(result.emptyHtml?.written, true);
    assert.equal(await readFile(join(dir, EMPTY_HTML_NAME), 'utf8'), EMPTY_HTML);
    assert.deepEqual(result.queue.tasks.map((t) => t.target), [
      join(dir, 'a.zip'),
      join(dir, 'docs/b.pdf'),
    ]);
    // Sans `emptyHtml`, le dossier n'est pas marqué.
    const bare = await prepareGrab({ project, queue, retained, rootDir: join(dir, 'bis'), emptyHtml: false });
    assert.equal(bare.emptyHtml, null);
  });
});
