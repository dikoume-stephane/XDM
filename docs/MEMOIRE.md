# Mémoire du projet — index et conventions

> Ce fichier est la **carte** de tout ce qui est su sur la cible et sur les décisions
> prises. Il ne contient pas d'analyse : il dit *où* trouver quoi, *à quel point* c'est
> fiable, et *comment* mettre à jour sans casser la traçabilité.

- **Projet** : clonage du Site Grabber (« çonage ») d'Internet Download Manager dans XDM.
- **Cible** : `cible/IDMan.exe` — IDM 6.42.22.3, PE32 i386, 6 017 024 octets,
  SHA-256 `5f78da5a63604a3fefba6577ef6b2af976ec4d2fc4d0f219a72099a0da2f11c9`.
- **Dernière revue** : 2026-10-28 (annexe 15 v3 : fiches C et D, HLS et DASH implémentés ; annexe 16 v1 : protocole VM ; annexe 14 v0.7 : `A-11`/`A-13`, `D-030`/`D-031` ; annexe 13 v0.2 : `A-10`, `D-032`/`D-033` ; **A, B, HLS et DASH implémentés, C entamé : 52 exigences, 45 vertes, 141 tests, `D-034`→`D-048`**).

---

## 1. Les quatre niveaux de mémoire

| Niveau | Fichier | Nature | Règle de mise à jour |
|---|---|---|---|
| Décisions | [`JOURNAL.md`](JOURNAL.md) | chronologique, **immuable** | on ajoute une entrée ; on ne réécrit jamais une décision passée (on la remplace) |
| Plan | [`ROADMAP-IDM.md`](ROADMAP-IDM.md) | vivant | révisé à chaque jalon / changement de périmètre |
| Index | ce fichier | vivant | mis à jour dès qu'une annexe est créée ou déplacée |
| Connaissances | `analysis/idman/NN-*.md` | thématique, versionnée | enrichie par ajout de lignes sourcées ; jamais « de mémoire » |

---

## 2. Annexes thématiques

