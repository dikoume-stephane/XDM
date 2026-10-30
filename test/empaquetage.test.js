import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { construirePaquet, empreinte, EXCLUS, PaquetError } from '../tools/empaqueter.mjs';

/** Dépôt minimal : le nécessaire, plus ce qui ne doit jamais partir. */
async function depot() {
  const racine = await mkdtemp(join(tmpdir(), 'xdm-paquet-'));
  const ecrire = async (chemin, contenu) => {
    const cible = join(racine, chemin);
    await mkdir(join(cible, '..'), { recursive: true });
    await writeFile(cible, contenu);
  };
  await ecrire('package.json', JSON.stringify({ name: 'xdm', version: '9.9.9', main: 'desktop/main.js' }));
  await ecrire('README.md', '# XDM\n');
  await ecrire('src/moteur.js', 'export const x = 1;\n');
  await ecrire('src/sous/module.js', 'export const y = 2;\n');
  await ecrire('src/moteur.test.js', "// ne doit pas partir\n");
  await ecrire('bin/xdm.js', '#!/usr/bin/env node\n');
  await ecrire('desktop/main.js', '// colle Electron\n');
  await ecrire('test/moteur.test.js', "import 'node:test';\n");
  await ecrire('cible/IDMan.exe', 'binaire de la cible — jamais distribué');
  await ecrire('analysis/idman/classes.json', '{}');
  await ecrire('dl/gros.bin', Buffer.alloc(64));
  return racine;
}

test('T-E-20 : le paquet contient ce qui fait tourner XDM, et rien de la cible', async () => {
  const racine = await depot();
  try {
    const paquet = await construirePaquet({ racine, sortie: join(racine, 'dist', 'xdm'), maintenant: () => 0 });
    const fichiers = paquet.fichiers.map((f) => f.chemin).sort();
    assert.deepEqual(fichiers, [
      'README.md',
      'bin/xdm.js',
      'desktop/main.js',
      'package.json',
      'src/moteur.js',
      'src/sous/module.js',
    ]);
    assert.equal(fichiers.some((f) => f.startsWith('cible/')), false, 'le binaire de la cible ne part jamais');
    assert.equal(fichiers.some((f) => f.startsWith('test/')), false);
    assert.equal(fichiers.some((f) => f.endsWith('.test.js')), false, 'aucun test dans le paquet');

    // Le manifeste décrit exactement ce qui a été copié, avec une empreinte vérifiable.
    const manifeste = JSON.parse(await readFile(join(paquet.sortie, 'manifeste.json'), 'utf8'));
    assert.equal(manifeste.version, '9.9.9');
    assert.equal(manifeste.pointEntree, 'desktop/main.js');
    assert.equal(manifeste.total.fichiers, fichiers.length);
    const source = await readFile(join(racine, 'src/moteur.js'));
    const calcule = await empreinte(join(racine, 'src/moteur.js'));
    assert.equal(manifeste.fichiers.find((f) => f.chemin === 'src/moteur.js').sha256, calcule);
    assert.equal(manifeste.fichiers.find((f) => f.chemin === 'src/moteur.js').octets, source.length);
    assert.equal((await readdir(paquet.sortie)).includes('manifeste.json'), true);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('T-E-20 : un paquet se reconstruit à l’identique, et une sortie absurde est refusée', async () => {
  const racine = await depot();
  try {
    const un = await construirePaquet({ racine, sortie: join(racine, 'dist', 'un'), maintenant: () => 0 });
    const deux = await construirePaquet({ racine, sortie: join(racine, 'dist', 'deux'), maintenant: () => 0 });
    assert.deepEqual(un.manifeste.fichiers, deux.manifeste.fichiers, 'deux constructions, mêmes empreintes');

    await assert.rejects(
      construirePaquet({ racine, sortie: racine }),
      (error) => error instanceof PaquetError && error.code === 'SORTIE_INVALIDE',
    );

    // La liste d'exclusion est explicite : c'est elle qu'on vérifie, pas un filtre deviné.
    for (const dossier of ['cible', 'test', 'analysis', 'dl', 'telechargements', '.git']) {
      assert.ok(EXCLUS.includes(dossier), `${dossier} doit être exclu`);
    }
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});
