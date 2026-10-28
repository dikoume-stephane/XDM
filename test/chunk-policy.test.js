import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_CHUNK_SIZE,
  MIB,
  MIN_CHUNK_SIZE,
  PROFILES,
  chunkSizeFor,
  plannedChunkCount,
} from "../src/chunk-policy.js";

test("T-A-06 : les trois paliers observés sont reproduits", () => {
  // Fichier courant : 2 MiB jusqu'à 512 Mio, 10 MiB au-delà.
  assert.equal(chunkSizeFor(10 * MIB), 2 * MIB);
  assert.equal(chunkSizeFor(512 * MIB), 2 * MIB);
  assert.equal(chunkSizeFor(512 * MIB + 1), 10 * MIB);

  // Branche A (15 classes) : 1 MiB puis 5 MiB.
  assert.equal(chunkSizeFor(10 * MIB, { profile: "fine" }), 1 * MIB);
  assert.equal(chunkSizeFor(600 * MIB, { profile: "fine" }), 5 * MIB);

  // Branche B (9 classes) : 5 MiB jusqu'à 2 Gio, puis 10 MiB.
  assert.equal(chunkSizeFor(10 * MIB, { profile: "coarse" }), 5 * MIB);
  assert.equal(chunkSizeFor(2048 * MIB, { profile: "coarse" }), 5 * MIB);
  assert.equal(chunkSizeFor(2049 * MIB, { profile: "coarse" }), 10 * MIB);
});

test("T-A-06 (suite) : l'encadrement 1–10 MiB s'applique à toute demande hors bornes", () => {
  assert.equal(chunkSizeFor(1_000, { profile: "fine" }), MIN_CHUNK_SIZE);
  assert.equal(chunkSizeFor(1_000), 2 * MIB, "le palier par défaut reste dans les bornes");

  // Un profil volontairement hors bornes est ramené dans [1 MiB, 10 MiB].
  assert.equal(chunkSizeFor(1_000, { min: 4 * MIB }), 4 * MIB);
  assert.equal(chunkSizeFor(1_000, { max: 1 * MIB }), MIN_CHUNK_SIZE);
  assert.equal(chunkSizeFor(100 * 1024 * MIB, { max: 64 * MIB }), MAX_CHUNK_SIZE);

  for (const profil of /** @type {const} */ (["default", "fine", "coarse"])) {
    for (const taille of [1, MIB, 100 * MIB, 3 * 1024 * MIB]) {
      const value = chunkSizeFor(taille, { profile: profil });
      assert.ok(
        value >= MIN_CHUNK_SIZE && value <= MAX_CHUNK_SIZE,
        `${profil} / ${taille} : ${value} hors bornes`,
      );
    }
  }
});

test("T-A-06 (fin) : un fichier plus petit que le plancher ne crée pas de morceau vide", () => {
  assert.equal(plannedChunkCount(1_000, MIN_CHUNK_SIZE), 1);
  assert.equal(plannedChunkCount(10 * MIB, 2 * MIB), 5);
  assert.equal(plannedChunkCount(10 * MIB + 1, 2 * MIB), 6);
  assert.throws(() => plannedChunkCount(0, MIB), TypeError);
});

test("chunkSizeFor refuse les entrées absurdes au lieu de les corriger", () => {
  assert.throws(() => chunkSizeFor(0), TypeError);
  assert.throws(() => chunkSizeFor(Number.NaN), TypeError);
  assert.throws(() => chunkSizeFor(MIB, { profile: /** @type {any} */ ("inconnu") }), RangeError);
  assert.throws(() => chunkSizeFor(MIB, { min: 2 * MIB, max: 1 * MIB }), RangeError);
  assert.deepEqual(Object.keys(PROFILES).sort(), ["coarse", "default", "fine"]);
});
