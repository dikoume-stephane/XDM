import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_MAX_ACTIVE,
  QUEUE_FILE,
  activeCount,
  addTask,
  beginVerification,
  completeTask,
  createQueue,
  failTask,
  fillSlots,
  isIdle,
  loadQueue,
  pauseTask,
  queuePath,
  recoverAfterCrash,
  resumeTask,
  saveQueue,
  startNext,
  stats,
  validateQueue,
} from "../src/task-queue.js";

const NOW = 1_700_000_000_000;

/** File de `n` tâches en attente. */
function queueOf(n, maxActive = DEFAULT_MAX_ACTIVE) {
  let queue = createQueue({ maxActive });
  for (let i = 0; i < n; i += 1) {
    ({ queue } = addTask(queue, { url: `https://exemple.test/f${i}.bin`, target: `f${i}.bin`, now: NOW }));
  }
  return queue;
}

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "xdm-queue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("T-A-07 : la file démarre au plus 8 téléchargements et suit l'ordre d'arrivée", () => {
  assert.equal(DEFAULT_MAX_ACTIVE, 8, "valeur observée dans le binaire (0x0fbe17)");

  let queue = queueOf(12);
  queue = fillSlots(queue, NOW);
  assert.equal(activeCount(queue), 8);
  assert.deepEqual(
    queue.tasks.filter((t) => t.state === "ACTIVE").map((t) => t.id),
    [1, 2, 3, 4, 5, 6, 7, 8],
    "FIFO",
  );
  assert.equal(queue.tasks[8].state, "PENDING");

  // Une place libérée en ouvre exactement une (ACTIVE → VERIFYING → DONE).
  queue = completeTask(beginVerification(queue, 3, NOW), 3, NOW);
  assert.equal(activeCount(queue), 7);
  const { started } = startNext(queue, NOW);
  assert.equal(started.id, 9);
});

test("T-A-27 : une place ne s'ouvre qu'après libération, jamais par dépassement", () => {
  let queue = queueOf(3, 2);
  queue = fillSlots(queue, NOW);
  assert.equal(activeCount(queue), 2);
  assert.equal(startNext(queue, NOW).started, null, "plafond atteint");

  // La limite est un paramètre, pas une constante codée en dur.
  const big = fillSlots(queueOf(20, 20), NOW);
  assert.equal(activeCount(big), 20);
});

test("T-A-19 : les transitions illégales sont refusées, pas absorbées", () => {
  let queue = queueOf(1);
  assert.throws(() => completeTask(queue, 1), /transition interdite/);
  queue = startNext(queue, NOW).queue;
  assert.throws(() => resumeTask(queue, 1), /transition interdite/, "ACTIVE → PENDING passe par PAUSED");
  queue = beginVerification(queue, 1, NOW);
  assert.throws(() => pauseTask(queue, 1), /transition interdite/, "on ne met pas en pause une vérification");
  queue = completeTask(queue, 1, NOW);
  assert.throws(() => failTask(queue, 1, "trop tard"), /transition interdite/, "DONE est terminal");
  assert.equal(isIdle(queue), true);
});

test("une tâche en échec peut être remise en attente sans perdre son compteur", () => {
  let queue = startNext(queueOf(1), NOW).queue;
  queue = failTask(queue, 1, "503 après 3 tentatives", NOW);
  assert.equal(queue.tasks[0].error, "503 après 3 tentatives");
  assert.equal(queue.tasks[0].attempts, 1);

  queue = resumeTask(queue, 1, NOW);
  queue = startNext(queue, NOW).queue;
  assert.equal(queue.tasks[0].attempts, 2, "les tentatives s'accumulent");
  assert.equal(queue.tasks[0].error, null, "l'erreur est effacée au redémarrage");
});

test("T-A-02 (file) : une coupure laisse les tâches actives récupérables", async (t) => {
  const dir = await sandbox(t);
  let queue = fillSlots(queueOf(3, 2), NOW);
  assert.equal(activeCount(queue), 2);
  await saveQueue(dir, queue);

  // Redémarrage : le fichier contient deux ACTIVE, ce qui est cohérent mais pas
  // exécutable tel quel.
  const reloaded = await loadQueue(dir);
  assert.equal(activeCount(reloaded), 2);

  const recovered = recoverAfterCrash(reloaded, NOW + 5);
  assert.equal(activeCount(recovered), 0);
  assert.equal(
    recovered.tasks.filter((task) => task.state === "PENDING").length,
    3,
    "aucune tâche perdue",
  );
  assert.equal(recovered.tasks[0].attempts, 1, "les tentatives sont conservées");
  assert.deepEqual(validateQueue(recovered), { ok: true, errors: [] });
});

test("T-A-02 (file) : écriture atomique et relecture fidèle", async (t) => {
  const dir = await sandbox(t);
  const queue = fillSlots(queueOf(4, 2), NOW);
  const path = await saveQueue(dir, queue);
  assert.equal(path, queuePath(dir));
  assert.deepEqual(await readdir(dir), [QUEUE_FILE], "ni .tmp ni fichier orphelin");
  assert.deepEqual(await loadQueue(dir), queue);
});

test("T-A-02 (file, bis) : une file incohérente est rejetée", async (t) => {
  const dir = await sandbox(t);
  const path = join(dir, QUEUE_FILE);

  await writeFile(path, "pas du json", "utf8");
  await assert.rejects(() => loadQueue(dir), /JSON invalide/);

  const bad = {
    version: 1,
    maxActive: 2,
    nextId: 2,
    tasks: [{ id: 1, url: "u", target: "t", totalSize: -1, state: "EN_COURS", attempts: 0, startedAt: null, updatedAt: 0, error: null }],
  };
  await writeFile(path, JSON.stringify(bad), "utf8");
  await assert.rejects(() => loadQueue(dir), /état inconnu/);

  const dup = { version: 1, maxActive: 2, nextId: 3, tasks: [
    { id: 1, url: "u", target: "t", totalSize: -1, state: "PENDING", attempts: 0, startedAt: null, updatedAt: 0, error: null },
    { id: 1, url: "v", target: "u", totalSize: -1, state: "PENDING", attempts: 0, startedAt: null, updatedAt: 0, error: null },
  ] };
  await writeFile(path, JSON.stringify(dup), "utf8");
  await assert.rejects(() => loadQueue(dir), /dupliqué/);
  await assert.rejects(() => saveQueue(dir, dup), /refusée à l'écriture/);
});

test("T-A-05 (file) : les statistiques sont dérivées, jamais stockées", () => {
  let queue = fillSlots(queueOf(3, 1), NOW);
  queue = completeTask(beginVerification(queue, 1, NOW), 1, NOW);
  const s = stats(queue);
  assert.equal(s.total, 3);
  assert.deepEqual(s.counts, { PENDING: 2, ACTIVE: 0, PAUSED: 0, VERIFYING: 0, DONE: 1, FAILED: 0 });
  assert.equal(Object.hasOwn(queue, "stats"), false);
});
