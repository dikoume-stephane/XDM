#!/usr/bin/env node
/**
 * Banc d'essai local — sert de cible aux trois CLI, sans réseau ni dépendance.
 *
 * Pourquoi : les tests de `test/` sont hermétiques (serveurs montés puis refermés), et un
 * utilisateur qui veut **voir** marcher `xdm`, `xdm-grab` et `xdm-media` n'a aucun site sous la
 * main. Ce banc en fabrique un : un fichier gros mais reproductible, une page qui le cite, un
 * `robots.txt` qui interdit une branche, un fichier protégé par en-tête, un flux HLS dont les
 * segments exigent le même en-tête (`D-075`), et un journal de **chaque** requête reçue.
 *
 * Le journal est la partie qui compte : il permet de vérifier côté serveur ce que le client
 * prétend faire — un en-tête sur la playlist **et** sur les segments, un cookie posé par la
 * sonde et renvoyé avec les plages, une reprise qui redemande au bon offset.
 *
 * Usage :
 *   node tools/banc-essai.mjs                       # http://127.0.0.1:8080/
 *   node tools/banc-essai.mjs --port 9000 --taille 20M
 *   node tools/banc-essai.mjs --hote 0.0.0.0        # joignable depuis une VM Windows
 *
 * Options :
 *   --port N        port d'écoute (défaut 8080, 0 = choisi par le système)
 *   --hote ADRESSE  interface d'écoute (défaut 0.0.0.0 : la VM doit pouvoir joindre l'hôte)
 *   --taille T      taille de `/fichier.bin` (500K, 5M, 2G ; unités binaires, `src/size.js`)
 *   --calme         ne journalise pas les requêtes (utile pour un test de charge)
 *   --souffle N     secondes de silence de `/lent.bin` avant de finir (défaut 35 : au-delà du
 *                   seuil d'inactivité de 30 s de la cible, pour la phase P6 du protocole VM)
 *
 * `D-004` : ce banc ne met **aucun** cookie reel en jeu, aucun secret, aucun serveur tiers.
 */

import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { parseSize } from '../src/size.js';

/** Date fixe : `If-Modified-Since` doit pouvoir être testé sans horloge qui bouge. */
const LAST_MODIFIED = new Date('2025-01-01T00:00:00Z');
const ETAG = '"banc-essai-v1"';

/** Jeton attendu par `/protege.bin` et par le flux HLS. */
export const JETON = 'secret';

/**
 * Contenu reproductible : deux exécutions donnent les mêmes octets, donc les mêmes empreintes.
 * @param {number} size
 * @returns {Buffer}
 */
export function contenu(size) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 31 + 7) & 0xff;
  return buffer;
}

/**
 * Interprète `Range: bytes=a-b` (une seule plage, comme le moteur).
 * @param {string | undefined} header
 * @param {number} size
 * @returns {{start: number, end: number} | null}
 */
export function plageDemandee(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end = rawStart === '' || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || start > end || start >= size) return null;
  return { start, end };
}

/** Page d'accueil : trois liens de fichiers, une branche interdite et une page de suivi. */
const ACCUEIL = `<!doctype html><html><head><title>banc d'essai</title></head><body>
<h1>banc d'essai XDM</h1>
<ul>
  <li><a href="/a.html">page A</a></li>
  <li><a href="/b.html">page B</a></li>
  <li><a href="/fichier.bin">fichier.bin</a></li>
  <li><a href="/doc.pdf">doc.pdf</a></li>
  <li><a href="/session.bin">session.bin (cookie posé par la première requête)</a></li>
  <li><a href="/protege.bin">protege.bin (en-tête x-jeton: secret)</a></li>
  <li><a href="/lent.bin">lent.bin (silence de 35 s en cours de route)</a></li>
  <li><a href="/flux/index.m3u8">flux HLS (en-tête x-jeton: secret)</a></li>
  <li><a href="/prive/interdit.html">branche interdite par robots.txt</a></li>
</ul></body></html>`;

const PAGE_A = `<!doctype html><html><head><title>page A</title></head><body>
<h1>A</h1><a href="/fichier.bin">fichier.bin</a> <a href="/c.html">page C</a></body></html>`;

const PAGE_B = `<!doctype html><html><head><title>page B</title></head><body>
<h1>B</h1><a href="/doc.pdf">doc.pdf</a></body></html>`;

const PAGE_C = `<!doctype html><html><head><title>page C</title></head><body>
<h1>C</h1><a href="/fichier.bin">fichier.bin</a></body></html>`;

const PLAGE_INTERDITE = `<!doctype html><html><head><title>privé</title></head><body>
<h1>ne devrait jamais être aspiré</h1><a href="/fichier.bin">fichier.bin</a></body></html>`;

