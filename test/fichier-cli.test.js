import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, parseArgs } from '../bin/xdm.js';
import { main as grabMain } from '../bin/xdm-grab.js';
import { saveQueue, createQueue, addTask } from '../src/task-queue.js';
import { createProject, saveProject } from '../src/project.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/xdm.js', import.meta.url));
const GRAB_CLI = fileURLToPath(new URL('../bin/xdm-grab.js', import.meta.url));

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-fichier-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Site de test : plages HTTP, coupure programmable, `Content-Disposition`.
 * `served` accumule les octets réellement envoyés sur les plages, ce qui est la seule mesure
 * honnête d'une reprise : « le fichier est complet » ne dit pas qu'on n'a pas tout relu.
 */
async function startSite({ size = 64 * 1024, cut = null, disposition = null, name = 'f.bin' } = {}) {
  const body = Buffer.alloc(size, 0x41);
  const served = [];
  let cuts = 0;
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const headers = {
      etag: '"v1"',
      'accept-ranges': 'bytes',
      ...(disposition ? { 'content-disposition': disposition } : {}),
      'content-type': 'application/octet-stream',
    };
    if (!match) {
      res.writeHead(200, { ...headers, 'content-length': String(size) });
      res.end(body);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), size - 1);
    served.push(end - start + 1);
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    });
    // Coupure sur **toutes** les plages non nulles : une seule coupure ne suffit pas, le
    // moteur la rattrape (reprise avec recouvrement). Ici les morceaux suivants épuisent
    // leurs tentatives, le premier morceau reste acquis — l'état exact d'un fichier
    // interrompu, sans dépendre d'un `kill` ni d'un délai.
    if (cut && start > 0) {
      cuts += 1;
      res.write(body.subarray(start, Math.min(start + 64, end + 1)));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(body.subarray(start, end + 1));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const site = {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/${name}`,
    body,
    served,
    // La coupure se coupe : la seconde passe du même test doit pouvoir aboutir.
    set cut(value) { cut = value; },
    bytesServed: () => served.reduce((sum, n) => sum + n, 0),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
  return site;
}

test('T-A-29 : un fichier interrompu reprend **par défaut**, sans tout relire', async () => {
  const site = await startSite({ size: 64 * 1024, cut: true });
  await withTempDir(async (dir) => {
    try {
      // Première passe : elle échoue, mais les morceaux clos sont sur disque.
      await assert.rejects(() => main([site.url, dir, '--morceau', '4096'], { log: () => {} }));
      const files = await readdir(dir);
      assert.ok(files.includes('f.bin.xdm-part.json'), `carte absente : ${files.join(', ')}`);

      site.cut = false;
      site.served.length = 0;
      const result = await main([site.url, dir, '--morceau', '4096'], { log: () => {} });
      assert.equal(result.resumeDropped ?? null, null);
      assert.equal(result.target, join(dir, 'f.bin'));
      assert.equal((await stat(join(dir, 'f.bin'))).size, site.body.length);
      assert.deepEqual(await readFile(join(dir, 'f.bin')), site.body);

      // La reprise se mesure en octets **demandés** : moins que le fichier, jamais zéro.
      assert.ok(site.bytesServed() < site.body.length,
        `reprise : ${site.bytesServed()} octets relus pour ${site.body.length}`);
      assert.ok(site.bytesServed() > 0, 'une reprise n’invente pas les octets manquants');
    } finally {
      await site.close();
    }
  });
});

test('T-A-29 : `--sans-reprise` repart de zéro, carte ou pas', async () => {
  const site = await startSite({ size: 32 * 1024, cut: true });
  await withTempDir(async (dir) => {
    try {
      await assert.rejects(() => main([site.url, dir, '--morceau', '4096'], { log: () => {} }));
      site.cut = false;
      site.served.length = 0;
      const result = await main([site.url, dir, '--morceau', '4096', '--sans-reprise'], { log: () => {} });
      assert.ok(site.bytesServed() >= site.body.length,
        `avec --sans-reprise, tout est relu (${site.bytesServed()} octets pour ${site.body.length})`);
      assert.equal(result.size, site.body.length);
      assert.deepEqual(await readFile(join(dir, 'f.bin')), site.body);
      assert.equal(parseArgs(['http://h/f']).resume, true, 'la reprise est le défaut');
      assert.equal(parseArgs(['http://h/f', '--sans-reprise']).resume, false);
    } finally {
      await site.close();
    }
  });
});

test('T-A-30 : une carte venue d’une autre URL est ignorée, et la raison est dite', async () => {
  const site = await startSite({ size: 32 * 1024, cut: true });
  await withTempDir(async (dir) => {
    try {
      await assert.rejects(() => main([site.url, dir, '--morceau', '4096'], { log: () => {} }));
      // La carte existe, mais elle décrit une autre ressource : la recoller fabriquerait un
      // fichier hybride sans que rien ne le signale.
      const { loadPartFile, savePartFile } = await import('../src/part-file.js');
      const map = await loadPartFile(join(dir, 'f.bin'));
      await savePartFile(join(dir, 'f.bin'), { ...map, url: 'http://autre.test/autre.bin' });
      site.cut = false;
      site.served.length = 0;
      const result = await main([site.url, dir, '--morceau', '4096'], { log: () => {} });
      assert.equal(result.resumeDropped, 'url');
      assert.ok(site.bytesServed() >= site.body.length, 'aucun morceau de l’autre ressource réutilisé');
      assert.deepEqual(await readFile(join(dir, 'f.bin')), site.body);
    } finally {
      await site.close();
    }
  });
});

test('T-A-29 : l’aspiration coupe la reprise (`--sans-reprise`)', async () => {
  await withTempDir(async (dir) => {
    let queue = createQueue({});
    queue = addTask(queue, { url: 'http://h/gros.bin', target: join(dir, 'gros.bin'), totalSize: 4 }).queue;
    const pending = { ...queue, tasks: queue.tasks.map((task) => ({ ...task, state: 'PENDING' })) };
    await saveQueue(dir, pending);
    // `--reprendre` lit le projet autant que la file : sans lui, il n'y a pas de reprise.
    await saveProject(join(dir, 'h.xdmspider.json'), createProject({ name: 'h', rootUrl: 'http://h/', depth: 2 }));

    const seen = [];
    const result = await grabMain(['http://h/', dir, '--reprendre', '--sans-reprise'], {
      log: () => {},
      runTask: async (task) => {
        seen.push(task.id);
        await writeFile(task.target, 'AAAA');
        return { target: task.target, size: 4, requests: 1 };
      },
      downloadOptions: {},
    });
    assert.equal(result.done, 1);
    assert.deepEqual(seen, [1]);
    // Le runner reçoit `resume` : la preuve est dans les options transmises au transport.
    const { downloadTask } = await import('../src/grab-runner.js');
    const calls = [];
    const fake = async (url, target, options) => {
      calls.push(options);
      return { target, size: 1, requests: 1 };
    };
    await downloadTask({ url: 'http://h/x', target: join(dir, 'x.bin') }, {
      downloadOptions: { resume: false }, download: fake,
    });
    assert.equal(calls[0].resume, false);
    await downloadTask({ url: 'http://h/y', target: join(dir, 'y.bin') }, { download: fake });
    assert.equal(calls[1].resume, undefined, 'sans option, le moteur garde sa reprise par défaut');
  });
});

test('T-A-30 : le nom vient de `Content-Disposition` quand l’URL n’en donne pas', async () => {
  const site = await startSite({ size: 1024, name: 'download', disposition: 'attachment; filename="rapport final.pdf"' });
  await withTempDir(async (dir) => {
    try {
      const url = `${site.origin}/download?id=3`;
      const result = await main([url, dir], { log: () => {} });
      assert.equal(result.target, join(dir, 'rapport final.pdf'));
      assert.equal((await stat(result.target)).size, 1024);
    } finally {
      await site.close();
    }
  });
});

test('T-A-30 : l’extension de l’URL, `--nom` et les traversées de chemin', async () => {
  const site = await startSite({ size: 512, name: 'archive.tar.gz', disposition: 'attachment; filename="autre.zip"' });
  const mechant = await startSite({ size: 16, name: 'x', disposition: 'attachment; filename="../../etc/passwd"' });
  await withTempDir(async (dir) => {
    try {
      // L'URL porte une extension : elle fait foi, sans sonde supplémentaire.
      const premier = await main([site.url, dir], { log: () => {} });
      assert.equal(premier.target, join(dir, 'archive.tar.gz'));

      // `--nom` l'emporte sur tout.
      const second = await main([site.url, dir, '--nom', 'force.zip'], { log: () => {} });
      assert.equal(second.target, join(dir, 'force.zip'));

      // Un nom de fichier n'est jamais un chemin : la composante finale, rien de plus.
      const troisieme = await main([mechant.url, dir], { log: () => {} });
      assert.equal(troisieme.target, join(dir, 'passwd'));
      await assert.rejects(() => stat(join(dir, '..', 'etc', 'passwd')).then(() => readFile(join(dir, '..', 'etc', 'passwd'))));
      const { fileNameFromDisposition } = await import('../src/promote.js');
      assert.equal(fileNameFromDisposition('attachment; filename*=UTF-8\'\'na%C3%AFve.tar.gz'), 'naïve.tar.gz');
      assert.equal(fileNameFromDisposition('inline'), null);
      assert.equal(fileNameFromDisposition(null), null);
      assert.equal(fileNameFromDisposition('attachment; filename=".."'), null);
      assert.throws(() => parseArgs(['http://h/f', '--nom']), /--nom attend/);
    } finally {
      await site.close();
      await mechant.close();
    }
  });
});

test('T-A-31 : `--sortie json` rend un objet sur stdout et la progression sur stderr', async () => {
  const site = await startSite({ size: 4096 });
  await withTempDir(async (dir) => {
    try {
      const sortie = [];
      const erreurs = [];
      const result = await main([site.url, dir, '--sortie', 'json'], {
        log: (line) => sortie.push(line),
        logErreur: (line) => erreurs.push(line),
      });
      assert.equal(sortie.length, 1, `stdout doit porter un seul objet : ${sortie.join(' | ')}`);
      const parsed = JSON.parse(sortie[0]);
      assert.equal(parsed.target, join(dir, 'f.bin'));
      assert.equal(parsed.size, 4096);
      assert.equal(parsed.requests, result.requests);
      assert.ok(erreurs.length > 0, 'la progression part sur stderr');
      assert.ok(erreurs.every((line) => line.includes('%') || line.includes('écrit')));

      // Le vrai binaire : `JSON.parse(stdout)` doit suffire, sans filtrer une seule ligne.
      const { stdout } = await execFileAsync(process.execPath, [CLI, site.url, dir, '--sortie', 'json'], { encoding: 'utf8' });
      assert.equal(JSON.parse(stdout).size, 4096);
      assert.throws(() => parseArgs(['http://h/f', '--sortie', 'xml']), /--sortie attend/);
    } finally {
      await site.close();
    }
  });
});

test('T-A-32 : `--proxy` s’applique vraiment au transfert HTTP', async () => {
  const site = await startSite({ size: 2048 });
  const connects = [];
  // L'événement `connect` n'existe que sur un serveur HTTP : un `net.Server` ne parse pas la
  // requête `CONNECT` et resterait muet, ce qui donne un test qui expire au lieu d'échouer.
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    connects.push(req.url);
    const [host, port] = req.url.split(':');
    const amont = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) amont.write(head);
      amont.pipe(clientSocket);
      clientSocket.pipe(amont);
    });
    amont.on('error', () => clientSocket.destroy());
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  const proxyPort = proxy.address().port;
  await withTempDir(async (dir) => {
    try {
      const result = await main([site.url, dir, '--proxy', `http://127.0.0.1:${proxyPort}`], { log: () => {} });
      assert.equal((await readFile(result.target)).length, 2048);
      assert.ok(connects.length > 0, 'le proxy n’a jamais été contacté : l’option serait inerte');
      assert.ok(connects.every((target) => target.endsWith(':0') === false));
      assert.match(connects[0], /^127\.0\.0\.1:\d+$/);

      // Un proxy illisible est refusé **localement**, avant toute connexion.
      assert.throws(() => parseArgs(['http://h/f', '--proxy', 'ftp://x:1']), /proxy invalide/);
    } finally {
      await site.close();
      proxy.close();
    }
  });
});

