import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PacError,
  createPacTransport,
  createProxyResolver,
  dnsDomainIs,
  isPlainHostName,
  localHostOrDomainIs,
  parsePac,
  parseProxyResult,
  resolveProxy,
  shExpMatch,
} from '../src/pac.js';

test('T-C-09 : un PAC rend des directives ordonnées, jamais une seule', () => {
  assert.deepEqual(parseProxyResult('PROXY proxy.local:3128'), [
    { type: 'PROXY', host: 'proxy.local', port: 3128 },
  ]);
  assert.deepEqual(parseProxyResult('PROXY a:8080; SOCKS5 b:1080; DIRECT'), [
    { type: 'PROXY', host: 'a', port: 8080 },
    { type: 'SOCKS5', host: 'b', port: 1080 },
    { type: 'DIRECT', host: null, port: null },
  ]);
  assert.deepEqual(parseProxyResult('DIRECT'), [{ type: 'DIRECT', host: null, port: null }]);
  // Port par défaut selon le type.
  assert.equal(parseProxyResult('SOCKS h')[0].port, 1080);
  assert.equal(parseProxyResult('PROXY h')[0].port, 8080);
  assert.throws(() => parseProxyResult('HTTP h:1'), /directive PAC inconnue/);
  assert.throws(() => parseProxyResult('PROXY h:99999'), /port invalide/);
  assert.throws(() => parseProxyResult(''), /chaîne PAC vide/);
});

test('T-C-09 : les fonctions PAC autorisées se comportent comme dans un navigateur', () => {
  assert.equal(isPlainHostName('intranet'), true);
  assert.equal(isPlainHostName('a.example.com'), false);
  assert.equal(dnsDomainIs('a.example.com', '.example.com'), true);
  assert.equal(dnsDomainIs('example.com', '.example.com'), false);
  assert.equal(shExpMatch('https://a.b/c', 'https://*'), true);
  assert.equal(shExpMatch('http://a.b/c', 'https://*'), false);
  assert.equal(shExpMatch('a.b', '?.b'), true);
  assert.equal(shExpMatch('a+b.c', 'a+b.c'), true, 'les métacaractères sont échappés');
  assert.equal(localHostOrDomainIs('www', 'www.example.com'), true);
  assert.equal(localHostOrDomainIs('mail', 'www.example.com'), false);
});

test('T-C-09 : résolution d’un PAC avec if/else if/else', () => {
  const resolve = createProxyResolver(`// proxy interne
function FindProxyForURL(url, host) {
  if (isPlainHostName(host)) return "DIRECT";
  if (dnsDomainIs(host, ".interne.fr")) return "PROXY 10.0.0.1:3128";
  else if (shExpMatch(url, "https://*")) return "PROXY s1:8080; SOCKS5 s2:1080";
  else if (host == "special.example.com") return "DIRECT";
  return "DIRECT";
}`);

  assert.deepEqual(resolve('http://intranet/')[0].type, 'DIRECT');
  assert.deepEqual(resolve('http://a.interne.fr/x'), [
    { type: 'PROXY', host: '10.0.0.1', port: 3128 },
  ]);
  assert.deepEqual(resolve('https://example.com/'), [
    { type: 'PROXY', host: 's1', port: 8080 },
    { type: 'SOCKS5', host: 's2', port: 1080 },
  ]);
  assert.deepEqual(resolve('http://special.example.com/')[0], { type: 'DIRECT', host: null, port: null });
  assert.deepEqual(resolve('http://autre.com/')[0].type, 'DIRECT');
});

test('T-C-09 : blocs, conditions composées et variable dnsDomain', () => {
  const pac = parsePac(`function FindProxyForURL(url, host) {
  if ((dnsDomainIs(host, "corp.example") && !shExpMatch(url, "http://*:8080/*")) || dnsDomainLevels(host) > 3) {
    return "PROXY corp:3128";
  }
  if (dnsDomain == "example") { return "DIRECT"; }
  return "PROXY secours:8080";
}`);
  assert.equal(resolveProxy(pac, 'https://a.corp.example/x')[0].host, 'corp');
  assert.equal(resolveProxy(pac, 'http://a.corp.example:8080/x')[0].host, 'secours');
  assert.equal(resolveProxy(pac, 'http://x.example/')[0].type, 'DIRECT');
  assert.equal(resolveProxy(pac, 'http://a.b.c.d.example.com/')[0].host, 'corp');

  const withComparator = parsePac(`function FindProxyForURL(url, host) {
    if (host != "libre.local") return "PROXY p:1";
    return "DIRECT";
  }`);
  assert.equal(resolveProxy(withComparator, 'http://libre.local/')[0].type, 'DIRECT');
  assert.equal(resolveProxy(withComparator, 'http://autre/')[0].host, 'p');
});

test('T-C-09 : ce qui n’est pas géré est refusé, jamais deviné', () => {
  assert.throws(() => parsePac('var x = 1;'), /FindProxyForURL.*introuvable/);
  assert.throws(
    () => parsePac('function FindProxyForURL(url, host) { if (isResolvable(host)) return "PROXY p:1"; }'),
    (error) => error instanceof PacError && error.code === 'UNSUPPORTED',
  );
  assert.throws(
    () => parsePac('function FindProxyForURL(url, host) { return toto; }'),
    (error) => error.code === 'UNSUPPORTED',
  );
  assert.throws(
    () => parsePac('function FindProxyForURL(url, host) { var a = 1; return "DIRECT"; }'),
    (error) => error.code === 'UNSUPPORTED',
  );
  assert.throws(
    () => parsePac('function FindProxyForURL(url, host) {'),
    /accolades déséquilibrées/,
  );
});

test('T-C-09 : le PAC devient un transport qui essaie les directives dans l’ordre', async () => {
  const calls = [];
  // Aucune requête réseau : on observe seulement le choix de route.
  const directTransport = async (url) => {
    calls.push(['direct', url]);
    return { status: 200, headers: {}, stream: null };
  };
  const transport = createPacTransport(`function FindProxyForURL(url, host) {
    if (isPlainHostName(host)) return "DIRECT";
    return "PROXY 127.0.0.1:1";
  }`, { directTransport, timeout: 2000 });

  const answer = await transport('http://intranet/', { method: 'GET' });
  assert.equal(answer.status, 200);
  assert.deepEqual(calls, [['direct', 'http://intranet/']]);

  // Cible non locale : toutes les directives proxy échouent (port 1 fermé) et l'erreur
  // remonte — on ne bascule pas silencieusement en direct.
  await assert.rejects(
    transport('http://example.com/', { method: 'GET' }),
    (error) => ['PROXY_UNREACHABLE', 'CONNECT_REFUSED', 'PROXY_TIMEOUT'].includes(error.code),
  );
  assert.equal(calls.length, 1, 'aucun repli direct non demandé par le PAC');
});
