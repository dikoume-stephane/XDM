#!/usr/bin/env node
/**
 * Aperçu d'un fichier HTML statique, sans dépendance.
 *
 * Sert un **seul** fichier à la racine, quel que soit le chemin demandé : c'est ce qu'il faut
 * pour montrer une maquette ou un rapport à quelqu'un qui n'a pas de serveur sous la main.
 * Aucun répertoire n'est exposé (pas de liste de fichiers, pas de `..`), ce qui évite de
 * publier le dépôt entier pour afficher une page.
 *
 * Usage :
 *   node tools/apercu.mjs docs/maquettes/interface-xdm.html
 *   node tools/apercu.mjs <fichier.html> --port 8100 --hote 0.0.0.0
 *
 * Écoute par défaut sur `0.0.0.0` : une page servie sur la boucle locale seule n'est visible
 * ni depuis une VM, ni depuis l'aperçu du bac à sable.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Types servis : une maquette est du HTML, une capture peut être une image. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.md': 'text/plain; charset=utf-8',
};

/**
 * Crée le serveur d'aperçu.
 * @param {string} file chemin du fichier à servir
 * @returns {http.Server}
 */
export function createPreviewServer(file) {
  const path = resolve(file);
  const type = TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';

  return http.createServer(async (req, res) => {
    // Tout chemin rend le même fichier : la page n'a aucune ressource externe.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-length': '0' });
      res.end();
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(body.length),
        // Un aperçu se recharge souvent : pas de cache, sinon on montre l'ancienne version.
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`lecture impossible : ${path}\n${error.message}\n`);
    }
  });
}

/** Point d'entrée : `node tools/apercu.mjs <fichier> [--port N] [--hote ADRESSE]`. */
async function principal() {
  const argv = process.argv.slice(2);
  /** @type {string[]} */
  const positionnels = [];
  let port = 8100;
  let hote = '0.0.0.0';

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') {
      i += 1;
      port = Number(argv[i]);
      if (!Number.isInteger(port) || port < 0) throw new Error('--port attend un entier ≥ 0');
    } else if (argv[i] === '--hote') {
      i += 1;
      hote = argv[i];
    } else if (argv[i] === '--aide' || argv[i] === '-h') {
      console.log('usage : apercu <fichier.html> [--port N] [--hote ADRESSE]');
      return;
    } else if (argv[i].startsWith('--')) {
      throw new Error(`option inconnue : ${argv[i]}`);
    } else {
      positionnels.push(argv[i]);
    }
  }

  const fichier = positionnels[0];
  if (!fichier) throw new Error('usage : apercu <fichier.html> [--port N] [--hote ADRESSE]');

  const serveur = createPreviewServer(fichier);
  await new Promise((done) => serveur.listen(port, hote, done));
  console.log(`aperçu : http://127.0.0.1:${serveur.address().port}/  (${resolve(fichier)})`);
  console.log('Ctrl-C pour arrêter.');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1))) {
  principal().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
