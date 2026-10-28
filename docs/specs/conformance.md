# Matrice de conformité (WP-12, v0.1)

> **Statut** : ✅ v1.1 — **Dernière revue** : 2026-10-28
> **Rôle** : relier, pour chaque exigence de spécification, la **preuve** statique qui la
> fonde et le **test** qui la vérifiera. Aucune ligne d'implémentation ne référence une
> exigence absente de ce fichier.
> **Sources** : `docs/specs/A-moteur-de-telechargement.md` (v0.7),
> `docs/specs/B-grabber.md` (v0.5), annexes 12 à 16 ; fiches C et D dans l'annexe 15.
> **Rappel** : « preuve » ne veut pas dire « comportement validé ». Une exigence
> **Hypothèse** n'a pas de preuve et ne peut pas être marquée conforme.

## 1. Légende

| Colonne | Sens |
|---|---|
| Niveau | `Observé` (lu dans le binaire), `Dérivé` (interprétation explicite), `Décision` (choix XDM), `Hypothèse` (non prouvé) |
| Test | identifiant du test prévu ; `—` = pas encore écrit |
| État | `à faire`, `écrit`, `vert`, `rouge` |

## 2. Domaine A — moteur de téléchargement

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-A-01` fichier unique écrit en place | Observé | annexe 14 §5.2, §7 (`CreateFileW` `0x156d48`) | `T-A-01` | **vert** |
| `EX-A-02` état dans `<cible>.xdm-part.json` | Décision | `D-024` | `T-A-02` | **vert** |
| `EX-A-03` carte = liste de bornes | Observé + Décision | annexe 14 §5.1 ; `D-030` | `T-A-03` | **vert** |
| `EX-A-04` rejet des cartes incohérentes | Dérivé | `D-030` | `T-A-04` | **vert** |
| `EX-A-05` progression dérivée | Dérivé | `D-031` | `T-A-05` | **vert** |
| `EX-A-06` morceau 1–10 MiB, paliers 2/10 MiB | Observé + Décision | annexe 14 §5.4 ; `chunks.json` ; `D-029` | `T-A-06` | **vert** |
| `EX-A-07` 1 → N connexions, plafond 8 par défaut | Observé + Décision | annexe 14 §6 ; `0x0fbe17` ; `D-036`, `D-043` | `T-A-07` | **vert** (allocation, file, boucle et **runner** ; la boucle réseau reste à écrire) |
| `EX-A-08` `Range` par morceau, repli 1 connexion sans `206` | Observé | annexe 14 §8 ; `D-038` | `T-A-08` | **vert** (planification ; la boucle reste à écrire) |
| `EX-A-09` rollback = troncature + morceau de reprise | Observé + Décision | annexe 14 §5.3 ; `D-035` | `T-A-09` | **vert** |
| `EX-A-10` divergence → empreinte → repli | Observé + Décision | annexe 14 §5.5 ; `D-025`, `D-039` | `T-A-10` | **vert** |
| `EX-A-11` morceau incomplet jamais finalisé | Observé | annexe 14 §7 (`isCmpleted = 0`) | `T-A-11` | **vert** |
| `EX-A-12` promotion conditionnée à la vérification | Observé + Décision | annexe 14 §7 ; `D-026` | `T-A-12` | **vert** |
| `EX-A-13` réacteur unique, 128 sockets, délai ≤ 12 s | Observé + Décision | annexe 14 §4.4 ; `io-model.json` ; `D-028`, `D-039` | `T-A-13` | **vert** (plafond 128 ; le réacteur unique est celui de Node) |
| `EX-A-14` nom final assaini | Observé + Décision | annexe 14 §3 ; `D-037` | `T-A-14` | **vert** |
| `EX-A-15` URL relative résolue, ≤ 10 redirections, ≤ 10 239 o | Observé | annexe 14 §8.1 (`0x17dc90`) ; `D-038` | `T-A-15` | **vert** |
| `EX-A-16` `Accept-Encoding: identity` | Observé | annexe 14 §8 ; `D-038` | `T-A-16` | **vert** |
| `EX-A-17` aucune télémétrie | Décision | `D-004`, `D-012` | `T-A-17` | **vert** |
| `EX-A-18` inactivité > 30 s ⇒ reconnexion | Observé | annexe 14 §4.5 (`0x1a139f`, `0x18adad`) ; `D-038` | `T-A-25` | **vert** |
| `EX-A-19` reprise sans retour à zéro | Observé + Décision | annexe 14 §4.5, §5.3 ; `D-030` | `T-A-26` | **vert** |

**Couverture** : 19 exigences, **19 vertes** (`npm test`, 108 cas) — domaine A **clos**.
La boucle de connexions (`src/connection-loop.js`) exécute les exigences de bout en bout
contre des serveurs locaux, y compris la coupure, la reprise depuis la carte persistée et la
promotion (`T-A-25`, `T-A-19`, `T-A-12`). Aucune exigence
`Hypothèse` dans ce domaine.

## 3. Domaine B — grabber

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-B-01` projet = un artefact | Observé + Décision | annexe 11 §1 (`%sproject%s.gsd`) ; `D-042` | `T-B-01` | **vert** |
| `EX-B-02` contenu du projet | Dérivé | annexe 11 §4 | `T-B-02` | **vert** |
| `EX-B-03` filtre sans portée propre | Observé + Décision | annexe 13 §2 bis ; `D-032` | `T-B-03` | **vert** |
| `EX-B-04` identifiants à partir de 100 | Observé + Décision | annexe 13 §2 ter ; `D-033` | `T-B-04` | **vert** |
| `EX-B-05` motif = masque glob | Observé | annexe 13 §4 bis | `T-B-05` | **vert** |
| `EX-B-06` champs d'une entrée | Observé | annexe 12 §2 | `T-B-06` | **vert** |
| `EX-B-07` profondeur paramétrable (`nLevels`) | Observé / Hypothèse | annexe 13 §4 bis | `T-B-07` | à faire |
| `EX-B-08` exploration HTML → liens → classement | **Hypothèse** | — (`H-05`) | `T-B-08` | **bloqué** (`Q-B-01`) |
| `EX-B-09` dédoublonnage des URL | **Hypothèse** | — | `T-B-09` | **bloqué** |
| `EX-B-10` entrée = tâche de téléchargement | Observé | annexe 12 §1 ; `D-042`, `D-043` | `T-B-10` | **vert** |
| `EX-B-11` arborescence locale | Observé + Décision | annexe 12 §2 ; `D-042` | `T-B-11` | **vert** |
| `EX-B-12` `empty.html` | Observé + Décision | annexe 13 §4 (`0xd1ed0`) ; `D-042` | `T-B-12` | **vert** |
| `EX-B-13` pas de sortie de domaine | **Hypothèse** | — | `T-B-13` | **bloqué** |

