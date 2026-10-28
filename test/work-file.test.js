import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MAX_WRITE, openWorkFile } from "../src/work-file.js";

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "xdm-work-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "fichier.bin.xdm-part") };
}

test("T-A-01 : deux connexions écrivent à des offsets disjoints dans un seul fichier", async (t) => {
  const { path } = await sandbox(t);
  const work = await openWorkFile(path, 16);
  t.after(() => work.close());

  assert.equal(await work.size(), 16, "fichier préalloué à la taille cible");

  // Écritures concurrentes, comme deux connexions simultanées.
  await Promise.all([
    work.writeAt(Uint8Array.from({ length: 8 }, (_, i) => i), 0),
    work.writeAt(Uint8Array.from({ length: 8 }, (_, i) => 100 + i), 8),
  ]);

  const content = await readFile(path);
  assert.deepEqual([...content.subarray(0, 8)], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...content.subarray(8, 16)], [100, 101, 102, 103, 104, 105, 106, 107]);
});

test("T-A-01 (suite) : une écriture hors fichier est refusée, pas tronquée en silence", async (t) => {
  const { path } = await sandbox(t);
  const work = await openWorkFile(path, 8);
  t.after(() => work.close());

  await assert.rejects(() => work.writeAt(Uint8Array.from([1, 2]), 7), RangeError);
  await assert.rejects(() => work.writeAt(Uint8Array.from([1]), -1), RangeError);
  await assert.rejects(() => work.writeAt(new Uint8Array(MAX_WRITE + 1), 0), RangeError);
  assert.equal(await work.size(), 8, "le fichier n'a pas bougé");
});

test("T-A-09 : le rollback tronque au dernier offset confirmé", async (t) => {
  const { path } = await sandbox(t);
  const work = await openWorkFile(path, 10);
  t.after(() => work.close());

  await work.writeAt(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 0);
  assert.equal(await work.size(), 10);

  await work.rollbackTo(4);
  assert.equal(await work.size(), 4, "troncature = SetEndOfFile (0x15ff52)");
  assert.deepEqual([...(await readFile(path))], [1, 2, 3, 4], "le préfixe confirmé est intact");

  await assert.rejects(() => work.rollbackTo(11), RangeError, "au-delà de la taille cible");
  await assert.rejects(() => work.rollbackTo(-1), RangeError);
});

test("T-A-26 : après un rollback, la réécriture au-delà de la coupure reste possible", async (t) => {
  const { path } = await sandbox(t);
  const work = await openWorkFile(path, 8);
  t.after(() => work.close());

  await work.writeAt(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]), 0);
  await work.rollbackTo(3);
  // La zone perdue est réécrite par la reprise (l'offset est de nouveau valide).
  await work.writeAt(Uint8Array.from([7, 7, 7, 7, 7]), 3);

  assert.deepEqual([...(await readFile(path))], [9, 9, 9, 7, 7, 7, 7, 7]);
});
