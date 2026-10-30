import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addTask, completeTask, createQueue, saveQueue, transition } from '../src/task-queue.js';
import { LIBELLES_ANOMALIE, verifierDossier } from '../src/verification.js';

/** Prépare un dossier avec `queue.json` et les fichiers demandés. */
async function preparer({ fichiers = {}, etats = {} } = {}) {
  const racine = await mkdtemp(join(tmpdir(), 'xdm-verif-'));
  let file = createQueue({});
  for (const [nom, taille] of Object.entries(fichiers)) {
    const ajout = addTask(file, { url: `https://exemple.fr/${nom}`, target: join(racine, nom), totalSize: taille });
    file = ajout.queue;
    if ((etats[nom] ?? 'DONE') === 'DONE') {
      file = transition(file, ajout.task.id, 'ACTIVE');
      file = transition(file, ajout.task.id, 'VERIFYING');
      file = completeTask(file, ajout.task.id);
    }
  }
  await saveQueue(racine, file);
  return { racine, file };
}

test('T-E-07 : un dossier conforme sort en code 0 avec tous les compteurs à zéro', async () => {
  const { racine } = await preparer({ fichiers: { 'a.bin': 4 } });
  try {
    await writeFile(join(racine, 'a.bin'), Buffer.from([1, 2, 3, 4]));
    const rapport = await verifierDossier({ dossier: racine, maintenant: () => 1000 });
    assert.equal(rapport.conformes, true);
    assert.equal(rapport.codeSortie, 0);
    assert.equal(rapport.total, 1);
    assert.equal(rapport.ok, 1);
    assert.equal(rapport.anomalies, 0);
    assert.deepEqual(rapport.compteurs, {
      verifies: 1, conformes: 1, manquants: 0, tronques: 0, partiels: 0, absents: 0, horsFile: 0,
    });
    assert.equal(rapport.dossier, racine);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('WP-52 : un fichier tronqué et un fichier manquant sortent en code 1', async () => {
  const { racine } = await preparer({ fichiers: { 'court.bin': 8, 'absent.bin': 3 } });
  try {
    await writeFile(join(racine, 'court.bin'), Buffer.alloc(5));
    const rapport = await verifierDossier({ dossier: racine });
    assert.equal(rapport.conformes, false);
    assert.equal(rapport.codeSortie, 1);
    assert.equal(rapport.anomalies, 2);
    assert.equal(rapport.compteurs.tronques, 1);
    assert.equal(rapport.compteurs.manquants, 1);
    const etats = rapport.entrees.map((e) => e.state).sort();
    assert.deepEqual(etats, ['MANQUANT', 'TRONQUÉ']);
    for (const entree of rapport.entrees) {
      assert.equal(entree.libelle, LIBELLES_ANOMALIE[entree.state]);
      assert.ok(entree.libelle.length > 0);
    }
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('WP-52 : une tâche non terminée n’est pas une anomalie bloquante', async () => {
  const { racine } = await preparer({ fichiers: { 'attente.bin': 4 }, etats: { 'attente.bin': 'PENDING' } });
  try {
    await truncate(join(racine, 'attente.bin'), 0).catch(() => {});
    const rapport = await verifierDossier({ dossier: racine });
    assert.equal(rapport.compteurs.absents, 1);
    assert.equal(rapport.compteurs.manquants, 0);
    assert.equal(rapport.codeSortie, 0, 'une tâche en attente n’est pas un échec');
    assert.equal(rapport.conformes, true, 'le verdict affiché suit le code de sortie');
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('WP-52 : dossier absent, dossier sans file, file illisible — trois refus distincts', async () => {
  await assert.rejects(
    () => verifierDossier({ dossier: join(tmpdir(), 'xdm-inexistant-xyz') }),
    (e) => e.code === 'DOSSIER_ABSENT',
  );

  const vide = await mkdtemp(join(tmpdir(), 'xdm-vide-'));
  try {
    await assert.rejects(() => verifierDossier({ dossier: vide }), (e) => e.code === 'FILE_ABSENTE');
    await assert.rejects(() => verifierDossier({ dossier: '' }), (e) => e.code === 'DOSSIER_MANQUANT');

    await writeFile(join(vide, 'queue.json'), '{ pas une file');
    await assert.rejects(() => verifierDossier({ dossier: vide }), (e) => e.code === 'FILE_ILLISIBLE');

    const fichier = join(vide, 'un-fichier.txt');
    await writeFile(fichier, 'x');
    await assert.rejects(() => verifierDossier({ dossier: fichier }), (e) => e.code === 'DOSSIER_INVALIDE');
  } finally {
    await rm(vide, { recursive: true, force: true });
  }
});

test('WP-52 : la vérification ne sort pas du dossier demandé', async () => {
  const { racine } = await preparer({ fichiers: { 'ok.bin': 2 } });
  const dehors = await mkdtemp(join(tmpdir(), 'xdm-dehors-'));
  try {
    await writeFile(join(racine, 'ok.bin'), Buffer.alloc(2));
    await writeFile(join(dehors, 'intrus.bin'), Buffer.alloc(2));
    const rapport = await verifierDossier({ dossier: racine });
    assert.equal(rapport.compteurs.horsFile, 0, 'le fichier voisin n’est pas compté comme géré');
    assert.ok(rapport.entrees.every((e) => !String(e.target).includes('intrus')));
  } finally {
    await mkdir(racine, { recursive: true });
    await rm(racine, { recursive: true, force: true });
    await rm(dehors, { recursive: true, force: true });
  }
});
