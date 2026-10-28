import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyRollback,
  chainOrder,
  completeChunk,
  createChunkMap,
  freeChunks,
  intervals,
  progress,
  validateChunkMap,
} from "../src/chunk-map.js";

const BASE = { url: "https://exemple.test/fichier.bin", target: "fichier.bin", totalSize: 10 };

/** Carte à `n` morceaux égaux, chaînés. */
function mapWithStarts(starts, totalSize = 100) {
  return {
    version: 1,
    url: "https://exemple.test/f",
    target: "f",
    totalSize,
    chunkSize: 10,
    created: "1970-01-01T00:00:00.000Z",
    chunks: starts.map((start, i) => ({
      id: i + 1,
      start,
      next: i + 2 <= starts.length ? i + 2 : 0,
      completed: false,
    })),
  };
}

test("T-A-03 : la fin d'un morceau est dérivée du maillon suivant, sans champ end", () => {
  const map = mapWithStarts([0, 40, 70], 100);
  assert.deepEqual(
    intervals(map).map(({ start, end }) => [start, end]),
    [
      [0, 40],
      [40, 70],
      [70, 100],
    ],
  );
  assert.ok(
    map.chunks.every((chunk) => !Object.hasOwn(chunk, "end")),
    "aucun morceau ne doit porter de champ end (D-030)",
  );
  assert.deepEqual(validateChunkMap(map), { ok: true, errors: [] });
});

test("T-A-04 : trois cartes incohérentes sont rejetées (cycle, non monotone, orphelin)", () => {
  const cyclic = mapWithStarts([0, 50], 100);
  cyclic.chunks[1].next = 1; // 1 -> 2 -> 1
  assert.equal(validateChunkMap(cyclic).ok, false);
  assert.match(validateChunkMap(cyclic).errors[0], /cycle|tête de chaîne/);

  const decreasing = mapWithStarts([0, 80, 40], 100);
  const verdict = validateChunkMap(decreasing);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(" "), /intervalle vide ou inversé/);

  const orphan = mapWithStarts([0, 50], 100);
  orphan.chunks[1].next = 9; // 9 n'existe pas
  assert.equal(validateChunkMap(orphan).ok, false);
  assert.match(validateChunkMap(orphan).errors[0], /orphelin/);

  const unknownSize = { ...mapWithStarts([0]), totalSize: 0 };
  assert.equal(validateChunkMap(unknownSize).ok, false);
  assert.match(validateChunkMap(unknownSize).errors[0], /totalSize/);
});

test("T-A-04 (suite) : une carte valide est une chaîne strictement croissante", () => {
  const map = createChunkMap(BASE);
  assert.deepEqual(validateChunkMap(map), { ok: true, errors: [] });
  const { order } = chainOrder(map.chunks);
  assert.equal(order.length, 1);
  assert.equal(order[0].next, 0, "le dernier maillon pointe sur 0");
});

test("T-A-05 : la progression est dérivée et identique après rechargement", () => {
  let map = mapWithStarts([0, 25, 60], 100);
  assert.deepEqual(progress(map), { downloaded: 0, total: 100, ratio: 0 });

  map = completeChunk(map, 1);
  assert.deepEqual(progress(map), { downloaded: 25, total: 100, ratio: 0.25 });

  // Le rechargement ne transporte que la carte : la progression est recalculée.
  const reloaded = JSON.parse(JSON.stringify(map));
  assert.deepEqual(progress(reloaded), progress(map));
  assert.equal(Object.hasOwn(reloaded, "downloaded"), false, "aucune progression persistée (D-031)");
});

test("T-A-07 : seuls les morceaux libres sont proposés, du plus gros au plus petit", () => {
  let map = mapWithStarts([0, 10, 60], 100);
  // Du plus gros au plus petit : [10,60) = 50 o, puis [60,100) = 40 o, puis [0,10) = 10 o.
  assert.deepEqual(
    freeChunks(map).map(({ start, end }) => [start, end]),
    [
      [10, 60],
      [60, 100],
      [0, 10],
    ],
  );
  map = completeChunk(map, 2);
  assert.deepEqual(
    freeChunks(map).map(({ id }) => id),
    [3, 1],
    "un morceau clos n'est plus proposé ; le plus gros libre passe devant",
  );
});

test("T-A-09 (carte) : le rollback rouvre la zone perdue en morceau de reprise", () => {
  const map = mapWithStarts([0, 40], 100);
  const rolledBack = applyRollback(map, 2, 55);

  // P [0,40) clos -> R [40,55) à refaire -> N [55,100) en cours
  assert.deepEqual(
    intervals(rolledBack).map(({ id, start, end, completed }) => [id, start, end, completed]),
    [
      [1, 0, 40, false],
      [3, 40, 55, false],
      [2, 55, 100, false],
    ],
  );
  assert.equal(map.chunks[1].start, 40, "la carte d'origine n'est pas mutée");
  assert.deepEqual(validateChunkMap(rolledBack), { ok: true, errors: [] });

  // Aucun offset confirmé : aucun morceau ajouté.
  assert.deepEqual(applyRollback(map, 2, 40), map);

  assert.throws(() => applyRollback(map, 2, 10), RangeError, "offset hors du morceau");
  assert.throws(() => applyRollback(map, 2, 100), RangeError, "offset égal à la fin");
  assert.throws(() => applyRollback(map, 42, 50), Error, "morceau inconnu");
});

test("T-A-09 (carte, suite) : le morceau clos devant une reprise garde ses octets", () => {
  const map = mapWithStarts([0, 40, 80], 120);
  const withClosed = completeChunk(map, 1);
  const rolledBack = applyRollback(withClosed, 2, 60);

  const result = intervals(rolledBack);
  assert.deepEqual(
    result.map(({ start, end }) => [start, end]),
    [
      [0, 40],
      [40, 60],
      [60, 80],
      [80, 120],
    ],
    "le morceau 1 reste [0,40) : il n'hérite pas de la zone perdue",
  );
  assert.equal(result[0].completed, true);
  assert.equal(progress(rolledBack).downloaded, 40, "progression inchangée pour la partie acquise");
});

test("T-A-26 : une reprise ne repart jamais de zéro tant que la carte est valide", () => {
  let map = mapWithStarts([0, 30, 60], 90);
  map = completeChunk(map, 1);
  map = completeChunk(map, 2);
  const before = progress(map).downloaded;

  const reloaded = JSON.parse(JSON.stringify(map));
  assert.deepEqual(validateChunkMap(reloaded), { ok: true, errors: [] });
  assert.equal(progress(reloaded).downloaded, before, "les octets acquis sont conservés");
  assert.deepEqual(
    freeChunks(reloaded).map(({ id }) => id),
    [3],
    "seul le morceau inachevé est repris",
  );
});

test("clore deux fois le même morceau est idempotent, sans mutation", () => {
  const map = mapWithStarts([0, 50], 100);
  const once = completeChunk(map, 1);
  const twice = completeChunk(once, 1);
  assert.deepEqual(twice, once);
  assert.throws(() => completeChunk(map, 99), Error, "morceau inconnu");
});

test("createChunkMap refuse une taille inconnue plutôt que de deviner", () => {
  assert.throws(() => createChunkMap({ ...BASE, totalSize: -1 }), TypeError);
  assert.throws(() => createChunkMap({ ...BASE, totalSize: 1.5 }), TypeError);
  assert.throws(() => createChunkMap({ ...BASE, chunkSize: 0 }), TypeError);
});
