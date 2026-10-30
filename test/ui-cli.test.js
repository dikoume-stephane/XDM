import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { DEFAUTS, USAGE, main, parseArgs } from '../bin/xdm-ui.js';
import { VERSION } from '../src/version.js';

test('WP-51 : xdm-ui a des valeurs par défaut explicites et locales', () => {
  const options = parseArgs([]);
  assert.deepEqual(
    { port: options.port, hote: options.hote, connexions: options.connexions, actifs: options.actifs },
    { port: DEFAUTS.port, hote: '127.0.0.1', connexions: 4, actifs: 2 },
  );
  assert.equal(options.dossier, DEFAUTS.dossier);
  assert.match(USAGE, /--hote\s+adresse d'écoute/);
});

test('WP-51 : xdm-ui refuse les arguments invalides', () => {
  assert.throws(() => parseArgs(['--inconnu']), /option inconnue/);
  assert.throws(() => parseArgs(['--port']), /--port attend un entier/);
  assert.throws(() => parseArgs(['--port', 'abc']), /--port attend un entier/);
  assert.throws(() => parseArgs(['--port', '70000']), /--port doit être <= 65535/);
  assert.throws(() => parseArgs(['--connexions', '0']), /--connexions doit être >= 1/);
  assert.throws(() => parseArgs(['--hote']), /--hote attend une valeur/);
  // `0` est un port valide : le système en choisit un libre.
  assert.equal(parseArgs(['--port', '0']).port, 0);
});

test('WP-51 : --aide et --version sortent sans démarrer de serveur', async () => {
  const lignes = [];
  let appels = 0;
  const jamais = async () => {
    appels += 1;
    return null;
  };
  const aide = await main(['--aide'], { log: (l) => lignes.push(l), demarrer: jamais });
  assert.equal(aide, null);
  assert.equal(appels, 0);
  assert.match(lignes.join('\n'), /usage : xdm-ui/);

  lignes.length = 0;
  const version = await main(['--version'], { log: (l) => lignes.push(l), demarrer: jamais });
  assert.equal(version, null);
  assert.equal(lignes[0], `xdm-ui ${VERSION}`);
  assert.equal(appels, 0);
});

test('WP-51 : main transmet les options au serveur et affiche l’URL', async () => {
  const lignes = [];
  let recues = null;
  const faux = async (options) => {
    recues = options;
    return { url: 'http://127.0.0.1:8123/', fermer: async () => {} };
  };
  const serveur = await main(
    ['--port', '8123', '--dossier', 'dl', '--connexions', '6', '--actifs', '3'],
    { log: (l) => lignes.push(l), demarrer: faux },
  );
  assert.equal(serveur.url, 'http://127.0.0.1:8123/');
  assert.equal(recues.port, 8123);
  assert.equal(recues.hote, '127.0.0.1');
  assert.equal(recues.dossier, resolve('dl'));
  assert.equal(recues.connexions, 6);
  assert.equal(recues.maxActifs, 3);
  assert.match(lignes[0], /interface : http:\/\/127\.0\.0\.1:8123\//);
  assert.ok(!lignes.some((l) => l.includes('attention')), 'aucun avertissement en écoute locale');
});

test('WP-51 : une écoute sur 0.0.0.0 est annoncée comme une exposition', async () => {
  const lignes = [];
  await main(['--hote', '0.0.0.0', '--port', '0'], {
    log: (l) => lignes.push(l),
    demarrer: async () => ({ url: 'http://127.0.0.1:4567/', fermer: async () => {} }),
  });
  assert.ok(lignes.some((l) => /attention : écoute sur 0\.0\.0\.0/.test(l)));
});

test('T-E-19 : hors boucle locale, xdm-ui tire un jeton ; en local, il n’en impose pas', async () => {
  const lignes = [];
  const recus = [];
  const faux = async (options) => {
    recus.push(options);
    return { url: 'http://127.0.0.1:8100/', fermer: async () => {} };
  };
  const lire = async () => null;

  await main(['--hote', '0.0.0.0', '--jeton', 'secret-explicite'], { log: (l) => lignes.push(l), demarrer: faux, lire });
  assert.equal(recus[0].jeton, 'secret-explicite');

  await main(['--hote', '0.0.0.0'], { log: (l) => lignes.push(l), demarrer: faux, lire });
  assert.equal(typeof recus[1].jeton, 'string');
  assert.ok(recus[1].jeton.length >= 32, 'un jeton est tiré quand l’interface sort de la machine');
  assert.match(lignes.join('\n'), /ouvrir\s+: http:\/\/127\.0\.0\.1:8100\/\?jeton=/);

  await main(['--hote', '127.0.0.1'], { log: (l) => lignes.push(l), demarrer: faux, lire });
  assert.equal(recus[2].jeton, null, 'sur la boucle locale, pas de jeton imposé');
});

test('T-E-19 : un jeton base64url commençant par un tiret reste une valeur', () => {
  // Constaté en essai réel : `--jeton -IAStIU0a7qq` était refusé comme un drapeau.
  const options = parseArgs(['--jeton', '-IAStIU0a7qq']);
  assert.equal(options.jeton, '-IAStIU0a7qq');
  assert.throws(() => parseArgs(['--jeton', '--port']), /--jeton attend une valeur/);
});
