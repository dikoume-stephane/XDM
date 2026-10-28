import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPlaylist,
  parseAttributes,
  parseByteRange,
  parsePlaylist,
  resolveUrl,
  selectVariant,
} from '../src/hls.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Français",LANGUAGE="fr",DEFAULT=YES,URI="audio/fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
bas/360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
bas/720.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:41
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef0123456789abcdef
#EXTINF:6.006,premier
seg-a.m4s
#EXTINF:6.006,
seg-b.m4s
#EXT-X-DISCONTINUITY
#EXTINF:4.5,après coupure
seg-c.m4s
#EXT-X-ENDLIST
`;

test('T-D-01 : une playlist HLS se reconnaît à #EXTM3U, maître ou média', () => {
  assert.equal(isPlaylist(MASTER), true);
  assert.equal(isPlaylist('\uFEFF#EXTM3U\n#EXTINF:1,\na.ts'), true);
  assert.equal(isPlaylist('<html></html>'), false);
  assert.throws(() => parsePlaylist('pas une playlist'), /#EXTM3U attendu/);
});

test('T-D-02 : les variantes sont résolues et choisies par débit', () => {
  const master = parsePlaylist(MASTER, { baseUrl: 'https://cdn.example/flux/master.m3u8' });
  assert.equal(master.type, 'master');
  assert.equal(master.version, 3);
  assert.equal(master.variants.length, 2);
  assert.deepEqual(master.variants.map((v) => v.bandwidth), [800000, 2400000]);
  assert.equal(master.variants[0].url, 'https://cdn.example/flux/bas/360.m3u8');
  assert.equal(master.variants[0].resolution, '640x360');
  assert.equal(master.variants[0].codecs, 'avc1.4d401f,mp4a.40.2', 'virgule interne préservée');

  // Rendition audio alternative : URL résolue, groupe et langue conservés.
  assert.equal(master.renditions.length, 1);
  assert.deepEqual(master.renditions[0], {
    type: 'AUDIO',
    groupId: 'aud',
    name: 'Français',
    language: 'fr',
    url: 'https://cdn.example/flux/audio/fr.m3u8',
    isDefault: true,
  });

  assert.equal(selectVariant(master).bandwidth, 2400000, 'débit le plus élevé par défaut');
  assert.equal(selectVariant(master, { bandwidth: 1000000 }).bandwidth, 2400000);
  assert.equal(selectVariant(master, { bandwidth: 500000 }).bandwidth, 800000);
  assert.equal(selectVariant(parsePlaylist(MEDIA)), null, 'pas de variante dans une playlist média');
});

test('T-D-03 : segments, durées et séquences d’une playlist média', () => {
  const playlist = parsePlaylist(MEDIA, { baseUrl: 'https://cdn.example/v/720/index.m3u8' });
  assert.equal(playlist.type, 'media');
  assert.equal(playlist.playlistType, 'VOD');
  assert.equal(playlist.targetDuration, 6);
  assert.equal(playlist.endList, true);
  assert.equal(playlist.segments.length, 3);
  assert.deepEqual(playlist.segments.map((s) => s.url), [
    'https://cdn.example/v/720/seg-a.m4s',
    'https://cdn.example/v/720/seg-b.m4s',
    'https://cdn.example/v/720/seg-c.m4s',
  ]);
  assert.deepEqual(playlist.segments.map((s) => s.duration), [6.006, 6.006, 4.5]);
  assert.equal(playlist.segments[0].title, 'premier');
  assert.equal(playlist.segments[1].title, null);
  assert.deepEqual(playlist.segments.map((s) => s.sequence), [41, 42, 43],
    'la séquence suit #EXT-X-MEDIA-SEQUENCE');
  assert.deepEqual(playlist.segments.map((s) => s.discontinuity), [false, false, true]);
});

test('T-D-04 : segment d’initialisation et clé lue, jamais utilisée', () => {
  const playlist = parsePlaylist(MEDIA, { baseUrl: 'https://cdn.example/v/720/index.m3u8' });
  assert.deepEqual(playlist.map, {
    url: 'https://cdn.example/v/720/init.mp4',
    byteRange: { length: 720, offset: 0 },
  });
  assert.deepEqual(playlist.key, {
    method: 'AES-128',
    url: 'https://cdn.example/v/720/key.bin',
    iv: '0x0123456789abcdef0123456789abcdef',
  });
  assert.equal(playlist.segments[0].key.method, 'AES-128', 'chaque segment porte sa clé');

  // METHOD=NONE remet la clé à zéro pour les segments suivants.
  const cleared = parsePlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k"
#EXTINF:1,
a.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:1,
b.ts
`);
  assert.equal(cleared.segments[0].key.method, 'AES-128');
  assert.equal(cleared.segments[1].key, null);
});

test('T-D-05 : plages d’octets explicites puis implicites', () => {
  const playlist = parsePlaylist(`#EXTM3U
#EXT-X-VERSION:4
#EXTINF:4,
#EXT-X-BYTERANGE:1000@0
f.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:2000
f.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:500@9000
f.mp4
#EXTINF:4,
g.mp4
`, { baseUrl: 'http://h/' });
  assert.deepEqual(playlist.segments.map((s) => s.byteRange), [
    { length: 1000, offset: 0 },
    { length: 2000, offset: 1000 }, // implicite : suit la plage précédente
    { length: 500, offset: 9000 },
    null,
  ]);
  assert.deepEqual(parseByteRange('42'), { length: 42, offset: null });
  assert.deepEqual(parseByteRange('42@7'), { length: 42, offset: 7 });
  assert.throws(() => parseByteRange('0@1'), /plage d'octets invalide/);
});

test('T-D-07 : playlist de direct — pas de fin, séquence glissante', () => {
  const playlist = parsePlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:987654
#EXTINF:2,
live-1.ts
#EXTINF:2,
live-2.ts
`);
  assert.equal(playlist.endList, false);
  assert.equal(playlist.playlistType, null);
  assert.deepEqual(playlist.segments.map((s) => s.sequence), [987654, 987655]);
});

test('T-D-09 : balises inconnues ignorées, attributs entre guillemets', () => {
  assert.deepEqual(parseAttributes('BANDWIDTH=1,CODECS="a,b",NAME="x=y",RESOLUTION=1x2'), {
    BANDWIDTH: '1',
    CODECS: 'a,b',
    NAME: 'x=y',
    RESOLUTION: '1x2',
  });
  const playlist = parsePlaylist(`#EXTM3U
#EXT-X-FUTURE-TAG:VALUE=1,OTHER=2
#EXTINF:1,
a.ts
`);
  assert.equal(playlist.segments.length, 1);
  assert.equal(resolveUrl('https://a/b/c.m3u8', '../d.ts'), 'https://a/d.ts');
});

test('T-D-06 : une playlist chiffrée est signalée par la clé, pas déchiffrée', () => {
  const playlist = parsePlaylist(MEDIA);
  assert.equal(playlist.key.method, 'AES-128');
  const clear = parsePlaylist(`#EXTM3U
#EXTINF:1,
a.ts
`);
  assert.equal(clear.key, null);
});
