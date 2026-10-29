#!/usr/bin/env node
/**
 * Porte G3 — parcours complet sur un site local (`docs/specs/porte-g3.md`).
 *
 * La porte G3 est la sortie de la phase P3 : « parcours complet sur un site local (≥ 200
 * pages, fichiers de 1 Ko à 200 Mo, coupures réseau simulées) **sans perte ni doublon** ».
 * Ce script produit ce site, l'aspire, coupe une connexion en plein transfert, reprend, puis
 * **compare octet par octet** ce qui est sur disque avec ce que le serveur a servi.
 *
 * Pourquoi un générateur plutôt qu'un site figé : 200 Mo de fixtures dans un dépôt Git sont
 * un poids mort et une source de dérive. Ici les fichiers sont **déterministes** (graine
 * fixe) et vivent dans un dossier temporaire jeté après la mesure.
 *
 * Usage :
 *   node tools/gate-g3.mjs                          # profil de test : 24 pages, 1 Kio → 2 Mio
 *   node tools/gate-g3.mjs --pages 200 --max 200M   # profil de la porte (long, ~200 Mo)
 *   node tools/gate-g3.mjs --json                   # résultat machine
 *   node tools/gate-g3.mjs --sans-coupure           # ne pas simuler l'incident réseau
 *
 * Code de sortie : 0 porte franchie, 1 porte non franchie (écart détaillé).
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../bin/xdm-grab.js';
import { loadQueue } from '../src/task-queue.js';

/** Taille lisible (`1.5 Mio`). */
const human = (bytes) => {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
};

/** `200M`, `2M`, `512K`, `1024` → octets. */
export function parseSize(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)i?b?$/i.exec(String(text).trim());
  if (!match) throw new Error(`taille illisible : ${text}`);
  const factor = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()];
  return Math.round(Number(match[1]) * factor);
}

/**
 * Contenu déterministe d'un fichier : `counter` blocs de 64 Kio tirés d'un SHA-256 enchaîné.
 * Deux exécutions produisent les mêmes octets, donc la même empreinte.
 * @param {number} size
 * @param {number} seed
 * @returns {Buffer}
 */
export function contentOf(size, seed) {
  const block = 64 * 1024;
  const out = Buffer.alloc(size);
  let digest = createHash('sha256').update(`xdm-g3:${seed}`).digest();
  let offset = 0;
  while (offset < size) {
    const chunk = digest.subarray(0, Math.min(block, size - offset));
    chunk.copy(out, offset);
    offset += chunk.length;
    digest = createHash('sha256').update(digest).digest();
  }
  return out;
}

/**
 * Site synthétique : pages HTML + fichiers binaires, tailles réparties géométriquement.
 *
 * @param {{pages?: number, minSize?: number, maxSize?: number, seed?: number}} [options]
 * @returns {{routes: Map<string, {body: Buffer, type: string}>, files: Map<string, {size: number, sha256: string, path: string}>, pages: string[]}}
 */
