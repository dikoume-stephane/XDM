# XDM

Projet de **réimplémentation du « Site Grabber » d'Internet Download Manager** (aspirateur
de site, « çonage ») dans XDM, mené en **analyse statique outillée** : la cible
`cible/IDMan.exe` (IDM 6.42.22.3) est inspectée sans jamais être exécutée, chaque
constat étant rattaché à une preuve reproductible.

Outil principal : **[REA](https://github.com/morluto/rea)** (*Reverse Engineer Anything*),
CLI + serveur MCP qui produit des bundles *Evidence* (constats, couverture, limites).

## Démarrage

```bash
npm test                           # socle XDM : 106 tests, sans dépendance (node --test)
node bin/xdm.js <url> [dossier]    # téléchargement réel : plages, reprise, promotion
node bin/xdm-grab.js <url> [dir]   # aspiration de site : parcours, arborescence, file
```

```bash
npm install                        # rea-agents épinglé (6.8.0)
npm run doctor                     # état de l'environnement et des providers
bash tools/collect-idman-evidence.sh   # preuves REA sur la cible  -> analysis/raw/idman/
python3 tools/idman_triage.py          # agrégats déterministes    -> analysis/idman/triage.json
python3 tools/idman_extract.py         # chaînes/RTTI/dialogues    -> analysis/raw/idman/
python3 tools/idman_classes.py         # RTTI -> vtables/méthodes  -> analysis/idman/classes.json
python3 tools/idman_symbols.py         # noms « Classe::Methode »  -> analysis/idman/symbols.json
python3 tools/idman_attrib.py          # noms -> adresses          -> analysis/idman/methods.json
python3 tools/idman_states.py          # machine à états (39)      -> analysis/idman/states.json
python3 tools/idman_io.py             # modèle d'E/S et seuils    -> analysis/idman/io-model.json
python3 tools/idman_io.py --resolve 0x35c0a0   # slot d'import -> DLL!fonction
python3 tools/idman_chunks.py         # politique de morceaux     -> analysis/idman/chunks.json
python3 tools/idman_filters.py        # structure des filtres     -> analysis/idman/filters.json
python3 tools/idman_grabber.py        # où vit le grabber         -> analysis/idman/grabber.json
python3 tools/idman_class_profile.py --pattern 'HTTPConnection'   # fiche par classe
```

Dépendances Python : `pefile`, `capstone` (`python3 -m pip install --break-system-packages pefile capstone`).
Dépendances du socle : **aucune** — Node 22, ES modules, types JSDoc (`D-034`).

## Le logiciel (moteur, domaine A clos)

| Module | Rôle | Décision |
|---|---|---|
| `src/chunk-map.js` | carte de morceaux : liste de bornes `{id, start, next, completed}`, validation des 6 invariants, progression dérivée, rollback | `D-030`, `D-031`, `D-035` |
| `src/chunk-policy.js` | taille de morceau adaptative bornée 1–10 MiB, trois profils observés | `D-029` |
| `src/part-file.js` | persistance atomique de `<cible>.xdm-part.json` | `D-024` |
| `src/work-file.js` | fichier de travail unique, écriture positionnée, rollback par troncature | `D-026` |
| `src/project.js` | projet d'aspiration, filtres (masques glob), compteur d'ids à partir de 100 | `D-032`, `D-033` |
| `src/task-queue.js` | file de tâches reprenable, 8 actifs par défaut, transitions explicites | `D-036` |
| `src/promote.js` | assainissement du nom final, promotion atomique après vérification | `D-037`, `D-026` |
| `src/http-client.js` | sonde de ressource, `Range`/`If-Range`, redirections ≤ 10, `identity`, inactivité 30 s | `D-038` |
| `src/divergence.js` | hachage des fenêtres de recouvrement, détection de divergence entre connexions | `D-039` |
| `src/connection-loop.js` | boucle de connexions : distribution des morceaux, reprise depuis la carte, repli, plafond 128 sockets, promotion optionnelle | `D-039`, `D-040` |
| `src/crawler.js` | aspiration : BFS par niveau, URL canonique, `robots.txt`, filtres du projet | `D-041` |
| `src/grabber.js` | arborescence locale, collisions, `empty.html`, promotion en tâches ordinaires | `D-042` |
| `src/grab-runner.js` | exécution d'une file : états, échec isolé, concurrence bornée, persistance | `D-043` |
| `bin/xdm.js` | CLI : `xdm <url> [dossier] [--connexions N] [--morceau T]`, nom déduit de l'URL, promotion finale | `D-037`, `D-040` |

État : **domaines A et B clos** — 97 cas verts, 30 exigences sur 32 couvertes
(`docs/specs/conformance.md`). Le moteur télécharge, reprend, vérifie et promeut ; le grabber
parcourt un site, en déduit l'arborescence locale et alimente la file de téléchargement. La chaîne fonctionne de bout en bout : sonde,
découpage, connexions parallèles, reprise après coupure **depuis la carte persistée**,
détection de divergence, promotion atomique — pilotée par la CLI. Reste le grabber
(`WP-11`, bloqué par l'exploration de `CIDMSpider`, cf. `Q-B-01`).

## Où lire quoi

| Objectif | Fichier |
|---|---|
| **Décisions prises et pourquoi** | [`docs/JOURNAL.md`](docs/JOURNAL.md) |
| **Plan de travail (phases, lots, portes)** | [`docs/ROADMAP-IDM.md`](docs/ROADMAP-IDM.md) |
| **Index de la mémoire du projet** | [`docs/MEMOIRE.md`](docs/MEMOIRE.md) |
| Anatomie du binaire | [`analysis/idman/01-anatomie-binaire.md`](analysis/idman/01-anatomie-binaire.md) |
| Fonctionnalités cartographiées | [`analysis/idman/02-cartographie-fonctionnelle.md`](analysis/idman/02-cartographie-fonctionnelle.md) |
| Protocoles et formats attestés | [`analysis/idman/03-protocoles-et-formats.md`](analysis/idman/03-protocoles-et-formats.md) |
| Modules de la suite IDM | [`analysis/idman/04-modules-et-composants.md`](analysis/idman/04-modules-et-composants.md) |
| Registre, navigateurs, état du grabber | [`analysis/idman/05-integrations-et-registre.md`](analysis/idman/05-integrations-et-registre.md) |
| Vtables, classes, attribution | [`analysis/idman/10-vtables-et-classes.md`](analysis/idman/10-vtables-et-classes.md) |
| Modèle de données du projet (v0.1) | [`analysis/idman/11-modele-donnees-projet.md`](analysis/idman/11-modele-donnees-projet.md) |
| Spécification du grabber (v0.1) | [`analysis/idman/12-spec-grabber.md`](analysis/idman/12-spec-grabber.md) |
| Filtres et artefacts (`empty.html`) | [`analysis/idman/13-filtres-et-artefacts.md`](analysis/idman/13-filtres-et-artefacts.md) |
| Moteur de téléchargement (morceaux, reprise) | [`analysis/idman/14-moteur-de-telechargement.md`](analysis/idman/14-moteur-de-telechargement.md) |
| Hypothèses à vérifier | [`analysis/idman/06-hypotheses.md`](analysis/idman/06-hypotheses.md) |
| Gabarit de fiche de spécification | [`docs/specs/TEMPLATE.md`](docs/specs/TEMPLATE.md) |
| Fiche A — moteur de téléchargement (brouillon, `A-05`) | [`docs/specs/A-moteur-de-telechargement.md`](docs/specs/A-moteur-de-telechargement.md) |
| Fiche B — grabber / aspiration de site (brouillon, `A-05`) | [`docs/specs/B-grabber.md`](docs/specs/B-grabber.md) |
| Matrice de conformité exigence → preuve → test (`WP-12`) | [`docs/specs/conformance.md`](docs/specs/conformance.md) |
| Installation et usage de REA | [`docs/REA.md`](docs/REA.md) |

## Structure

```text
src/                       socle XDM (ESM, zéro dépendance)
test/                      tests de spécification (node --test)
cible/IDMan.exe            cible d'analyse (fournie sur main)
docs/                      journal, roadmap, index mémoire, specs, doc REA
analysis/idman/            annexes de mémoire (00 → 14) + triage.json + classes.json
analysis/raw/              bundles Evidence + extractions brutes (non versionnés)
samples/demo-electron-app  app témoin pour valider REA
tools/                     collecte de preuves, triage, extractions
```

## État actuel

- ✅ Outillage REA installé, épinglé et validé (app Electron témoin + 11 bundles Evidence
  sur `IDMan.exe`).
- ✅ Triage statique complet : PE, sections, mitigations, imports (509 + 111), ressources
  (436), 439 noms RTTI, 105 dialogues, marqueurs de protocoles, 124 clés de registre.
- ✅ Journal, roadmap, index mémoire et 10 annexes rédigés.
- ✅ WP-04 terminé : **422 classes / 427 vtables / 13 760 méthodes** extraites des RTTI
  (`analysis/idman/classes.json`, annexe 10), 45 chaînes fonctionnelles attribuées.
- 🟡 WP-06/WP-11 démarrés : projet de grabber = **fichier `.gsd`** dans
  `<IDM>\Grabber\Projects\` (classe `GrSh`) + miroir registre
  (`GrabberSts\Projects\%ld\%ld\ChList`, compteur `nextFilterID`) — annexes 11 et 12.
- 🟡 WP-05 (annexe 14 v0.2) : moteur = `SessionManager` → `Session`/`Connection`
  (HTTP/FTP/MMS/RTMP + proxies) → `ChunksList` ; morceaux persistants, rollback par
  troncature, anti-corruption par recouvrement, montée en charge progressive ; état de
  connexion = **entier en `this+0xa4`, 39 valeurs**, 8 `switch` en tables de sauts,
  115 transitions (A-12 levée, `D-027`). Modèle d'E/S : un `select` par session,
  `fd_set` de 516 o (128 sockets), échéance plafonnée à 12 000 ms, 8 connexions par
  défaut (A-13, `D-028`).
- 🟢 WP-05 v0.4 : taille de morceau **1–10 MiB** par classe de taille (`D-029`), états
  17..27 nommés d'après les libellés d'interface, `MNSP` = combinaison d'URL WinINet.
- ⛔ WP-03 (décompilation Ghidra) **bloqué** dans ce sandbox : ni JVM ni accès au CDN des
  releases GitHub (`JOURNAL.md` D-019) — à reprendre hors sandbox.
- ⏳ Reste à confirmer : le périmètre (action A-01) et la stack d'implémentation (D-017).
- ⛔ Hors périmètre par décision : licence/activation, contournement anti-débogage,
  extraction des cookies de navigateurs (voir `docs/JOURNAL.md` D-004).
