# Matrice de conformité (WP-12, v0.1)

> **Statut** : 🟡 v0.1 — **Dernière revue** : 2026-10-27
> **Rôle** : relier, pour chaque exigence de spécification, la **preuve** statique qui la
> fonde et le **test** qui la vérifiera. Aucune ligne d'implémentation ne référence une
> exigence absente de ce fichier.
> **Sources** : `docs/specs/A-moteur-de-telechargement.md` (v0.2),
> `docs/specs/B-grabber.md` (v0.1), annexes 13 et 14.
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
| `EX-A-07` 1 → N connexions, plafond 8 par défaut | Observé + Décision | annexe 14 §6 ; `0x0fbe17` ; `D-036` | `T-A-07` | **vert** (allocation + file ; la boucle réseau reste à écrire) |
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

**Couverture** : 19 exigences, **19 vertes** (`npm test`, 79 cas) — domaine A **clos**.
La boucle de connexions (`src/connection-loop.js`) exécute les exigences de bout en bout
contre des serveurs locaux, y compris la coupure, la reprise depuis la carte persistée et la
promotion (`T-A-25`, `T-A-19`, `T-A-12`). Aucune exigence
`Hypothèse` dans ce domaine.

## 3. Domaine B — grabber

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-B-01` projet = un artefact | Observé + Décision | annexe 11 §1 (`%sproject%s.gsd`) | `T-B-01` | à faire |
| `EX-B-02` contenu du projet | Dérivé | annexe 11 §4 | `T-B-02` | **vert** |
| `EX-B-03` filtre sans portée propre | Observé + Décision | annexe 13 §2 bis ; `D-032` | `T-B-03` | **vert** |
| `EX-B-04` identifiants à partir de 100 | Observé + Décision | annexe 13 §2 ter ; `D-033` | `T-B-04` | **vert** |
| `EX-B-05` motif = masque glob | Observé | annexe 13 §4 bis | `T-B-05` | **vert** |
| `EX-B-06` champs d'une entrée | Observé | annexe 12 §2 | `T-B-06` | à faire |
| `EX-B-07` profondeur paramétrable (`nLevels`) | Observé / Hypothèse | annexe 13 §4 bis | `T-B-07` | à faire |
| `EX-B-08` exploration HTML → liens → classement | **Hypothèse** | — (`H-05`) | `T-B-08` | **bloqué** (`Q-B-01`) |
| `EX-B-09` dédoublonnage des URL | **Hypothèse** | — | `T-B-09` | **bloqué** |
| `EX-B-10` entrée = tâche de téléchargement | Observé | annexe 12 §1 | `T-B-10` | à faire |
| `EX-B-11` arborescence locale | Observé / Dérivé | annexe 12 §2 | `T-B-11` | à faire |
| `EX-B-12` `empty.html` | Observé | annexe 13 §4 (`0xd1ed0`) | `T-B-12` | à faire |
| `EX-B-13` pas de sortie de domaine | **Hypothèse** | — | `T-B-13` | **bloqué** |

**Couverture** : 13 exigences, **4 vertes**, **4 spécifiées par décision** (`EX-B-07`→
`EX-B-09`, `EX-B-13`, `D-041`), 5 testables au lot `WP-11`. **Aucune exigence bloquée** :
`Q-B-01` est close comme non instruite dans ce module (annexe 12 §6).

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
| 6 | `T-B-*` (sauf bloqués) | après `Q-B-01` |

## 6. Journal des révisions

| Date | Changement |
|---|---|
| 2026-10-28 | v0.7 : `D-041` — le moteur d'exploration n'est pas dans `IDMan.exe` (mesure `grabber.json`) ; domaine B **débloqué** par décision de périmètre, plus aucune exigence en `Hypothèse` |
| 2026-10-27 | v0.6 : assemblage (`D-040`) — carte persistée, fusion des morceaux de reprise (`A-21`), promotion, CLI ; **79 tests verts** |
| 2026-10-27 | v0.5 : boucle de connexions (`D-039`) — domaine A **clos**, 19/19 ; repli sur divergence et plafond de 128 sockets vérifiés ; 73 tests verts |
| 2026-10-27 | v0.4 : couche HTTP écrite (`D-038`) — `EX-A-08`, `EX-A-15`→`EX-A-18` vertes, 17/19 du domaine A ; 61 tests verts au total |
| 2026-10-27 | v0.3 : `WP-20` clos — 50 tests verts, 13 exigences du domaine A et 4 du domaine B au vert ; `D-036` (file) et `D-037` (nom) consignées |
| 2026-10-27 | v0.2 : socle `WP-20` livré — 9 tests verts sur le domaine A (24 cas), `D-034` (stack) et `D-035` (rollback) consignées |
| 2026-10-27 | création v0.1 : 32 exigences recensées (19 domaine A, 13 domaine B), 3 bloquées, 0 test écrit |
