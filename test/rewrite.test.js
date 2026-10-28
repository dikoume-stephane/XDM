import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRewritable,
  relativeLink,
  rewriteCss,
  rewriteDocument,
  rewriteHtml,
  rewriteReference,
  siteMapFromEntries,
} from '../src/rewrite.js';

const SITE = siteMapFromEntries([
  { url: 'http://h/index.html', localPath: 'index.html' },
  { url: 'http://h/docs/guide.html', localPath: 'docs/guide.html' },
  { url: 'http://h/img/logo.png', localPath: 'img/logo.png' },
  { url: 'http://h/style/main.css', localPath: 'style/main.css' },
]);

test('T-B-26 : chemins relatifs corrects entre fichiers locaux', () => {
  assert.equal(relativeLink('index.html', 'img/logo.png'), 'img/logo.png');
  assert.equal(relativeLink('docs/guide.html', 'img/logo.png'), '../img/logo.png');
  assert.equal(relativeLink('docs/guide.html', 'docs/autre.html'), 'autre.html');
  assert.equal(relativeLink('a/b/c.html', 'a/d/e.png'), '../d/e.png');
  assert.equal(relativeLink('docs/guide.html', 'docs/guide.html'), './', 'lien vers soi-même');
});

test('T-B-26 : une référence connue devient locale, ancre et requête conservées', () => {
  const next = rewriteReference({
    reference: '/img/logo.png',
    pageUrl: 'http://h/docs/guide.html',
    pageLocalPath: 'docs/guide.html',
    siteMap: SITE,
  });
  assert.equal(next, '../img/logo.png');

  const anchor = rewriteReference({
    reference: 'http://h/docs/guide.html#section',
    pageUrl: 'http://h/docs/guide.html',
    pageLocalPath: 'docs/guide.html',
    siteMap: SITE,
  });
  assert.equal(anchor, './#section');

  // Une requête ne crée pas une autre ressource : on retombe sur l'entrée sans requête.
  const query = rewriteReference({
    reference: 'http://h/img/logo.png?v=2',
    pageUrl: 'http://h/index.html',
    pageLocalPath: 'index.html',
    siteMap: SITE,
  });
  assert.equal(query, 'img/logo.png?v=2');

  // Références non réécrites : inconnue, non-HTTP, vide.
  assert.equal(rewriteReference({
    reference: 'http://ailleurs.com/x.png',
    pageUrl: 'http://h/',
    pageLocalPath: 'index.html',
    siteMap: SITE,
  }), null);
  assert.equal(rewriteReference({
    reference: 'mailto:a@b.c', pageUrl: 'http://h/', pageLocalPath: 'index.html', siteMap: SITE,
  }), null);
  assert.equal(isRewritable('#ancre'), false);
  assert.equal(isRewritable('data:image/png;base64,AAAA'), false);
  assert.equal(isRewritable('javascript:void(0)'), false);
});

test('T-B-26 : réécriture d’une page HTML, attributs multiples et srcset', () => {
  const html = `<!doctype html>
<html><head>
  <link rel="stylesheet" href="/style/main.css">
  <link rel="icon" href="http://ailleurs.com/favicon.ico">
</head><body>
  <a href="/docs/guide.html">guide</a>
  <img src="/img/logo.png" alt="logo" srcset="/img/logo.png 1x, /img/logo.png?v=2 2x">
  <a href="#bas">bas</a>
  <div style="background: url('/img/logo.png')"></div>
  <!-- <a href="/docs/guide.html">commenté</a> -->
  <script>var url = "/docs/guide.html";</script>
  <pre>  <a href="/docs/guide.html">pré</a></pre>
</body></html>`;

  const result = rewriteHtml(html, {
    pageUrl: 'http://h/docs/guide.html',
    pageLocalPath: 'docs/guide.html',
    siteMap: SITE,
  });

  assert.match(result.html, /href="\.\.\/style\/main\.css"/);
  assert.match(result.html, /href="http:\/\/ailleurs\.com\/favicon\.ico"/, 'externe intact');
  assert.match(result.html, /href="\.\/"/, 'lien vers soi-même depuis docs/');
  assert.match(result.html, /src="\.\.\/img\/logo\.png"/);
  assert.match(result.html, /srcset="\.\.\/img\/logo\.png 1x, \.\.\/img\/logo\.png\?v=2 2x"/);
  assert.match(result.html, /href="#bas"/, 'ancre seule intacte');
  assert.match(result.html, /style="background: url\('\.\.\/img\/logo\.png'\)"/);
  assert.match(result.html, /<!-- <a href="\/docs\/guide.html">commenté<\/a> -->/, 'commentaire intact');
  assert.match(result.html, /var url = "\/docs\/guide\.html";/, 'script intact');
  assert.match(result.html, /<pre>  <a href="\/docs\/guide\.html">pré<\/a><\/pre>/, 'pre intact');
  assert.equal(result.skipped.length, 2, 'script et style ignorés sont signalés');
  assert.ok(result.rewritten >= 6, 'href, src, deux srcset, style, feuille de style');
});

test('T-B-26 : feuille de style — url() et @import', () => {
  const css = `@import url("base.css");
.logo { background: url(/img/logo.png) no-repeat; }
.fond { background-image: url('/img/logo.png'); }
.data { content: url(data:image/png;base64,AAA); }`;
  const result = rewriteCss(css, {
    cssUrl: 'http://h/style/main.css',
    cssLocalPath: 'style/main.css',
    siteMap: SITE,
  });
  assert.match(result.css, /url\("base\.css"\)/, 'import inconnu du plan : intact');
  assert.match(result.css, /url\(\.\.\/img\/logo\.png\) no-repeat/);
  assert.match(result.css, /url\('\.\.\/img\/logo\.png'\)/);
  assert.match(result.css, /url\(data:image\/png;base64,AAA\)/, 'data: intact');
  assert.equal(result.rewritten, 2);
});

test('T-B-26 : rewriteDocument choisit d’après l’extension, ignore le reste', () => {
  const html = '<a href="/img/logo.png">x</a>';
  const asHtml = rewriteDocument(html, {
    pageUrl: 'http://h/index.html', pageLocalPath: 'index.html', siteMap: SITE,
  });
  assert.equal(asHtml.text, '<a href="img/logo.png">x</a>');

  // Une feuille de style passe par `rewriteCss` : `rewriteDocument` doit transmettre l'URL
  // sous le nom qu'attend cette fonction (`cssUrl`), sinon rien n'est réécrit.
  const asCss = rewriteDocument('body{background:url(/img/logo.png)}', {
    pageUrl: 'http://h/style.css', pageLocalPath: 'style.css', siteMap: SITE,
  });
  assert.equal(asCss.text, 'body{background:url(img/logo.png)}', 'relatif à la feuille');
  assert.equal(asCss.rewritten, 1);

  const binary = rewriteDocument('\x00\x01\x02', {
    pageUrl: 'http://h/a.zip', pageLocalPath: 'a.zip', siteMap: SITE,
  });
  assert.deepEqual(binary, { text: '\x00\x01\x02', rewritten: 0, skipped: [] }, 'binaire intact');
});
