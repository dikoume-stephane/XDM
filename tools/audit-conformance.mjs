#!/usr/bin/env node
/**
 * Audit de traçabilité (`WP-32`, revue « clean-room »).
 *
 * La revendication du projet est précise : **chaque exigence remonte à une preuve** (offset,
 * annexe, chaîne du binaire) ou à une **décision** écrite, et **chaque exigence verte est
 * couverte par un test qui existe**. Ce script vérifie cette revendication au lieu de la
 * répéter : il lit la matrice de conformité, le code et les tests, et signale les écarts.
 *
 * Ce qu'il ne fait **pas** : juger si le code est une copie. Un audit automatique ne peut pas
 * distinguer une réimplémentation d'une traduction ; il vérifie la **chaîne de références**,
 * et la revue manuelle (docs/specs/revue-clean-room.md §3) vérifie le reste.
 *
 * Usage :
 *   node tools/audit-conformance.mjs            # texte lisible
 *   node tools/audit-conformance.mjs --json     # machine
 *   node tools/audit-conformance.mjs --strict   # exit 1 si un écart est trouvé
 *
 * Aucune dépendance : `node:fs`, `node:path`, `node:url`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Un motif « preuve » : offset hexadécimal, annexe, fiche, décision ou question close. */
const EVIDENCE_PATTERN = /\b(D-0\d\d|EX-[A-Z]-\d\d|Q-[A-Z]-\d\d|H-\d\d|annexe\s+\d+|fiche\s+[A-Z]\b|0x[0-9a-f]{4,})/i;

/** Identifiants d'exigence, de test, de décision. */
const REQUIREMENT_ID = /EX-[A-Z]-\d\d/g;
const TEST_ID = /T-[A-Z]-\d\d/g;
const DECISION_ID = /D-0\d\d/g;

/**
 * Découpe la matrice en sections (`## …`) et extrait les lignes d'exigence.
 * @param {string} markdown
 * @returns {{title: string, rows: object[], coverage: string|null}[]}
 */
export function parseMatrix(markdown) {
  /** @type {{title: string, rows: object[], coverage: string|null}[]} */
  const sections = [];
  let current = { title: '(en-tête)', rows: [], coverage: null };
  sections.push(current);

  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      current = { title: line.slice(3).trim(), rows: [], coverage: null };
      sections.push(current);
      continue;
    }
    const coverage = /\*\*Couverture\*\*\s*:\s*([^*]+)/.exec(line);
    if (coverage) current.coverage = coverage[1].trim();

    // Deux dispositions coexistent dans la matrice : `| id exigence | niveau | preuve | test |
    // état |` (5 colonnes utiles) et `| id | exigence | niveau | preuve | test | état |`
    // (6 colonnes). On reconnaît la première à ce que sa 2ᵉ colonne utile est un niveau.
    const cells = line.split('|').map((cell) => cell.trim()).slice(1, -1);
    if (cells.length < 5) continue;
    const head = /^`(EX-[A-Z]-\d\d)`\s*(.*)$/.exec(cells[0]);
    if (!head) continue;
    const twoColumns = !/^(Observé|Dérivé|Décision|Hypothèse|\*\*)/i.test(cells[1]);
    const [level, evidence, test, state] = twoColumns ? cells.slice(2, 6) : cells.slice(1, 5);
    current.rows.push({
      id: head[1],
      requirement: twoColumns ? cells[1] : head[2],
      level,
      evidence,
      test,
      state,
    });
  }
  return sections;
}

/**
 * Identifiants de test **réellement présents** dans `test/`.
 * @param {string} dir
 * @returns {Map<string, string[]>} identifiant → fichiers qui le citent
 */
export function collectTestIds(dir) {
  /** @type {Map<string, string[]>} */
  const found = new Map();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort()) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const match of text.matchAll(TEST_ID)) {
      const id = match[0];
      const files = found.get(id) ?? [];
      if (!files.includes(file)) files.push(file);
      found.set(id, files);
    }
  }
  return found;
}

/**
 * Audit complet.
 * @param {{root?: string}} [options]
 * @returns {{problems: object[], sections: object[], totals: object, modules: object[]}}
 */