**Couverture** : 13 exigences, **13 vertes** (`npm test`, 108 cas) — domaine B **clos**.
`Q-B-01` est close comme non instruite dans ce module (annexe 12 §6) : l'exploration et
l'arborescence sont des **choix XDM** implémentés et testés (`src/crawler.js`,
`src/grabber.js`, `D-041`/`D-042`).

**Exécution de bout en bout (`D-043`)** — ces exigences ne dépendent plus d'un plan :

| Ce qui est exécuté | Code | Tests |
|---|---|---|
| parcours → arborescence → file | `src/crawler.js`, `src/grabber.js` | `T-B-20` (`test/grab-cli.test.js`) |
| file → téléchargement → promotion | `src/grab-runner.js` | `T-B-01`, `T-B-10` (`test/grab-runner.test.js`) |
| états `PENDING → ACTIVE → VERIFYING → DONE`, échec isolé | `src/grab-runner.js`, `src/task-queue.js` | `T-A-07`, `T-A-22` |
| concurrence bornée (8 par défaut) | `src/grab-runner.js` | `T-A-07` |
| seules les pages sont explorées | `src/crawler.js` (`isPageUrl`) | `T-B-08` |

## 3 bis. Domaine C — transports (`WP-07`)

> Source : [`analysis/idman/15-spec-protocoles.md`](../../analysis/idman/15-spec-protocoles.md) §2.

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-C-01` HTTP/1.1 uniquement | Observé | annexe 15 §2.1 | `T-C-01` | à faire |
| `EX-C-02` en-têtes de requête | Observé | annexe 15 §2.1 | `T-C-02` | à faire |
| `EX-C-03` `If-Range` + `Content-Range` | Observé | `0x6b8018`, `0x6b1e24` | `T-C-03` | à faire |
| `EX-C-04` cookies de session | Observé + Dérivé | `0x6b2958` | `T-C-04` | à faire |
| `EX-C-05` `gzip, deflate` hors morceaux | Observé | `0x6b26bc` | `T-C-05` | à faire |
| `EX-C-06` séquence FTP `CWD`→`TYPE I`→`SIZE`→`REST`→`RETR` | Observé | annexe 15 §2.3 | `T-C-06` | à faire |
| `EX-C-07` refus de `PASV` = échec explicite | Observé | annexe 15 §2.3 | `T-C-07` | à faire |
| `EX-C-08` RTMP/RTMPT/MMS hors grabber | Observé + `H-12` | annexe 15 §2.4 | `T-C-08` | **bloqué** (`H-12`) |
| `EX-C-09` proxys HTTP/HTTPS/FTP/SOCKS + PAC | Observé | annexe 15 §2.5 | `T-C-09` | à faire |
| `EX-C-10` authentification proxy Basic/Digest | Observé | annexe 15 §2.5 | `T-C-10` | à faire |

**Couverture : 0 / 10** — domaine **spécifié, non implémenté**. XDM ne fait aujourd'hui
qu'HTTP/1.1 sans proxy (`src/http-client.js`) ; `T-C-01`→`T-C-03` sont pourtant à portée.

## 3 ter. Domaine D — médias (`WP-07`)

> Source : [`analysis/idman/15-spec-protocoles.md`](../../analysis/idman/15-spec-protocoles.md) §3.

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-D-01` playlist HLS reconnue | Observé | `0x6b2790`, MIME `0x6b2f48` | `T-D-01` | à faire |
| `EX-D-02` variantes `STREAM-INF` | Observé + Dérivé | `0x6b275c` | `T-D-02` | à faire |
| `EX-D-03` segments `EXTINF` | Dérivé | annexe 15 §3.1 | `T-D-03` | à faire |
| `EX-D-04` `EXT-X-MAP` avant les segments | Observé + Dérivé | `0x6b27c8`, `-tmp_dashinit` | `T-D-04` | à faire |
| `EX-D-05` `EXT-X-BYTERANGE` | Observé | `0x6b27f8` | `T-D-05` | à faire |
| `EX-D-06` `EXT-X-KEY` sans déchiffrement | Observé + `D-004` | `0x6b2828` | `T-D-06` | à faire |
| `EX-D-07` direct (`MEDIA-SEQUENCE`) | Observé + Dérivé | `0x6b284c` | `T-D-07` | à faire |
| `EX-D-08` DASH par `sidx`, pas de `MPD` | Observé + `H-13` | `CMp4DashReader`, `CSidxParser` | `T-D-08` | **bloqué** (`H-13`) |
| `EX-D-09` `DISCONTINUITY` | Dérivé | `0x6b2798` | `T-D-09` | à faire |
| `EX-D-10` aucun DRM | Décision `D-004` | — | `T-D-10` | à faire |

