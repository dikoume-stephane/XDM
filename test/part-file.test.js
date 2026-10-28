import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyRollback, completeChunk, createChunkMap, progress } from "../src/chunk-map.js";
import { PART_SUFFIX, loadPartFile, partPath, removePartFile, savePartFile } from "../src/part-file.js";

/** Dossier jetable par test. */
async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "xdm-part-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, target: join(dir, "fichier.bin") };
}

test("T-A-02 : la carte survit à un rechargement, progression identique", async (t) => {
  const { target } = await sandbox(t);
  let map = createChunkMap({ url: "https://exemple.test/f", target: "fichier.bin", totalSize: 9 });
  map = completeChunk(map, 1);

  const written = await savePartFile(target, map);
  assert.equal(written, partPath(target));
  assert.ok(written.endsWith(PART_SUFFIX));

  const reloaded = await loadPartFile(target);
  assert.deepEqual(reloaded.chunks, map.chunks);
  assert.deepEqual(progress(reloaded), progress(map));
});

test("T-A-02 (suite) : écriture atomique — aucun fichier temporaire ne subsiste", async (t) => {
  const { dir, target } = await sandbox(t);
  const map = createChunkMap({ url: "https://exemple.test/f", target: "f", totalSize: 4 });

  await savePartFile(target, map);
  await savePartFile(target, completeChunk(map, 1));

  const entries = await readdir(dir);
  assert.deepEqual(entries, ["fichier.bin.xdm-part.json"], "ni .tmp, ni fichier orphelin");
  assert.deepEqual(progress(await loadPartFile(target)).downloaded, 4, "la dernière version gagne");
});

test("T-A-02 (bis) : une carte corrompue est rejetée, jamais réparée", async (t) => {
  const { dir, target } = await sandbox(t);
  const path = partPath(target);

  await writeFile(path, "{ ceci n'est pas du JSON", "utf8");
  await assert.rejects(() => loadPartFile(target), /JSON invalide/);

  const cyclic = {
    version: 1,
    url: "u",
    target: "t",
    totalSize: 10,
    chunkSize: 5,
    created: "1970-01-01T00:00:00.000Z",
    chunks: [
      { id: 1, start: 0, next: 2, completed: false },
      { id: 2, start: 5, next: 1, completed: false },
    ],
  };
  await writeFile(path, JSON.stringify(cyclic), "utf8");
  await assert.rejects(() => loadPartFile(target), /carte rejetée/);

  await assert.rejects(() => savePartFile(target, cyclic), /refusée à l'écriture/);
  assert.deepEqual(await readdir(dir), ["fichier.bin.xdm-part.json"]);
});

test("T-A-02 (ter) : le fichier écrit est du JSON lisible, versionné et daté", async (t) => {
  const { target } = await sandbox(t);
  const map = createChunkMap({ url: "https://exemple.test/f", target: "f", totalSize: 6 });
  await savePartFile(target, map);

  const raw = await readFile(partPath(target), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.totalSize, 6);
  assert.match(parsed.created, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(raw.endsWith("\n"), "fichier terminé par un saut de ligne");
});

test("removePartFile supprime la carte et tolère son absence", async (t) => {
  const { dir, target } = await sandbox(t);
  await savePartFile(target, createChunkMap({ url: "u", target: "t", totalSize: 3 }));
  await removePartFile(target);
  assert.deepEqual(await readdir(dir), []);
  await removePartFile(target); // idempotent
});

test("T-A-09 + T-A-26 : rollback persisté puis reprise conservant les octets acquis", async (t) => {
  const { target } = await sandbox(t);
  const map = {
    version: 1,
    url: "https://exemple.test/f",
    target: "f",
    totalSize: 100,
    chunkSize: 50,
    created: "1970-01-01T00:00:00.000Z",
    chunks: [
      { id: 1, start: 0, next: 2, completed: true },
      { id: 2, start: 50, next: 0, completed: false },
    ],
  };
  await savePartFile(target, map);

  const rolledBack = applyRollback(await loadPartFile(target), 2, 70);
  await savePartFile(target, rolledBack);

  const reloaded = await loadPartFile(target);
  assert.equal(progress(reloaded).downloaded, 50, "le morceau 1 reste acquis");
  // 1 [0,50) clos -> 3 [50,70) rouvert -> 2 [70,100) à reprendre
  assert.deepEqual(
    reloaded.chunks.map((c) => [c.id, c.start]),
    [
      [1, 0],
      [3, 50],
      [2, 70],
    ],
  );
});
