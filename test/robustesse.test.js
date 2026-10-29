import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkSpace, estimateSpace, freeSpace, nearestExisting } from '../src/diskspace.js';
import { SIZE_UNITS, parseSize } from '../src/size.js';
import { isToolFile, verifyGrab, walkTree } from '../src/verify.js';
import { DownloadError, download } from '../src/connection-loop.js';
import { main } from '../bin/xdm-grab.js';
import { buildReport, escapeHtml, formatReport, toHtml } from '../src/report.js';
import { addTask, createQueue, saveQueue } from '../src/task-queue.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-rob-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Site qui annonce et sert `size` octets pour n'importe quel fichier. */
async function startSite(size = 4096) {
  const body = Buffer.alloc(size, 7);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/robots.txt') {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    if (req.url === '/') {
      const page = Buffer.from('<a href="/gros.bin">g</a>');
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(page.length) });
      res.end(page);
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' });
    res.end(body);
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

test('T-B-41 : `--taille-max` refuse après la sonde, sans écrire un octet', async () => {
  // Lecture des tailles : unités binaires, virgule décimale, refus explicites.
  assert.equal(parseSize('1K'), 1024);
  assert.equal(parseSize('1,5 Mio'), 1572864);
  assert.equal(parseSize('2G'), 2 * 1024 ** 3);
  assert.equal(parseSize('512'), 512);
  assert.equal(SIZE_UNITS.k, 1024, 'K vaut 1024, jamais 1000');
  for (const bad of ['', '4 X', '-1', 'abc', 1.5]) {
    assert.throws(() => parseSize(bad), RangeError, String(bad));
  }

  const site = await startSite(4096);
  await withTempDir(async (dir) => {
    try {
      const target = join(dir, 'gros.bin');
      await assert.rejects(
        () => download(`${site.origin}/gros.bin`, target, { connections: 1, maxSize: 1000 }),
        (error) => error instanceof DownloadError
          && error.code === 'TOO_LARGE'
          && error.details.size === 4096
          && error.details.maxSize === 1000,
      );
      await assert.rejects(() => readFile(target), /ENOENT/, 'aucun fichier partiel écrit');

      // Sous le plafond, le téléchargement a lieu normalement.
      const ok = await download(`${site.origin}/gros.bin`, target, { connections: 2, maxSize: 4096 });
      assert.equal(ok.size, 4096);
    } finally {
      await site.close();
    }
  });
});

test('T-B-41 : la CLI traduit `--taille-max` et échoue proprement la tâche', async () => {
  const site = await startSite(4096);
  await withTempDir(async (dir) => {
    const lignes = [];
    try {
      const result = await main([`${site.origin}/`, dir, '--taille-max', '2K'],
        { log: (line) => lignes.push(line) });
      assert.equal(result.done, 0);
      assert.equal(result.failed, 1, 'la tâche est en échec, avec une raison lisible');
      assert.ok(lignes.some((line) => /fichier trop volumineux/.test(line)), lignes.join('\n'));
    } finally {
      await site.close();
    }
  });
});

test('T-B-42 : espace disque vérifié avant la première connexion', async () => {
  assert.equal(estimateSpace([{ totalSize: 100, state: 'PENDING' }]).remaining, 100);
  assert.equal(estimateSpace([{ totalSize: 100, state: 'DONE' }]).remaining, 0,
    'un fichier déjà terminé ne réclame plus de place');
  assert.deepEqual(estimateSpace([{ totalSize: -1, state: 'PENDING' }, { totalSize: 0, state: 'PENDING' }]),
    { known: 0, unknown: 2, remaining: 0 });
  assert.deepEqual(estimateSpace(null), { known: 0, unknown: 0, remaining: 0 });

  // `statfs` factice : 1 Mio disponible sur un volume de 100 Mio.
  const fake = async () => ({ bsize: 4096, blocks: (100 * 1024 * 1024) / 4096, bavail: 256 });
  // Volume de 100 Mio, 1 Mio libre : la réserve par défaut (64 Mio) ne tient pas — c'est
  // précisément ce qu'on veut refuser, avant d'écrire. Sans réserve, 1 000 octets tiennent.
  const roomy = await checkSpace({ dir: '/tmp', needed: 1000, reserve: 0, statfs: fake });
  assert.equal(roomy.enough, true);
  assert.equal(roomy.available, 256 * 4096);
  const reserveDefault = await checkSpace({ dir: '/tmp', needed: 1000, statfs: fake });
  assert.equal(reserveDefault.enough, false, 'la réserve par défaut protège le système');

  const tight = await checkSpace({ dir: '/tmp', needed: 900_000, statfs: fake });
  assert.equal(tight.enough, false);
  assert.ok(tight.missing > 0, 'le message doit dire combien libérer');
  assert.equal(tight.available - (tight.needed + tight.reserve) + tight.missing, 0);

  // « bavail » (et non « bfree ») : ce qui reste réellement inscriptible.
  const reserveCapped = await checkSpace({ dir: '/tmp', needed: 0, reserve: 10 ** 9, statfs: fake });
  assert.equal(reserveCapped.reserve, 50 * 1024 * 1024, 'réserve bornée à la moitié du volume');
  await assert.rejects(() => checkSpace({ dir: '/tmp', needed: -1 }), RangeError);

  // Le vrai système : `/tmp` existe, un chemin absent remonte au parent existant.
  assert.ok((await freeSpace(tmpdir())).available > 0);
  assert.equal(await nearestExisting(join(tmpdir(), 'absent', 'encore')), tmpdir());

  // La CLI refuse **avant** de demander le fichier.
  const site = await startSite(4096);
  await withTempDir(async (dir) => {
    const lignes = [];
    try {
      const result = await main([`${site.origin}/`, dir], {
        log: (line) => lignes.push(line),
        statfs: async () => ({ bsize: 4096, blocks: 256, bavail: 1 }),
      });
      assert.equal(result.blocked, 'espace');
      assert.equal(result.done, 0);
      assert.ok(lignes.some((line) => line.startsWith('espace insuffisant')));
      assert.ok(!site.requests.includes('/gros.bin'), 'aucune requête de fichier');
      // Le projet et la file sont écrits : l'aspiration est planifiée, pas perdue.
      const queue = JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8'));
      assert.deepEqual(queue.tasks.map((task) => task.state), ['PENDING']);
    } finally {
      await site.close();
    }
  });
});

