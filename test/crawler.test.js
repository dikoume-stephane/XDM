import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DEPTH,
  USER_AGENT,
  classifyLink,
  crawl,
  extractLinks,
  isAllowed,
  canonicalUrl,
  parseRobots,
  robotsUrl,
  sameOrigin,
} from '../src/crawler.js';

/** Site factice : table `url -> {status, body}`, compte les requêtes. */
function site(routes, { robotsText } = {}) {
  const requests = [];
  const fetchPage = async (url) => {
    requests.push(url);
    if (robotsText !== undefined && url.endsWith('/robots.txt')) {
      return { status: 200, body: robotsText };
    }
    const route = routes[url];
    if (route === undefined) return { status: 404, body: '' };
    return typeof route === 'function' ? route(url) : { status: 200, body: route };
  };
  return { fetchPage, requests };
}

test('T-B-09 : normalisation des URL — fragment, barre finale, casse de l’hôte', () => {
  assert.equal(canonicalUrl('http://Example.COM/a/b#section'), 'http://example.com/a/b');
  assert.equal(canonicalUrl('http://example.com/a/'), 'http://example.com/a');
  assert.equal(canonicalUrl('http://example.com/'), 'http://example.com/');
  assert.equal(canonicalUrl('/docs/x.html', 'http://example.com/racine/'), 'http://example.com/docs/x.html');
  assert.equal(canonicalUrl('#ancre', 'http://example.com/'), null);
  assert.equal(canonicalUrl('mailto:contact@example.com'), null);
  assert.equal(canonicalUrl('javascript:void(0)'), null);
  assert.equal(canonicalUrl('ftp://example.com/f'), null);
  assert.equal(canonicalUrl(''), null);
  assert.equal(sameOrigin('http://a.example/x', 'http://a.example/y'), true);
  assert.equal(sameOrigin('http://a.example/x', 'https://a.example/y'), false);
  assert.equal(USER_AGENT.startsWith('XDM'), true);
});

test('T-B-08 : extraction des liens — href, src, dédoublonnage, schémas ignorés', () => {
  const html = `
    <a href="/a.html">a</a>
    <a href='/b.html#frag'>b</a>
    <a href="/b.html">b encore</a>
    <img src="images/logo.png">
    <script src="http://cdn.example/x.js"></script>
    <a href="mailto:x@y.z">mail</a>
    <a href="javascript:void(0)">js</a>
  `;
  assert.deepEqual(extractLinks(html, 'http://site.example/dir/page.html'), [
    'http://site.example/a.html',
    'http://site.example/b.html',
    'http://site.example/dir/images/logo.png',
    'http://cdn.example/x.js',
  ]);
  assert.deepEqual(extractLinks('', 'http://site.example/'), []);
});

test('T-B-13 : `robots.txt` — règle la plus longue, `Disallow` prioritaire', () => {
  const text = `
    User-agent: *
    Disallow: /prive
    Allow: /prive/public

    User-agent: autre
    Disallow: /
  `;
  const rules = parseRobots(text);
  assert.equal(isAllowed('http://h/prive/x', rules), false);
  assert.equal(isAllowed('http://h/prive/public/page', rules), true, 'Allow plus long gagne');
  assert.equal(isAllowed('http://h/public', rules), true);
  assert.equal(isAllowed('http://h/prive', rules), false);
  assert.equal(isAllowed('http://h/n-importe-quoi', []), true);
  assert.equal(robotsUrl('http://h/a/b?c=1'), 'http://h/robots.txt');

  // Disallow l'emporte à longueur égale.
  const tie = parseRobots('User-agent: *\nAllow: /x\nDisallow: /x\n');
  assert.equal(isAllowed('http://h/x', tie), false);
});

test('T-B-03/T-B-05 : classement d’un lien par les filtres du projet', () => {
  assert.deepEqual(classifyLink('http://h/a.pdf'), { retained: true, reason: 'aucun filtre' });
  assert.equal(classifyLink('http://h/a.pdf', { include: ['*.pdf'] }).retained, true);
  assert.equal(classifyLink('http://h/a.html', { include: ['*.pdf'] }).retained, false);
  assert.equal(
    classifyLink('http://h/a.pdf', { include: ['*.pdf'], exclude: ['a.*'] }).retained,
    false,
    "l'exclusion l'emporte",
  );
  assert.match(classifyLink('http://h/a.png', { exclude: ['*.png'] }).reason, /exclusion/);
});