test('T-B-49 : `--verifier --rapport` écrit le constat dans les quatre formats', async () => {
  await withTempDir(async (dir) => {
    let queue = createQueue({});
    queue = addTask(queue, { url: 'http://h/a.bin', target: join(dir, 'a.bin'), totalSize: 4 }).queue;
    queue = addTask(queue, { url: 'http://h/b.bin', target: join(dir, 'b.bin'), totalSize: 9 }).queue;
    queue = { ...queue, tasks: queue.tasks.map((task) => ({ ...task, state: 'DONE' })) };
    await saveQueue(dir, queue);
    await writeFile(join(dir, 'a.bin'), 'AAAA'); // b.bin manque, 4 o conformes
    await writeFile(join(dir, 'intrus.txt'), 'x');

    // Les rapports s'écrivent **hors** du dossier vérifié : dedans, ils seraient eux-mêmes
    // des fichiers hors file, et le rapport suivant constaterait ses propres traces.
    const rapports = await mkdtemp(join(tmpdir(), 'xdm-rapports-'));
    const html = join(rapports, 'verif.html');
    const result = await grabMain(['http://h/', dir, '--verifier', '--rapport', html], { log: () => {} });
    assert.equal(result.conforms, false);
    assert.equal(result.report, html);
    const page = await readFile(html, 'utf8');
    assert.match(page, /Rapport de vérification/);
    assert.match(page, /MANQUANT/);
    assert.match(page, /HORS FILE/);

    for (const [extension, motif] of [['json', /"conforms": false/], ['csv', /MANQUANT/], ['md', /Conforme/]]) {
      const path = join(rapports, `verif.${extension}`);
      await grabMain(['http://h/', dir, '--verifier', '--rapport', path], { log: () => {} });
      const text = await readFile(path, 'utf8');
      assert.match(text, motif, `${extension} : ${text.slice(0, 120)}`);
    }
    // Le format déduit de l'extension est une règle unique, testable seule.
    const { reportFormatFor } = await import('../bin/xdm-grab.js');
    assert.equal(reportFormatFor('r.json'), 'json');
    assert.equal(reportFormatFor('r.CSV'.toLowerCase()), 'csv');
    assert.equal(reportFormatFor('r.htm'), 'html');
    assert.equal(reportFormatFor('r.txt'), 'markdown');

    // Une vérification conforme écrit aussi son rapport, et il le dit.
    const { rm: remove } = await import('node:fs/promises');
    await remove(join(dir, 'intrus.txt'));
    await writeFile(join(dir, 'b.bin'), 'BBBBBBBBB');
    const conforme = join(rapports, 'conforme.json');
    const ok = await grabMain(['http://h/', dir, '--verifier', '--rapport', conforme], { log: () => {} });
    assert.equal(ok.conforms, true);
    const rapport = JSON.parse(await readFile(conforme, 'utf8'));
    assert.equal(rapport.verification.conforms, true);
    assert.equal(rapport.verification.ok, 2);
    assert.deepEqual(rapport.entries, [], 'un rapport de vérification ne liste que les anomalies');
    await rm(rapports, { recursive: true, force: true });
  });
});
