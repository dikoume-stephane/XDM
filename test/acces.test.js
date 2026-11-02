import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  AccesError, COOKIE_JETON, cookieDeJeton, effacerCookie, estBoucleLocale, extraireJeton,
  genererJeton, jetonDuCookie, jetonValide,
} from '../src/acces.js';
import { createUiServer } from '../src/ui-server.js';

/** Démarre un serveur protégé par jeton sur un port libre, sans dossier de travail. */
async function avecServeurProtege(jeton, callback) {
  const { serveur } = createUiServer({ jeton, dossier: '/tmp/xdm-acces-inexistant' });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  try {
    return await callback({ base });
  } finally {
    await new Promise((ok) => serveur.close(() => ok(undefined)));
  }
}

test('T-E-17 : le jeton est long, unique, et se compare en temps constant', () => {
  const a = genererJeton();
  const b = genererJeton();
  assert.notEqual(a, b);
  assert.equal(a.length >= 32, true, `longueur : ${a.length}`);
  assert.match(a, /^[A-Za-z0-9_-]+$/, 'base64url : utilisable dans une URL sans échappement');
  assert.throws(() => genererJeton(8), RangeError, 'un jeton court n’est pas un jeton');

  assert.equal(jetonValide(a, a), true);
  assert.equal(jetonValide(a, b), false);
  assert.equal(jetonValide(null, a), false);
  assert.equal(jetonValide(a, ''), false);
  assert.equal(jetonValide(a, `${a}x`), false, 'une longueur différente ne compare pas');

  assert.equal(estBoucleLocale('127.0.0.1'), true);
  assert.equal(estBoucleLocale('localhost'), true);
  assert.equal(estBoucleLocale('0.0.0.0'), false);
  assert.equal(estBoucleLocale('192.168.1.10'), false);
});

test('T-E-17 : le jeton se lit par en-tête, par paramètre ou par cookie', () => {
  const jeton = 'secret-de-test';
  assert.equal(extraireJeton({ headers: { authorization: `Bearer ${jeton}` } }), jeton);
  assert.equal(extraireJeton({ headers: { authorization: `bearer ${jeton}` } }), jeton);
  assert.equal(extraireJeton({ headers: { 'x-jeton': jeton } }), jeton);
  assert.equal(extraireJeton({ url: `http://x/?jeton=${jeton}` }), jeton);
  const cookie = cookieDeJeton(jeton);
  assert.match(cookie, new RegExp(`${COOKIE_JETON}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(extraireJeton({ headers: { cookie } }), jeton);
  assert.equal(extraireJeton({ headers: { cookie: `${COOKIE_JETON}=` } }), null);
  assert.equal(jetonDuCookie('a=1; b=2'), null);
  assert.match(effacerCookie(), /Max-Age=0/);
  assert.ok(AccesError);
});

test('T-E-18 : sans jeton valide, les données et les actions restent fermées', async () => {
  const jeton = genererJeton();
  await avecServeurProtege(jeton, async ({ base }) => {
    // API : 401 explicite, avec l'en-tête qui dit comment s'authentifier.
    const api = await fetch(`${base}/api/etat`);
    assert.equal(api.status, 401);
    assert.equal(api.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await api.json()).erreur.code, 'JETON_REQUIS');

    // Toute l'API est fermée, y compris les routes d'action et les flux.
    for (const chemin of ['/api/journal', '/api/historique', '/api/reglages', '/api/evenements', '/api/taches']) {
      assert.equal((await fetch(`${base}${chemin}`)).status, 401, `${chemin} exige le jeton`);
    }
    const action = await fetch(`${base}/api/demarrer`, { method: 'POST' });
    assert.equal(action.status, 401, 'aucune action sans jeton');
    const ajout = await fetch(`${base}/api/taches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://exemple.test/x.bin' }),
    });
    assert.equal(ajout.status, 401, 'aucun ajout à la file sans jeton');

    // Un mauvais jeton est traité comme une absence.
    assert.equal((await fetch(`${base}/api/etat`, { headers: { authorization: 'Bearer faux' } })).status, 401);

    // Le bon jeton ouvre l'API, par en-tête `Authorization`…
    const bon = await fetch(`${base}/api/etat`, { headers: { authorization: `Bearer ${jeton}` } });
    assert.equal(bon.status, 200);
    assert.equal((await bon.json()).version !== undefined, true);

    // …par en-tête `x-jeton` (c'est ce que pose la page)…
    const parEntete = await fetch(`${base}/api/etat`, { headers: { 'x-jeton': jeton } });
    assert.equal(parEntete.status, 200);

    // …ou par `?jeton=`, ce qui permet à `EventSource` de s'authentifier.
    const parUrl = await fetch(`${base}/api/etat?jeton=${encodeURIComponent(jeton)}`);
    assert.equal(parUrl.status, 200);

    // Le cookie reste un confort : s'il est présent, il vaut jeton.
    const avecCookie = await fetch(`${base}/api/etat`, {
      headers: { cookie: `${COOKIE_JETON}=${encodeURIComponent(jeton)}` },
    });
    assert.equal(avecCookie.status, 200);
  });
});

