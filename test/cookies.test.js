import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  createCookieJar,
  defaultPath,
  domainMatches,
  parseSetCookie,
  pathMatches,
  withCookies,
} from '../src/cookies.js';
import { defaultTransport, probe } from '../src/http-client.js';

test('T-C-04 : lecture d’un Set-Cookie, attributs et valeurs par défaut', () => {
  assert.deepEqual(parseSetCookie('sid=abc123'), {
    name: 'sid',
    value: 'abc123',
    domain: null,
    path: null,
    expires: null,
    maxAge: null,
    expires: null,
    secure: false,
    httpOnly: false,
    hostOnly: true,
  });

  const full = parseSetCookie('session=xyz; Domain=.Example.COM; Path=/app; Max-Age=60; Secure; HttpOnly');
  assert.equal(full.domain, 'example.com', 'domaine mis en minuscules, point initial retiré');
  assert.equal(full.path, '/app');
  assert.equal(full.secure, true);
  assert.equal(full.httpOnly, true);
  assert.equal(full.maxAge, 60, 'Max-Age gardé en secondes relatives');
  assert.equal(full.hostOnly, false, 'un attribut Domain rend le cookie partageable');

  assert.equal(parseSetCookie('sans egal'), null);
  assert.equal(parseSetCookie('=vide'), null);
  assert.equal(parseSetCookie(''), null);
  assert.equal(parseSetCookie('a=1; Max-Age=0').maxAge, 0, 'Max-Age=0 ⇒ suppression');
  assert.ok(Date.parse('2020-01-01T00:00:00Z') === parseSetCookie('a=1; Expires=Wed, 01 Jan 2020 00:00:00 GMT').expires);
});

test('T-C-04 : correspondance de domaine et de chemin', () => {
  assert.equal(domainMatches('www.example.com', 'example.com'), true);
  assert.equal(domainMatches('example.com', 'example.com'), true);
  assert.equal(domainMatches('badexample.com', 'example.com'), false);
  assert.equal(defaultPath('/a/b/c.html'), '/a/b');
  assert.equal(defaultPath('/a/'), '/a');
  assert.equal(defaultPath('/'), '/');
  assert.equal(pathMatches('/app/x', '/app'), true);
  assert.equal(pathMatches('/application', '/app'), false);
  assert.equal(pathMatches('/app', '/app'), true);
});

test('T-C-04 : magasin — portée, expiration, Secure, remplacement', () => {
  const jar = createCookieJar();
  jar.store('http://www.example.com/a/page', { 'set-cookie': 'sid=1; Path=/' });
  jar.store('http://www.example.com/a/page', { 'set-cookie': 'autre=2; Path=/a' });

  assert.equal(jar.cookieHeader('http://www.example.com/a/b'), 'autre=2; sid=1', 'chemin le plus spécifique d’abord');
  assert.equal(jar.cookieHeader('http://www.example.com/z'), 'sid=1');
  assert.equal(jar.cookieHeader('http://autre.example.com/'), null,
    'cookie d’hôte (sans Domain) : jamais envoyé à un sous-domaine');
  assert.equal(jar.cookieHeader('http://other.com/'), null, 'pas de fuite vers un autre domaine');

  // Un cookie `Domain` est refusé s'il ne couvre pas l'hôte émetteur.
  jar.store('http://www.example.com/', { 'set-cookie': 'voleur=1; Domain=autre.com' });
  assert.equal(jar.cookieHeader('http://autre.com/'), null);

  // Même nom + même domaine + même chemin : remplacement.
  jar.store('http://www.example.com/', { 'set-cookie': 'sid=2; Path=/' });
  assert.equal(jar.cookieHeader('http://www.example.com/'), 'sid=2');

  // Secure n'est envoyé qu'en HTTPS.
  jar.store('https://secure.example.com/', { 'set-cookie': 'jeton=t; Path=/; Secure' });
  assert.equal(jar.cookieHeader('https://secure.example.com/'), 'jeton=t', 'Secure envoyé en HTTPS');
  assert.equal(jar.cookieHeader('http://secure.example.com/'), null, 'autre hôte : rien');
  jar.store('https://secure.example.com/', { 'set-cookie': 'large=1; Path=/; Domain=example.com' });
  assert.equal(jar.cookieHeader('https://secure.example.com/'), 'jeton=t; large=1',
    'même chemin : ordre de création');
  assert.equal(jar.cookieHeader('http://secure.example.com/'), 'large=1', 'cookie Secure retenu en HTTP');

  jar.clear();
  assert.equal(jar.size(), 0);
});

test('T-C-04 : expiration par Max-Age et par horloge injectée', () => {
  let stamp = 1_000_000;
  const jar = createCookieJar({ now: () => stamp });
  jar.store('http://h/', { 'set-cookie': 'court=1; Max-Age=1' });
  assert.equal(jar.cookieHeader('http://h/'), 'court=1');
  stamp += 1500;
  assert.equal(jar.cookieHeader('http://h/'), null, 'expiré après Max-Age');
  assert.equal(jar.size(), 0);
});

test('T-C-04 : parcours et téléchargement portent les cookies de session', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.cookie ?? null);
    if (req.url === '/entree') {
      res.writeHead(200, {
        'set-cookie': 'sid=abc; Path=/',
        'content-length': '2',
      });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'content-length': '5' });
    res.end('suite');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${port}`;

  const jar = createCookieJar();
  const transport = withCookies(defaultTransport, jar);
  try {
    const capabilities = await probe(`${origin}/entree`, { transport });
    assert.equal(capabilities.status, 200);
    assert.equal(jar.cookieHeader(`${origin}/autre`), 'sid=abc');

    // La requête suivante part avec le cookie, sans que l'appelant ait à le gérer.
    const segment = await transport(`${origin}/autre`, { method: 'GET', headers: {} });
    segment.stream.destroy();
    assert.deepEqual(seen, [null, 'sid=abc']);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