test('T-B-08 : parcours en largeur, profondeur = niveaux visités', () => {
  const routes = {
    'http://site.example/': '<a href="/n1-a.html">a</a><a href="/n1-b.html">b</a>',
    'http://site.example/n1-a.html': '<a href="/n2-a.html">a</a>',
    'http://site.example/n1-b.html': '<a href="/n2-b.html">b</a>',
    'http://site.example/n2-a.html': '<a href="/n3.html">trop profond</a>',
  };
  const { fetchPage } = site(routes);

  return crawl('http://site.example/', { fetchPage, robots: false }).then((result) => {
    assert.deepEqual(result.pages.map((p) => p.url), [
      'http://site.example/',
      'http://site.example/n1-a.html',
      'http://site.example/n1-b.html',
    ]);
    assert.deepEqual(result.pages.map((p) => p.depth), [1, 2, 2]);
    assert.equal(result.fetched, 3);
    // Les liens de niveau 3 sont retenus comme fichiers mais pas visités.
    assert.ok(result.retained.some((r) => r.url === 'http://site.example/n2-a.html'));
    assert.ok(!result.pages.some((p) => p.url.endsWith('/n3.html')));
  });
});

test('T-B-08 (suite) : profondeur 1 = page de départ seule', async () => {
  const routes = { 'http://s.example/': '<a href="/x.html">x</a>' };
  const { fetchPage, requests } = site(routes);
  const result = await crawl('http://s.example/', { fetchPage, depth: 1, robots: false });
  assert.equal(result.fetched, 1);
  assert.deepEqual(result.pages.map((p) => p.depth), [1]);
  assert.deepEqual(result.retained.map((r) => r.url), ['http://s.example/x.html']);
  assert.deepEqual(requests, ['http://s.example/']);
  assert.equal(DEFAULT_DEPTH, 2);
});

test('T-B-09 (suite) : une boucle de liens ne provoque qu’une requête par page', async () => {
  const routes = {
    'http://loop.example/': '<a href="/a">a</a><a href="/">racine</a>',
    'http://loop.example/a': '<a href="/">retour</a><a href="/a">soi</a>',
  };
  const { fetchPage, requests } = site(routes);
  const result = await crawl('http://loop.example/', { fetchPage, depth: 5, robots: false });
  assert.deepEqual(requests, ['http://loop.example/', 'http://loop.example/a']);
  assert.equal(result.pages.length, 2);
});

test('T-B-13 (suite) : un lien externe est signalé, jamais suivi', async () => {
  const routes = {
    'http://interne.example/': '<a href="/ici.html">ici</a><a href="http://autre.example/loin">loin</a>',
    'http://interne.example/ici.html': 'ok',
  };
  const { fetchPage, requests } = site(routes);
  const result = await crawl('http://interne.example/', { fetchPage, robots: false });
  assert.deepEqual(requests, ['http://interne.example/', 'http://interne.example/ici.html']);
  assert.ok(result.skipped.some((s) => s.reason === 'hors site'));
  assert.ok(!result.retained.some((r) => r.url.includes('autre.example')));
});

test('T-B-13 (ter) : `robots.txt` respecté pendant le parcours', async () => {
  const routes = {
    'http://r.example/': '<a href="/prive/x.html">secret</a><a href="/public.html">public</a>',
    'http://r.example/public.html': 'ok',
    'http://r.example/prive/x.html': 'ne doit pas être lu',
  };
  const { fetchPage, requests } = site(routes, {
    robotsText: 'User-agent: *\nDisallow: /prive\n',
  });
  const result = await crawl('http://r.example/', { fetchPage, depth: 2 });
  assert.ok(!requests.includes('http://r.example/prive/x.html'));
  assert.ok(result.skipped.some((s) => s.reason === 'robots.txt'));
  assert.ok(result.pages.some((p) => p.url === 'http://r.example/public.html'));
});

test('T-B-20 : une page en erreur n’arrête pas l’aspiration', async () => {
  const routes = {
    'http://e.example/': '<a href="/ko.html">ko</a><a href="/ok.html">ok</a>',
    'http://e.example/ok.html': 'ok',
  };
  const { fetchPage } = site(routes);
  const result = await crawl('http://e.example/', { fetchPage, robots: false });
  assert.deepEqual(result.errors, [{ url: 'http://e.example/ko.html', status: 404 }]);
  assert.ok(result.pages.some((p) => p.url === 'http://e.example/ok.html'));
});

test('T-B-08 (erreurs) : arguments invalides refusés explicitement', async () => {
  await assert.rejects(() => crawl('http://h/', {}), /fetchPage/);
  await assert.rejects(() => crawl('pas une url', { fetchPage: async () => ({ status: 200, body: '' }) }), /invalide/);
  await assert.rejects(
    () => crawl('http://h/', { fetchPage: async () => ({ status: 200, body: '' }), depth: 0 }),
    /profondeur/,
  );
});
