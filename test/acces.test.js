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

test('T-E-18 : sans jeton valide, ni les données ni l’interface ne s’ouvrent', async () => {
  const jeton = genererJeton();
  await avecServeurProtege(jeton, async ({ base }) => {
    // API : 401 explicite, avec l'en-tête qui dit comment s'authentifier.
    const api = await fetch(`${base}/api/etat`);
    assert.equal(api.status, 401);
    assert.equal(api.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await api.json()).erreur.code, 'JETON_REQUIS');

    // Page : une page de connexion, pas l'interface.
    const page = await fetch(base);
    assert.equal(page.status, 401);
    const html = await page.text();
    assert.match(html, /accès protégé/);
    assert.doesNotMatch(html, /File d’attente/, 'l’interface elle-même n’est pas servie');

    // Un mauvais jeton est traité comme une absence.
    assert.equal((await fetch(`${base}/api/etat`, { headers: { authorization: 'Bearer faux' } })).status, 401);

    // Le bon jeton ouvre l'API…
    const bon = await fetch(`${base}/api/etat`, { headers: { authorization: `Bearer ${jeton}` } });
    assert.equal(bon.status, 200);
    assert.equal((await bon.json()).version !== undefined, true);

    // …et le premier passage par `?jeton=` échange le secret contre un cookie.
    const echange = await fetch(`${base}/?jeton=${encodeURIComponent(jeton)}`, { redirect: 'manual' });
    assert.equal(echange.status, 303);
    const setCookie = echange.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    const valeur = /xdm_jeton=([^;]+)/.exec(setCookie)[1];
    const avecCookie = await fetch(`${base}/api/etat`, { headers: { cookie: `${COOKIE_JETON}=${valeur}` } });
    assert.equal(avecCookie.status, 200);
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
