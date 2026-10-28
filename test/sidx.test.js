import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findBox, parseBoxes, parseSidx, readMp4Index } from '../src/sidx.js';

/** Construit une boîte MP4 : taille sur 4 octets, type sur 4, puis la charge. */
function box(type, payload) {
  const buffer = Buffer.alloc(8 + payload.length);
  buffer.writeUInt32BE(8 + payload.length, 0);
  buffer.write(type, 4, 'latin1');
  payload.copy(buffer, 8);
  return buffer;
}

/** Construit une boîte `sidx` avec les tailles de sous-segments demandées. */
function sidxBox({ version = 0, referenceId = 1, timescale = 90000, references = [] }) {
  const header = Buffer.alloc(version === 0 ? 16 : 24);
  header.writeUInt32BE(referenceId, 0);
  header.writeUInt32BE(timescale, 4);
  if (version === 0) {
    header.writeUInt32BE(0, 8); // earliest_presentation_time
    header.writeUInt32BE(0, 12); // first_offset
  } else {
    header.writeBigUInt64BE(0n, 8);
    header.writeBigUInt64BE(0n, 16);
  }
  const count = Buffer.alloc(4);
  count.writeUInt16BE(references.length, 2);
  const entries = Buffer.alloc(12 * references.length);
  references.forEach((size, index) => {
    entries.writeUInt32BE(size & 0x7fffffff, index * 12); // reference_type = 0
    entries.writeUInt32BE(2000, index * 12 + 4); // 2000 / timescale
    entries.writeUInt32BE(0x90000000, index * 12 + 8); // SAP + type 1
  });
  const prefix = Buffer.alloc(4);
  prefix.writeUInt8(version, 0);
  return box('sidx', Buffer.concat([prefix, header, count, entries]));
}

test('T-D-08 : parcours des boîtes MP4 de premier niveau', () => {
  const ftyp = box('ftyp', Buffer.from('iso6\0\0\0\0', 'latin1'));
  const styp = box('styp', Buffer.alloc(4));
  const mdat = box('mdat', Buffer.alloc(10));
  const buffer = Buffer.concat([ftyp, styp, mdat]);

  const boxes = parseBoxes(buffer);
  assert.deepEqual(boxes.map((b) => b.type), ['ftyp', 'styp', 'mdat']);
  assert.deepEqual(boxes.map((b) => b.offset), [0, 16, 28]);
  assert.equal(boxes[2].size, 18);

  // Une boîte tronquée arrête le parcours sans lever (lecture par tranches).
  assert.deepEqual(parseBoxes(buffer.subarray(0, buffer.length - 5)).map((b) => b.type), ['ftyp', 'styp']);
  // Taille 0 : la boîte occupe jusqu'à la fin.
  const zero = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('mdat', 'latin1'), Buffer.alloc(6)]);
  assert.equal(parseBoxes(zero)[0].size, zero.length);
});

test('T-D-08 : un index sidx donne les plages exactes des sous-segments', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const sidx = sidxBox({ references: [1000, 2000, 500] });
  const buffer = Buffer.concat([ftyp, sidx, Buffer.alloc(4000)]);

  const parsed = parseSidx(buffer, parseBoxes(buffer)[1]);
  assert.equal(parsed.version, 0);
  assert.equal(parsed.referenceId, 1);
  assert.equal(parsed.timescale, 90000);
  assert.equal(parsed.firstOffset, 0);
  assert.deepEqual(parsed.references.map((r) => r.size), [1000, 2000, 500]);
  assert.equal(parsed.references[0].startsWithSap, true);
  assert.equal(parsed.references[0].referenceType, 0);

  // Les données indexées commencent juste après la boîte `sidx`.
  const dataStart = ftyp.length + sidx.length;
  assert.deepEqual(parsed.segments.map((s) => [s.offset, s.size]), [
    [dataStart, 1000],
    [dataStart + 1000, 2000],
    [dataStart + 3000, 500],
  ]);
  assert.equal(parsed.segments[1].duration, 2000);
});

test('T-D-08 : version 1 (temps 64 bits) et sidx imbriqué dans moov/trak', () => {
  const v1 = sidxBox({ version: 1, timescale: 1000, references: [300] });
  const bufferV1 = Buffer.concat([v1, Buffer.alloc(400)]);
  const parsed = parseSidx(bufferV1, parseBoxes(bufferV1)[0]);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.timescale, 1000);
  assert.deepEqual(parsed.segments.map((s) => s.size), [300]);

  const inner = sidxBox({ references: [128, 256] });
  const trak = box('trak', inner);
  const moov = box('moov', trak);
  const buffer = Buffer.concat([box('ftyp', Buffer.alloc(8)), moov, Buffer.alloc(512)]);
  const found = findBox(buffer, 'sidx');
  assert.ok(found, 'sidx trouvé dans moov/trak');
  assert.equal(found.type, 'sidx');
  assert.equal(parseSidx(buffer, found).segments.length, 2);
});

test('T-D-08 : index absent ou tronqué se dit, ne devine pas', () => {
  const withoutSidx = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('mdat', Buffer.alloc(64))]);
  assert.deepEqual(readMp4Index(withoutSidx).boxes.map((b) => b.type), ['ftyp', 'mdat']);
  assert.equal(readMp4Index(withoutSidx).sidx, null);

  const withSidx = Buffer.concat([sidxBox({ references: [10] }), Buffer.alloc(10)]);
  assert.equal(readMp4Index(withSidx).sidx.segments.length, 1);

  const truncated = sidxBox({ references: [10, 20, 30] }).subarray(0, 40);
  const buffer = Buffer.concat([truncated, Buffer.alloc(64)]);
  buffer.writeUInt32BE(truncated.length, 0); // taille annoncée = réel, mais références coupées
  assert.throws(() => parseSidx(buffer, parseBoxes(buffer)[0]), /sidx tronqué/);
});
