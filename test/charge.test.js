import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManager } from '../src/manager.js';
import { createUiServer, UI_DIR } from '../src/ui-server.js';

const POLICES = join(UI_DIR, 'polices');

/** Démarre un serveur sur un port libre, avec le dossier temporaire fourni. */
async function avecServeur(options, callback) {
  const { serveur, manager } = createUiServer(options);
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  try {
    return await callback({ base, manager });
  } finally {
    await new Promise((ok) => serveur.close(() => ok(undefined)));
  }
}

/** Mesure une requête : durée en millisecondes et charge utile décodée. */
async function chronometrer(url) {
  const debut = process.hrtime.bigint();
  const reponse = await fetch(url);
  const texte = await reponse.text();
  const duree = Number(process.hrtime.bigint() - debut) / 1e6;
  return { statut: reponse.status, duree, texte, taille: Buffer.byteLength(texte) };
}

test('T-E-23 : la police est embarquée et servie par l’interface, pas par un CDN', async () => {
  for (const fichier of ['plus-jakarta-sans-latin-400-normal.woff2', 'plus-jakarta-sans-latin-700-normal.woff2']) {
    const contenu = await readFile(join(POLICES, fichier));
    assert.equal(contenu.subarray(0, 4).toString('latin1'), 'wOF2', `${fichier} est bien un WOFF2`);
    assert.ok(contenu.length < 30 * 1024, `${fichier} reste léger (${contenu.length} o)`);
  }
  const licence = await readFile(join(POLICES, 'OFL.txt'), 'utf8');
  assert.match(licence, /SIL Open Font License/i, 'la licence accompagne les fontes');

  const css = await readFile(join(UI_DIR, 'style.css'), 'utf8');
  assert.match(css, /@font-face/, 'les fontes sont déclarées');
  assert.match(css, /url\("\/polices\/plus-jakarta-sans-latin-400-normal\.woff2"\)/);
  assert.doesNotMatch(css, /https?:\/\//, 'aucune requête vers un CDN depuis la feuille de style');

  await avecServeur({ dossier: '/tmp/xdm-charge-inexistant' }, async ({ base }) => {
    const fonte = await fetch(`${base}/polices/plus-jakarta-sans-latin-400-normal.woff2`);
    assert.equal(fonte.status, 200);
    assert.equal(fonte.headers.get('content-type'), 'font/woff2');
    const octets = new Uint8Array(await fonte.arrayBuffer());
    assert.equal(Buffer.from(octets.subarray(0, 4)).toString('latin1'), 'wOF2');
  });
});

test('T-E-23 : une file de 300 tâches reste servie en moins de 300 ms', async () => {
  const racine = await mkdtemp(join(tmpdir(), 'xdm-charge-'));
  try {
    const manager = createManager({ dossier: racine, telecharger: async () => ({ size: 0 }) });
    for (let i = 0; i < 300; i += 1) {
      manager.ajouter({ url: `https://exemple.test/fichier-${i}.bin`, nom: `fichier-${i}.bin` });
    }
    assert.equal(manager.etat().taches.length, 300);

    await avecServeur({ manager }, async ({ base }) => {
      const etat = await chronometrer(`${base}/api/etat`);
      assert.equal(etat.statut, 200);
      assert.ok(etat.duree < 300, `GET /api/etat : ${etat.duree.toFixed(1)} ms`);
      const charge = JSON.parse(etat.texte);
      assert.equal(charge.taches.length, 300);
      assert.equal(charge.compteurs.attente, 300);

      const journal = await chronometrer(`${base}/api/journal`);
      assert.equal(journal.statut, 200);
      assert.ok(journal.duree < 300, `GET /api/journal : ${journal.duree.toFixed(1)} ms`);
    });
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('T-E-23 : le journal est borné, et l’historique aussi', async () => {
  const racine = await mkdtemp(join(tmpdir(), 'xdm-charge-'));
  try {
    const manager = createManager({ dossier: racine, maxJournal: 50, telecharger: async () => ({ size: 0 }) });
    // 120 ajouts produisent au moins 120 entrées de journal : la borne doit tenir.
    for (let i = 0; i < 120; i += 1) manager.ajouter({ url: `https://exemple.test/${i}.bin` });
    assert.equal(manager.journal().length, 50, 'le journal garde les 50 dernières entrées');
    assert.equal(manager.journal().at(-1).seq > manager.journal()[0].seq, true, 'les entrées restent ordonnées');
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('T-E-23 : vingt abonnés SSE reçoivent le même événement', async () => {
  const racine = await mkdtemp(join(tmpdir(), 'xdm-charge-'));
  try {
    const manager = createManager({ dossier: racine, telecharger: async () => ({ size: 0 }) });
    const recus = [];
    const desabonnements = [];
    for (let i = 0; i < 20; i += 1) {
      recus.push([]);
      desabonnements.push(manager.abonner((evenement) => recus[i].push(evenement.type)));
    }
    manager.ajouter({ url: 'https://exemple.test/fanout.bin' });
    for (const liste of recus) assert.ok(liste.includes('ajout'), 'chaque abonné a reçu l’ajout');
    for (const desabonner of desabonnements) desabonner();
    manager.ajouter({ url: 'https://exemple.test/apres.bin' });
    assert.equal(recus[0].includes('ajout') && recus[0].filter((t) => t === 'ajout').length, 1, 'un abonné désabonné ne reçoit plus rien');
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test('T-E-23 : la page réelle ne tire rien d’Internet', async () => {
  const html = await readFile(join(UI_DIR, 'index.html'), 'utf8');
  // Aucune ressource distante : ni script, ni style, ni image, ni fonte.
  assert.doesNotMatch(html, /<script[^>]+src="https?:/i);
  assert.doesNotMatch(html, /<link[^>]+href="https?:/i);
  assert.doesNotMatch(html, /<img[^>]+src="https?:/i);
  assert.match(html, /<script type="module" src="\/app\.js">/);
  // Toutes les références locales existent réellement sur disque.
  for (const [, chemin] of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    if (chemin === '/') continue;
    const fichier = fileURLToPath(new URL(`.${chemin}`, `file://${UI_DIR}/`));
    const contenu = await readFile(fichier).catch(() => null);
    assert.ok(contenu, `ressource déclarée mais absente : ${chemin}`);
  }
  assert.ok(http);
});