export function audit({ root = ROOT } = {}) {
  const matrix = readFileSync(join(root, 'docs/specs/conformance.md'), 'utf8');
  const sections = parseMatrix(matrix);
  const rows = sections.flatMap((section) => section.rows.map((row) => ({ ...row, section: section.title })));
  const testIds = collectTestIds(join(root, 'test'));

  /** @type {object[]} */
  const problems = [];
  const problem = (check, message, detail = {}) => problems.push({ check, message, ...detail });

  // 1. Preuve : une exigence doit citer quelque chose, sauf si elle est explicitement
  //    une hypothèse (et dans ce cas, elle ne peut pas être verte).
  for (const row of rows) {
    if (!EVIDENCE_PATTERN.test(row.evidence)) {
      const declared = /hypothèse/i.test(row.level) && /^—|-{1,2}$/.test(row.evidence.trim());
      if (!declared) {
        problem('preuve', `${row.id} n'a aucune preuve citable`, { evidence: row.evidence });
      }
    }
    const hypothesis = /hypothèse/i.test(row.level) && !/décision/i.test(row.level);
    if (hypothesis && /vert/i.test(row.state)) {
      problem('hypothese-verte', `${row.id} est une hypothèse mais compte comme verte`);
    }
  }

  // 2. Test : chaque identifiant cité existe réellement, et un état « vert » n'est possible
  //    que si le test existe.
  for (const row of rows) {
    const cited = row.test.match(TEST_ID) ?? [];
    if (cited.length === 0) {
      // Une exigence **hors périmètre** n'a pas de test, mais elle doit dire pourquoi.
      if (/hors périmètre/i.test(row.state)) continue;
      problem('test-absent', `${row.id} ne cite aucun test`);
      continue;
    }
    for (const id of cited) {
      if (!testIds.has(id)) problem('test-inconnu', `${row.id} cite ${id}, absent de test/`, { test: id });
    }
    if (/vert/i.test(row.state) && !cited.some((id) => testIds.has(id))) {
      problem('vert-sans-test', `${row.id} est verte sans test existant`);
    }
  }

  // 3. Traçabilité montante : chaque module de `src/` et chaque CLI cite une exigence, une
  //    décision, une fiche ou une annexe. Un module qui ne cite rien est un module dont on
  //    ne sait plus pourquoi il existe.
  const modules = [];
  for (const dir of ['src', 'bin']) {
    for (const file of readdirSync(join(root, dir)).filter((name) => name.endsWith('.js')).sort()) {
      const text = readFileSync(join(root, dir, file), 'utf8');
      const header = text.slice(0, 2000);
      const cited = new Set();
      for (const match of header.matchAll(REQUIREMENT_ID)) cited.add(match[0]);
      for (const match of header.matchAll(DECISION_ID)) cited.add(match[0]);
      const annex = /annexe\s+\d+|fiche\s+[A-G]\b/i.test(header);
      modules.push({ file: `${dir}/${file}`, references: [...cited], annex });
      if (cited.size === 0 && !annex) {
        problem('module-sans-reference', `${dir}/${file} ne cite ni exigence, ni décision, ni annexe`);
      }
    }
  }

  // 4. Traçabilité descendante : une exigence citée par le code doit exister dans la matrice.
  const known = new Set(rows.map((row) => row.id));
  for (const module of modules) {
    for (const id of module.references) {
      if (id.startsWith('EX-') && !known.has(id)) {
        problem('exigence-inconnue', `${module.file} cite ${id}, absent de la matrice`, { module: module.file });
      }
    }
  }

  // 5. Cohérence des totaux : la ligne « Couverture » d'une section contredite par ses
  //    propres lignes est un chiffre faux, pas un détail de style.
  for (const section of sections) {
    if (!section.coverage || section.rows.length === 0) continue;
    const total = section.rows.length;
    const green = section.rows.filter((row) => /vert/i.test(row.state)).length;
    const claimedTotal = /\b(\d+)\s+exigences?\b/.exec(section.coverage);
    const claimedGreen = /\*\*(\d+)\s+vertes?\*\*/.exec(section.coverage)
      ?? /(\d+)\s*\/\s*\d+/.exec(section.coverage);
    if (claimedTotal && Number(claimedTotal[1]) !== total) {
      problem('couverture', `${section.title} : « ${claimedTotal[1]} exigences » annoncées, ${total} présentes`);
    }
    if (claimedGreen && Number(claimedGreen[1]) !== green) {
      problem('couverture', `${section.title} : « ${claimedGreen[1]} vertes » annoncées, ${green} comptées`);
    }
  }

  return {
    problems,
    sections: sections.filter((section) => section.rows.length > 0).map((section) => ({
      title: section.title,
      total: section.rows.length,
      green: section.rows.filter((row) => /vert/i.test(row.state)).length,
      coverage: section.coverage,
    })),
    totals: {
      requirements: rows.length,
      green: rows.filter((row) => /vert/i.test(row.state)).length,
      tests: testIds.size,
      modules: modules.length,
    },
    modules,
  };
}

/** Rendu texte, groupé par contrôle. */
export function formatAudit(result) {
  const lines = [`Exigences : ${result.totals.requirements} (vertes : ${result.totals.green})`,
    `Modules : ${result.totals.modules} · identifiants de test distincts : ${result.totals.tests}`, ''];
  for (const section of result.sections) {
    lines.push(`  ${section.title} : ${section.green}/${section.total} vertes`);
  }
  lines.push('');
  if (result.problems.length === 0) {
    lines.push('Aucun écart de traçabilité.');
    return lines.join('\n');
  }
  const byCheck = new Map();
  for (const item of result.problems) {
    byCheck.set(item.check, [...(byCheck.get(item.check) ?? []), item]);
  }
  for (const [check, items] of [...byCheck].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${check} (${items.length}) :`);
    for (const item of items) lines.push(`  - ${item.message}`);
  }
  return lines.join('\n');
}

// Exécution directe : `node tools/audit-conformance.mjs`
if (process.argv[1] && import.meta.url.endsWith(relative(ROOT, process.argv[1]).split('/').at(-1))) {
  const result = audit();
  const json = process.argv.includes('--json');
  console.log(json ? JSON.stringify(result, null, 2) : formatAudit(result));
  if (process.argv.includes('--strict') && result.problems.length > 0) process.exitCode = 1;
}
