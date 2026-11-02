import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLE_STOCKAGE,
  LONGUEUR_MINIMALE,
  avecJeton,
  entetesJeton,
  estPlausible,
  jetonDeLaPage,
  jetonDeUrl,
  jetonMemorise,
  memoriserJeton,
  oublierJeton,
  sansJetonDansUrl,
  stockageDisponible,
} from '../src/ui/jeton.js';

/** Faux `sessionStorage` : la page ne doit pas dépendre du vrai. */
function fauxStockage({ refuse = false } = {}) {
  const donnees = new Map();
  return {
    donnees,
    getItem: (cle) => (donnees.has(cle) ? donnees.get(cle) : null),
    setItem: (cle, valeur) => {
      if (refuse) throw new Error('QuotaExceededError');
      donnees.set(cle, String(valeur));
    },
    removeItem: (cle) => {
      if (refuse) throw new Error('SecurityError');
      donnees.delete(cle);
    },
  };
}

const JETON = 'Q2xpb25YK2R1LXNvY2xlLTIwMjY';

test('T-E-24 : le jeton se lit dans l’URL et disparaît de l’adresse', () => {
  assert.equal(jetonDeUrl(`?jeton=${JETON}`), JETON);
  assert.equal(jetonDeUrl(`?autre=1&jeton=${JETON}`), JETON);
  assert.equal(jetonDeUrl(''), null, 'pas de requête, pas de jeton');
  assert.equal(jetonDeUrl('?autre=1'), null);
  assert.equal(jetonDeUrl('?jeton='), null, 'un jeton vide ne compte pas');
  assert.equal(jetonDeUrl(`?jeton=${encodeURIComponent('a b')}`), null, 'un espace est refusé');

  // Le jeton ne doit pas rester dans l'historique du navigateur.
  assert.equal(sansJetonDansUrl(`?jeton=${JETON}`, '/'), '/');
  assert.equal(sansJetonDansUrl(`?b=2&jeton=${JETON}`, '/'), '/?b=2');
  assert.equal(sansJetonDansUrl('?b=2', '/'), '/?b=2', 'les autres paramètres survivent');
  assert.equal(sansJetonDansUrl('', '/'), '/');

  // Un paramètre nommé `jeton` mais **plausible** est bien retenu, tel quel (encodage).
  assert.equal(jetonDeUrl('?jeton=abc%2Fdef%2Bghi'), 'abc/def+ghi');
});

test('T-E-24 : le jeton reste dans la page quand le stockage est refusé', () => {
  // Cas d'une iframe verrouillée : `sessionStorage` lève, la page doit continuer.
  const ferme = fauxStockage({ refuse: true });
  assert.equal(stockageDisponible({ sessionStorage: ferme }), null);
  assert.equal(memoriserJeton(ferme, JETON), false, 'la mémorisation échoue proprement');
  assert.equal(jetonMemorise(ferme), null, 'et ne casse pas la lecture');
  assert.equal(jetonDeLaPage(`?jeton=${JETON}`, ferme), JETON, 'le jeton de l’URL suffit');
  oublierJeton(ferme); // ne lève pas

  // Et sans aucun stockage du tout.
  assert.equal(stockageDisponible({}), null);
  assert.equal(jetonDeLaPage('', null), null);
});

test('T-E-24 : le jeton survit à un rechargement par le stockage de session', () => {
  const memoire = fauxStockage();
  assert.equal(stockageDisponible({ sessionStorage: memoire }), memoire, 'le stockage est utilisable');
  assert.equal(memoriserJeton(memoire, JETON), true);
  assert.equal(memoire.donnees.get(CLE_STOCKAGE), JETON);
  assert.equal(jetonDeLaPage('', memoire), JETON, 'un rechargement sans `?jeton=` reste ouvert');
  assert.equal(jetonDeLaPage('?jeton=autre-jeton-long', memoire), 'autre-jeton-long', 'l’URL est plus récente');

  oublierJeton(memoire);
  assert.equal(jetonMemorise(memoire), null, 'la déconnexion efface la session');
});

test('T-E-24 : chaque appel porte le jeton, sans écraser les en-têtes fournis', () => {
  assert.equal(avecJeton('/api/etat', JETON), `/api/etat?jeton=${encodeURIComponent(JETON)}`);
  assert.equal(avecJeton('/api/evenements', JETON), `/api/evenements?jeton=${encodeURIComponent(JETON)}`);
  assert.equal(avecJeton('/api/etat?x=1', JETON), `/api/etat?x=1&jeton=${encodeURIComponent(JETON)}`);
  assert.equal(avecJeton('/api/etat', null), '/api/etat', 'sans jeton, l’URL est inchangée');
  assert.equal(avecJeton('/api/etat', '  '), '/api/etat', 'un jeton fait d’espaces est ignoré');

  assert.deepEqual(entetesJeton(JETON), { 'x-jeton': JETON });
  assert.deepEqual(
    entetesJeton(JETON, { 'content-type': 'application/json' }),
    { 'content-type': 'application/json', 'x-jeton': JETON },
  );
  assert.deepEqual(entetesJeton(JETON, { 'x-jeton': 'explicite' }), { 'x-jeton': 'explicite' });
  assert.deepEqual(entetesJeton(null, { a: '1' }), { a: '1' });
});

test('T-E-24 : la plausibilité d’un jeton est vérifiable sans le serveur', () => {
  assert.equal(estPlausible(JETON), true);
  assert.equal(estPlausible('a'.repeat(LONGUEUR_MINIMALE)), true);
  assert.equal(estPlausible('a'.repeat(LONGUEUR_MINIMALE - 1)), false, 'trop court');
  assert.equal(estPlausible('jeton avec espace'), false);
  assert.equal(estPlausible('jeton\ninjecté'), false);
  assert.equal(estPlausible(''), false);
  assert.equal(estPlausible(null), false);
  assert.equal(estPlausible(42), false);
});