test('T-B-43 : `--verifier` compare la file au disque, sans réseau', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'sous'), { recursive: true });
    await writeFile(join(dir, 'a.bin'), 'AAAA');
    await writeFile(join(dir, 'sous', 'b.bin'), 'BB');        // doit être 3 octets
    await writeFile(join(dir, 'sous', 'inattendu.txt'), 'X');
    await writeFile(join(dir, 'empty.html'), '<HTML><BODY> </BODY></HTML>');

    let queue = createQueue({});
    queue = addTask(queue, { url: 'http://h/a.bin', target: join(dir, 'a.bin'), totalSize: 4 }).queue;
    queue = addTask(queue, { url: 'http://h/sous/b.bin', target: join(dir, 'sous', 'b.bin'), totalSize: 3 }).queue;
    queue = addTask(queue, { url: 'http://h/perdu.zip', target: join(dir, 'perdu.zip'), totalSize: 10 }).queue;
    queue = addTask(queue, { url: 'http://h/attente.zip', target: join(dir, 'attente.zip'), totalSize: 10 }).queue;
    // Deux tâches sont `DONE` (l'une manque, l'autre est tronquée) : c'est l'écart à trouver.
    queue = {
      ...queue,
      tasks: queue.tasks.map((task, index) => (index < 3 ? { ...task, state: 'DONE' } : task)),
    };
    await saveQueue(dir, queue);

    const result = await verifyGrab({ rootDir: dir, tasks: queue.tasks });
    assert.equal(result.checked, 4);
    assert.equal(result.ok, 1, 'seul a.bin est conforme');
    assert.deepEqual(result.missing.map((item) => item.path), ['perdu.zip']);
    assert.deepEqual(result.truncated.map((item) => [item.path, item.expected, item.found]),
      [['sous/b.bin', 3, 2]]);
    assert.deepEqual(result.absent.map((item) => item.path), ['attente.zip']);
    assert.deepEqual(result.unmanaged.map((item) => item.path), ['sous/inattendu.txt'],
      'les fichiers de l’outil (empty.html) ne sont pas « hors file »');
    assert.equal(result.ok_, false);
    assert.equal(result.totalBytes, 27);
    assert.equal(result.diskBytes, 6);

    // `walkTree` et le filtre des fichiers de l'outil.
    const tree = await walkTree(dir);
    assert.ok(tree.files.has('a.bin'));
    assert.equal(tree.dirs, 1);
    for (const tool of ['queue.json', 'empty.html', 'h.xdmspider.json', 'a.bin.xdm-part', 'a.bin.xdm-part.json']) {
      assert.equal(isToolFile(tool), true, tool);
    }
    assert.equal(isToolFile('sous/b.bin'), false);

    // Un dossier absent n'est pas une exception : tout ce qu'on y attend est « manquant »,
    // et le dossier illisible est signalé plutôt que masqué.
    const dansAbsent = addTask(createQueue({}), {
      url: 'http://h/x.bin', target: join(dir, 'absent', 'x.bin'), totalSize: 5,
    }).queue;
    dansAbsent.tasks[0].state = 'DONE';
    const vide = await verifyGrab({ rootDir: join(dir, 'absent'), tasks: dansAbsent.tasks });
    assert.deepEqual(vide.missing.map((item) => item.path), ['x.bin']);
    // Le dossier absent est **signalé** : on ne peut pas affirmer « conforme » sur un
    // arbre qu'on n'a pas pu lire, et `ok_` reste donc faux.
    assert.equal(vide.errors.length, 1);
    assert.match(vide.errors[0].message, /ENOENT/);
    assert.equal(vide.ok_, false);

    // Un cible hors de la racine est rendue telle quelle, en relatif : le rapport ne ment pas.
    const dehors = await verifyGrab({ rootDir: join(dir, 'absent'), tasks: queue.tasks.slice(0, 1) });
    assert.deepEqual(dehors.missing.map((item) => item.path), ['../a.bin']);
  });
});

