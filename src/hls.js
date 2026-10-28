/**
 * Analyseur de playlist HLS (`m3u8`) — lot `WP-26`, fiche D (`EX-D-01`→`EX-D-07`, `EX-D-09`).
 *
 * Ce module ne fait **que** lire : il transforme un texte de playlist en description
 * typée (variantes, renditions, segments, clé, segment d'initialisation). Le
 * téléchargement des segments est dans `media.js`, le moteur de morceaux reste
 * `connection-loop.js` — aucune logique réseau ici.
 *
 * Périmètre assumé (`D-046`) :
 *  - balises reconnues : `#EXTM3U`, `#EXT-X-VERSION`, `#EXT-X-STREAM-INF`, `#EXT-X-MEDIA`,
 *    `#EXTINF`, `#EXT-X-MAP`, `#EXT-X-BYTERANGE`, `#EXT-X-KEY`, `#EXT-X-DISCONTINUITY`,
 *    `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-PLAYLIST-TYPE`, `#EXT-X-ENDLIST`,
 *    `#EXT-X-TARGETDURATION` ;
 *  - une clé `AES-128` est **lue et enregistrée**, jamais utilisée : XDM ne déchiffre rien
 *    (`D-004`, `EX-D-10`), il le dit.
 *
 * @module hls
 */

/** Types de playlist produits par {@link parsePlaylist}. */
export const PLAYLIST_TYPES = /** @type {const} */ (['master', 'media']);

/**
 * Découpe une liste d'attributs `NAME=VALUE,…` (RFC 8216 §4.2).
 *
 * Les valeurs peuvent être entre guillemets et contenir des virgules
 * (`CODECS="avc1.4d401f,mp4a.40.2"`), ce qui interdit un simple `split(',')`.
 *
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parseAttributes(raw) {
  /** @type {Record<string, string>} */
  const attributes = {};
  let index = 0;
  while (index < raw.length) {
    const equals = raw.indexOf('=', index);
    if (equals < 0) break;
    const name = raw.slice(index, equals).trim();
    let cursor = equals + 1;
    let value;
    if (raw[cursor] === '"') {
      const close = raw.indexOf('"', cursor + 1);
      const end = close < 0 ? raw.length : close;
      value = raw.slice(cursor + 1, end);
      cursor = end + 1;
    } else {
      let end = raw.indexOf(',', cursor);
      if (end < 0) end = raw.length;
      value = raw.slice(cursor, end).trim();
      cursor = end;
    }
    if (name) attributes[name] = value;
    const next = raw.indexOf(',', cursor);
    if (next < 0) break;
    index = next + 1;
  }
  return attributes;
}

/**
 * Lit `n` ou `n@offset` (`#EXT-X-BYTERANGE`).
 *
 * @param {string} raw
 * @returns {{length: number, offset: number | null}}
 */
export function parseByteRange(raw) {
  const [length, offset] = String(raw).trim().split('@');
  const parsed = { length: Number(length), offset: offset === undefined ? null : Number(offset) };
  if (!Number.isInteger(parsed.length) || parsed.length < 1) {
    throw new TypeError(`plage d'octets invalide : ${raw}`);
  }
  if (parsed.offset !== null && (!Number.isInteger(parsed.offset) || parsed.offset < 0)) {
    throw new TypeError(`plage d'octets invalide : ${raw}`);
  }
  return parsed;
}

/**
 * Résout une URI de playlist, qui peut être absolue, relative ou protocole-relatif.
 *
 * @param {string} base URL de la playlist
 * @param {string} reference
 * @returns {string}
 */
export function resolveUrl(base, reference) {
  return new URL(reference, base).toString();
}

/** Le texte est-il une playlist HLS ? */
export const isPlaylist = (text) => /^\uFEFF?#EXTM3U/.test(String(text).trimStart());

/**
 * Analyse une playlist HLS (master ou média).
 *
 * @param {string} text contenu du `.m3u8`
 * @param {{baseUrl?: string}} [options] URL de la playlist, pour résoudre les URI relatives
 * @returns {{type: 'master' | 'media', version: number | null, targetDuration: number | null,
 *   mediaSequence: number, playlistType: string | null, endList: boolean,
 *   variants: {url: string, bandwidth: number, averageBandwidth: number | null,
 *     resolution: string | null, codecs: string | null, audio: string | null,
 *     subtitles: string | null}[],
 *   renditions: {type: string, groupId: string, name: string, language: string | null,
 *     url: string | null, isDefault: boolean}[],
 *   map: {url: string, byteRange: {length: number, offset: number | null} | null} | null,
 *   segments: {index: number, url: string, duration: number, title: string | null,
 *     byteRange: {length: number, offset: number | null} | null, discontinuity: boolean,
 *     sequence: number, key: {method: string, url: string | null, iv: string | null} | null}[],
 *   key: {method: string, url: string | null, iv: string | null} | null}}
 */
