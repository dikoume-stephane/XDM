import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { audit, collectTestIds, formatAudit, parseMatrix } from '../tools/audit-conformance.mjs';

test('T-32 : la matrice réelle ne présente aucun écart de traçabilité', () => {
  const result = audit();
  assert.deepEqual(result.problems, [], formatAudit(result));

  // Les chiffres revendiqués dans la documentation sont ceux que l'audit compte.
  assert.equal(result.totals.requirements, 79);
  assert.equal(result.totals.green, 78, '79 exigences, 1 hors périmètre');
  const byDomain = Object.fromEntries(result.sections.map((s) => [s.title, [s.green, s.total]]));
  assert.deepEqual(byDomain['2. Domaine A — moteur de téléchargement'], [19, 19]);
  assert.deepEqual(byDomain['3. Domaine B — grabber'], [36, 36]);
  assert.deepEqual(byDomain['3 bis. Domaine C — transports (`WP-07`)'], [13, 14]);
  assert.deepEqual(byDomain['3 ter. Domaine D — médias (`WP-07`)'], [10, 10]);
});

test('T-32 : chaque module cite au moins une exigence, une décision ou une annexe', () => {
  const { modules } = audit();
  assert.ok(modules.length >= 28, `modules audités : ${modules.length}`);
  const silent = modules.filter((module) => module.references.length === 0 && !module.annex);
  assert.deepEqual(silent, [], 'un module sans référence est un module sans justification');
});

test('T-32 : l’audit détecte les écarts — il n’est pas un tampon', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xdm-audit-'));
  try {
    await mkdir(join(root, 'docs/specs'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'bin'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });

    // Un test existe pour `T-X-01` seulement.
    await writeFile(join(root, 'test/x.test.js'), "test('T-X-01 : cas réel', () => {});\n");

    await writeFile(join(root, 'docs/specs/conformance.md'), [
      '# Matrice',
      '',
      '## 1. Domaine X',
      '',
      '| Exigence | Niveau | Preuve | Test | État |',
      '|---|---|---|---|---|',
      '| `EX-X-01` verte et couverte | Observé | annexe 14 §1 | `T-X-01` | **vert** |',
      '| `EX-X-02` verte sans test | Observé | annexe 14 §2 | `T-X-02` | **vert** |',
      '| `EX-X-03` sans preuve | Observé | `src/x.js` | `T-X-01` | **vert** |',
      '| `EX-X-04` hors périmètre | Observé | `D-004` | — | ⛔ **hors périmètre** (`H-18`) |',
      '',
      '**Couverture** : 9 exigences, **7 vertes** — chiffres faux, l’audit doit le voir.',
      '',
    ].join('\n'));

    await writeFile(join(root, 'src/x.js'), '// module sans aucune référence\nexport const x = 1;\n');
    await writeFile(join(root, 'src/y.js'), '// `EX-X-99` citée mais absente de la matrice\nexport const y = 1;\n');
    await writeFile(join(root, 'bin/cli.js'), '#!/usr/bin/env node\n// CLI sans référence (fiche C)\n');

    const result = audit({ root });
    const checks = new Set(result.problems.map((item) => item.check));
    assert.ok(checks.has('test-inconnu'), 'test cité mais absent');
    assert.ok(checks.has('vert-sans-test'), 'verte sans test existant');
    assert.ok(checks.has('preuve'), 'aucune preuve citable');
    assert.ok(checks.has('module-sans-reference'), 'module sans référence');
    assert.ok(checks.has('exigence-inconnue'), 'exigence citée hors matrice');
    assert.ok(checks.has('couverture'), 'totaux de section faux');
    // L’exigence hors périmètre n’est pas signalée : elle a le droit de ne pas avoir de test.
    assert.ok(!result.problems.some((item) => item.message.includes('EX-X-04')));

    assert.match(formatAudit(result), /couverture \(\d\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('T-32 : la matrice se lit dans ses deux dispositions de tableau', () => {
  const markdown = [
    '| Exigence | Niveau | Preuve | Test | État |',
    '|---|---|---|---|---|',
    '| `EX-A-01` fichier unique | Observé | annexe 14 §5.2 | `T-A-01` | **vert** |',
    '',
    '| ID | Exigence | Niveau | Preuve | Test | État |',
    '|---|---|---|---|---|---|',
    '| `EX-B-01` | projet = un artefact | Dérivé | annexe 11 §1 | `T-B-01` | **vert** |',
    '',
  ].join('\n');
  const [section] = parseMatrix(markdown);
  assert.deepEqual(section.rows.map((row) => [row.id, row.requirement, row.level, row.evidence, row.test]), [
    ['EX-A-01', 'fichier unique', 'Observé', 'annexe 14 §5.2', '`T-A-01`'],
    ['EX-B-01', 'projet = un artefact', 'Dérivé', 'annexe 11 §1', '`T-B-01`'],
  ]);
});

test('T-32 : les identifiants de test sont collectés depuis les fichiers, pas depuis la doc', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xdm-ids-'));
  try {
    await writeFile(join(dir, 'a.test.js'), "test('T-A-01 : un', () => {});\ntest('T-A-01 (suite) : bis', () => {});\n");
    await writeFile(join(dir, 'b.test.js'), "test('T-B-02 : deux', () => {});\n");
    const ids = collectTestIds(dir);
    assert.deepEqual([...ids.keys()].sort(), ['T-A-01', 'T-B-02']);
    assert.deepEqual(ids.get('T-A-01'), ['a.test.js'], 'un identifiant répété ne compte qu’une fois');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
