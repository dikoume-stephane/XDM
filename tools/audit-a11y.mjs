#!/usr/bin/env node
/**
 * Audit d'accessibilité d'une page HTML statique (maquette, page de doc).
 *
 * Dépendances optionnelles, volontairement hors `package.json` pour ne pas
 * alourdir le dépôt ni la CI : `npm i --no-save axe-core jsdom`.
 *
 * Usage :
 *   node tools/audit-a11y.mjs docs/maquettes/interface-xdm-v2.html
 *   node tools/audit-a11y.mjs <fichier> --tous-les-ecrans   # retire hidden/.ecran
 *
 * Règles : wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa + best-practice.
 * `color-contrast` est désactivé : jsdom ne calcule pas la mise en page, le
 * contraste se vérifie sur les jetons (voir docs/maquettes/SKILL-ui-ux-pro-max.md).
 *
 * Codes de sortie : 0 = aucune violation, 1 = violations, 2 = dépendance absente.
 */
import fs from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const fichier = args.find((a) => !a.startsWith('--'));
const tousLesEcrans = args.includes('--tous-les-ecrans');

if (!fichier) {
  console.error('Usage : node tools/audit-a11y.mjs <fichier.html> [--tous-les-ecrans]');
  process.exit(2);
}
if (!fs.existsSync(fichier)) {
  console.error(`Fichier introuvable : ${fichier}`);
  process.exit(2);
}

let JSDOM;
let axe;
try {
  ({ JSDOM } = await import('jsdom'));
  axe = (await import('axe-core')).default;
} catch {
  console.error('Dépendances absentes : npm i --no-save axe-core jsdom');
  process.exit(2);
}

const html = fs.readFileSync(fichier, 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const document = dom.window.document;

if (tousLesEcrans) {
  for (const e of document.querySelectorAll('.ecran')) {
    e.removeAttribute('hidden');
    e.classList.add('actif');
  }
  for (const e of document.querySelectorAll('[hidden]')) e.removeAttribute('hidden');
}

dom.window.eval(axe.source);

const resultat = await dom.window.axe.run(document, {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
  },
  rules: { 'color-contrast': { enabled: false } },
});

console.log(
  `${fichier} : ${resultat.violations.length} violation(s), ` +
    `${resultat.passes.length} règle(s) satisfaite(s), ${resultat.incomplete.length} à vérifier à la main.`,
);

for (const v of resultat.violations) {
  console.log(`\n[${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} nœud(s))`);
  for (const n of v.nodes.slice(0, 5)) console.log(`   ${n.target.join(' ')}`);
}

process.exit(resultat.violations.length === 0 ? 0 : 1);
