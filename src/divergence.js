/**
 * Détection de divergence entre connexions (`EX-A-10`, `D-025`).
 *
 * Deux connexions qui demandent des plages différentes du **même** fichier
 * doivent voir des octets cohérents. IDM compare les zones de recouvrement
 * (annexe 14 §5.5) ; quand deux vues divergent, il abandonne le multi-connexion
 * et reprend à une seule — c'est cette règle que `createDivergenceGuard`
 * applique.
 *
 * Convention retenue (`D-039`) : chaque connexion demande, en plus de son
 * morceau `[start, end)`, les `overlap` octets qui le précèdent (dans la limite
 * du début du fichier). Ces octets forment la fenêtre `[start-overlap, start)`,
 * que le morceau précédent possède déjà comme fin de son propre intervalle. Les
 * deux vues sont donc hachées séparément, à la même clé `start-overlap` : une
 * différence de condensat signe une divergence de contenu.
 *
 * Aucune dépendance : `node:crypto`.
 *
 * @module divergence
 */

import { createHash } from 'node:crypto';

/** Repli de recouvrement minimal, en octets. */
export const MIN_OVERLAP = 64;

/** Repli par défaut : assez large pour ne pas confondre deux contenus proches. */
export const DEFAULT_OVERLAP = 1024;

/**
 * @param {Uint8Array} bytes
 * @returns {string} condensat SHA-256 en hexadécimal
 */
export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Début de la requête pour un morceau, recouvrement inclus.
 * @param {number} start
 * @param {number} overlap
 * @returns {number}
 */
export function requestStart(start, overlap = DEFAULT_OVERLAP) {
  if (!Number.isInteger(start) || start < 0) throw new RangeError(`start invalide : ${start}`);
  const window = Math.max(MIN_OVERLAP, overlap);
  return Math.max(0, start - window);
}

/**
 * Nombre d'octets de recouvrement réellement disponibles avant `start`.
 * @param {number} start
 * @param {number} overlap
 * @returns {number}
 */
export function overlapBefore(start, overlap = DEFAULT_OVERLAP) {
  return start - requestStart(start, overlap);
}

/**
 * Clé d'une fenêtre de recouvrement : offset absolu de son premier octet.
 * @param {number} boundary
 * @param {number} overlap
 * @returns {number}
 */
export function overlapKey(boundary, overlap = DEFAULT_OVERLAP) {
  return requestStart(boundary, overlap);
}

/**
 * Condensats des fenêtres d'un flux : premiers et derniers `overlap` octets.
 *
 * Le flux est consommé au fil de l'eau (aucune rétention du morceau entier) :
 * seule une fenêtre glissante de `overlap` octets est conservée pour la traîne.
 */
export class WindowHashes {
  /**
   * @param {number} [overlap]
   */
  constructor(overlap = DEFAULT_OVERLAP) {
    this.overlap = Math.max(MIN_OVERLAP, overlap);
    this.total = 0;
    this._lead = createHash('sha256');
    this._leadBytes = 0;
    /** @type {Buffer} */
    this._tail = Buffer.alloc(0);
  }

  /**
   * Ajoute des octets au flux.
   * @param {Uint8Array} bytes
   * @returns {this}
   */
  update(bytes) {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (this._leadBytes < this.overlap) {
      const take = Math.min(this.overlap - this._leadBytes, buffer.byteLength);
      this._lead.update(buffer.subarray(0, take));
      this._leadBytes += take;
    }
    const merged = this._tail.byteLength === 0 ? buffer : Buffer.concat([this._tail, buffer]);
    const keep = Math.min(this.overlap, merged.byteLength);
    this._tail = Buffer.from(merged.subarray(merged.byteLength - keep));
    this.total += buffer.byteLength;
    return this;
  }

  /**
   * Condensat des `n` premiers octets reçus (`n = min(overlap, total)`).
   * @returns {string}
   */
  lead() {
    const hash = this._lead.copy();
    return hash.digest('hex');
  }

  /**
   * Condensat des `n` derniers octets reçus (`n = min(overlap, total)`).
   * @returns {string}
   */
  trail() {
    return digest(this._tail);
  }

  /** Nombre d'octets vus. */
  get received() {
    return this.total;
  }
}

/**
 * Registre des fenêtres déjà vues, avec détection de contradiction.
 *
 * Une même fenêtre absolue vue deux fois avec des condensats différents est une
 * **divergence** : l'objet passe alors en état `divergent` et toute écriture
 * ultérieure est refusée (`EX-A-10`).
 */
export class DivergenceGuard {
  /**
   * @param {{overlap?: number}} [options]
   */
  constructor({ overlap = DEFAULT_OVERLAP } = {}) {
    this.overlap = Math.max(MIN_OVERLAP, overlap);
    /** @type {Map<number, string>} */
    this.windows = new Map();
    this.divergent = false;
    /** @type {{key: number, expected: string, actual: string} | null} */
    this.firstConflict = null;
  }

  /**
   * Enregistre le condensat d'une fenêtre commençant à `key`.
   * @param {number} key offset absolu du premier octet de la fenêtre
   * @param {string} hex
   * @returns {'ok' | 'divergent'}
   */
  record(key, hex) {
    if (this.divergent) return 'divergent';
    const known = this.windows.get(key);
    if (known === undefined) {
      this.windows.set(key, hex);
      return 'ok';
    }
    if (known === hex) return 'ok';
    this.divergent = true;
    this.firstConflict = { key, expected: known, actual: hex };
    return 'divergent';
  }

  /**
   * Enregistre la fenêtre de recouvrement vue **avant** un morceau.
   * @param {number} start borne basse du morceau
   * @param {Uint8Array} bytes octets reçus en tête de requête
   * @returns {'ok' | 'divergent' | 'skipped'}
   */
  recordLead(start, bytes) {
    const available = overlapBefore(start, this.overlap);
    // Seules les fenêtres **pleines** sont comparables : une fenêtre courte a une
    // autre clé des deux côtés du morceau, donc rien à confronter.
    if (available < this.overlap) return 'skipped';
    const relevant = bytes.subarray(0, available);
    if (relevant.byteLength < available) return 'skipped';
    return this.record(start - available, digest(relevant));
  }

  /**
   * Enregistre la fenêtre de fin d'un morceau (les `overlap` derniers octets).
   * @param {number} end borne haute du morceau
   * @param {Uint8Array} tailBytes derniers `overlap` octets reçus
   * @returns {'ok' | 'divergent' | 'skipped'}
   */
  recordTrail(end, tailBytes) {
    if (end < this.overlap || tailBytes.byteLength < this.overlap) return 'skipped';
    const window = tailBytes.subarray(tailBytes.byteLength - this.overlap);
    return this.record(end - this.overlap, digest(window));
  }
}