export function buildSite({
  pages = 24, minSize = 1024, maxSize = 2 * 1024 * 1024, seed = 1,
} = {}) {
  if (!Number.isInteger(pages) || pages < 1) throw new Error('pages ≥ 1');
  if (!(minSize > 0) || !(maxSize >= minSize)) throw new Error('tailles incohérentes');

  /** @type {Map<string, {body: Buffer, type: string}>} */
  const routes = new Map();
  /** @type {Map<string, {size: number, sha256: string, path: string}>} */
  const files = new Map();
  const pagePaths = [];

  // Distribution d'un vrai site : une longue traîne de petits fichiers et **une** grosse
  // ressource. Une progression géométrique sur 200 fichiers produirait 3 Go de fixtures —
  // inutile pour éprouver la reprise, et impossible à faire tourner dans un test.
  const smallCap = Math.min(maxSize, 64 * 1024);
  const sizes = Array.from({ length: pages }, (_, i) => {
    if (i === pages - 1) return maxSize;
    return Math.min(minSize + i * Math.max(1, Math.round(minSize / 4)), smallCap);
  });
  for (let i = 0; i < pages; i += 1) {
    const size = sizes[i];
    const seedOf = seed * 1000 + i;
    const body = contentOf(size, seedOf);
    const path = `/f/${i + 1}/fichier-${i + 1}.bin`;
    files.set(path, { size, sha256: createHash('sha256').update(body).digest('hex'), path });
    routes.set(path, { body, type: 'application/octet-stream' });

    const pagePath = `/p/${i + 1}.html`;
    pagePaths.push(pagePath);
    const html = `<html><body><h1>Page ${i + 1}</h1>`
      + `<a href="${path}">fichier ${i + 1}</a> `
      + `<a href="/p/${(i % pages) + 1}.html">suivante</a></body></html>`;
    routes.set(pagePath, { body: Buffer.from(html), type: 'text/html' });
  }

  const index = `<html><body><h1>Index</h1><ul>${pagePaths
    .map((path) => `<li><a href="${path}">${path}</a></li>`).join('')}</ul></body></html>`;
  routes.set('/', { body: Buffer.from(index), type: 'text/html' });
  routes.set('/robots.txt', { body: Buffer.from('User-agent: *\nAllow: /\n'), type: 'text/plain' });

  return { routes, files, pages: pagePaths };
}

/**
 * Serveur du site synthétique.
 *
 * `cutOnce` désigne un chemin : la **première** requête de plage sur ce fichier est coupée
 * au milieu du corps (destruction de la socket), les suivantes sont servies normalement.
 * C'est une coupure réelle — pas un statut d'erreur — donc elle éprouve le rollback et la
 * reprise, pas le diagnostic des codes HTTP.
 *
 * @param {ReturnType<typeof buildSite>} site
 * @param {{cutOnce?: string|null, cutAfter?: number, range?: boolean}} [options]
 * @returns {Promise<{origin: string, close: () => Promise<void>, stats: {requests: number, cuts: number}}>}
 */