| Fichier | Contenu | Statut | Source de vérité |
|---|---|---|---|
| [`analysis/idman/00-preuves.md`](../analysis/idman/00-preuves.md) | Registre des preuves : commande REA, `evidence_id`, ce qu'elle établit, ses limites | ✅ | bundles `analysis/raw/idman/*.json` |
| [`01-anatomie-binaire.md`](../analysis/idman/01-anatomie-binaire.md) | Format PE, sections, entropies, mitigations, build, imports, ressources | ✅ | `triage.json` + bundles REA |
| [`02-cartographie-fonctionnelle.md`](../analysis/idman/02-cartographie-fonctionnelle.md) | 8 domaines fonctionnels, classes RTTI, dialogues, marqueurs | ✅ | `triage.json` §rtti, §resources |
| [`03-protocoles-et-formats.md`](../analysis/idman/03-protocoles-et-formats.md) | HTTP/FTP/HLS/DASH/RTMP/MMS/TS : ce qui est attesté, ce qui reste à prouver | ✅ | `triage.json` §protocol_markers |
| [`04-modules-et-composants.md`](../analysis/idman/04-modules-et-composants.md) | Cartographie de la suite IDM (exe/dll, rôles inférés) | ✅ | chaînes + imports |
| [`05-integrations-et-registre.md`](../analysis/idman/05-integrations-et-registre.md) | Navigation native (`com.tonec.idm`), BHO/extension, clés de registre | ✅ | `triage.json` §registry_hits |
| [`06-hypotheses.md`](../analysis/idman/06-hypotheses.md) | Hypothèses ouvertes `H-xx` avec protocole de vérification | ✅ | — |
| [`07-glossaire.md`](../analysis/idman/07-glossaire.md) | Sigles (MFC, RTTI, DASH, SIDX, LSP, AMF…) et vocabulaire Evidence | ✅ | — |
| [`08-index-citations.md`](../analysis/idman/08-index-citations.md) | Offsets, IDs de ressources, offsets de chaînes : de quoi rejouer chaque citation | ✅ | `triage.json` |
| [`09-registre-decisions.md`](../analysis/idman/09-registre-decisions.md) | Tableau récapitulatif des décisions (vue dense du journal) | ✅ | `JOURNAL.md` |
| [`analysis/idman/10-vtables-et-classes.md`](../analysis/idman/10-vtables-et-classes.md) | Vtables, méthodes, attribution chaîne→classe | ✅ v1 (WP-04) | `classes.json` |
| [`analysis/idman/11-modele-donnees-projet.md`](../analysis/idman/11-modele-donnees-projet.md) | Modèle de données du projet (fichier `.gsd`, registre, filtres) | 🟡 brouillon (WP-11) | capstone + `classes.json` |
| [`analysis/idman/12-spec-grabber.md`](../analysis/idman/12-spec-grabber.md) | Spécification du grabber : stockage du projet, schéma de valeurs, **mesures « où vit le grabber »** (réglages `+0xb8`/`+0x124`/`+0x138`, conteneurs `SPL`/`RL`/`LI2` sans référence code, imports WinINet non transférants) | 🟡 v0.2 (WP-06/WP-11) | `classes.json` + `grabber.json` + capstone |
| [`analysis/idman/13-filtres-et-artefacts.md`](../analysis/idman/13-filtres-et-artefacts.md) | Filtres du grabber : `IDM_SPIDERFILTER` (16 o), identifiants (`nextFilterID`, premier = 100), persistance `REG_SZ` sous `IncludeFilters`/`ExcludeFilters`, défauts, `empty.html` | 🟢 v0.2 (A-08/A-10) | `filters.json` |
| [`analysis/idman/14-moteur-de-telechargement.md`](../analysis/idman/14-moteur-de-telechargement.md) | Moteur : architecture en anneaux, noms→adresses, machine à états (39 états nommés), E/S et seuils, taille de morceau 1–10 MiB, `MNSP`, **modèle de morceau = intervalle dans un fichier unique**, carte = liste de bornes, assemblage = promotion du `.tmp`, rollback par troncature, délai `select` et inactivité 30 s/300 s, multi-connexion, HTTP/FTP | 🟡 v0.7 (WP-05) | `methods.json` + `states.json` + `chunks.json` + `io-model.json` + capstone |
| [`analysis/idman/15-spec-protocoles.md`](../analysis/idman/15-spec-protocoles.md) | **Fiches C et D** : transports (HTTP/1.1, `If-Range`, cookies, compression, FTP, RTMP/MMS, proxys) et médias (12 balises HLS, `CM3UParser`, DASH par `sidx`, conteneurs) | 🟢 v3 (domaine D 10/10, domaine C 3/10) | `D-045`→`D-048`, `H-18`, `H-19` |
| [`analysis/idman/16-protocole-observation-vm.md`](../analysis/idman/16-protocole-observation-vm.md) | Protocole d'observation en VM (6 phases, critères d'acceptation) : défauts d'installation, ordre d'exploration, `robots.txt`, format `.gsd`, *native messaging*, inactivité/reprises | ✅ v1 (non exécuté) | preuves `analysis/raw/idman/vm-*` |

---

## 2 bis. Code produit (domaine A clos : `WP-20`→`WP-22`)

