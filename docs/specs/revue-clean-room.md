# Revue « clean-room » (WP-32)

> **Statut** : ✅ v1.6 — **Dernière revue** : 2026-10-29
> **Rôle** : vérifier que la reconstruction repose sur des **descriptions de comportement**
> et non sur du code recopié, et que cette revendication est **mesurable**.
> **Moyens** : `tools/audit-conformance.mjs` (automatique) + lecture manuelle (§3).
> **Cible** : `IDMan.exe` SHA-256 `5f78da5a…2f11c9` — **jamais** exécutée, seulement lue.

---

## 1. Ce que « clean-room » veut dire ici — et ce que cela ne veut pas dire

Une reconstruction est dite *clean-room* quand celui qui écrit le code ne travaille que sur
une **spécification** : une description du comportement attendu, pas le code d'origine.

La situation de ce projet est plus simple et plus inconfortable à la fois :

| Question | Réponse | Conséquence |
|---|---|---|
| Le code source d'IDM a-t-il été lu ? | **Non** — il n'est pas public, et il n'a pas été cherché. | aucun code source à recopier |
| Le binaire a-t-il été décompilé ? | **Non** — Ghidra est indisponible ici (`D-019`), et il ne l'est pas devenu. | pas de pseudo-code à traduire |
| Qu'a-t-on lu ? | la **structure** du PE, les **chaînes**, les **tables** (RTTI, vtables, imports), les **constantes** et les **séquences d'appels** | des faits vérifiables, pas des algorithmes |
| Que produit la lecture ? | des **fiches** (`docs/specs/A…D`) et des **annexes** (`analysis/idman/00…16`) | c'est la spécification |
| Que voit l'implémenteur ? | les fiches et les annexes, **pas** les dumps | il code contre une description |

**Ce que l'audit automatique peut prouver** : que chaque exigence cite une preuve ou une
décision, que chaque exigence verte cite un test **qui existe**, que chaque module cite une
exigence, une décision ou une annexe, et que les totaux annoncés sont les totaux comptés.

**Ce qu'il ne peut pas prouver** : qu'aucune ligne n'a été copiée. Un outil ne distingue pas
une réimplémentation d'une traduction. C'est l'objet du §3, et c'est un jugement humain.

---

## 2. Audit automatique

```bash
node tools/audit-conformance.mjs          # rapport lisible
node tools/audit-conformance.mjs --json   # rapport machine
node tools/audit-conformance.mjs --strict # code 1 si un écart subsiste
```

Six contrôles, chacun rattaché à un écart réel rencontré pendant le projet :

| Contrôle | Question posée | Écart détecté en pratique |
|---|---|---|
| `preuve` | l'exigence cite-t-elle une preuve (`D-`, `Q-`, `H-`, annexe, fiche, offset) ? | `EX-B-15`, `EX-B-16`, `EX-C-11` citaient un **chemin de code** au lieu d'une preuve |
| `hypothese-verte` | une `Hypothèse` est-elle comptée verte ? | aurait masqué un domaine non prouvé |
| `test-inconnu` / `vert-sans-test` | le test cité existe-t-il dans `test/` ? | `T-B-07` **n'existait pas** : le test de profondeur portait le numéro de son voisin |
| `test-absent` | l'exigence cite-t-elle un test (sauf hors périmètre déclaré) ? | `EX-C-08` citait `T-C-08`, qui n'a jamais existé |
| `module-sans-reference` | le module dit-il **pourquoi** il existe ? | `src/report.js` et `bin/xdm-grab.js` ne citaient aucune exigence |
| `couverture` | les totaux d'une section sont-ils ses propres lignes ? | domaine B annoncé clos alors que 4 lignes disaient encore « bloqué » |
| `exigence-inconnue` | le code cite-t-il une exigence absente de la matrice ? | détecte les renvois périmés après renommage |

Le contrôle est lui-même testé (`test/audit.test.js`) : un jeu de données **volontairement
fautif** doit produire chaque code d'écart. Un audit qui ne trouve jamais rien n'a aucune
valeur ; c'est pourquoi l'un des tests vérifie qu'il trouve.

**Résultat au 2026-10-28** :

```
Exigences : 56 (vertes : 55)
Modules : 30 · identifiants de test distincts : 62

  2. Domaine A — moteur de téléchargement : 19/19 vertes
  3. Domaine B — grabber : 16/16 vertes
  3 bis. Domaine C — transports : 10/11 vertes
  3 ter. Domaine D — médias : 10/10 vertes

Aucun écart de traçabilité.
```

---

## 3. Lecture manuelle — les cinq questions

L'audit automatique ne suffit pas. Pour chaque domaine, la revue pose cinq questions et
consigne la réponse. Une réponse « non » n'est pas un échec : c'est une **limite déclarée**.