export async function serveSite(site, { cutOnce = null, cutAfter = 32 * 1024, range = true } = {}) {
  const stats = { requests: 0, cuts: 0 };
  /** @type {Set<string>} */
  const alreadyCut = new Set();

  const server = http.createServer((req, res) => {
    stats.requests += 1;
    const path = new URL(req.url, 'http://h').pathname;
    const route = site.routes.get(path);
    if (!route) {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    const header = req.headers.range;
    const match = header && range ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
    if (match) {
      const start = Number(match[1]);
      const end = match[2] === '' ? route.body.length - 1 : Math.min(Number(match[2]), route.body.length - 1);
      if (start >= route.body.length) {
        res.writeHead(416, { 'content-range': `bytes */${route.body.length}`, 'content-length': '0' });
        res.end();
        return;
      }
      const slice = route.body.subarray(start, end + 1);
      res.writeHead(206, {
        'content-type': route.type,
        'content-range': `bytes ${start}-${end}/${route.body.length}`,
        'content-length': String(slice.length),
        etag: `"g3-${route.body.length}"`,
      });
      if (cutOnce === path && !alreadyCut.has(path) && slice.length > cutAfter) {
        alreadyCut.add(path);
        stats.cuts += 1;
        res.write(slice.subarray(0, cutAfter));
        // Coupure franche : le client voit un corps tronqué, pas un `Content-Length` respecté.
        setTimeout(() => res.socket?.destroy(), 5);
        return;
      }
      res.end(slice);
      return;
    }
    res.writeHead(200, {
      'content-type': route.type,
      'content-length': String(route.body.length),
      etag: `"g3-${route.body.length}"`,
      ...(range ? { 'accept-ranges': 'bytes' } : {}),
    });
    res.end(route.body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    stats,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Compare une arborescence locale à ce que le serveur a servi : taille **et** empreinte.
 *
 * C'est le seul contrôle qui ne peut pas mentir par construction : tout le reste (états,
 * compteurs, rapport) décrit ce que le programme *croit* avoir fait ; ceci décrit ce qui est
 * réellement sur le disque. Exporté pour être testé sur une arborescence volontairement
 * faussée — une vérification qui ne trouve jamais rien ne vérifie rien.
 *
 * @param {string} root
 * @param {Map<string, {size: number, sha256: string, path: string}>} expected
 * @returns {Promise<{checked: number, mismatches: string[]}>}
 */
export async function compareTree(root, expected) {
  /** @type {string[]} */
  const mismatches = [];
  for (const [path, file] of expected) {
    const local = join(root, file.path.replace(/^\//, ''));
    try {
      const data = await readFile(local);
      if (data.length !== file.size) {
        mismatches.push(`${path} : ${data.length} o au lieu de ${file.size}`);
        continue;
      }
      if (createHash('sha256').update(data).digest('hex') !== file.sha256) {
        mismatches.push(`${path} : empreinte différente`);
      }
    } catch {
      mismatches.push(`${path} : fichier absent`);
    }
  }
  return { checked: expected.size, mismatches };
}

/** Liste récursive des fichiers d'un dossier, en chemins relatifs POSIX. */
async function listFiles(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * Franchit — ou non — la porte G3.
 *
 * @param {{pages?: number, minSize?: number, maxSize?: number, cut?: boolean,
 *   directory?: string, keep?: boolean, log?: (line: string) => void}} [options]
 * @returns {Promise<{ok: boolean, checks: {name: string, ok: boolean, detail: string}[],
 *   summary: object}>}
 */
export async function runGate({
  pages = 24,
  minSize = 1024,
  maxSize = 2 * 1024 * 1024,
  cut = true,
  directory = null,
  keep = false,
  log = () => {},
} = {}) {
  const root = directory ?? (await mkdtemp(join(tmpdir(), 'xdm-g3-')));
  const site = buildSite({ pages, minSize, maxSize });
  // La plus grosse ressource est celle qu'on coupe : c'est là que la reprise coûte cher.
  const biggest = [...site.files.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  const target = cut ? biggest[0] : null;
  const server = await serveSite(site, { cutOnce: target, cutAfter: 16 * 1024 });

  /** @type {{name: string, ok: boolean, detail: string}[]} */
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log(`${ok ? '✅' : '❌'} ${name} — ${detail}`);
    return ok;
  };

  try {
    const args = [
      `${server.origin}/`, root,
      '--profondeur', '2',
      '--sans-exclusions',
      '--inclure', '*',
      '--connexions', '4',
      '--rapport', join(root, 'rapport.json'),
    ];
    log(`aspiration de ${pages} page(s) et ${site.files.size} fichier(s) `
      + `(${human(minSize)} → ${human(maxSize)})${cut ? `, coupure sur ${target}` : ''}`);
    const first = await main(args, { log: () => {} });
    log(`première passe : ${first.done} terminé(s), ${first.failed} échec(s)`);

    // Une coupure réseau ne doit **pas** condamner une tâche : la boucle rouvre la plage au
    // dernier octet écrit. Si malgré tout une tâche échoue, la reprise doit la rattraper —
    // les deux chemins sont acceptables, un fichier manquant ne l'est pas.
    let second = null;
    if (first.failed > 0) {
      second = await main([`${server.origin}/`, root, '--reprendre'], { log: () => {} });
      log(`seconde passe (reprise) : ${second.done} terminé(s), ${second.failed} échec(s)`);
    }
    const recoveredBy = first.failed === 0 ? 'interne' : second?.failed === 0 ? 'reprise' : 'aucune';
    if (cut) {
      check('coupure absorbée sans perte', recoveredBy !== 'aucune',
        recoveredBy === 'interne'
          ? 'la boucle a rouvert la plage au dernier octet écrit (aucune tâche en échec)'
          : 'récupérée par la passe de reprise');
    }

    // Le rapport est régénéré **après** la reprise : un rapport rédigé avant le rattrapage
    // décrit un état qui n'existe plus.
    await main([`${server.origin}/`, root, '--reprendre', '--rapport', join(root, 'rapport.json')], {
      log: () => {},
    });

    const queue = await loadQueue(root);
    const states = queue.tasks.map((task) => task.state);
    check('toutes les tâches terminées', states.every((state) => state === 'DONE'),
      `${states.filter((s) => s === 'DONE').length}/${states.length} en DONE`);

    const urls = queue.tasks.map((task) => task.url);
    check('aucun doublon dans la file', new Set(urls).size === urls.length,
      `${urls.length} tâche(s), ${new Set(urls).size} URL distincte(s)`);

    // Comparaison octet par octet : c'est le cœur de la porte.
    const { mismatches: mismatched } = await compareTree(root, site.files);
    check('fichiers identiques au serveur', mismatched.length === 0,
      mismatched.length === 0 ? `${site.files.size} empreintes vérifiées`
        : `${mismatched.length} écart(s) : ${mismatched.slice(0, 3).join(' ; ')}`);

    // Aucun résidu de travail : une aspiration propre ne laisse ni `.xdm-part.json` ni `.tmp`.
    const leftovers = (await listFiles(root))
      .filter((name) => name.endsWith('.xdm-part.json') || name.endsWith('.xdmwork'));
    check('aucun résidu de travail', leftovers.length === 0,
      leftovers.length === 0 ? 'aucun fichier temporaire' : leftovers.slice(0, 3).join(', '));

    // Le rapport doit compter ce que le disque contient, pas ce qu'on espérait.
    let reportOk = false;
    let reportDetail = 'rapport illisible';
    try {
      const report = JSON.parse(await readFile(join(root, 'rapport.json'), 'utf8'));
      const total = [...site.files.values()].reduce((sum, file) => sum + file.size, 0);
      // Toutes les pages retenues comptent, **y compris l'index** (`/`, qui n'a pas
      // d'extension `.html`) : c'est exactement l'oubli que cette porte a révélé.
      const pagesBytes = [...site.routes.values()]
        .filter((route) => route.type === 'text/html')
        .reduce((sum, route) => sum + route.body.length, 0);
      reportOk = report.done === site.files.size + site.pages.length + 1
        && report.failed === 0
        && report.bytes.known === total + pagesBytes;
      reportDetail = `${report.done} tâche(s), ${human(report.bytes.known)} annoncés `
        + `(attendu ${human(total + pagesBytes)})`;
    } catch (error) {
      reportDetail = String(error.message);
    }
    check('rapport cohérent avec le disque', reportOk, reportDetail);

    if (cut) {
      check('coupure réellement infligée', server.stats.cuts === 1,
        `${server.stats.cuts} coupure(s), ${server.stats.requests} requête(s)`);
    }

    const ok = checks.every((item) => item.ok);
    return {
      ok,
      checks,
      summary: {
        pages,
        files: site.files.size,
        bytesServed: [...site.files.values()].reduce((sum, file) => sum + file.size, 0),
        requests: server.stats.requests,
        cuts: server.stats.cuts,
        passes: second === null ? 1 : 2,
        recoveredBy,
        tasks: queue.tasks.length,
      },
    };
  } finally {
    await server.close();
    if (!keep && directory === null) await rm(root, { recursive: true, force: true });
    else log(`dossier conservé : ${root}`);
  }
}

// ---------------------------------------------------------------------------- CLI

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1));

if (isMain) {
  const argv = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const pages = Number(option('--pages', '24'));
  const maxSize = parseSize(option('--max', '2M'));
  const minSize = parseSize(option('--min', '1K'));
  const cut = !argv.includes('--sans-coupure');
  const json = argv.includes('--json');
  const keep = argv.includes('--garder');

  const result = await runGate({
    pages,
    minSize,
    maxSize,
    cut,
    keep,
    log: json ? () => {} : (line) => console.log(line),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const s = result.summary;
    console.log('');
    console.log(`Porte G3 : ${result.ok ? 'franchie' : 'NON franchie'} — `
      + `${s.files} fichier(s), ${human(s.bytesServed)}, ${s.requests} requête(s), `
      + `${s.cuts} coupure(s), ${s.passes} passe(s)`);
  }
  if (!result.ok) process.exitCode = 1;
}