| Fichier | Rôle | Décisions | Tests |
|---|---|---|---|
| `src/chunk-map.js` | carte de morceaux `{id,start,next,completed}`, 6 invariants, progression dérivée, rollback | `D-030`, `D-031`, `D-035` | `T-A-01`→`T-A-06` |
| `src/chunk-policy.js` | taille de morceau par profil (`default`/`fine`/`coarse`), bornes 1–10 MiB | `D-029` | `T-A-19`, `T-A-26` |
| `src/part-file.js` | persistance atomique de la carte (`<fichier>.xdm-part.json`) | `D-024` | `T-A-27` |
| `src/work-file.js` | fichier de travail unique, écriture positionnée, rollback par troncature | `D-026` | `T-A-09` |
| `src/project.js` | projet d'aspiration, filtres glob, compteur d'ids dès 100 | `D-032`, `D-033` | `T-B-02`→`T-B-05` |
| `src/task-queue.js` | file reprenable, 8 actifs, transitions explicites | `D-036` | `T-A-07` |
| `src/promote.js` | nom final assaini, promotion atomique après vérification | `D-037`, `D-026` | `T-A-11`, `T-A-12`, `T-A-14` |
| `src/http-client.js` | sonde et segments HTTP : `Range`, `If-Range`, redirections bornées, `identity`, inactivité 30 s | `D-038` | `T-A-08`, `T-A-15`→`T-A-17`, `T-A-25` |
| `src/divergence.js` | fenêtres de recouvrement hachées en SHA-256, garde de divergence | `D-039` | `T-A-10` |
| `src/connection-loop.js` | boucle de connexions : distribution, reprise, repli, 128 sockets | `D-039` | `T-A-01`, `T-A-08`, `T-A-10`, `T-A-13`, `T-A-25` |
| `src/crawler.js` | aspiration : BFS par niveau, URL canonique, `robots.txt`, filtres | `D-041` | `T-B-07`→`T-B-09`, `T-B-13` |
| `src/grabber.js` | aspiration : arborescence locale, collisions, `empty.html`, promotion en tâches ordinaires | `D-042` | `T-B-01`, `T-B-06`, `T-B-10`→`T-B-12` |
| `src/cookies.js` | cookies de session RFC 6265 : portée hôte/domaine/chemin, `Secure`, expiration ; transport enveloppé | `D-047` | `T-C-04` |
| `src/dash.js` | média MP4 segmenté : `sidx` → plages, init (préfixe ou URL), refus sans index | `D-048` | `T-D-08` |
| `src/hls.js` | analyse de playlist HLS : variantes, renditions, segments, plages, clé, init | `D-046` | `T-D-01`→`T-D-07`, `T-D-09` |
| `src/sidx.js` | boîtes MP4 et index `sidx` : plages exactes des sous-segments | `D-046` | `T-D-08` |
| `src/media.js` | plan et téléchargement d'un flux HLS, assemblage facultatif | `D-046` | `T-D-02`→`T-D-06`, `T-D-10` |
| `bin/xdm-media.js` | CLI de flux : playlist → segments → dossier assemblé | `D-046` | `T-D-03` |
| `src/grab-runner.js` | exécution d'une file : états, échec isolé, concurrence, persistance | `D-043` | `T-A-07`, `T-A-22`, `T-B-01` |
| `bin/xdm-grab.js` | CLI d'aspiration : parcours → arborescence → file → téléchargements ; `--reprendre`, `--sortie json` | `D-043`, `D-044` | `T-B-10`, `T-B-20`→`T-B-22` |
| `bin/xdm.js` | CLI : `xdm <url> [dossier]`, nom déduit de l'URL, promotion finale | `D-037`, `D-040` | `T-A-14` |
| `src/index.js` | barillet (159 exports) | `D-034` | — |

**Règle** : une exigence ne passe au vert que si un test de `test/` la couvre ; le tableau de
`docs/specs/conformance.md` fait foi.

---

## 3. Données générées (ne pas éditer à la main)