**Couverture : 0 / 10** — domaine **spécifié, non implémenté** (`WP-26`).

## 4. Ce que cette matrice révèle

1. **Le domaine A est spécifiable et testable immédiatement** : 19 exigences, aucune
   hypothèse, chaque test peut s'écrire sans réseau réel (serveur local + fichiers).
2. **Le domaine B ne l'est pas** : 3 exigences sur 13 reposent sur l'algorithme
   d'exploration, qui n'est pas établi (`Q-B-01`, `A-09`).
3. **Le socle est complet et couvert** : 50 cas verts sur six modules (`chunk-map`,
   `chunk-policy`, `part-file`, `work-file`, `project`, `task-queue`, `promote`) écrits
   *avant* toute couche réseau. Un test a d'ailleurs invalidé une conséquence implicite de
   `D-030` (`D-035`) : c'est exactement ce que la porte G1 cherche à produire.

## 5. Ordre de mise en œuvre proposé

| Rang | Test | Pourquoi d'abord |
|---|---|---|
| 1 | `T-A-03`, `T-A-04` | ✅ fait — la carte est le contrat de données ; tout le reste en dépend |
| 2 | `T-A-01`, `T-A-09` | ✅ fait — écriture en place + troncature : cœur du modèle |
| 3 | `T-A-06`, `T-A-07` | ✅ fait — valeurs par défaut et plafonds (observés) ; `T-A-13` reste à faire |
| 4 | ~~`T-A-08`, `T-A-15`, `T-A-16`~~ | contrat HTTP minimal — **fait** (`D-038`) |
| 5 | ~~`T-A-10`, `T-A-25`, `T-A-26`~~ | robustesse — **fait** (`D-039`) |
| 6 | `T-B-*` (sauf bloqués) | ✅ fait — `D-041` a débloqué le domaine B ; **13/13** |
| 7 | `T-B-20` | ✅ fait — `D-043` : l'aspiration s'exécute de bout en bout |
| 8 | `T-C-01`→`T-C-03` | à faire — reprise conditionnelle et en-têtes : à portée de `http-client.js` |
| 9 | `T-D-*` | après `WP-26` — médias segmentés |