| # | Question | Domaine A (moteur) | B (grabber) | C (transports) | D (médias) |
|---|---|---|---|---|---|
| 1 | La description existait-elle **avant** le code ? | ✅ annexe 14 avant `src/chunk-map.js` | ⚠️ partiellement : annexes 11-13 avant `src/crawler.js`, mais `D-041` a été écrit **après** la mesure qui montrait l'absence du moteur | ✅ annexe 15 avant `src/ftp.js`, `src/proxy.js` | ✅ annexe 15 §3 avant `src/hls.js` |
| 2 | Les valeurs viennent-elles d'une **mesure** (offset, chaîne) ? | ✅ `0x0fbe17` (8 connexions), `0x1559e0` (paliers), `0x1e` (30 s) | ⚠️ `nLevels` en `+0xb8` est mesuré ; le **défaut** (2) est un choix | ✅ séquence FTP, `REST %I64d%s`, `WinHttpGetProxyForUrl` | ✅ 12 balises HLS, `CSidxParser 0x2b5aa8` |
| 3 | Les comportements non observables sont-ils marqués **Décision** ? | ✅ `D-030`, `D-035`, `D-038` | ✅ `D-041` (parcours), `D-053` (réécriture), `D-054` (planification) | ✅ `D-051` (SOCKS4 refusé), `D-055` (pas de reprise silencieuse) | ✅ `D-004` (aucun DRM) |
| 4 | Y a-t-il un choix **contraire** à la cible, et est-il dit ? | ✅ `rename()` atomique au lieu de la séquence de renommages d'IDM | ✅ **trois ajouts** : réécriture, rapport, planification (§4) | ✅ pas de FTPS implicite ; `DIRECT` seulement si le PAC le dit | ✅ pas de fusion DASH hors `sidx` |
| 5 | Un test échouerait-il si le comportement changeait ? | ✅ 69 cas `T-A-*` | ✅ 16 exigences, 61 cas `T-B-*` | ✅ 11 exigences, 50 cas `T-C-*` | ✅ 10 exigences, 24 cas `T-D-*` |

### Constats consignés

1. **Le vocabulaire d'IDM fuit dans le code, et c'est voulu.** `isCmpleted`, `nLevels`,
   `nextFilterID`, `ChList`, `GrSh` apparaissent dans les commentaires : ce sont des **noms
   de champs observés**, pas du code. Les garder permet de refaire la mesure ; les traduire
   aurait rendu la vérification impossible.
2. **Aucun extrait de désassemblage n'est recopié dans `src/`.** Les seules occurrences
   d'offsets dans le code sont des **citations de preuve** en commentaire (`0x0fbe17`), et
   l'audit vérifie que le module cite par ailleurs une exigence ou une annexe.
3. **`D-041` est la seule décision prise après coup** : la mesure (0 référence aux
   conteneurs `SPL`/`RL`/`LI2`) a précédé l'écriture, mais c'est elle qui a *créé* le
   périmètre du parcours. La fiche B le dit explicitement dès son en-tête.