| Fichier | Producteur | Versionné | Régénération |
|---|---|---|---|
| `analysis/idman/triage.json` | `tools/idman_triage.py` | ✅ (déterministe, 74 Ko) | `python3 tools/idman_triage.py` |
| `analysis/idman/classes.json` | `tools/idman_classes.py` | ✅ (déterministe, 461 Ko) | `python3 tools/idman_classes.py` |
| `analysis/idman/symbols.json` | `tools/idman_symbols.py` | ✅ (déterministe, 55 Ko) | `python3 tools/idman_symbols.py` |
| `analysis/idman/methods.json` | `tools/idman_attrib.py` | ✅ (déterministe, 96 Ko) | `python3 tools/idman_attrib.py` |
| `analysis/idman/states.json` | `tools/idman_states.py` | ✅ (déterministe, 37 Ko) | `python3 tools/idman_states.py` |
| `analysis/idman/io-model.json` | `tools/idman_io.py` | ✅ (déterministe, 8 Ko) | `python3 tools/idman_io.py` |
| `analysis/idman/chunks.json` | `tools/idman_chunks.py` | ✅ (déterministe, 4 Ko) | `python3 tools/idman_chunks.py` |
| `analysis/idman/filters.json` | `tools/idman_filters.py` | ✅ (déterministe, 2 Ko) | `python3 tools/idman_filters.py` |
| `analysis/idman/grabber.json` | `tools/idman_grabber.py` | ✅ (déterministe) | `python3 tools/idman_grabber.py` |
| `analysis/idman/profiles/*.json` | `tools/idman_class_profile.py` | ❌ (exploration) | `python3 tools/idman_class_profile.py --pattern '<Classe>'` |
| `analysis/raw/idman/*.json` | `tools/collect-idman-evidence.sh` | ❌ (ignoré) | `bash tools/collect-idman-evidence.sh` |
| `analysis/raw/idman/strings-*.txt`, `rtti-classes.txt`, `rt-string.txt`, `dialog-captions.txt`, `menus.txt` | scripts ad hoc documentés en annexe 08 | ❌ (ignoré) | voir annexe 08 §3 |

**Règle** : si une donnée doit être citée plus d'une fois, elle passe dans
`tools/idman_triage.py` (donc dans `triage.json`), jamais dans une note manuelle.

---

## 4. Conventions d'identifiants

| Préfixe | Sens | Exemple |
|---|---|---|
| `D-xxx` | décision (journal) | `D-004` périmètre légal |
| `WP-xx` | lot de travail (roadmap) | `WP-06` grabber |
| `EV-xxx` | preuve (bundle REA ou mesure) | `EV-inspect-pe-imports` |
| `H-xx` | hypothèse ouverte | `H-02` format de projet binaire |
| `R-xx` | risque | `R-02` attribution classe↔fonction |
| `A-xx` | action | `A-02` installer Ghidra |

Un identifiant n'est **jamais** réutilisé, même après abandon d'un lot.

### Niveaux de confiance (obligatoires dans les annexes)

| Étiquette | Définition | Exemple |
|---|---|---|
| **Observé** | mesuré directement dans le fichier | « la ressource 5 (DIALOG) contient 105 modèles » |
| **Dérivé** | conséquence d'observations, raisonnement explicite | « `mfcm90.dll` ⇒ VS2008 SP1 » |
| **Hypothèse** | plausible, non prouvé → `H-xx` | « `CIDMSpider` gère la file de frontière » |
| **Inconnu** | on ne sait pas, et on l'écrit | « format exact du fichier projet » |

---

## 5. Règles de fraîcheur

1. Une annexe dont une affirmation a été **invalidée** porte en tête
   `⚠ ANNEXE PARTIELLEMENT PÉRIMÉE — voir JOURNAL D-0xx`.
2. Les preuves REA sont valables **pour ce SHA-256** uniquement ; si la cible change,
   relancer `tools/collect-idman-evidence.sh` et mettre à jour `00-preuves.md`.
3. Les faits marqués **Hypothèse** n'entrent dans une spécification qu'après
   validation (phase 6) ou décision explicite du porteur de projet.
4. Aucune capture binaire, aucun dump de chaînes complet dans Git (`D-003`, `D-010`).

---

## 6. Par où commencer la lecture

- **Nouveau sur le projet** → `ROADMAP-IDM.md` §0-1, puis `02-cartographie-fonctionnelle.md`.
- **Je veux vérifier une affirmation** → `00-preuves.md` puis `08-index-citations.md`.
- **Je veux coder** → `ROADMAP-IDM.md` §3 (P3) + la fiche `docs/specs/` du domaine.
- **Je veux savoir pourquoi un choix a été fait** → `JOURNAL.md`.
