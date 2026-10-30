import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAUTS_REGLAGES,
  ReglagesError,
  ecrireReglages,
  lireReglages,
  validerReglages,
} from '../src/reglages.js';
import { parseArgs, main } from '../bin/xdm-ui.js';

async function dossier() {
  return mkdtemp(join(tmpdir(), 'xdm-reglages-'));
}

test('T-E-05 : les réglages valides sont complétés par les défauts', () => {
  const valides = validerReglages({ connexions: 8, theme: 'sombre' });
  assert.equal(valides.connexions, 8);
  assert.equal(valides.theme, 'sombre');
  assert.equal(valides.maxActifs, DEFAUTS_REGLAGES.maxActifs);
  assert.equal(valides.robots, true);
  // Les clés inconnues sont ignorées, pas recopiées : un fichier d'une version future
  // ne doit pas polluer l'état courant.
  assert.equal('inconnu' in validerReglages({ inconnu: 1 }), false);
});

test('WP-52 : une valeur hors bornes est refusée avec le nom du champ', () => {
  for (const [patch, champ] of [
    [{ connexions: 0 }, 'connexions'],
    [{ connexions: 129 }, 'connexions'],
    [{ maxActifs: 0 }, 'maxActifs'],
    [{ profondeur: 9 }, 'profondeur'],
    [{ maxPages: 0 }, 'maxPages'],
    [{ dossier: '   ' }, 'dossier'],
    [{ dossier: 42 }, 'dossier'],
  ]) {
    assert.throws(
      () => validerReglages(patch),
      (error) => error instanceof ReglagesError && error.code === 'REGLE_INVALIDE' && error.details.champ === champ,
      JSON.stringify(patch),
    );
  }
  assert.throws(() => validerReglages({ theme: 'neon' }), (e) => e.code === 'REGLE_INVALIDE');
  assert.throws(() => validerReglages(null), (e) => e.code === 'REGLAGES_INVALIDE');
  assert.throws(() => validerReglages([]), (e) => e.code === 'REGLAGES_INVALIDE');
});

test('WP-52 : robots.txt ne se désactive pas depuis un fichier', () => {
  assert.throws(() => validerReglages({ robots: false }), (e) => e.code === 'ROBOTS_VERROUILLE');
  assert.equal(validerReglages({ robots: true }).robots, true);
});

test('WP-52 : un fichier absent rend les défauts, un fichier cassé lève', async () => {
  const racine = await dossier();
  try {
    const absent = join(racine, 'absent.json');
    const lus = await lireReglages(absent);
    assert.equal(lus.existe, false);
    assert.equal(lus.dossier, DEFAUTS_REGLAGES.dossier);
    assert.equal(lus.chemin, absent);

    const casse = join(racine, 'casse.json');
    await writeFile(casse, '{ ceci n’est pas du json');
    await assert.rejects(() => lireReglages(casse), (e) => e.code === 'JSON_INVALIDE');

    const versionne = join(racine, 'v99.json');
    await writeFile(versionne, JSON.stringify({ version: 99 }));
    await assert.rejects(() => lireReglages(versionne), (e) => e.code === 'VERSION_INCONNUE');
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('WP-52 : l’écriture est atomique, relisible, et ne laisse pas de temporaire', async () => {
  const racine = await dossier();
  try {
    const chemin = join(racine, 'sous', 'reglages.json');
    await ecrireReglages(chemin, { dossier: '/data/dl', connexions: 8, theme: 'clair' });
    const relus = await lireReglages(chemin);
    assert.equal(relus.existe, true);
    assert.equal(relus.dossier, '/data/dl');
    assert.equal(relus.connexions, 8);
    assert.equal(relus.theme, 'clair');
    const brut = JSON.parse(await readFile(chemin, 'utf8'));
    assert.equal(brut.version, 1);
    assert.equal(brut.robots, true);
    await assert.rejects(() => readFile(`${chemin}.${process.pid}.tmp`), /ENOENT/);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('WP-52 : --reglages est une option reconnue et mémorisée', () => {
  const options = parseArgs(['--reglages', '/tmp/r.json', '--connexions', '6']);
  assert.equal(options.reglages, '/tmp/r.json');
  assert.deepEqual(options.explicites.sort(), ['connexions', 'reglages']);
  assert.throws(() => parseArgs(['--reglages']), /--reglages attend une valeur/);
});

test('WP-52 : la ligne de commande l’emporte sur le fichier, qui l’emporte sur les défauts', async () => {
  const recues = [];
  const faux = async (options) => {
    recues.push(options);
    return { url: 'http://127.0.0.1:1/', fermer: async () => {} };
  };
  const lire = async () => ({ chemin: '/tmp/r.json', existe: true, dossier: '/fichier/dl', connexions: 7, maxActifs: 3 });

  await main([], { log: () => {}, demarrer: faux, lire });
  assert.equal(recues[0].dossier, '/fichier/dl');
  assert.equal(recues[0].connexions, 7);
  assert.equal(recues[0].maxActifs, 3);

  await main(['--connexions', '2', '--dossier', '/cli/dl'], { log: () => {}, demarrer: faux, lire });
  assert.equal(recues[1].dossier, '/cli/dl');
  assert.equal(recues[1].connexions, 2);
  assert.equal(recues[1].maxActifs, 3, 'les valeurs non précisées viennent toujours du fichier');
});

test('WP-52 : des réglages illisibles n’empêchent pas un démarrage entièrement explicite', async () => {
  const faux = async () => ({ url: 'http://127.0.0.1:1/', fermer: async () => {} });
  const lire = async () => {
    throw new ReglagesError('fichier cassé', 'JSON_INVALIDE');
  };
  await assert.rejects(() => main([], { log: () => {}, demarrer: faux, lire }), (e) => e.code === 'JSON_INVALIDE');

  const serveur = await main(['--dossier', '/cli/dl'], { log: () => {}, demarrer: faux, lire });
  assert.equal(serveur.url, 'http://127.0.0.1:1/');
});