4. **Trois défauts ont été trouvés par les tests, pas par la relecture** — c'est l'argument
   le plus solide du dossier : `T-A-05` a invalidé une conséquence de `D-030` (le rollback
   devait rouvrir une zone, pas l'absorber ⇒ `D-035`) ; la démonstration de bout en bout puis
   `T-B-26` ont montré que `rewriteDocument` ne transmettait pas `cssUrl` (0 lien CSS réécrit)
   et qu'une page de départ n'était jamais aspirée (site miroir sans page d'accueil) ;
   `T-C-11` a établi qu'un `429` sortait sous le libellé trompeur de « taille inconnue ».

---

## 4. Écarts assumés — la liste exhaustive

Ces points **ne sont pas conformes à la cible**, et ne le seront pas : ce sont des choix,
documentés comme tels, jamais présentés comme « observés ».

| # | Écart | Motif | Décision |
|---|---|---|---|
| 1 | Réécriture des liens HTML/CSS | `Q-B-01` : **aucun parseur HTML** dans `IDMan.exe` (0 référence aux conteneurs, annexe 12 §6) | `D-053` |
| 2 | Rapport texte/JSON/CSV/Markdown | les statistiques d'IDM existent, leur format n'est pas lisible dans le binaire | `D-053` |
| 3 | Planification recalculée à chaque exécution | un démon ou une tâche planifiée serait une dépendance d'exploitation | `D-054` |
| 4 | Projet en JSON, pas en `.gsd` | format propriétaire non documenté, aucun besoin d'interopérabilité | `EX-B-01` |
| 5 | Pas d'intégration navigateur | hors périmètre P0 (`D-007`) | annexe 02 |
| 6 | Pas de RTMP/MMS | sert l'**enregistrement de flux**, hors du grabber (`H-18`) | `EX-C-08` hors périmètre |
| 7 | Pas de DRM, aucun contournement | décision de principe | `D-004` |
| 8 | Pas de licence/activation, pas d'anti-débogage | décision de principe | `D-004` |

---

## 5. Ce que cette revue ne couvre pas

| Limite | Pourquoi | Ce qui la lèverait |
|---|---|---|
| Comportement **dynamique** d'IDM (ordre réel des requêtes, temporisations) | aucune VM Windows ici (`A-09`) | annexe 16 : protocole en 6 phases |
| Format binaire du `.gsd` | aucun échantillon disponible (`A-09-bis`) | un vrai fichier projet, déversé |
| Algorithme d'exploration d'IDM | absent du binaire (`Q-B-01`) ; `IDMGrHlp.exe` pourrait le contenir | analyste du composant frère |
| Sémantique exacte de `robots.txt` dans IDM | une seule chaîne, une seule référence (`Q-B-02`) | VM + capture réseau |
| Décompilation | Ghidra indisponible (`D-019`) | hors sandbox, avec `GHIDRA_INSTALL_DIR` |

Ces cinq limites sont **ouvertes**, pas résolues par la rédaction : aucune exigence n'en
dépend pour être verte, sauf celles marquées `Décision` — et c'est précisément pourquoi
elles sont marquées ainsi.

---

## 6. Journal des révisions

| Date | Changement |
|---|---|
| 2026-10-29 | v1.8 : `D-079`→`D-083` — 4 exigences (`EX-A-25`, `EX-B-39`→`41`) et `EX-B-28` étendue : cinq défauts **mesurés** avant correction (400 s de silence sur `--morceau 100`, code de sortie 0 avec 3 fichiers manquants, « conforme » sur une aspiration incomplète, `--aide` en code 2 sur la troisième CLI, « undefined cookie(s) ») ; **92 exigences, 91 vertes, 0 écart**, 286 tests |
| 2026-10-29 | v1.7 : `D-075`→`D-078` — 4 exigences (`EX-D-11`, `EX-A-24`, `EX-C-15`, `EX-B-38`) : un seul transport authentifié pour les médias, `xdm --cookies`, positionnels de trop refusés, `absent` dans le JSON de vérification ; **88 exigences, 87 vertes, 0 écart**, 281 tests. Une enveloppe **partagée** (`withHeaders`) remplace deux copies locales de la même règle, et le transport perdu pour les segments sans `BYTERANGE` a été trouvé par un test, pas par relecture |
| 2026-10-29 | v1.6 : `D-071`→`D-074` — 5 exigences (`EX-A-20`→`23`, `EX-B-37`) : reprise de fichier par défaut et `--sans-reprise`, carte d'une autre URL refusée, nom par `Content-Disposition`, `--sortie json`, `--proxy` appliqué, rapport de vérification ; **84 exigences, 83 vertes, 0 écart**, 274 tests. Deux options documentées mais inertes ont été corrigées, pas contournées |
| 2026-10-29 | v1.5 : `D-069`/`D-070` — 4 exigences (`EX-B-33`→`36`) : en-têtes personnalisés, aspiration incrémentale, crédit d'essais cumulés, progression/audit JSON ; **79 exigences, 78 vertes, 0 écart**, 265 tests. La validation d'en-tête n'existe **qu'une fois** (`parseHeaderOption`) et les deux CLI y délèguent : aucune règle dupliquée à diverger |
| 2026-10-29 | v1.4 : `D-067`/`D-068` — 4 exigences (`EX-B-29`→`32`) ; **75 exigences, 74 vertes, 0 écart**, 257 tests. Deux fonctions redéfinies ont été retirées au profit des modules d'origine (`WORK_SUFFIX`, `PART_SUFFIX`), pour ne pas créer deux vérités |
| 2026-10-29 | v1.3 : `D-065`/`D-066` — 5 exigences (`EX-B-24`→`28`) : plans de site, sous-domaines, reprise de l'exploration, interruption propre, aide/version ; **71 exigences, 70 vertes, 0 écart**, 250 tests |
| 2026-10-29 | v1.2 : `D-063`/`D-064` — 4 exigences ajoutées (`EX-B-21`→`23`, `EX-C-14`) et `EX-B-15` étendue au diagnostic d'exploration ; **66 exigences, 65 vertes, 0 écart**, 240 tests. Chaque nouvelle ligne cite sa décision, pas un chemin de code |
| 2026-10-29 | v1.1 : `D-059`→`D-062` — 6 exigences ajoutées (`EX-B-17`→`20`, `EX-C-12`/`13`) avec leur preuve et leur test, dans le format déjà audité ; **62 exigences, 61 vertes, 0 écart**, 233 tests. Aucun écart nouveau : les deux exigences de cookies et de transport citent leur décision, pas un chemin de code |
| 2026-10-28 | v1.0 : création (`WP-32`) — audit automatique (6 contrôles, lui-même testé), lecture manuelle en 5 questions, 8 écarts assumés, 5 limites déclarées. Résultat mesuré : **56 exigences, 55 vertes, 0 écart de traçabilité**, 212 tests |
