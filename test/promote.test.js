import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { completeChunk, createChunkMap } from "../src/chunk-map.js";
import { partPath, savePartFile } from "../src/part-file.js";
import {
  PromotionError,
  checkReadyToPromote,
  discard,
  fileNameFromUrl,
  promote,
  sanitizeFileName,
  workPathFor,
} from "../src/promote.js";

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "xdm-promote-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Carte complète de `totalSize` octets, écrite sur disque avec le fichier de travail. */
async function readyDownload(dir, content, map = null) {
  const target = join(dir, "fichier.bin");
  const work = workPathFor(target);
  const carte =
    map ??
    completeChunk(
      createChunkMap({ url: "https://exemple.test/f", target: "fichier.bin", totalSize: content.length }),
      1,
    );
  await writeFile(work, content);
  await savePartFile(target, carte);
  return { target, work, map: carte };
}

test("T-A-14 : un nom de fichier ne peut pas sortir du dossier cible", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("..\\..\\windows\\system32\\cmd.exe"), "cmd.exe");
  assert.equal(sanitizeFileName("/etc/shadow"), "shadow");
  assert.equal(sanitizeFileName("a/../../b.txt"), "b.txt", "seule la dernière composante survit");
  assert.equal(sanitizeFileName("..."), "download");
  assert.equal(sanitizeFileName("   "), "download");
  assert.equal(sanitizeFileName("con.txt"), "_con.txt", "nom réservé Windows");
  assert.equal(sanitizeFileName("LPT1"), "_LPT1");
  assert.equal(sanitizeFileName("rapport?.pdf"), "rapport_.pdf");
  assert.equal(sanitizeFileName("fichier."), "fichier", "point final retiré");

  // Décodage défensif : un « .. » encodé est neutralisé.
  assert.equal(sanitizeFileName("%2e%2e%2fsecret"), "secret");

  // Un nom très long est tronqué en conservant l'extension.
  const long = sanitizeFileName(`${"a".repeat(400)}.tar.gz`);
  assert.ok(Buffer.byteLength(long, "utf8") <= 200);
  assert.ok(long.endsWith(".gz"));
});

test("T-A-14 (suite) : le nom par défaut vient de l'URL, jamais d'un chemin brut", () => {
  assert.equal(fileNameFromUrl("https://exemple.test/docs/manuel.pdf?v=2#p1"), "manuel.pdf");
  assert.equal(fileNameFromUrl("https://exemple.test/docs/"), "exemple.test");
  assert.equal(fileNameFromUrl("https://exemple.test/a/%2e%2e%2fevasion.txt"), "evasion.txt");
  assert.equal(fileNameFromUrl("https://exemple.test/a/b/c.tar.gz"), "c.tar.gz");
  assert.equal(fileNameFromUrl("pas-une-url"), "pas-une-url");
});

test("T-A-12 : la promotion est refusée tant que la carte n'est pas complète", async (t) => {
  const dir = await sandbox(t);
  const target = join(dir, "fichier.bin");
  const work = workPathFor(target);

  // Carte avec un morceau non clos : on écrit quand même le fichier.
  const incomplete = {
    version: 1,
    url: "u",
    target: "fichier.bin",
    totalSize: 4,
    chunkSize: 2,
    created: "1970-01-01T00:00:00.000Z",
    chunks: [{ id: 1, start: 0, next: 0, completed: false }],
  };
  await writeFile(work, Buffer.from("abcd"));
  await savePartFile(target, incomplete);

  const verdict = checkReadyToPromote(incomplete);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors[0], /morceaux non clos/);

  await assert.rejects(() => promote({ workPath: work, target, map: incomplete }), PromotionError);
  assert.deepEqual(await readdir(dir).then((f) => f.sort()), ["fichier.bin.xdm-part", "fichier.bin.xdm-part.json"],
    "rien n'est livré, rien n'est supprimé");
});

test("T-A-12 (suite) : une taille incohérente sur disque bloque la promotion", async (t) => {
  const dir = await sandbox(t);
  const { target, work, map } = await readyDownload(dir, Buffer.from("abc"));
  await writeFile(work, Buffer.from("ab")); // fichier tronqué sous la carte

  await assert.rejects(
    () => promote({ workPath: work, target, map }),
    (error) => error instanceof PromotionError && error.reason === "taille",
  );
  assert.equal((await stat(work)).size, 2, "le fichier de travail est conservé");
});

test("T-A-12 (ter) : promotion réussie — rename atomique, carte supprimée, contenu intact", async (t) => {
  const dir = await sandbox(t);
  const content = Buffer.from("contenu final vérifié");
  const { target, work, map } = await readyDownload(dir, content);

  const result = await promote({ workPath: work, target, map });
  assert.deepEqual(result, { target, size: content.length });
  assert.deepEqual(await readdir(dir), ["fichier.bin"], "seul le livrable reste");
  assert.deepEqual(await readFile(target), content);

  await assert.rejects(() => stat(partPath(target)), /ENOENT/);
  await assert.rejects(() => stat(work), /ENOENT/);
});

test("T-A-12 (fin) : la promotion écrase une cible existante (Delete old file + Rename)", async (t) => {
  const dir = await sandbox(t);
  const { target, work, map } = await readyDownload(dir, Buffer.from("nouveau"));
  await writeFile(target, "ancien contenu bien plus long");

  await promote({ workPath: work, target, map });
  assert.deepEqual(await readFile(target), Buffer.from("nouveau"));
});

test("T-A-11 : un morceau non clos suffit à empêcher la livraison", () => {
  const map = {
    version: 1,
    url: "u",
    target: "t",
    totalSize: 10,
    chunkSize: 5,
    created: "1970-01-01T00:00:00.000Z",
    chunks: [
      { id: 1, start: 0, next: 2, completed: true },
      { id: 2, start: 5, next: 0, completed: false },
    ],
  };
  const verdict = checkReadyToPromote(map);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors[0], /morceaux non clos : 2/);

  const full = { ...map, chunks: map.chunks.map((c) => ({ ...c, completed: true })) };
  assert.deepEqual(checkReadyToPromote(full), { ok: true, errors: [] });

  // Une carte invalide est rejetée avant tout examen des morceaux.
  const cyclic = { ...full, chunks: [{ id: 1, start: 0, next: 1, completed: true }] };
  assert.equal(checkReadyToPromote(cyclic).ok, false);
});

test("discard supprime le fichier de travail et la carte, sans toucher au reste", async (t) => {
  const dir = await sandbox(t);
  const { target, work } = await readyDownload(dir, Buffer.from("abc"));
  await discard({ workPath: work, target });
  assert.deepEqual(await readdir(dir), []);
  await discard({ workPath: work, target }); // idempotent
});