const FLUX = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg-1.ts
#EXTINF:4.0,
seg-2.ts
#EXT-X-ENDLIST
`;

/**
 * Construit le serveur (exporté pour être testé sans écouter sur un port).
 * @param {{taille?: number, journal?: (ligne: string) => void}} [options]
 * @returns {http.Server}
 */
export function creerBanc({ taille = 5 * 1024 * 1024, souffle = 35, journal = () => {} } = {}) {
  const fichier = contenu(taille);
  const petit = Buffer.from('contenu du document PDF de test\n', 'utf8');
  // `/lent.bin` : les 200 premiers Kio partent, puis le serveur **se tait** `souffle`
  // secondes. C'est la panne que la phase P6 du protocole VM doit provoquer : un client qui
  // ne coupe pas attend, un client qui reprend redemande au bon offset.
  const lent = contenu(Math.min(taille, 1024 * 1024));
  // `/session.bin` : la **première** requête (la sonde) est admise sans cookie et en pose un ;
  // toutes les suivantes l'exigent. C'est exactement ce que `xdm --cookies` doit savoir faire
  // (`D-076`, `T-A-24`) — sans le magasin, les plages repartent en 401.
  let amnisties = 1;

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://banc.local');
    const chemin = url.pathname;
    const plage = plageDemandee(req.headers.range, fichier.length);
    const jeton = req.headers['x-jeton'] === JETON;
    const cookie = String(req.headers.cookie ?? '').includes('session=ok');
    const noter = (statut, detail = '') => journal(
      `${req.method} ${chemin} ${statut} range=${req.headers.range ?? '-'} `
      + `ims=${req.headers['if-modified-since'] ? 'oui' : 'non'} `
      + `jeton=${jeton ? 'oui' : 'non'} cookie=${cookie ? 'oui' : 'non'}${detail ? ` ${detail}` : ''}`,
    );

    /** Sert un tampon avec plages, `ETag` et `Last-Modified`. */
    const servir = (contenuServi, type) => {
      const entetes = {
        'content-type': type,
        'accept-ranges': 'bytes',
        etag: ETAG,
        'last-modified': LAST_MODIFIED.toUTCString(),
      };
      // `If-Modified-Since` : un 304 est un succès, pas une erreur (`D-070`).
      const depuis = req.headers['if-modified-since'];
      if (depuis && Date.parse(depuis) >= LAST_MODIFIED.getTime()) {
        res.writeHead(304, entetes);
        res.end();
        noter(304);
        return;
      }
      const sousPlage = plageDemandee(req.headers.range, contenuServi.length);
      if (sousPlage) {
        const body = contenuServi.subarray(sousPlage.start, sousPlage.end + 1);
        res.writeHead(206, {
          ...entetes,
          'content-range': `bytes ${sousPlage.start}-${sousPlage.end}/${contenuServi.length}`,
          'content-length': String(body.length),
        });
        res.end(body);
        noter(206, `octets=${sousPlage.start}-${sousPlage.end}`);
        return;
      }
      res.writeHead(200, { ...entetes, 'content-length': String(contenuServi.length) });
      res.end(contenuServi);
      noter(200);
    };

    switch (chemin) {
      case '/':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(ACCUEIL);
        noter(200);
        return;
      case '/a.html':
      case '/b.html':
      case '/c.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(chemin === '/a.html' ? PAGE_A : chemin === '/b.html' ? PAGE_B : PAGE_C);
        noter(200);
        return;
      case '/robots.txt':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('User-agent: *\nDisallow: /prive\n');
        noter(200);
        return;
      case '/prive/interdit.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PLAGE_INTERDITE);
        noter(200);
        return;
      case '/fichier.bin':
        servir(fichier, 'application/octet-stream');
        return;
      case '/doc.pdf':
        servir(petit, 'application/pdf');
        return;
      case '/session.bin': {
        if (!cookie) {
          if (amnisties === 0) {
            res.writeHead(401, { 'content-length': '0' });
            res.end();
            noter(401);
            return;
          }
          amnisties -= 1;
        }
        const sousPlage = plageDemandee(req.headers.range, fichier.length);
        const entetes = {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'set-cookie': 'session=ok; Path=/; Max-Age=3600',
        };
        if (sousPlage) {
          const body = fichier.subarray(sousPlage.start, sousPlage.end + 1);
          res.writeHead(206, {
            ...entetes,
            'content-range': `bytes ${sousPlage.start}-${sousPlage.end}/${fichier.length}`,
            'content-length': String(body.length),
          });
          res.end(body);
          noter(206, `octets=${sousPlage.start}-${sousPlage.end}`);
          return;
        }
        res.writeHead(200, { ...entetes, 'content-length': String(fichier.length) });
        res.end(fichier);
        noter(200);
        return;
      }
      case '/lent.bin': {
        const sousPlage = plageDemandee(req.headers.range, lent.length);
        const debut = sousPlage ? sousPlage.start : 0;
        const fin = sousPlage ? sousPlage.end : lent.length - 1;
        res.writeHead(sousPlage ? 206 : 200, {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          ...(sousPlage
            ? { 'content-range': `bytes ${debut}-${fin}/${lent.length}` }
            : {}),
          'content-length': String(fin - debut + 1),
        });
        res.write(lent.subarray(debut, Math.min(debut + 200 * 1024, fin + 1)));
        setTimeout(() => {
          res.end(lent.subarray(Math.min(debut + 200 * 1024, fin + 1), fin + 1));
          noter(res.statusCode, `silence=${souffle}s`);
        }, souffle * 1000);
        return;
      }
      case '/protege.bin':
        // L'en-tête est exigé sur **toutes** les requêtes, sonde comprise : c'est la preuve
        // que `--entete` ne s'arrête pas au premier appel (`D-069`, `D-075`).
        if (!jeton) {
          res.writeHead(401, { 'content-length': '0' });
          res.end();
          noter(401);
          return;
        }
        servir(fichier, 'application/octet-stream');
        return;
      case '/flux/index.m3u8':
        if (!jeton) {
          res.writeHead(401, { 'content-length': '0' });
          res.end();
          noter(401);
          return;
        }
        // La playlist **pose** le cookie ; les segments l'exigent (`D-075`, `T-D-11`).
        res.writeHead(200, {
          'content-type': 'application/vnd.apple.mpegurl',
          'content-length': String(Buffer.byteLength(FLUX)),
          'set-cookie': `session=ok; Path=/; Max-Age=3600`,
        });
        res.end(FLUX);
        noter(200);
        return;
      case '/flux/init.mp4':
      case '/flux/seg-1.ts':
      case '/flux/seg-2.ts': {
        if (!jeton && !cookie) {
          res.writeHead(401, { 'content-length': '0' });
          res.end();
          noter(401);
          return;
        }
        const body = contenu(64 * 1024);
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(body.length) });
        res.end(body);
        noter(200);
        return;
      }
      default:
        res.writeHead(404, { 'content-length': '0' });
        res.end();
        noter(404);
    }
  });
}

/** Adresse IPv4 non locale, pour l'annonce « depuis une VM ». */
function adresseLocale() {
  for (const cartes of Object.values(networkInterfaces())) {
    for (const carte of cartes ?? []) {
      if (carte.family === 'IPv4' && !carte.internal) return carte.address;
    }
  }
  return null;
}

/** Point d'entrée : `node tools/banc-essai.mjs` (jamais importé par les tests). */
async function principal() {
  const argv = process.argv.slice(2);
  let port = 8080;
  let hote = '0.0.0.0';
  let taille = 5 * 1024 * 1024;
  let calme = false;
  let souffle = 35;
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--port') {
      i += 1;
      port = Number(argv[i]);
      if (!Number.isInteger(port) || port < 0) throw new Error('--port attend un entier ≥ 0');
    } else if (argument === '--hote') {
      i += 1;
      hote = argv[i];
    } else if (argument === '--taille') {
      i += 1;
      taille = parseSize(argv[i]);
    } else if (argument === '--calme') {
      calme = true;
    } else if (argument === '--souffle') {
      i += 1;
      souffle = Number(argv[i]);
      if (!Number.isFinite(souffle) || souffle < 0) throw new Error('--souffle attend un nombre ≥ 0');
    } else if (argument === '--aide' || argument === '-h') {
      console.log('usage : banc-essai [--port N] [--hote ADRESSE] [--taille T] [--calme] [--souffle S]');
      return;
    } else {
      throw new Error(`argument inconnu : ${argument}`);
    }
  }

  const banc = creerBanc({
    taille,
    souffle,
    journal: calme ? () => {} : (ligne) => console.log(`[req] ${ligne}`),
  });
  await new Promise((done) => banc.listen(port, hote, done));
  const { port: reel } = banc.address();
  const locale = adresseLocale();
  console.log(`banc d'essai : http://127.0.0.1:${reel}/`);
  if (locale) console.log(`depuis une VM : http://${locale}:${reel}/  (pare-feu à ouvrir)`);
  console.log(`taille de /fichier.bin : ${taille} octets ; jeton protégé : x-jeton: ${JETON}`);
  console.log(`/lent.bin s'interrompt ${souffle} s après 200 Kio (phase P6 du protocole VM)`);
  console.log('Ctrl-C pour arrêter.');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1))) {
  principal().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
