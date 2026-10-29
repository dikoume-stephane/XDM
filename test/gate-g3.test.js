import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, truncate, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSite, compareTree, contentOf, parseSize, runGate,
} from '../tools/gate-g3.mjs';

test('T-G3 : tailles lisibles et contenu déterministe', () => {
  assert.equal(parseSize('1024'), 1024);
  assert.equal(parseSize('1K'), 1024);
  assert.equal(parseSize('2M'), 2 * 1024 * 1024);
  assert.equal(parseSize('200M'), 200 * 1024 * 1024);
  assert.equal(parseSize('1.5G'), 1.5 * 1024 ** 3);
  assert.throws(() => parseSize('beaucoup'), /taille illisible/);

  const a = contentOf(1024, 7);
  const b = contentOf(1024, 7);
  const c = contentOf(1024, 8);
  assert.equal(a.length, 1024);
  assert.deepEqual(a, b, 'même graine ⇒ mêmes octets (la porte doit être reproductible)');
  assert.notDeepEqual(a, c, 'graine différente ⇒ contenu différent');
  // Le contenu doit varier à l'intérieur du fichier, sinon une coupure au milieu serait
  // indétectable par l'empreinte.
  assert.notEqual(a.subarray(0, 32).toString('hex'), a.subarray(1024 - 32).toString('hex'));
});

test('T-G3 : le site synthétique couvre la plage demandée, sans exploser en volume', () => {
  const site = buildSite({ pages: 20, minSize: 1024, maxSize: 1024 * 1024 });
  assert.equal(site.files.size, 20);
  const sizes = [...site.files.values()].map((file) => file.size).sort((x, y) => x - y);
  assert.equal(sizes[0], 1024, 'le plus petit fait exactement le minimum');
  assert.equal(sizes.at(-1), 1024 * 1024, 'le plus gros fait exactement le maximum');
  const total = sizes.reduce((sum, size) => sum + size, 0);
  assert.ok(total < 8 * 1024 * 1024, `volume total raisonnable : ${total} o`);

  assert.ok(site.routes.has('/'), 'index présent');
  assert.ok(site.routes.has('/robots.txt'), 'robots.txt présent');
  for (const [, file] of site.files) {
    const served = site.routes.get(file.path).body;
    assert.equal(createHash('sha256').update(served).digest('hex'), file.sha256, 'empreinte annoncée = contenu servi');
  }
});

test('T-G3 : la comparaison disque/serveur détecte absence, troncature et corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xdm-g3-cmp-'));
  try {
    const site = buildSite({ pages: 3, minSize: 2048, maxSize: 8192 });
    const files = [...site.files.entries()];
    // Tout écrire correctement : aucune divergence.
    await mkdir(join(root, 'f'), { recursive: true });
    for (const [, file] of files) {
      await mkdir(join(root, file.path.replace(/^\//, '').split('/').slice(0, -1).join('/')), { recursive: true });
      await writeFile(join(root, file.path.replace(/^\//, '')), site.routes.get(file.path).body);
    }
    assert.deepEqual((await compareTree(root, site.files)).mismatches, []);

    // Trois sabotages, trois diagnostics distincts.
    const [first, second, third] = files;
    await truncate(join(root, first[1].path.replace(/^\//, '')), 100);
    const corrupted = Buffer.from(site.routes.get(second[0]).body);
    corrupted[0] ^= 0xff;
    await writeFile(join(root, second[1].path.replace(/^\//, '')), corrupted);
    await rm(join(root, third[1].path.replace(/^\//, '')));

    const { mismatches, checked } = await compareTree(root, site.files);
    assert.equal(checked, 3);
    assert.equal(mismatches.length, 3);
    assert.ok(mismatches.some((line) => /au lieu de/.test(line)), 'troncature');
    assert.ok(mismatches.some((line) => /empreinte différente/.test(line)), 'corruption');
    assert.ok(mismatches.some((line) => /absent/.test(line)), 'absence');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('T-G3 : la porte est franchie sur un site de 8 pages, coupure comprise', async () => {
  const result = await runGate({ pages: 8, minSize: 1024, maxSize: 256 * 1024, cut: true });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok), null, 1));
  assert.equal(result.summary.recoveredBy, 'interne',
    'une coupure en cours de morceau est reprise par la boucle, sans échec de tâche');
  assert.equal(result.summary.passes, 1);
  assert.equal(result.summary.cuts, 1, 'la coupure a bien été infligée, sinon le test ne prouve rien');
  assert.equal(result.summary.files, 8);
});

test('T-G3 : sans coupure, la porte passe aussi (le banc ne dépend pas de l’incident)', async () => {
  const result = await runGate({ pages: 4, minSize: 1024, maxSize: 64 * 1024, cut: false });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok), null, 1));
  assert.equal(result.summary.cuts, 0);
  assert.equal(result.summary.recoveredBy, 'interne');
});

test('T-G3 : sans `Range`, une coupure coûte un redémarrage — et la reprise le rattrape', async () => {
  const result = await runGate({
    pages: 4, minSize: 1024, maxSize: 64 * 1024, cut: true, ranges: false,
  });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok), null, 1));
  assert.equal(result.summary.cuts, 1, 'l’incident a bien eu lieu, sur le transfert (pas sur la sonde)');
  assert.equal(result.summary.recoveredBy, 'reprise',
    'sans plage il n’y a rien à reprendre dans le fichier : la tâche est rejouée');
  assert.equal(result.summary.passes, 2);
});

test('T-G3 : un serveur saturé (429) est absorbé par la reprise, sans second passage', async () => {
  const result = await runGate({
    pages: 3, minSize: 1024, maxSize: 32 * 1024, cut: false, saturate: 1, attempts: 2,
  });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok), null, 1));
  assert.equal(result.summary.throttled, 3, 'un refus par fichier, exactement');
  assert.equal(result.summary.passes, 1);
  assert.equal(result.summary.recoveredBy, 'interne');
});

test('T-G3 : une saturation mal dimensionnée échoue — le banc ne l’absout pas', async () => {
  const result = await runGate({
    pages: 3, minSize: 1024, maxSize: 32 * 1024, cut: false, saturate: 2, attempts: 2,
  });
  // Deux refus pour deux tentatives : la seconde est la dernière, donc échec constaté.
  assert.equal(result.summary.throttled, 6);
  assert.equal(result.ok, false, 'une saturation non couverte doit se voir');
  assert.ok(result.checks.some((c) => !c.ok && /saturation/.test(c.name)));
});
