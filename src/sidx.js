/**
 * Lecture d'index MP4 `sidx` et parcours de boîtes — lot `WP-26`, fiche D (`EX-D-08`).
 *
 * Dans un flux DASH, l'index des segments est **dans le fichier** : une boîte `sidx`
 * énumère chaque sous-segment par sa taille, ce qui suffit à retrouver ses octets par
 * `Range`. C'est exactement le rôle de `CSidxParser` et `CMp4DashReader` dans `IDMan.exe`
 * (annexe 15 §3.2) ; ce module en fait la version XDM, sans parseur de manifeste `MPD`
 * (`H-19` : IDM n'en a pas non plus).
 *
 * Ce module ne fait aucun accès réseau ni disque : il lit des octets.
 *
 * @module sidx
 */

/** Types de boîtes utiles à un flux segmenté. */
export const MEDIA_BOXES = /** @type {const} */ (['ftyp', 'moov', 'moof', 'mdat', 'sidx', 'styp', 'emsg']);

/**
 * Parcourt les boîtes d'un tampon, au niveau `start` demandé.
 *
 * Une boîte se termine avant `end` : un en-tête tronqué arrête le parcours sans lever,
 * parce qu'un flux peut être lu par tranches.
 *
 * @param {Buffer} buffer
 * @param {number} [start]
 * @param {number} [end]
 * @returns {{type: string, offset: number, size: number, headerSize: number,
 *   dataStart: number, dataEnd: number}[]}
 */
export function parseBoxes(buffer, start = 0, end = buffer.length) {
  const boxes = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = buffer.readUInt32BE(cursor);
    const type = buffer.toString('latin1', cursor + 4, cursor + 8);
    let headerSize = 8;
    if (size === 1) {
      if (cursor + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(cursor + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - cursor;
    }
    if (size < headerSize || cursor + size > end) break;
    boxes.push({
      type,
      offset: cursor,
      size,
      headerSize,
      dataStart: cursor + headerSize,
      dataEnd: cursor + size,
    });
    cursor += size;
  }
  return boxes;
}

/**
 * Cherche la première boîte d'un type donné, en profondeur 1 (`moov` → `trak` → …).
 *
 * @param {Buffer} buffer
 * @param {string} type
 * @param {{start?: number, end?: number}} [range]
 * @returns {object | null}
 */
export function findBox(buffer, type, { start = 0, end = buffer.length } = {}) {
  for (const box of parseBoxes(buffer, start, end)) {
    if (box.type === type) return box;
    if (box.type === 'moov' || box.type === 'trak' || box.type === 'mdia' || box.type === 'minf') {
      const found = findBox(buffer, type, { start: box.dataStart, end: box.dataEnd });
      if (found) return found;
    }
  }
  return null;
}

/**
 * Lit une boîte `sidx` (ISO/IEC 14496-12 §8.16.3).
 *
 * @param {Buffer} buffer
 * @param {object} box boîte `sidx` issue de {@link parseBoxes}
 * @returns {{version: number, flags: number, referenceId: number, timescale: number,
 *   earliestPresentationTime: number, firstOffset: number,
 *   references: {referenceType: number, size: number, duration: number,
 *     startsWithSap: boolean, sapType: number, sapDeltaTime: number}[],
 *   segments: {index: number, offset: number, size: number, duration: number,
 *     startsWithSap: boolean}[]}}
 */
export function parseSidx(buffer, box) {
  let cursor = box.dataStart;
  const version = buffer.readUInt8(cursor);
  const flags = buffer.readUIntBE(cursor + 1, 3);
  cursor += 4;
  const referenceId = buffer.readUInt32BE(cursor);
  const timescale = buffer.readUInt32BE(cursor + 4);
  cursor += 8;
  let earliestPresentationTime;
  let firstOffset;
  if (version === 0) {
    earliestPresentationTime = buffer.readUInt32BE(cursor);
    firstOffset = buffer.readUInt32BE(cursor + 4);
    cursor += 8;
  } else {
    earliestPresentationTime = Number(buffer.readBigUInt64BE(cursor));
    firstOffset = Number(buffer.readBigUInt64BE(cursor + 8));
    cursor += 16;
  }
  if (cursor + 4 > box.dataEnd) throw new Error('sidx tronqué : en-tête incomplet');
  cursor += 2; // reserved
  const referenceCount = buffer.readUInt16BE(cursor);
  cursor += 2;

  /** @type {any[]} */
  const references = [];
  for (let i = 0; i < referenceCount; i += 1) {
    if (cursor + 12 > box.dataEnd) throw new Error('sidx tronqué : références incomplètes');
    const first = buffer.readUInt32BE(cursor);
    const duration = buffer.readUInt32BE(cursor + 4);
    const third = buffer.readUInt32BE(cursor + 8);
    references.push({
      referenceType: first >>> 31,
      size: first & 0x7fffffff,
      duration,
      startsWithSap: (third & 0x80000000) !== 0,
      sapType: (third >>> 28) & 0x7,
      sapDeltaTime: third & 0x0fffffff,
    });
    cursor += 12;
  }

  // Les données indexées commencent après la boîte, décalées de `firstOffset`.
  let offset = box.dataEnd + firstOffset;
  const segments = references.map((reference, index) => {
    const segment = {
      index,
      offset,
      size: reference.size,
      duration: reference.duration,
      startsWithSap: reference.startsWithSap,
    };
    offset += reference.size;
    return segment;
  });

  return {
    version,
    flags,
    referenceId,
    timescale,
    earliestPresentationTime,
    firstOffset,
    references,
    segments,
  };
}

/**
 * Index d'un fichier MP4 segmenté : boîtes de premier niveau et segments indexés.
 *
 * @param {Buffer} buffer
 * @returns {{boxes: {type: string, offset: number, size: number}[],
 *   sidx: ReturnType<typeof parseSidx> | null}}
 */
export function readMp4Index(buffer) {
  const boxes = parseBoxes(buffer);
  const box = boxes.find((candidate) => candidate.type === 'sidx')
    ?? findBox(buffer, 'sidx');
  return {
    boxes: boxes.map(({ type, offset, size }) => ({ type, offset, size })),
    sidx: box ? parseSidx(buffer, box) : null,
  };
}
