import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_EXCLUDE_MOTIFS,
  FIRST_FILTER_ID,
  addEntry,
  addFilter,
  classifyUrl,
  createProject,
  findFilterList,
  globToRegExp,
  loadProject,
  matchesMotif,
  moveFilter,
  normalizeUrl,
  projectPath,
  removeFilter,
  saveProject,
  setFilterActive,
  splitMotif,
  validateProject,
} from "../src/project.js";

const base = () => createProject({ name: "exemple", rootUrl: "https://exemple.test/docs/" });

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "xdm-proj-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("T-B-04 : le premier filtre reçoit l'identifiant 100, puis le compteur avance", () => {
  const project = base();
  assert.equal(project.filters.exclude[0].id, FIRST_FILTER_ID);
  assert.equal(project.nextFilterId, FIRST_FILTER_ID + 1);

  const withInclude = addFilter(project, "include", "*.pdf");
  assert.equal(withInclude.filters.include[0].id, 101);
  assert.equal(withInclude.nextFilterId, 102);

  const again = addFilter(withInclude, "include", "*.zip");
  assert.equal(again.filters.include[1].id, 102);
  assert.deepEqual(validateProject(again), { ok: true, errors: [] });
});

test("T-B-03 : un filtre n'a pas de portée propre — le déplacer ne change que la collection", () => {
  let project = addFilter(base(), "include", "*.pdf");
  const [filter] = project.filters.include;
  assert.deepEqual(Object.keys(filter).sort(), ["actif", "id", "motif"], "ni scope ni type (D-032)");

  project = moveFilter(project, filter.id, "exclude");
  assert.equal(project.filters.include.length, 0);
  assert.deepEqual(
    project.filters.exclude.find((f) => f.id === filter.id),
    filter,
    "le filtre est identique, seule la liste a changé",
  );
  assert.equal(findFilterList(project, filter.id), "exclude");

  // Déplacer vers la liste courante ne fait rien, et un id inconnu est refusé.
  assert.equal(moveFilter(project, filter.id, "exclude"), project);
  assert.throws(() => moveFilter(project, 999, "include"), /filtre inconnu/);
});

test("T-B-03 (suite) : une portée écrite dans un filtre invalide le projet", () => {
  const project = base();
  project.filters.include.push({ id: 500, motif: "*.pdf", actif: true, scope: "url" });
  project.nextFilterId = 501;
  const verdict = validateProject(project);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(" "), /porte une portée/);
});

test("T-B-05 : un motif est un masque glob, éventuellement une liste séparée par des virgules", () => {
  assert.equal(matchesMotif("*.png", "https://exemple.test/img/photo.png"), true);
  assert.equal(matchesMotif("*.png", "https://exemple.test/img/xapng"), false, "ancrage strict");
  assert.equal(matchesMotif("*.jpg,*.jpeg", "https://exemple.test/a/b.jpeg"), true);
  assert.equal(matchesMotif("*.jpg,*.jpeg", "https://exemple.test/a/b.gif"), false);
  assert.equal(matchesMotif("manuel?.pdf", "https://exemple.test/manuel1.pdf"), true);
  assert.equal(globToRegExp("*.tar.gz").test("a.tar.gz"), true);
  assert.deepEqual(splitMotif(" *.a , *.b ,"), ["*.a", "*.b"]);

  const parDefaut = DEFAULT_EXCLUDE_MOTIFS.join(",");
  assert.equal(DEFAULT_EXCLUDE_MOTIFS.length, 11);
  assert.equal(matchesMotif(parDefaut, "https://exemple.test/index.html"), true);
  assert.equal(matchesMotif(parDefaut, "https://exemple.test/manuel.pdf"), false);
});

test("T-B-05 (décision) : l'exclusion l'emporte, le reste n'est pas retenu", () => {
  let project = base();
  project = addFilter(project, "include", "*.html");
  // *.html est à la fois inclusion explicite et exclusion par défaut.
  assert.equal(classifyUrl(project, "https://exemple.test/page.html"), "exclude");

  // Désactiver l'exclusion rend l'inclusion effective : le champ actif compte.
  const exclusion = project.filters.exclude[0];
  const relaxed = setFilterActive(project, exclusion.id, false);
  assert.equal(classifyUrl(relaxed, "https://exemple.test/page.html"), "include");
  assert.equal(classifyUrl(project, "https://exemple.test/manuel.pdf"), "none");
});

test("T-B-* : suppression et désactivation ne recyclent jamais un identifiant", () => {
  let project = addFilter(base(), "include", "*.pdf");
  const id = project.filters.include[0].id;
  project = removeFilter(project, id);
  assert.equal(project.filters.include.length, 0);
  assert.equal(project.nextFilterId, id + 1, "le compteur continue d'avancer");

  const next = addFilter(project, "include", "*.zip");
  assert.equal(next.filters.include[0].id, id + 1);
  assert.equal(removeFilter(next, 4242), next, "supprimer un id inconnu est sans effet");
});

test("T-B-02 : le projet est validé, versionné et relu à l'identique", async (t) => {
  const dir = await sandbox(t);
  const path = projectPath(dir, "exemple");
  const project = addFilter(base(), "include", "*.pdf");

  await saveProject(path, project);
  assert.ok(path.endsWith(".xdmspider.json"));
  const reloaded = await loadProject(path);
  assert.deepEqual(reloaded, project);
  assert.deepEqual(validateProject(reloaded), { ok: true, errors: [] });

  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.version, 1);
  assert.deepEqual(await readdir(dir), ["exemple.xdmspider.json"], "écriture atomique");
});

test("T-B-02 (bis) : un projet incohérent est rejeté, jamais réparé", async (t) => {
  const dir = await sandbox(t);
  const path = projectPath(dir, "casse");
  await writeFile(path, "{ pas du json", "utf8");
  await assert.rejects(() => loadProject(path), /JSON invalide/);

  const broken = base();
  broken.nextFilterId = 1; // ≤ max id existant
  await writeFile(path, JSON.stringify(broken), "utf8");
  await assert.rejects(() => loadProject(path), /carte|projet rejeté/);
  await assert.rejects(() => saveProject(path, broken), /refusé à l'écriture/);
});

test("T-B-02 (ter) : nextFilterId, entrées et profondeur sont contrôlés", () => {
  const project = base();
  assert.equal(validateProject({ ...project, name: "" }).ok, false);

  const dup = { ...project, entries: [{ url: "https://a.test/x" }, { url: "https://a.test/x" }] };
  assert.match(validateProject(dup).errors.join(" "), /entrée dupliquée/);

  const deep = { ...project, depth: 1, sitemap: [{ url: "https://a.test", profondeur: 3 }] };
  assert.match(validateProject(deep).errors.join(" "), /au-delà de la profondeur/);

  const badCounter = { ...project, nextFilterId: 50 };
  assert.match(validateProject(badCounter).errors.join(" "), /nextFilterId/);
});

test("T-B-* : une entrée déjà présente n'est pas ajoutée deux fois", () => {
  const project = base();
  const once = addEntry(project, { url: "https://exemple.test/docs/a.pdf" });
  assert.equal(once.added, true);
  assert.equal(once.project.entries[0].etat, "en-attente");
  assert.equal(once.project.entries[0].localFileName, "a.pdf");

  const twice = addEntry(once.project, { url: "https://exemple.test/docs/a.pdf#page=2" });
  assert.equal(twice.added, false, "ancre ignorée par la normalisation");
  assert.equal(twice.project.entries.length, 1);

  assert.equal(normalizeUrl("https://A.test/x#y"), "https://a.test/x");
});
