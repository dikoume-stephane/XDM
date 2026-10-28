/**
 * Carte de morceaux d'un téléchargement XDM — modèle de données du domaine A.
 *
 * Dérivée de l'observation d'`IDMan.exe` (annexe 14 §5.1) et des décisions
 * D-030 / D-031 :
 *
 *  - un morceau est un **intervalle** `[start, next.start)` dans un fichier
 *    unique ; il n'y a **pas** de champ `end` (la fin se déduit du maillon
 *    suivant, exactement comme l'enregistrement `ChList` d'IDM qui ne stocke
 *    que `ID`, `startPos`, `nextID`) ;
 *  - la progression est **dérivée** de la carte (somme des intervalles clos),
 *    jamais persistée : elle ne peut donc pas diverger.
 *
 * Aucune dépendance, aucune E/S : ce module est du calcul pur, testable seul.
 */

/** Taille d'un morceau, en octets (2 MiB par défaut, cf. D-029). */
export const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;

/**
 * @typedef {object} Chunk
 * @property {number} id        identité stable, entier > 0
 * @property {number} start     borne basse inclusive dans le fichier final
 * @property {number} next      `id` du morceau suivant ; 0 = dernier
 * @property {boolean} completed morceau clos et vérifié
 */

/**
 * @typedef {object} ChunkMap
 * @property {number} version
 * @property {string} url
 * @property {string} target
 * @property {number} totalSize  taille attendue ; doit être > 0
 * @property {number} chunkSize  taille cible utilisée pour le découpage
 * @property {string} created    horodatage ISO 8601
 * @property {Chunk[]} chunks
 */

/**
 * Crée une carte neuve : un seul morceau couvrant tout le fichier.
 * @param {{url: string, target: string, totalSize: number, chunkSize?: number, created?: string}} init
 * @returns {ChunkMap}
 */
export function createChunkMap({ url, target, totalSize, chunkSize = DEFAULT_CHUNK_SIZE, created }) {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    throw new TypeError("totalSize doit être un entier strictement positif");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new TypeError("chunkSize doit être un entier strictement positif");
  }
  return {
    version: 1,
    url,
    target,
    totalSize,
    chunkSize,
    created: created ?? new Date(0).toISOString(),
    chunks: [{ id: 1, start: 0, next: 0, completed: false }],
  };
}

/**
 * Ordonne les morceaux selon le chaînage `next`, en partant de la tête
 * (le morceau que personne ne référence) et en détectant les cycles.
 * @param {Chunk[]} chunks
 * @returns {{order: Chunk[], errors: string[]}}
 */
export function chainOrder(chunks) {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const referenced = new Set(chunks.map((c) => c.next).filter((id) => id !== 0));
  const heads = chunks.filter((c) => !referenced.has(c.id));

  if (heads.length !== 1) {
    return { order: [], errors: [`tête de chaîne ambiguë : ${heads.length} morceaux non référencés`] };
  }
  const order = [];
  const seen = new Set();
  let current = heads[0];
  while (current) {
    if (seen.has(current.id)) {
      return { order: [], errors: [`cycle détecté sur le morceau ${current.id}`] };
    }
    seen.add(current.id);
    order.push(current);
    if (current.next === 0) break;
    const next = byId.get(current.next);
    if (!next) {
      return { order: [], errors: [`nextId ${current.next} orphelin (morceau ${current.id})`] };
    }
    current = next;
  }
  if (order.length !== chunks.length) {
    const missing = chunks.filter((c) => !seen.has(c.id)).map((c) => c.id);
    return { order: [], errors: [`morceaux hors chaîne : ${missing.join(", ")}`] };
  }
  return { order, errors: [] };
}

