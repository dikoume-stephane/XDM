import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OVERLAP,
  DivergenceGuard,
  MIN_OVERLAP,
  WindowHashes,
  digest,
  overlapBefore,
  overlapKey,
  requestStart,
} from '../src/divergence.js';

test('T-A-10 : géométrie du recouvrement', () => {
  assert.equal(DEFAULT_OVERLAP, 1024);
  assert.equal(requestStart(0, 64), 0);
  assert.equal(requestStart(1000, 64), 936);
  assert.equal(requestStart(1000, 1), 1000 - MIN_OVERLAP, 'plancher MIN_OVERLAP');
  assert.equal(overlapBefore(0, 64), 0);
  assert.equal(overlapBefore(1000, 64), 64);
  assert.equal(overlapBefore(10, 64), 10);
  assert.equal(overlapKey(1000, 64), 936);
  assert.throws(() => requestStart(-1), /start invalide/);
});

test('T-A-10 : fenêtres de tête et de traîne d’un flux', () => {
  const bytes = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
  const hashes = new WindowHashes(64).update(bytes.subarray(0, 100)).update(bytes.subarray(100));
  assert.equal(hashes.received, 300);
  assert.equal(hashes.lead(), digest(bytes.subarray(0, 64)));
  assert.equal(hashes.trail(), digest(bytes.subarray(236)));
});

test('T-A-10 : une fenêtre vue deux fois avec des octets différents est divergente', () => {
  const guard = new DivergenceGuard({ overlap: 64 });
  const left = Buffer.alloc(64, 1);
  const right = Buffer.alloc(64, 2);

  assert.equal(guard.recordLead(0, left), 'skipped', 'rien avant le début du fichier');
  assert.equal(guard.recordTrail(128, left), 'ok');
  assert.equal(guard.recordLead(32, left), 'skipped', 'fenêtre incomplète (32 < 64)');
  assert.equal(guard.recordLead(128, left), 'ok', 'même fenêtre, mêmes octets');
  assert.equal(guard.recordLead(128, right), 'divergent');
  assert.equal(guard.divergent, true);
  assert.deepEqual(guard.firstConflict?.key, 64);
  // Une fois divergente, la garde refuse toute nouvelle écriture.
  assert.equal(guard.recordTrail(4096, Buffer.alloc(64, 3)), 'divergent');
});

test('T-A-10 : les fenêtres courtes ne sont jamais comparées', () => {
  const guard = new DivergenceGuard({ overlap: 64 });
  const short = Buffer.alloc(16, 9);
  assert.equal(guard.recordTrail(16, short), 'skipped');
  assert.equal(guard.recordLead(16, short), 'skipped');
  assert.equal(guard.divergent, false);
});