test('T-B-43 : la CLI `--verifier` sort en code 1 sur écart, sans rien écrire', async () => {
  await withTempDir(async (dir) => {
    let queue = createQueue({});
    queue = addTask(queue, { url: 'http://h/a.bin', target: join(dir, 'a.bin'), totalSize: 4 }).queue;
    queue = { ...queue, tasks: [{ ...queue.tasks[0], state: 'DONE' }] };
    await saveQueue(dir, queue);

    const lignes = [];
    const result = await main(['http://h/', dir, '--verifier'], { log: (line) => lignes.push(line) });
    assert.equal(result.conforms, false);
    assert.equal(result.done, 0, 'aucun téléchargement');
    assert.ok(lignes.some((line) => line.includes('MANQUANT  a.bin')));
    assert.ok(lignes.some((line) => line.startsWith('vérification : ÉCART DÉTECTÉ')));

    // La vérification ne crée pas le dossier qu'elle vérifie.
    await assert.rejects(() => readFile(join(dir, 'absent', 'queue.json')), /ENOENT/);
    const rien = await main(['http://h/', join(dir, 'absent'), '--verifier'], { log: () => {} });
    assert.equal(rien.verify.checked, 0);

    // Aspiration conforme : code 0.
    await writeFile(join(dir, 'a.bin'), 'AAAA');
    const conforme = await main(['http://h/', dir, '--verifier'], { log: () => {} });
    assert.equal(conforme.conforms, true);
    assert.equal(conforme.verify.ok, 1);
  });
});

test('T-B-44 : rapport HTML autonome, avec échappement', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');

  const report = buildReport({
    project: { rootUrl: 'http://h/?q="<script>alert(1)</script>' },
    queue: {
      tasks: [
        { id: 1, url: 'http://h/a.bin', target: '/t/a.bin', state: 'DONE', totalSize: 4, attempts: 0 },
        { id: 2, url: 'http://h/"b".bin', target: '/t/b.bin', state: 'FAILED', totalSize: 0, attempts: 2, error: '<b>404</b>' },
      ],
    },
    crawl: {
      fetched: 2, retained: [{ url: 'http://h/a.bin' }], stopped: 'épuisement', delay: 0, parallelisme: 1,
      skipped: [{ url: 'http://h/x', reason: 'hors site' }], errors: [],
    },
  });
  const html = toHtml(report);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="fr">/);
  assert.ok(!html.includes('<script>'), 'aucune balise injectée depuis une URL');
  assert.ok(!html.includes('<b>404</b>'), 'aucun balisage injecté depuis un message');
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!/<link\b|<img\b|src="http/.test(html), 'aucune ressource externe : rapport autonome');
  assert.match(html, /Exploration/, 'le diagnostic du parcours est repris');
  assert.match(html, /hors site/);
  assert.equal(formatReport(report, 'html'), html);
  assert.equal(formatReport(report, 'htm'), html);
  assert.throws(() => formatReport(report, 'pdf'), /format de rapport inconnu/);
});

test('T-B-52 : une tâche en échec compte dans la conformité, une tâche en attente non', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'ok.bin'), 'OK');
    let queue = createQueue({});
    queue = addTask(queue, { url: 'http://h/ok.bin', target: join(dir, 'ok.bin'), totalSize: 2 }).queue;
    queue = addTask(queue, { url: 'http://h/rate.bin', target: join(dir, 'rate.bin'), totalSize: 4 }).queue;
    queue = addTask(queue, {
      url: 'http://h/attente.bin', target: join(dir, 'attente.bin'), totalSize: 9,
    }).queue;
    // Une tâche **tentée et ratée**, une tâche **pas encore tentée** : les deux sont absentes
    // du disque, une seule est un écart (`D-081`).
    queue.tasks[0] = { ...queue.tasks[0], state: 'DONE' };
    queue.tasks[1] = { ...queue.tasks[1], state: 'FAILED' };

    const result = await verifyGrab({ rootDir: dir, tasks: queue.tasks });
    assert.deepEqual(result.absent.map((item) => [item.path, item.state]),
      [['rate.bin', 'FAILED'], ['attente.bin', 'PENDING']]);
    assert.equal(result.failed, 1);
    assert.equal(result.ok_, false, '3 tâches sur 5 absentes ne sont pas « conforme »');

    // La même file **sans** l'échec reste conforme : une file interrompue n'est pas fautive.
    const attenteSeule = [queue.tasks[0], queue.tasks[2]];
    const calme = await verifyGrab({ rootDir: dir, tasks: attenteSeule });
    assert.equal(calme.failed, 0);
    assert.equal(calme.ok_, true);
  });
});
