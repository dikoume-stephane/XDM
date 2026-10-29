import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, parseArgs } from '../bin/xdm-grab.js';
import { loadQueue } from '../src/task-queue.js';

const CLI = fileURLToPath(new URL('../bin/xdm-grab.js', import.meta.url));

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-suite-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Site lent : chaque fichier répond après `delay` ms, ce qui laisse le temps d'interrompre. */
async function startSlowSite({ delay = 120 } = {}) {
  const files = {};
  for (let i = 0; i < 4; i += 1) files[`/f/f${i}.bin`] = Buffer.from(`fichier ${i}`);
  const links = Object.keys(files).map((path) => `<a href="${path}">f</a>`).join('');
  const requests = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    requests.push(path);
    if (path === '/robots.txt') {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    if (path === '/') {
      const body = Buffer.from(links);
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    const file = files[path];
    if (!file) {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-length': String(file.length) });
      res.end(file);
    }, delay);
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

test('T-C-18 : `--sitemap` ajoute les fichiers que personne ne cite', async () => {
  const files = { '/pub/cite.zip': 'C', '/pub/orphelin.zip': 'O' };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    if (path === '/robots.txt') {
      const body = Buffer.from('User-agent: *\nSitemap: /plan.xml\n');
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    if (path === '/plan.xml') {
      const body = Buffer.from('<urlset><url><loc>/pub/orphelin.zip</loc></url>'
        + '<url><loc>/pub/cite.zip</loc></url></urlset>');
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    if (path === '/') {
      const body = Buffer.from('<a href="/pub/cite.zip">c</a>');
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    const file = files[path];
    if (!file) {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': String(file.length) });
    res.end(Buffer.from(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${port}`;

  await withTempDir(async (dir) => {
    try {
      const lignes = [];
      const sans = await main([`${origin}/`, join(dir, 'sans')], { log: (l) => lignes.push(l) });
      assert.equal(sans.done, 1, 'sans plan de site : seul le fichier cité est aspiré');

      const avec = await main([`${origin}/`, join(dir, 'avec'), '--sitemap'],
        { log: (l) => lignes.push(l) });
      assert.equal(avec.done, 2, 'le fichier orphelin vient du plan de site');
      assert.ok(lignes.some((line) => line.includes('plans de site : 1 consulté(s), 2 URL')));
      assert.ok(lignes.some((line) => line.startsWith('amorces :')));
      const tasks = (await loadQueue(join(dir, 'avec'))).tasks;
      assert.ok(tasks.some((task) => task.url.endsWith('/pub/orphelin.zip')));
      assert.equal(tasks.length, 2, 'pas de doublon pour le fichier cité deux fois');
    } finally {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
    }
  });
});

test('T-C-19 : `--sous-domaines` élargit le parcours, `--tentatives` couvre l’exploration', async () => {
  assert.equal(parseArgs(['http://h/', '--sous-domaines']).subdomains, true);
  assert.equal(parseArgs(['http://h/']).subdomains, false);
  assert.equal(parseArgs(['http://h/']).sitemap, false);

  let flaky = 0;
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://h').pathname;
    if (path === '/robots.txt') {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    if (path === '/instable.html') {
      flaky += 1;
      if (flaky === 1) {
        res.writeHead(503, { 'retry-after': '0', 'content-length': '0' });
        res.end();
        return;
      }
      const body = Buffer.from('stable');
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    const body = Buffer.from('<a href="/instable.html">i</a>');
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${port}`;

  await withTempDir(async (dir) => {
    try {
      const lignes = [];
      const result = await main([`${origin}/`, dir, '--tentatives', '2'], { log: (l) => lignes.push(l) });
      assert.equal(result.failed, 0);
      assert.ok(lignes.some((line) => line.includes('reprises pendant le parcours : 1')));
      assert.equal(flaky, 2, 'le 503 a bien été rejoué');
    } finally {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
    }
  });
});

test('T-C-20 : Ctrl-C arrête proprement, sans tâche restée `ACTIVE`', async () => {
  const site = await startSlowSite({ delay: 150 });
  await withTempDir(async (dir) => {
    try {
      const child = spawn(process.execPath, [CLI, `${site.origin}/`, dir, '--connexions', '1'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      // L'écoute de `exit` est posée **avant** l'interruption : un processus peut sortir
      // pendant qu'on attend autre chose, et l'événement serait alors perdu.
      // `close` (et non `exit`) : il n'arrive qu'une fois les flux stdio vidés, donc le
      // dernier message sur stderr est bien arrivé au parent.
      const exited = new Promise((resolve) => child.on('close', resolve));
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const interrupted = new Promise((resolve) => {
        // Un seul signal : la seconde interruption sort tout de suite (comportement voulu),
        // donc un test qui en envoie deux ne mesurerait plus la reprise.
        let signale = false;
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (!signale && /page\(s\) visitée/.test(stdout)) {
            signale = true;
            // Le parcours vient de finir : on laisse partir **un** téléchargement (150 ms),
            // puis on interrompt au milieu des suivants.
            setTimeout(() => {
              child.kill('SIGINT');
              resolve(null);
            }, 250);
          }
        });
      });
      await interrupted;
      const code = await exited;

      assert.equal(code, 130, `code de sortie attendu 130, obtenu ${code}`);
      assert.match(stderr, /interruption demandée/);
      assert.match(stderr, /interrompu — la file et le projet sont à jour/);
      // Le fichier de file existe et aucune tâche n'est restée `ACTIVE` : la reprise est sûre.
      const queue = await loadQueue(dir);
      assert.ok(queue.tasks.length >= 1);
      assert.deepEqual(queue.tasks.filter((task) => task.state === 'ACTIVE'), []);
      assert.ok(queue.tasks.some((task) => task.state === 'PENDING'),
        'les tâches non commencées restent à faire');
    } finally {
      await site.close();
    }
  });
});

test('T-C-21 : `--aide` et `--version` répondent sans URL, avec le code 0', async () => {
  const run = (cli, args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('exit', (code) => resolve({ code, stdout }));
  });

  const version = await run(CLI, ['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^xdm-grab 0\.1\.0/);

  const aide = await run(CLI, ['--aide']);
  assert.equal(aide.code, 0);
  assert.match(aide.stdout, /usage : xdm-grab/);
  assert.match(aide.stdout, /--sitemap/);

  // En programme aussi : la fonction rend un objet, elle ne lève pas.
  const lignes = [];
  const sansUrl = await main(['--version'], { log: (line) => lignes.push(line) });
  assert.equal(sansUrl.version, '0.1.0');
  const aide2 = await main(['--aide'], { log: () => {} });
  assert.equal(aide2.help, true);
  assert.deepEqual(Object.keys(aide2.queue), ['tasks']);

  // La CLI de téléchargement répond de la même façon.
  const cli = fileURLToPath(new URL('../bin/xdm.js', import.meta.url));
  const tel = await run(cli, ['--version']);
  assert.equal(tel.code, 0);
  assert.match(tel.stdout, /^xdm 0\.1\.0/);
  const telAide = await run(cli, ['-h']);
  assert.equal(telAide.code, 0);
  assert.match(telAide.stdout, /le schéma de l’URL choisit le transport|le schéma de l'URL choisit le transport/);
});
