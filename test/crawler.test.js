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
  documentBase,
  parseCrawlDelay,
  sameSiteHost,
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
    if (typeof route === 'function') return route(url);
    // `{status, body}` permet de simuler une panne ; une chaîne reste une page `200`.
    return typeof route === 'string' ? { status: 200, body: route } : route;
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

test('T-B-13 : `robots.txt` — règle la plus longue, `Allow` à égalité (RFC 9309)', () => {
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

  // À longueur égale, `Allow` l'emporte : c'est le RFC 9309 (§2.2.2), et le sens pratique —
  // un administrateur qui écrit les deux veut autoriser l'exception. Changement assumé
  // (`D-059`) : la version précédente faisait gagner `Disallow`.
  const tie = parseRobots('User-agent: *\nAllow: /x\nDisallow: /x\n');
  assert.equal(isAllowed('http://h/x', tie), true);
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

test('T-B-07 : profondeur 1 = page de départ seule, `DEFAULT_DEPTH` = 2', async () => {
  const routes = { 'http://s.example/': '<a href="/x.html">x</a>' };
  const { fetchPage, requests } = site(routes);
  const result = await crawl('http://s.example/', { fetchPage, depth: 1, robots: false });
  assert.equal(result.fetched, 1);
  assert.deepEqual(result.pages.map((p) => p.depth), [1]);
  assert.deepEqual(result.retained.map((r) => r.url), ['http://s.example/x.html']);
  assert.deepEqual(requests, ['http://s.example/']);
  assert.equal(DEFAULT_DEPTH, 2);
});

test('T-B-08 (suite) : la page de départ est retenue seulement si une inclusion la retient', async () => {
  const routes = {
    'http://r.example/': '<a href="/a.html">a</a>',
    'http://r.example/a.html': '<a href="/">retour</a>',
  };
  const { fetchPage } = site(routes);

  // Sans inclusion : comportement historique, la racine n'est pas aspirée (elle n'a pas
  // d'extension, donc les exclusions `*.html` ne la viseraient pas par accident).
  const plain = await crawl('http://r.example/', { fetchPage, depth: 1, robots: false });
  assert.deepEqual(plain.retained.map((r) => r.url), ['http://r.example/a.html']);

  // Avec une inclusion qui la retient : elle fait partie du plan, en profondeur 0.
  const included = await crawl('http://r.example/', {
    fetchPage, depth: 1, robots: false, filters: { include: ['*'] },
  });
  assert.deepEqual(included.retained.map((r) => r.url), ['http://r.example/', 'http://r.example/a.html']);
  assert.equal(included.retained[0].depth, 0);

  // Une exclusion explicite de la racine reste souveraine (D-032).
  const excluded = await crawl('http://r.example/', {
    fetchPage, depth: 1, robots: false, filters: { include: ['*'], exclude: ['http://r.example/'] },
  });
  assert.deepEqual(excluded.retained.map((r) => r.url), ['http://r.example/a.html']);
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

test('T-B-29 : `robots.txt` — groupes, jokers, ancre de fin et directives ignorées', () => {
  const text = [
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: XDM',
    'User-agent: autre-robot',
    'Disallow: /prive',
    'Allow: /prive/public',
    'Disallow: /*.pdf$',
    'Disallow: /tmp/*/secret',
    'Crawl-delay: 10',
    'Sitemap: http://h/sitemap.xml',
    '',
    'User-agent: XDM',
    'Disallow: /bannis',
  ].join('\n');

  const rules = parseRobots(text);
  // Le groupe nommé l'emporte sur `*` : `/` reste donc explorable…
  assert.equal(isAllowed('http://h/', rules), true, 'le groupe `*` ne s’applique pas');
  // …mais les deux groupes `XDM` sont fusionnés (RFC 9309 §2.2.1).
  assert.equal(isAllowed('http://h/bannis/x', rules), false, 'second groupe XDM fusionné');
  assert.equal(isAllowed('http://h/prive/x', rules), false);
  assert.equal(isAllowed('http://h/prive/public/page', rules), true);

  // `$` ancre la fin : `*.pdf$` interdit `/a/b.pdf`, pas `/a/b.pdf.html`.
  assert.equal(isAllowed('http://h/doc.pdf', rules), false);
  assert.equal(isAllowed('http://h/doc.pdf.html', rules), true);
  // `*` traverse les séparateurs de chemin.
  assert.equal(isAllowed('http://h/tmp/a/b/secret', rules), false);
  assert.equal(isAllowed('http://h/tmp/secret', rules), true, 'le motif exige le segment du milieu');

  // Un `Disallow:` vide n'interdit rien, et les directives inconnues sont ignorées.
  const empty = parseRobots('User-agent: *\nDisallow:\nCrawl-delay: 5\n');
  assert.deepEqual(empty, []);
  assert.equal(isAllowed('http://h/n-importe-quoi', empty), true);

  // Aucun groupe ne nous nomme, aucun `*` : tout est permis.
  const other = parseRobots('User-agent: googlebot\nDisallow: /\n');
  assert.deepEqual(other, []);
  assert.equal(isAllowed('http://h/x', other), true);

  // Le jeton de produit ignore la version et la casse (`XDM/1.0 (+grabber)` → `xdm`).
  const versioned = parseRobots('User-agent: xdm/2.0\nDisallow: /x\n', { agent: 'XDM/1.0 (+grabber)' });
  assert.equal(isAllowed('http://h/x', versioned), false);

  // La requête fait partie du chemin comparé (RFC 9309 §2.2.2).
  const query = parseRobots('User-agent: *\nDisallow: /recherche?');
  assert.equal(isAllowed('http://h/recherche?q=1', query), false);
  assert.equal(isAllowed('http://h/recherche', query), true);

  // Un motif est du texte, pas une expression régulière : les métacaractères sont littéraux.
  const literal = parseRobots('User-agent: *\nDisallow: /a+b(c)');
  assert.equal(isAllowed('http://h/a+b(c)/x', literal), false);
  assert.equal(isAllowed('http://h/ab/x', literal), true);
});

test('T-B-30 : crawl parallèle borné — même résultat, ordre stable, plafond respecté', async () => {
  // Un site en étoile : la racine mène à 6 pages, chacune à un fichier.
  const routes = { 'http://p.example/': '' };
  const links = [];
  for (let i = 1; i <= 6; i += 1) {
    routes[`http://p.example/n${i}.html`] = `<a href="/f${i}.bin">f</a>`;
    links.push(`<a href="/n${i}.html">n${i}</a>`);
  }
  routes['http://p.example/'] = links.join('');

  const runWith = async (parallelisme) => {
    let active = 0;
    let peak = 0;
    const { fetchPage } = site(routes);
    const result = await crawl('http://p.example/', {
      depth: 2,
      robots: false,
      parallelisme,
      fetchPage: async (url) => {
        active += 1;
        peak = Math.max(peak, active);
        // Une latence variable : si l'ordre dépendait du hasard du réseau, il changerait ici.
        await new Promise((resolve) => setTimeout(resolve, (url.length % 3) + 1));
        try {
          return await fetchPage(url);
        } finally {
          active -= 1;
        }
      },
    });
    return { result, peak };
  };

  const serial = await runWith(1);
  assert.equal(serial.peak, 1, 'série : jamais deux requêtes à la fois');

  const parallel = await runWith(3);
  assert.ok(parallel.peak <= 3, `plafond respecté (pic observé : ${parallel.peak})`);
  assert.ok(parallel.peak >= 2, `le parallélisme sert à quelque chose (pic : ${parallel.peak})`);

  // Le résultat ne dépend pas du parallélisme : mêmes pages, même ordre, mêmes entrées.
  assert.deepEqual(
    parallel.result.pages.map((page) => [page.url, page.depth]),
    serial.result.pages.map((page) => [page.url, page.depth]),
  );
  assert.deepEqual(
    parallel.result.retained.map((entry) => entry.url),
    serial.result.retained.map((entry) => entry.url),
  );
  assert.equal(new Set(parallel.result.pages.map((page) => page.url)).size, parallel.result.pages.length,
    'aucune page demandée deux fois');

  // Un plafond absurde est refusé, pas silencieusement corrigé.
  await assert.rejects(
    () => crawl('http://p.example/', { fetchPage: site(routes).fetchPage, parallelisme: 0 }),
    /parallelisme/,
  );
});

test('T-B-31 : `Crawl-delay` lu pour le bon groupe, appliqué entre les vagues seulement', async () => {
  // Lecture : extension hors RFC, donc tolérante — mais jamais devinée.
  const text = [
    'User-agent: *',
    'Crawl-delay: 5',
    '',
    'User-agent: XDM',
    'Crawl-delay: 0.25',
    'Disallow: /prive',
  ].join('\n');
  assert.equal(parseCrawlDelay(text), 0.25, 'le groupe nommé l’emporte sur `*`');
  assert.equal(parseCrawlDelay('User-agent: *\nCrawl-delay: 7'), 7);
  assert.equal(parseCrawlDelay('User-agent: XDM'), null, 'site muet ⇒ aucun délai');
  assert.equal(parseCrawlDelay('User-agent: *\nCrawl-delay: -3'), null, 'valeur absurde ignorée');
  assert.equal(parseCrawlDelay('User-agent: *\nCrawl-delay: jamais'), null);
  assert.equal(parseCrawlDelay('User-agent: *\nCrawl-delay: 2\n\nUser-agent: XDM\nCrawl-delay: 9'),
    9, 'groupes homonymes : le plus exigeant gagne');

  const routes = {
    'http://d.example/': '<a href="/a.html">a</a><a href="/b.html">b</a>',
    'http://d.example/a.html': 'a',
    'http://d.example/b.html': 'b',
  };
  const runWith = async (options) => {
    const waits = [];
    const { fetchPage } = site(routes, { robotsText: 'User-agent: XDM\nCrawl-delay: 3\n' });
    const result = await crawl('http://d.example/', {
      depth: 2,
      fetchPage,
      sleep: async (ms) => { waits.push(ms); },
      ...options,
    });
    return { result, waits };
  };

  // Le site demande 3 s. En série, trois pages ⇒ trois vagues ⇒ deux attentes : le délai
  // sépare deux requêtes, il n'est pas payé avant la première ni après la dernière.
  const obey = await runWith({});
  assert.equal(obey.result.delay, 3);
  assert.deepEqual(obey.waits, [3000, 3000]);
  assert.equal(obey.result.pages.length, 3);

  // Avec deux requêtes en parallèle : deux vagues ⇒ une seule attente.
  const bunched = await runWith({ parallelisme: 2 });
  assert.deepEqual(bunched.waits, [3000]);
  assert.equal(bunched.result.pages.length, 3);

  // `delai: 0` est une décision explicite : on n'attend pas du tout.
  const override = await runWith({ delai: 0 });
  assert.equal(override.result.delay, 0);
  assert.deepEqual(override.waits, []);

  // Un délai explicite plus grand l'emporte aussi, et se compte en millisecondes.
  const slower = await runWith({ delai: 1.5 });
  assert.deepEqual(slower.waits, [1500, 1500], 'millisecondes, pas secondes');

  // Sans `robots`, aucun délai n'est lu — mais un délai explicite reste honoré.
  const { fetchPage } = site(routes, { robotsText: 'User-agent: *\nCrawl-delay: 9' });
  const waits = [];
  const withoutRobots = await crawl('http://d.example/', {
    depth: 1,
    robots: false,
    fetchPage,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(withoutRobots.delay, 0);
  assert.deepEqual(waits, []);

  await assert.rejects(() => crawl('http://d.example/', {
    fetchPage: site(routes).fetchPage,
    delai: -1,
  }), /delai/);
});

test('T-B-32 : l’élagage coupe la branche, le filtre d’exclusion ne fait que trier', async () => {
  const routes = {
    'http://e.example/': '<a href="/a.html">a</a><a href="/prive/b.html">b</a>',
    'http://e.example/a.html': '<a href="/f/a.txt">a</a>',
    'http://e.example/prive/b.html': '<a href="/f/b.txt">b</a>',
    'http://e.example/f/a.txt': 'A',
    'http://e.example/f/b.txt': 'B',
  };
  const filters = { include: ['*.html', '*.txt'], exclude: ['*/prive/*'] };

  // Filtre seul : la page privée n'est pas retenue, mais elle est **parcourue** — donc son
  // fichier est découvert. C'est le comportement historique, conservé.
  const simple = await crawl('http://e.example/', { depth: 2, robots: false, fetchPage: site(routes).fetchPage, filters });
  assert.ok(!simple.retained.some((entry) => entry.url.includes('/prive/')), 'page privée non retenue');
  assert.ok(simple.retained.some((entry) => entry.url.endsWith('/f/b.txt')), 'fichier découvert quand même');

  // Élagage : la branche n'est pas demandée du tout, et son fichier n'existe plus.
  const requests = [];
  const { fetchPage } = site(routes);
  const pruned = await crawl('http://e.example/', {
    depth: 2,
    robots: false,
    filters,
    prune: ['*/prive/*'],
    fetchPage: async (url) => {
      requests.push(url);
      return fetchPage(url);
    },
  });
  assert.ok(!requests.some((url) => url.includes('/prive/')), 'aucune requête vers la branche élaguée');
  assert.ok(!pruned.retained.some((entry) => entry.url.endsWith('/f/b.txt')));
  assert.ok(pruned.skipped.some((entry) => entry.reason === 'élagage:*/prive/*'));
  assert.deepEqual(pruned.retained.map((entry) => entry.url).sort(), [
    'http://e.example/a.html',
    'http://e.example/f/a.txt',
  ]);
});

test('T-B-33 : `<base href>` change la résolution des liens relatifs', () => {
  const page = 'http://b.example/dossier/page.html';
  assert.equal(documentBase('<base href="/autre/">', page), 'http://b.example/autre/');
  assert.equal(documentBase('<base href="http://cdn.example/x/">', page), 'http://cdn.example/x/');
  // Absente, vide, relative ou d'un autre protocole : on retombe sur la page.
  assert.equal(documentBase('<html></html>', page), page);
  assert.equal(documentBase('<base href="">', page), page);
  assert.equal(documentBase('<base href="ftp://h/x/">', page), page);
  assert.equal(documentBase(`<base href='../'>`, page), 'http://b.example/');
  // Seule la **première** balise compte, et elle n'a pas besoin d'être écrite sur une ligne.
  assert.equal(
    documentBase('<head>\n<BASE\n  HREF="/un/">\n<base href="/deux/"></head>', page),
    'http://b.example/un/',
  );

  const html = '<base href="/sous/"><a href="doc.zip">d</a><a href="/abs/autre.zip">a</a>'
    + '<a href="#ancre">ici</a><img src="img/x.png">';
  assert.deepEqual(extractLinks(html, page), [
    'http://b.example/sous/doc.zip',
    'http://b.example/abs/autre.zip',
    'http://b.example/sous/img/x.png',
  ]);

  // Conséquence de parcours : les fichiers sont retenus **sous la base**, pas sous la page.
  const routes = {
    'http://b.example/dossier/page.html': '<base href="/sous/"><a href="doc.zip">d</a>',
    'http://b.example/sous/doc.zip': 'ZIP',
  };
  return crawl('http://b.example/dossier/page.html', { depth: 1, robots: false, fetchPage: site(routes).fetchPage })
    .then((result) => {
      assert.deepEqual(result.retained.map((entry) => entry.url), ['http://b.example/sous/doc.zip']);
    });
});

test('T-B-34 : un site en panne s’arrête après N échecs consécutifs', async () => {
  // La racine répond, ses six pages renvoient `500` : sans garde-fou, six requêtes inutiles.
  const links = Array.from({ length: 6 }, (_, i) => `<a href="/p${i}.html">p${i}</a>`).join('');
  const routes = { 'http://x.example/': links };
  for (let i = 0; i < 6; i += 1) routes[`http://x.example/p${i}.html`] = { status: 500, body: 'boom' };

  const counted = () => {
    const requests = [];
    const { fetchPage } = site(routes);
    return {
      requests,
      fetchPage: async (url) => {
        requests.push(url);
        return fetchPage(url);
      },
    };
  };

  const open = counted();
  const unlimited = await crawl('http://x.example/', {
    depth: 2, robots: false, parallelisme: 1, fetchPage: open.fetchPage,
  });
  assert.equal(open.requests.length, 7, 'sans garde-fou : la racine + les six pages');
  assert.equal(unlimited.errors.length, 6);
  assert.equal(unlimited.stopped, 'épuisement', 'une file vidée n’est pas un arrêt sur erreur');

  const guarded = counted();
  const stopped = await crawl('http://x.example/', {
    depth: 2, robots: false, parallelisme: 1, maxErrors: 3, fetchPage: guarded.fetchPage,
  });
  assert.equal(stopped.stopped, 'erreurs');
  assert.equal(guarded.requests.length, 4, 'racine + trois échecs, puis plus rien');
  assert.equal(stopped.consecutiveErrors, 3);

  // Un échec isolé ne déclenche rien : le compteur repart à zéro après une page lue.
  const mixed = {
    'http://y.example/': '<a href="/ok.html">o</a><a href="/ko.html">k</a><a href="/ok2.html">o2</a>',
    'http://y.example/ok.html': 'ok',
    'http://y.example/ko.html': { status: 404, body: '' },
    'http://y.example/ok2.html': 'ok',
  };
  const survivant = await crawl('http://y.example/', {
    depth: 2, robots: false, parallelisme: 1, maxErrors: 2, fetchPage: site(mixed).fetchPage,
  });
  assert.equal(survivant.stopped, 'épuisement');
  assert.equal(survivant.pages.length, 4);

  await assert.rejects(
    () => crawl('http://y.example/', { fetchPage: site(mixed).fetchPage, maxErrors: 0 }),
    /maxErrors/,
  );
});

test('T-B-36 : `--sous-domaines` élargit au même parent, jamais à un tiers', () => {
  assert.equal(sameSiteHost('a.example.test', 'b.example.test'), true);
  assert.equal(sameSiteHost('www.example.test', 'example.test'), true);
  assert.equal(sameSiteHost('example.test', 'example.test'), true);
  // Un tiers n'est jamais « le même site », même s'il partage une fin de chaîne trompeuse.
  assert.equal(sameSiteHost('example.test', 'autre.test'), false);
  assert.equal(sameSiteHost('evil-example.test', 'example.test'), false);
  assert.equal(sameSiteHost('example.test', 'example.test.autre.test'), false);

  const routes = {
    'http://a.example.test/': '<a href="http://b.example.test/x.html">b</a>'
      + '<a href="http://autre.test/y.html">tiers</a>',
    'http://b.example.test/x.html': 'x',
    'http://autre.test/y.html': 'y',
  };
  // Comportement historique : tout ce qui n'est pas la même origine est « hors site ».
  return crawl('http://a.example.test/', { depth: 2, robots: false, fetchPage: site(routes).fetchPage })
    .then((strict) => {
      assert.deepEqual(strict.retained.map((entry) => entry.url), []);
      assert.equal(strict.skipped.filter((entry) => entry.reason === 'hors site').length, 2);
      return crawl('http://a.example.test/', {
        depth: 2, robots: false, subdomains: true, fetchPage: site(routes).fetchPage,
      });
    })
    .then((large) => {
      assert.deepEqual(large.pages.map((page) => page.url), [
        'http://a.example.test/',
        'http://b.example.test/x.html',
      ], 'le sous-domaine est visité');
      assert.deepEqual(large.skipped.filter((entry) => entry.reason === 'hors site')
        .map((entry) => entry.url), ['http://autre.test/y.html'], 'le tiers reste dehors');
    });
});

test('T-B-37 : les amorces (plan de site) sont visitées sans privilège', async () => {
  const routes = {
    'http://s.example/': '<a href="/liee.html">l</a>',
    'http://s.example/liee.html': 'l',
    'http://s.example/page-amorce.html': '<a href="/liee.html">l</a>',
    'http://s.example/prive/orpheline.zip': 'ZIP',
    'http://s.example/publique.zip': 'ZIP2',
    'http://autre.example/loin.zip': 'X',
  };
  const result = await crawl('http://s.example/', {
    depth: 1,
    robots: false,
    seeds: [
      'http://s.example/publique.zip',
      'http://s.example/page-amorce.html',
      'http://s.example#fragment',
      'http://autre.example/loin.zip',
      'mailto:contact@s.example',
    ],
    fetchPage: site(routes).fetchPage,
  });
  assert.equal(result.seeds.offered, 5);
  assert.equal(result.seeds.queued, 2, 'un fichier retenu, une page mise en file');
  assert.equal(result.seeds.rejected, 3, 'doublon de départ, tiers et URL invalide écartés');
  assert.ok(result.retained.some((entry) => entry.url === 'http://s.example/publique.zip'),
    'une amorce fichier est retenue sans être visitée');
  assert.ok(!result.pages.some((page) => page.url.endsWith('publique.zip')),
    'un fichier n’est pas « visité » comme une page');
  assert.ok(result.pages.some((page) => page.url === 'http://s.example/page-amorce.html'));
  assert.ok(!result.retained.some((entry) => entry.url.startsWith('http://autre.example')));

  // Une amorce interdite par `robots.txt` n'est pas visitée : même règle que les liens.
  const blocked = await crawl('http://s.example/', {
    depth: 1,
    seeds: ['http://s.example/prive/orpheline.zip'],
    fetchPage: site(routes, { robotsText: 'User-agent: *\nDisallow: /prive/\n' }).fetchPage,
  });
  assert.deepEqual(blocked.skipped.map((entry) => entry.reason), ['robots.txt']);
  assert.equal(blocked.fetched, 1, 'seule la page de départ est lue');
  assert.ok(!blocked.retained.some((entry) => entry.url.includes('/prive/')),
    'une amorce interdite n’est pas retenue');
  assert.equal(blocked.seeds.rejected, 1);
});

test('T-B-38 : `attempts` couvre aussi l’exploration (503 puis 200)', async () => {
  let calls = 0;
  const flaky = async (url) => {
    if (url.endsWith('/robots.txt')) return { status: 404, body: '' };
    if (url.endsWith('/instable.html')) {
      calls += 1;
      if (calls === 1) return { status: 503, body: '', headers: { 'retry-after': '2' } };
      return { status: 200, body: 'contenu' };
    }
    return { status: 200, body: '<a href="/instable.html">i</a>' };
  };
  const waits = [];
  const result = await crawl('http://f.example/', {
    depth: 2,
    attempts: 3,
    fetchPage: flaky,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(result.errors.length, 0, 'le 503 passager est absorbé');
  assert.equal(result.pages.length, 2);
  assert.equal(result.retries, 1);
  assert.deepEqual(waits, [2000], 'le Retry-After du serveur est respecté');

  // Sans reprise, le même serveur fait perdre la page — et l'erreur est comptée.
  calls = 0;
  const once = await crawl('http://f.example/', { depth: 2, attempts: 1, fetchPage: flaky });
  assert.deepEqual(once.errors.map((error) => error.status), [503]);
  assert.equal(once.retries, 0, 'sans reprise, le statut est remonté tel quel');

  await assert.rejects(
    () => crawl('http://f.example/', { fetchPage: flaky, attempts: 0 }),
    /attempts/,
  );
});

test('T-B-39 : une interruption coopérative arrête les vagues suivantes', async () => {
  const signal = { aborted: false };
  const links = Array.from({ length: 5 }, (_, i) => `<a href="/p${i}.html">p${i}</a>`).join('');
  const routes = { 'http://i.example/': links };
  for (let i = 0; i < 5; i += 1) routes[`http://i.example/p${i}.html`] = `p${i}`;

  const requests = [];
  const { fetchPage } = site(routes);
  const result = await crawl('http://i.example/', {
    depth: 2,
    robots: false,
    signal,
    fetchPage: async (url) => {
      requests.push(url);
      // L'interruption tombe au milieu du parcours, comme un Ctrl-C : la vague en cours va
      // au bout, la suivante n'est pas entamée.
      if (requests.length === 3) signal.aborted = true;
      return fetchPage(url);
    },
  });
  assert.equal(result.stopped, 'interrompu');
  assert.equal(result.pages.length, 3, `pages lues : ${result.pages.length}`);
  assert.equal(requests.length, 3, 'aucune requête après l’interruption');
});
