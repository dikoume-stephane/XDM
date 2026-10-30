#!/usr/bin/env node
/**
 * Comparaison de deux aspirations — outillage pour `WP-30` (comparer XDM au Site Grabber d'IDM).
 *
 * Le lot `WP-30` est bloqué ici faute de VM Windows et d'un IDM licite. Ce script existe
 * pour que la comparaison, une fois faite **hors de cet environnement**, soit reproductible :
 * deux arborescences entrent, un tableau sort, et le code de sortie dit s'il y a divergence.
 *
 * Usage :
 *   node tools/comparer-aspirations.mjs <dossier-idm> <dossier-xdm> [--json] [--tolere T]
 *
 *   --json       sortie JSON (pour l'annexe et pour un diff ultérieur)
 *   --tolere N   écart de taille toléré en octets (défaut 0)
 *
 * Codes de sortie : 0 identique, 1 divergence, 2 usage.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/** Fichiers de travail qui ne font pas partie du résultat d'une aspiration. */
const IGNORES = /(^.*\.xdmspider\.json$|^.*\.gsd$|^queue\.json$|\.xdm-part$|\.tmp$)/;

/**
 * Liste récursive des fichiers d'un dossier, triée.
 *
 * @param {string} racine
 * @param {string} [prefixe]
 * @returns {Promise<string[]>}
 */
export async function fichiers(racine, prefixe = '') {
  const entrees = await readdir(join(racine, prefixe), { withFileTypes: true });
  const liste = [];
  for (const entree of entrees.sort((a, b) => a.name.localeCompare(b.name))) {
    const chemin = prefixe === '' ? entree.name : `${prefixe}/${entree.name}`;
    if (IGNORES.test(entree.name)) continue;
    if (entree.isDirectory()) {
      liste.push(...(await fichiers(racine, chemin)));
    } else if (entree.isFile()) {
      liste.push(chemin);
    }
  }
  return liste;
}

/**
 * Décrit une arborescence : chemin → { octets, sha256 }.
 *
 * @param {string} racine
 * @returns {Promise<Map<string, {octets: number, sha256: string}>>}
 */
export async function decrire(racine) {
  const carte = new Map();
  for (const chemin of await fichiers(racine)) {
    const contenu = await readFile(join(racine, chemin));
    carte.set(chemin, {
      octets: contenu.length,
      sha256: createHash('sha256').update(contenu).digest('hex'),
    });
  }
  return carte;
}

/**
 * Compare deux descriptions.
 *
 * @param {Map<string, {octets: number, sha256: string}>} attendu
 * @param {Map<string, {octets: number, sha256: string}>} obtenu
 * @param {{tolere?: number}} [options]
 * @returns {{chemin: string, verdict: string, attendu: object|null, obtenu: object|null}[]}
 */
export function comparer(attendu, obtenu, { tolere = 0 } = {}) {
  const chemins = [...new Set([...attendu.keys(), ...obtenu.keys()])].sort();
  const lignes = [];
  for (const chemin of chemins) {
    const a = attendu.get(chemin) ?? null;
    const b = obtenu.get(chemin) ?? null;
    if (a && !b) {
      lignes.push({ chemin, verdict: 'manquant', attendu: a, obtenu: null });
      continue;
    }
    if (!a && b) {
      lignes.push({ chemin, verdict: 'en trop', attendu: null, obtenu: b });
      continue;
    }
    if (a.sha256 === b.sha256) {
      lignes.push({ chemin, verdict: 'identique', attendu: a, obtenu: b });
      continue;
    }
    const ecart = Math.abs(a.octets - b.octets);
    lignes.push({
      chemin,
      verdict: ecart <= tolere ? 'taille proche' : 'différent',
      attendu: a,
      obtenu: b,
    });
  }
  return lignes;
}

/**
 * Met le résultat en forme lisible.
 *
 * @param {{chemin: string, verdict: string, attendu: object|null, obtenu: object|null}[]} lignes
 * @returns {string}
 */
export function formater(lignes) {
  const compte = lignes.reduce((acc, ligne) => {
    acc[ligne.verdict] = (acc[ligne.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const largeur = Math.min(60, Math.max(20, ...lignes.map((l) => l.chemin.length)));
  const sortie = [
    `${'chemin'.padEnd(largeur)}  ${'verdict'.padEnd(12)}  idm (o)      xdm (o)`,
    `${'-'.repeat(largeur)}  ${'-'.repeat(12)}  -----------  -----------`,
  ];
  for (const ligne of lignes) {
    sortie.push(
      `${ligne.chemin.slice(0, largeur).padEnd(largeur)}  ${ligne.verdict.padEnd(12)}  `
      + `${String(ligne.attendu?.octets ?? '—').padEnd(12)} ${String(ligne.obtenu?.octets ?? '—')}`,
    );
  }
  const resume = Object.entries(compte).map(([verdict, nombre]) => `${verdict} : ${nombre}`).join(' · ');
  sortie.push('', `total ${lignes.length} fichier(s) — ${resume}`);
  return sortie.join('\n');
}

/**
 * Point d'entrée.
 *
 * @param {string[]} argv
 * @param {{log?: (ligne: string) => void}} [contexte]
 * @returns {Promise<number>} code de sortie
 */
export async function main(argv, { log = (ligne) => console.log(ligne) } = {}) {
  const options = { json: false, tolere: 0 };
  const positionnels = [];
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--tolere') {
      const valeur = argv[i + 1];
      if (valeur === undefined || !/^\d+$/.test(valeur)) throw new TypeError('--tolere attend un entier');
      options.tolere = Number(valeur);
      i += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new TypeError(`argument inconnu : ${argument}`);
    positionnels.push(argument);
  }
  if (positionnels.length !== 2) {
    log('usage : node tools/comparer-aspirations.mjs <dossier-idm> <dossier-xdm> [--json] [--tolere N]');
    return 2;
  }
  const [idm, xdm] = positionnels.map((chemin) => resolve(chemin));
  for (const chemin of [idm, xdm]) {
    const info = await stat(chemin).catch(() => null);
    if (!info?.isDirectory()) {
      log(`dossier introuvable : ${chemin}`);
      return 2;
    }
  }
  const lignes = comparer(await decrire(idm), await decrire(xdm), { tolere: options.tolere });
  const divergence = lignes.filter((ligne) => ligne.verdict !== 'identique' && ligne.verdict !== 'taille proche');
  if (options.json) {
    log(JSON.stringify({ idm, xdm, tolere: options.tolere, divergence: divergence.length, lignes }, null, 2));
  } else {
    log(formater(lignes));
    log('');
    log(`dossiers : ${relative(process.cwd(), idm) || idm} ↔ ${relative(process.cwd(), xdm) || xdm}`);
  }
  return divergence.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(`comparer-aspirations : ${error.message}`);
    process.exit(2);
  });
}