## 6. Journal des révisions

| Date | Changement |
|---|---|
| 2026-10-28 | v1.1 : domaines C (transports) et D (médias) ajoutés (`WP-07`, annexe 15) — 20 exigences spécifiées, 0 implémentée ; 108 tests sur A+B |
| 2026-10-28 | v1.0 : exécution (`src/grab-runner.js`, `bin/xdm-grab.js`, `D-043`) — file → téléchargement → promotion, 106 tests ; matrice figée |
| 2026-10-28 | v0.9 : assemblage (`src/grabber.js`, `D-042`) — arborescence, collisions, `empty.html`, promotion ; **domaine B clos (13/13)**, **97 tests** |
| 2026-10-28 | v0.8 : parcours implémenté (`src/crawler.js`) — `EX-B-07`→`EX-B-09`, `EX-B-13` vertes ; 8/13 du domaine B, 90 tests |
| 2026-10-28 | v0.7 : `D-041` — le moteur d'exploration n'est pas dans `IDMan.exe` (mesure `grabber.json`) ; domaine B **débloqué** par décision de périmètre, plus aucune exigence en `Hypothèse` |
| 2026-10-27 | v0.6 : assemblage (`D-040`) — carte persistée, fusion des morceaux de reprise (`A-21`), promotion, CLI ; **79 tests verts** |
| 2026-10-27 | v0.5 : boucle de connexions (`D-039`) — domaine A **clos**, 19/19 ; repli sur divergence et plafond de 128 sockets vérifiés ; 73 tests verts |
| 2026-10-27 | v0.4 : couche HTTP écrite (`D-038`) — `EX-A-08`, `EX-A-15`→`EX-A-18` vertes, 17/19 du domaine A ; 61 tests verts au total |
| 2026-10-27 | v0.3 : `WP-20` clos — 50 tests verts, 13 exigences du domaine A et 4 du domaine B au vert ; `D-036` (file) et `D-037` (nom) consignées |
| 2026-10-27 | v0.2 : socle `WP-20` livré — 9 tests verts sur le domaine A (24 cas), `D-034` (stack) et `D-035` (rollback) consignées |
| 2026-10-27 | création v0.1 : 32 exigences recensées (19 domaine A, 13 domaine B), 3 bloquées, 0 test écrit |