/**
 * Vérifie les 5 invariants de la fiche A (§3.1). Ne répare rien : une carte
 * invalide doit être **rejetée** (D-030), jamais corrigée en silence.
 * @param {unknown} map
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateChunkMap(map) {
  const errors = [];
  if (!map || typeof map !== "object") return { ok: false, errors: ["carte absente ou non-objet"] };

  const { totalSize, chunkSize, chunks } = /** @type {ChunkMap} */ (map);
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    errors.push("totalSize absent ou non strictement positif");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    errors.push("chunkSize absent ou non strictement positif");
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {
    errors.push("aucun morceau");
    return { ok: false, errors };
  }

  const ids = new Set();
  for (const c of chunks) {
    if (!Number.isSafeInteger(c.id) || c.id <= 0) errors.push(`id invalide : ${String(c.id)}`);
    if (ids.has(c.id)) errors.push(`id dupliqué : ${c.id}`);
    ids.add(c.id);
    if (!Number.isSafeInteger(c.start) || c.start < 0) errors.push(`start invalide (morceau ${c.id})`);
    if (!Number.isSafeInteger(c.next) || c.next < 0) errors.push(`next invalide (morceau ${c.id})`);
    if (typeof c.completed !== "boolean") errors.push(`completed non booléen (morceau ${c.id})`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const { order, errors: chainErrors } = chainOrder(chunks);
  if (chainErrors.length > 0) return { ok: false, errors: chainErrors };

  for (let i = 0; i < order.length; i += 1) {
    const current = order[i];
    const following = order[i + 1];
    const end = following ? following.start : totalSize;
    if (current.start >= end) {
      errors.push(`intervalle vide ou inversé (morceau ${current.id})`);
    }
    if (current.start >= totalSize) {
      errors.push(`morceau ${current.id} hors fichier (start >= totalSize)`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Intervalles effectifs, la fin étant **dérivée** du maillon suivant.
 * @param {ChunkMap} map
 * @returns {Array<{id: number, start: number, end: number, completed: boolean}>}
 */
export function intervals(map) {
  const { order } = chainOrder(map.chunks);
  return order.map((c, i) => ({
    id: c.id,
    start: c.start,
    end: i + 1 < order.length ? order[i + 1].start : map.totalSize,
    completed: c.completed,
  }));
}

/**
 * Progression dérivée (D-031) : somme des intervalles clos.
 * @param {ChunkMap} map
 * @returns {{downloaded: number, total: number, ratio: number}}
 */
export function progress(map) {
  let downloaded = 0;
  for (const interval of intervals(map)) {
    if (interval.completed) downloaded += interval.end - interval.start;
  }
  const total = map.totalSize;
  return { downloaded, total, ratio: total > 0 ? downloaded / total : 0 };
}

/**
 * Morceaux non clos, du plus gros au plus petit : sert à décider d'une
 * nouvelle connexion (`EX-A-07`) et de sa cible (`FindMaxFreeChunk` chez IDM).
 * @param {ChunkMap} map
 * @returns {Array<{id: number, start: number, end: number}>}
 */
export function freeChunks(map) {
  return intervals(map)
    .filter((i) => !i.completed)
    .map(({ id, start, end }) => ({ id, start, end }))
    .sort((a, b) => b.end - b.start - (a.end - a.start));
}

/**
 * Fusionne les morceaux de reprise **adjacents** (`A-21`, suite de `D-035`).
 *
 * `applyRollback` insère un morceau par coupure ; après plusieurs reprises, la
 * chaîne se couvre de morceaux courts, ce qui multiplierait les connexions pour
 * presque rien. Deux morceaux **incomplets** consécutifs décrivent une zone
 * continue : les fusionner ne change ni la couverture ni la progression, et un
 * morceau **clos** n'est jamais absorbé (il ne peut pas être redemandé).
 *
 * @param {ChunkMap} map
 * @returns {ChunkMap} nouvelle carte (aucune mutation)
 */
export function mergeResumeChunks(map) {
  const { order, errors } = chainOrder(map.chunks);
  if (errors.length > 0) throw new Error(`carte invalide : ${errors[0]}`);

  /** @type {Chunk[]} */
  const kept = [];
  for (const chunk of order) {
    const last = kept[kept.length - 1];
    if (last && !last.completed && !chunk.completed) continue; // absorbé par `last`
    kept.push({ ...chunk });
  }
  kept.forEach((chunk, index) => {
    chunk.next = index + 1 < kept.length ? kept[index + 1].id : 0;
  });

  return { ...structuredClone(map), chunks: kept };
}

/**
 * Clôt un morceau. Un morceau déjà clos est refusé (idempotence explicite).
 * @param {ChunkMap} map
 * @param {number} id
 * @returns {ChunkMap} nouvelle carte (aucune mutation)
 */
export function completeChunk(map, id) {
  const { order, errors } = chainOrder(map.chunks);
  if (errors.length > 0) throw new Error(`carte invalide : ${errors[0]}`);
  const index = order.findIndex((c) => c.id === id);
  if (index < 0) throw new Error(`morceau inconnu : ${id}`);
  if (order[index].completed) return structuredClone(map);

  const chunks = order.map((c, i) => (i === index ? { ...c, completed: true } : { ...c }));
  return { ...structuredClone(map), chunks };
}

/**
 * Rollback (EX-A-09) : les octets reçus après le dernier offset confirmé sont
 * perdus et doivent être **redemandés**.
 *
 * Avec la fin dérivée du maillon suivant (D-030), avancer simplement le `start`
 * du morceau volerait la queue de son prédécesseur, déjà clos. Le rollback
 * **rouvre donc la zone perdue sous la forme d'un nouveau morceau** inséré
 * devant celui qu'on reprend :
 *
 * ```text
 * avant : P [0,40) clos  ->  N [40,100) en cours
 * rollback de N à 55
 * après : P [0,40) clos  ->  R [40,55) à refaire  ->  N [55,100) en cours
 * ```
 *
 * Invariants préservés : chaîne strictement croissante, aucun morceau clos
 * n'annonce des octets qu'il ne possède pas, progression dérivée inchangée pour
 * les parties réellement acquises (D-031).
 *
 * @param {ChunkMap} map
 * @param {number} id morceau à reprendre
 * @param {number} validatedOffset dernier offset confirmé (borne basse après reprise)
 * @returns {ChunkMap}
 */
export function applyRollback(map, id, validatedOffset) {
  const { order, errors } = chainOrder(map.chunks);
  if (errors.length > 0) throw new Error(`carte invalide : ${errors[0]}`);
  const index = order.findIndex((c) => c.id === id);
  if (index < 0) throw new Error(`morceau inconnu : ${id}`);
  const interval = intervals(map).find((i) => i.id === id);

  if (!Number.isSafeInteger(validatedOffset)) throw new TypeError("offset de rollback non entier");
  if (validatedOffset < interval.start || validatedOffset >= interval.end) {
    throw new RangeError(
      `offset de rollback ${validatedOffset} hors du morceau ${id} [${interval.start}, ${interval.end})`,
    );
  }
  if (validatedOffset === interval.start) return structuredClone(map); // rien n'était acquis

  const lostId = Math.max(...map.chunks.map((c) => c.id)) + 1;
  /** Morceau qui reprend la zone perdue. */
  const lost = { id: lostId, start: interval.start, next: id, completed: false };

  const chunks = order.map((c) => {
    if (c.id === id) return { ...c, start: validatedOffset };
    if (index > 0 && c.id === order[index - 1].id) return { ...c, next: lostId };
    return { ...c };
  });
  chunks.splice(index, 0, lost);

  return { ...structuredClone(map), chunks };
}