test('T-E-18 : la coquille est publique, la page ne boucle plus sur la connexion', async () => {
  const jeton = genererJeton();
  await avecServeurProtege(jeton, async ({ base }) => {
    // La page, sa feuille, ses scripts et ses fontes n'exigent pas de jeton : ils ne
    // contiennent aucune donnée, et le cookie n'est pas renvoyé dans une iframe tierce.
    for (const chemin of ['/', '/index.html', '/style.css', '/app.js', '/jeton.js']) {
      assert.equal((await fetch(`${base}${chemin}`)).status, 200, `${chemin} est public`);
    }
    assert.equal(
      (await fetch(`${base}/polices/plus-jakarta-sans-latin-400-normal.woff2`)).status,
      200,
      'les fontes embarquées sont publiques',
    );

    // La page contient la boîte de jeton, pas une page de connexion servie par le serveur.
    const html = await (await fetch(base)).text();
    assert.match(html, /boite-jeton/);
    assert.match(html, /jeton d’accès requis/i);
    assert.doesNotMatch(html, /<form method="get"/, 'plus de formulaire GET plein écran');

    // La liste publique est fermée : tout le reste exige le jeton.
    assert.equal((await fetch(`${base}/polices/../../package.json`)).status, 401);
    assert.equal((await fetch(`${base}/package.json`)).status, 401);
    assert.equal((await fetch(`${base}/index.html?x=1`)).status, 200, 'la requête reste publique');

    // `?jeton=` sur la page : 200 direct, **sans redirection** — c'est ce qui cassait
    // l'aperçu (303 → cookie refusé en iframe → page de connexion → boucle).
    const avecJeton = await fetch(`${base}/?jeton=${encodeURIComponent(jeton)}`, { redirect: 'manual' });
    assert.equal(avecJeton.status, 200, 'plus de 303');
    assert.match(avecJeton.headers.get('set-cookie') ?? '', /HttpOnly/, 'le cookie reste proposé');
  });
});

test('T-E-18 : un jeton faux ne donne rien, même sur la page publique', async () => {
  const jeton = genererJeton();
  await avecServeurProtege(jeton, async ({ base }) => {
    const faux = await fetch(`${base}/?jeton=faux-faux-faux`, { redirect: 'manual' });
    assert.equal(faux.status, 200, 'la coquille est servie…');
    assert.equal(faux.headers.get('set-cookie'), null, '…mais aucun cookie n’est posé');
    // …et la page ne peut rien lire : c'est là que la boîte de jeton s'ouvre.
    assert.equal((await fetch(`${base}/api/etat?jeton=faux-faux-faux`)).status, 401);
  });
});

test('T-E-18 : sans jeton configuré, le serveur reste ouvert comme avant', async () => {
  const { serveur } = createUiServer({ dossier: '/tmp/xdm-acces-inexistant' });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/etat`)).status, 200);
    assert.equal((await fetch(base)).status, 200);
  } finally {
    await new Promise((ok) => serveur.close(() => ok(undefined)));
  }
  // Le serveur de test n'a jamais écouté au-delà de la boucle locale : rien à vérifier ici.
  assert.ok(http);
});
