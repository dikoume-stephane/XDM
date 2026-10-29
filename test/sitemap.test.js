import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SITEMAPS,
  decodeXmlEntities,
  discoverSitemaps,
  parseSitemapDirectives,
  parseSitemapXml,
} from '../src/sitemap.js';

/** Site factice : table `url -> {status, body}`. */
function site(routes) {
  const requests = [];
  return {
    requests,
    fetchPage: async (url) => {
      requests.push(url);
      const route = routes[url];
      if (route === undefined) return { status: 404, body: '' };
      return typeof route === 'string' ? { status: 200, body: route } : route;
    },
  };
}

test('T-C-17 : lecture d’un plan de site et de ses directives', () => {
  assert.equal(decodeXmlEntities('a&amp;b&#38;c'), 'a&b&#38;c',
    'seules les cinq entités XML sont décodées, le reste reste littéral');

  const urlset = parseSitemapXml(`<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc> http://h/a.zip </loc></url>
      <url><loc>http://h/b%E9.pdf</loc></url>
      <url><loc>http://h/q?a=1&amp;b=2</loc></url>
      <url><loc></loc></url>
    </urlset>`);
  assert.equal(urlset.kind, 'urlset');
  assert.deepEqual(urlset.urls, ['http://h/a.zip', 'http://h/b%E9.pdf', 'http://h/q?a=1&b=2']);

  const index = parseSitemapXml('<sitemapindex><sitemap><loc>http://h/s1.xml</loc>'
    + '<lastmod>2026-01-01</lastmod></sitemap></sitemapindex>');
  assert.equal(index.kind, 'sitemapindex');
  assert.deepEqual(index.sitemaps, ['http://h/s1.xml']);
  assert.deepEqual(index.urls, []);

  assert.deepEqual(parseSitemapXml(''), { urls: [], sitemaps: [], kind: 'inconnu' });
  assert.deepEqual(parseSitemapXml('<html><body>non</body></html>'),
    { urls: [], sitemaps: [], kind: 'inconnu' });
  assert.deepEqual(parseSitemapXml(/** @type {any} */ (null)),
    { urls: [], sitemaps: [], kind: 'inconnu' });

  // Les directives `Sitemap:` ne dépendent d'aucun groupe d'agent (RFC 9309 §2.2.3).
  assert.deepEqual(
    parseSitemapDirectives('User-agent: *\nSitemap: http://h/a.xml\n'
      + 'sitemap : http://h/b.xml  # commentaire\nSitemap: http://h/a.xml\nDisallow: /x'),
    ['http://h/a.xml', 'http://h/b.xml', 'http://h/a.xml'],
  );
  assert.deepEqual(parseSitemapDirectives('User-agent: *\nSitemap :\n'), []);
});

test('T-C-17 : découverte — directives d’abord, index suivi, plafonds respectés', async () => {
  // 1) Le robots.txt déclare un index ; on ne cherche pas /sitemap.xml.
  const index = site({
    'http://h/sm/index.xml': '<sitemapindex><sitemap><loc>/sm/a.xml</loc></sitemap>'
      + '<sitemap><loc>http://autre/sm.xml</loc></sitemap></sitemapindex>',
    'http://h/sm/a.xml': '<urlset><url><loc>/f/a.zip</loc></url>'
      + '<url><loc>http://autre/f/b.zip</loc></url></urlset>',
  });
  const found = await discoverSitemaps({
    startUrl: 'http://h/',
    fetchPage: index.fetchPage,
    robotsText: 'User-agent: *\nSitemap: http://h/sm/index.xml\n',
  });
  assert.deepEqual(found.urls, ['http://h/f/a.zip'], 'les URL hors origine sont écartées');
  assert.deepEqual(found.sitemaps, ['http://h/sm/index.xml', 'http://h/sm/a.xml']);
  assert.ok(!index.requests.includes('http://h/sitemap.xml'), 'aucun repli quand un plan est déclaré');

  // 2) Robots muet : repli sur /sitemap.xml ; un 404 n'est pas une erreur d'exécution.
  const fallback = site({ 'http://h/sitemap.xml': '<urlset><url><loc>http://h/x.pdf</loc></url></urlset>' });
  const byFallback = await discoverSitemaps({ startUrl: 'http://h/page.html', fetchPage: fallback.fetchPage });
  assert.deepEqual(byFallback.urls, ['http://h/x.pdf']);
  assert.deepEqual(byFallback.sitemaps, ['http://h/sitemap.xml']);

  const none = site({});
  const empty = await discoverSitemaps({ startUrl: 'http://h/', fetchPage: none.fetchPage });
  assert.deepEqual(empty.urls, []);
  assert.equal(empty.failed.length, 1);
  assert.match(empty.failed[0].reason, /statut 404/);

  // 3) Format inconnu : signalé, pas avalé.
  const broken = site({ 'http://h/sitemap.xml': '<html>oups</html>' });
  const bad = await discoverSitemaps({ startUrl: 'http://h/', fetchPage: broken.fetchPage });
  assert.match(bad.failed[0].reason, /format inconnu/);

  // 4) Plafond de plans : l'index à 20 entrées n'en fait consulter que MAX_SITEMAPS.
  const many = { 'http://h/sitemap.xml': '<sitemapindex>' + Array.from({ length: 20 },
    (_, i) => `<sitemap><loc>/s${i}.xml</loc></sitemap>`).join('') + '</sitemapindex>' };
  for (let i = 0; i < 20; i += 1) {
    many[`http://h/s${i}.xml`] = `<urlset><url><loc>http://h/f${i}.zip</loc></url></urlset>`;
  }
  const capped = await discoverSitemaps({ startUrl: 'http://h/', fetchPage: site(many).fetchPage });
  assert.equal(capped.sitemaps.length, MAX_SITEMAPS);
  assert.equal(capped.truncated, true);
  assert.equal(capped.urls.length, MAX_SITEMAPS - 1, 'l’index occupe un des créneaux');

  // 5) Plafond d'URL.
  const big = { 'http://h/sitemap.xml': '<urlset>' + Array.from({ length: 10 },
    (_, i) => `<url><loc>http://h/f${i}.zip</loc></url>`).join('') + '</urlset>' };
  const limited = await discoverSitemaps({
    startUrl: 'http://h/', fetchPage: site(big).fetchPage, maxUrls: 4,
  });
  assert.equal(limited.urls.length, 4);
  assert.equal(limited.truncated, true);

  await assert.rejects(() => discoverSitemaps({ startUrl: 'http://h/' }), /fetchPage/);
});