export function parsePlaylist(text, { baseUrl = '' } = {}) {
  const source = String(text).replace(/^\uFEFF/, '');
  if (!isPlaylist(source)) throw new Error('playlist HLS invalide : #EXTM3U attendu');

  /** @type {any} */
  const playlist = {
    type: 'media',
    version: null,
    targetDuration: null,
    mediaSequence: 0,
    playlistType: null,
    endList: false,
    variants: [],
    renditions: [],
    map: null,
    segments: [],
    key: null,
  };
  const resolve = (reference) => (baseUrl ? resolveUrl(baseUrl, reference) : reference);

  let pendingDuration = null;
  let pendingTitle = null;
  let pendingStreamInf = null;
  let pendingByteRange = null;
  let discontinuity = false;
  /** fin de la dernière plage d'octets, pour l'offset implicite */
  let byteRangeEnd = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (!line.startsWith('#')) {
      // Ligne d'URI : elle appartient à la balise précédente.
      if (pendingStreamInf) {
        playlist.variants.push({ url: resolve(line), ...pendingStreamInf });
        pendingStreamInf = null;
        continue;
      }
      if (pendingDuration === null) continue; // URI orpheline : ignorée
      const byteRange = pendingByteRange
        ? { length: pendingByteRange.length, offset: pendingByteRange.offset ?? byteRangeEnd ?? 0 }
        : null;
      if (byteRange) byteRangeEnd = byteRange.offset + byteRange.length;
      playlist.segments.push({
        index: playlist.segments.length,
        url: resolve(line),
        duration: pendingDuration,
        title: pendingTitle,
        byteRange,
        discontinuity,
        sequence: playlist.mediaSequence + playlist.segments.length,
        key: playlist.key ? { ...playlist.key } : null,
      });
      pendingDuration = null;
      pendingTitle = null;
      pendingByteRange = null;
      discontinuity = false;
      continue;
    }

    const colon = line.indexOf(':');
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1);

    switch (tag) {
      case '#EXTM3U':
        break;
      case '#EXT-X-VERSION':
        playlist.version = Number(value);
        break;
      case '#EXT-X-TARGETDURATION':
        playlist.targetDuration = Number(value);
        break;
      case '#EXT-X-MEDIA-SEQUENCE':
        playlist.mediaSequence = Number(value);
        break;
      case '#EXT-X-PLAYLIST-TYPE':
        playlist.playlistType = value.trim();
        break;
      case '#EXT-X-ENDLIST':
        playlist.endList = true;
        break;
      case '#EXT-X-DISCONTINUITY':
        discontinuity = true;
        break;
      case '#EXT-X-STREAM-INF': {
        const attributes = parseAttributes(value);
        playlist.type = 'master';
        pendingStreamInf = {
          bandwidth: Number(attributes.BANDWIDTH ?? 0),
          averageBandwidth: attributes['AVERAGE-BANDWIDTH'] ? Number(attributes['AVERAGE-BANDWIDTH']) : null,
          resolution: attributes.RESOLUTION ?? null,
          codecs: attributes.CODECS ?? null,
          audio: attributes.AUDIO ?? null,
          subtitles: attributes.SUBTITLES ?? null,
        };
        break;
      }
      case '#EXT-X-MEDIA': {
        const attributes = parseAttributes(value);
        playlist.renditions.push({
          type: attributes.TYPE ?? 'AUDIO',
          groupId: attributes['GROUP-ID'] ?? '',
          name: attributes.NAME ?? '',
          language: attributes.LANGUAGE ?? null,
          url: attributes.URI ? resolve(attributes.URI) : null,
          isDefault: attributes.DEFAULT === 'YES',
        });
        break;
      }
      case '#EXTINF': {
        pendingDuration = Number(value.split(',')[0]);
        const title = value.includes(',') ? value.slice(value.indexOf(',') + 1).trim() : '';
        pendingTitle = title === '' ? null : title;
        break;
      }
      case '#EXT-X-BYTERANGE':
        pendingByteRange = parseByteRange(value);
        break;
      case '#EXT-X-MAP': {
        const attributes = parseAttributes(value);
        const range = attributes.BYTERANGE ? parseByteRange(attributes.BYTERANGE) : null;
        playlist.map = {
          url: resolve(attributes.URI ?? ''),
          byteRange: range ? { length: range.length, offset: range.offset ?? 0 } : null,
        };
        if (playlist.map.byteRange) {
          byteRangeEnd = playlist.map.byteRange.offset + playlist.map.byteRange.length;
        }
        break;
      }
      case '#EXT-X-KEY': {
        const attributes = parseAttributes(value);
        const method = (attributes.METHOD ?? 'NONE').toUpperCase();
        playlist.key = method === 'NONE'
          ? null
          : {
            method,
            url: attributes.URI ? resolve(attributes.URI) : null,
            iv: attributes.IV ?? null,
          };
        break;
      }
      default:
        // Balise inconnue : ignorée, jamais devinée (même règle que le crawler).
        break;
    }
  }

  return playlist;
}

/**
 * Variante à retenir : le débit le plus élevé (choix XDM, `D-046`).
 * @param {ReturnType<typeof parsePlaylist>} master
 * @param {{bandwidth?: number}} [options]
 * @returns {object | null}
 */
export function selectVariant(master, { bandwidth } = {}) {
  if (master.type !== 'master' || master.variants.length === 0) return null;
  if (bandwidth !== undefined) {
    const sorted = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth);
    return sorted.find((variant) => variant.bandwidth >= bandwidth) ?? sorted[sorted.length - 1];
  }
  return [...master.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
}
