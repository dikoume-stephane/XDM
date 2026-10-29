# Roadmap — clonage du Site Grabber d'IDM (« çonage »)

> **Cible** : `cible/IDMan.exe` — IDM 6.42.22.3, PE32 i386, SHA-256 `5f78da5a…2f11c9`.
> **Projet** : XDM (dépôt `dikoume-stephane/XDM`), branche `arena/c3b095dd-xdm`.
> **Version du plan** : **v1.9** — 2026-10-29 · **Révision** : à chaque jalon atteint.
> **État** : P0–P3 **closes**, porte **G3 franchie** ; P4 close sauf `WP-30` (bloqué, VM
> Windows) ; P5 bloquée (`A-09`). Détail : §7.
> **Décisions liées** : [`JOURNAL.md`](JOURNAL.md) · **Preuves** : `analysis/idman/` ·
> **Index mémoire** : [`MEMOIRE.md`](MEMOIRE.md).

---

## 0. Objectif et définition du « terminé »

**Objectif.** Doter XDM d'un aspirateur de site (« Site Grabber ») fonctionnellement
équivalent à celui d'IDM 6.42 : à partir d'une URL et de filtres, explorer un site,
construire un plan de site, télécharger l'arborescence de façon reprenable, sauver et
recharger le projet, planifier l'exécution, et produire des statistiques.

**Le projet est « terminé » lorsque :**

1. Un **document de spécification** existe par domaine P0/P1 (`WP-10`), chaque
   affirmation portant sa preuve (`EV-*`) ou son statut d'hypothèse (`H-*`).
2. Un **prototype XDM** réalise le parcours complet : `URL → exploration → plan de
   site → filtres → téléchargement reprenable → rapport`, sur un site de test local.
3. La **conformance** est mesurée : même plan de site et même ensemble de fichiers
   que le grabber IDM sur ≥ 3 sites témoins (serveur local, site statique, site avec
   formulaires), à filtres identiques.
4. Les **formats de projet** (sauvegarde/rechargement) sont spécifiés et
   import/export testés (au minimum : notre format natif + lecture du format IDM si
   H-08 est confirmée).
5. Les **limites** sont écrites : ce que nous ne reproduisons pas (licence, anti-
   fraude, UI exacte, DRM) et pourquoi.

**Hors objectif (gelé — cf. `D-004`).** Licence/activation, fingerprint matériel,
contournement anti-débogage, reproduction de l'UI pixel-perfect, distribution du
binaire d'origine.

---

## 1. Périmètre fonctionnel (issu des preuves)

| Domaine | Contenu à cloner | Priorité | Preuves principales |
|---|---|---|---|
| Moteur de téléchargement | file, reprise, multi-connexions, limites de vitesse, cache, sessions | **P0** | 27 classes RTTI `download` ; dialogues 103/130/135/339/363 ; imports WinINet/WS2_32 |
| Site Grabber | exploration, plan de site, filtres, templates, projets, statistiques, planification | **P0** | 22 classes `Spider/Grabber/Scheduler` ; dialogues 239/241/244/245/262/268-271/284 ; chaînes `IDM Site Grabber` |
| HTTP/HTTPS/FTP | en-têtes Range/Cookie/Referer, proxy, authentification de site, redirections | **P0** | marqueurs `Range:`, `Content-Range`, `Set-Cookie`, `Proxy-Authorization`, `multipart/byteranges` ; `HTTPSession`/`FTPSession` |
| Médias (HLS/DASH/RTMP/MMS/TS) | playlists, segments, boîtes MP4, TS/PMT | **P1** | `CM3UParser`, `CSidxParser`, `CMp4DashReader`, `CMp4Converter`, `CPMTStream`, `RTMP*`, `MMS*`, `EXT-X-` ×12, `sidx` |
| Intégration navigateurs | hôte de messagerie native, extension, capture de liens | **P1** | `com.tonec.idm`, 12 marqueurs de navigateurs, `idmnmcl.dll`, `IDMNetMon.dll` |
| Persistance/DB | base des téléchargements, index, historique, cookies/passwords | **P1** | `CIDMDatabase`, `CIDMCacheDatabase`, `CDB*Array`, `CCookieMonster`, `CPasswordsMap` |
| UI/Shell | menus contextuels, dialogues clés, tray | **P2** | 105 dialogues, 2 menus, `IDMShellExt.dll`, `idmbrbtn.dll` |
| Licence / protection | *documenter la frontière seulement* | **gelé** | `CRegistration`, `CProtection`, `CSignVerifier` |

---

## 2. Principes d'exécution

1. **Preuve d'abord** : aucun lot de spécification n'est « terminé » sans `EV-*` ou
   offset vérifiable ; une intuition devient `H-xx`, jamais un fait.
2. **Statique avant dynamique** : l'exécution (VM Windows isolée) ne sert qu'à
   *valider* des hypothèses déjà écrites.
3. **Découpage vertical** : chaque lot livre une tranche utilisable (une fonction, pas
   une couche).
4. **Rejouabilité** : scripts de collecte et de triage uniquement (pas de clics dans un
   outil graphique sans trace écrite).
5. **Frontière juridique** : `D-004` prime sur tout le reste.

---

## 3. Phases, lots et portes de sortie

### P0 — Cadrage et hygiène (fait à ~90 %)

| Lot | Contenu | État | Livrable |
|---|---|---|---|
| WP-00 | Outillage REA installé, épinglé, testé sur une app témoin | ✅ | `docs/REA.md` |
| WP-01 | Registre de décisions + index mémoire + conventions | ✅ | `docs/JOURNAL.md`, `docs/MEMOIRE.md` |
| WP-02 | Triage statique reproductible de la cible | ✅ | `analysis/idman/`, `tools/idman_triage.py` |

**Porte G0** : périmètre confirmé par l'utilisateur (`A-01`) → sinon tout le reste est
une hypothèse de planification.

---

### P1 — Cartographie statique profonde (prochaine étape, ~40 % du travail total)

| Lot | Contenu | Outils | Sortie |
|---|---|---|---|
| **WP-03** | ~~Installer Ghidra 12.1.x headless~~ — **bloqué** : ni JVM ni accès au CDN des releases depuis le sandbox (`D-019`). À reprendre hors sandbox. | Ghidra + REA | `analysis/idman/ghidra/` (à produire) |
| **WP-04** | ✅ **Ancrage des classes RTTI → méthodes** : 422 classes, 427 vtables, **13 760 méthodes**, 45 chaînes attribuées. Outil maison (`D-019`, `D-020`) | pefile | `analysis/idman/10-vtables-et-classes.md` + `classes.json` |
| **WP-05** | 🟡 **Moteur de téléchargement** — `CDownload` est un **dialogue de suivi**, le moteur est `SessionManager` + `Session`/`Connection` + `ChunksList` (annexe 14 §2). v0.7 : architecture en anneaux, noms→adresses (246/323 confirmés), machine à états (39 états en `this+0xa4`, 8 switch, 115 transitions → `D-027`), modèle de morceaux (`A-11` : le morceau est un **intervalle** dans un fichier unique, carte = liste de bornes `{id, startPos, nextID}` → `D-030`), persistance, rollback par troncature (`0x15ff52`), anti-corruption, assemblage = promotion du `.tmp`, multi-connexion progressive, HTTP/FTP. Modèle d'E/S et seuils (`A-13`) : `select` par session plafonné à 12 s, inactivité 30 s/300 s ⇒ reconnexion → `D-028`. Taille de morceau 1–10 MiB → `D-029`. États 17..27 nommés (`A-15`) ; `MNSP` identifié (`A-14`). Reste hors WP-05 : A-10 (corps du filtre du grabber), A-09 (`.gsd` réels) | capstone, `classes.json`, `symbols.json`, `methods.json`, `states.json`, `chunks.json`, `io-model.json` | `analysis/idman/14-moteur-de-telechargement.md` (v0.7) |
| **WP-06** | 🟡 **Grabber** : stockage du projet **résolu** (fichier `.gsd` + miroir registre, annexe 11) (registre `GrabberSts\Projects\%ld\%ld[\ChList]`, valeurs `LocalFileName`/`LocalPath`/`LogFileName`) ; restent exploration, filtres, plan de site | capstone, `classes.json` | `analysis/idman/12-spec-grabber.md` (v0.1) |
| **WP-07** | 🟡 **Transports + médias** — **fiches C et D écrites** (`D-045`) : 10 exigences de transport (HTTP/1.1, `If-Range`, cookies, `gzip, deflate`, séquence FTP, proxys HTTP/HTTPS/FTP/SOCKS/PAC) et 10 de médias (12 balises HLS localisées, `CM3UParser`, `CMp4DashReader`, `CSidxParser`), **0/20 implémentées** | Ghidra, marqueurs | `analysis/idman/15-spec-protocoles.md` (v1) |

**État au 2026-10-27** : WP-04 terminé (v1) · WP-03 bloqué · **WP-05 cadré (v0.2,
annexe 14)** : la couche moteur est identifiée par les RTTI (`Session` → 4 sessions,
`Connection` → 4 transports + 2 variantes proxy) et par 323 noms auto-documentés,
dont 246 rattachés à une adresse de fonction (`tools/idman_attrib.py`) ; la machine à
états est décrite (39 états, `tools/idman_states.py`). Les décisions D-024→D-027 fixent
le stockage d'état, la vérification anti-corruption, l'absence d'assemblage et la forme
de la machine à états de XDM. WP-06 **débloqué
partiellement** : on sait *quelle* classe porte le grabber (`CSpiderSettings`,
`CGrabberFiltersDlg`, `CSpiderSelectSaveToDlg`) et les helpers de persistance du projet
(4 fonctions non virtuelles), mais pas encore *ce que fait* leur code (pas de
décompilateur).

**Prochaine marche (mise à jour du 2026-10-28)** : `WP-20`→`WP-23` sont **clos** et les
quatre fiches de spécification sont écrites (`A`, `B`, `C`, `D`). Le banc de tests compte
**220 cas verts**, la matrice de conformité recense **56 exigences** :
**55 vertes** (domaines A, B, C et D clos) et **1 hors périmètre** (RTMP/MMS, `H-18`).
L'aspiration s'exécute de bout en bout (`bin/xdm-grab.js`, `D-043`), se reprend
(`--reprendre`, `--sortie json`, `D-044`), réécrit les liens (`--reecrire`, `D-053`),
produit un rapport (`--rapport`) et respecte une fenêtre de planification sans démon
(`--planifier`, `D-054`). Trois chantiers restent ouverts :

1. **`A-09` — campagne d'observation en VM Windows** : protocole écrit
   (`analysis/idman/16-protocole-observation-vm.md`, 6 phases). C'est le seul moyen de
   trancher `Q-C-01`→`Q-C-05` et `Q-D-01`→`Q-D-03`, donc de valider les fiches C et D.
2. **`A-09` — seule réserve de fidélité** : les fiches C et D sont implémentées et testées,
   mais la conformité porte sur *notre* lecture des preuves. Le protocole VM
   (`analysis/idman/16-…md`) reste le seul moyen de les confronter au comportement réel.
3. **`A-09` reste seul verrou de fidélité** : sans VM Windows, les fiches C et D sont
   conformes à *notre* lecture des preuves, pas à un comportement observé.

**Porte G1** : pour chaque domaine P0, un document de spécification avec
(a) entrées/sorties, (b) machine à états, (c) structures de données, (d) cas d'erreur,
(e) preuves. Aucune ligne d'implémentation avant G1 sur le domaine concerné.

---

### P2 — Spécifications de comportement (~20 %)

| Lot | Contenu | Sortie |
|---|---|---|
| WP-10 | ✅ **Clos** — **4 fiches** (A moteur, B grabber, C transports, D médias), format imposé respecté ; **84 exigences** dont 83 vertes et 1 hors périmètre | `docs/specs/` (`A-…`, `B-…`, annexe 15 pour C et D) |
| WP-11 | ✅ **Clos** (`D-041`) — persistance résolue (`.gsd` + registre), **filtres entièrement décrits** (`A-10` → `D-032`/`D-033`), page de remplacement `empty.html`, **carte des réglages** (`grabber.json` : 10 champs, `nLevels` en `+0xb8`). Le **moteur d'exploration n'est pas dans `IDMan.exe`** (0 référence code aux conteneurs) ⇒ l'exploration est un **choix XDM** (BFS par niveau, défaut 2, `robots.txt` respecté) **implémenté et testé** (`src/crawler.js`, `T-B-07`→`T-B-09`, `T-B-13`) ; arborescence locale, `empty.html` et promotion en tâches ordinaires livrés (`src/grabber.js`, `D-042`) — **13/13 exigences vertes** | `analysis/idman/11-…` + `12-…` §6 + `grabber.json` |
| WP-12 | ✅ **Clos** — matrice de conformité : 84 exigences, **83 vertes**, 1 hors périmètre (`A-05` clos, `A-09` VM reste sans objet pour la matrice) | `docs/specs/conformance.md` (v1.0) |

---

### P3 — Reconstruction dans XDM (~30 %)

| Lot | Contenu | Ordre |
|---|---|---|
| WP-20 | ✅ **Socle terminé** : stack tranchée (`D-034` : Node 22, ESM, JSDoc, **zéro dépendance**, `node --test`) ; carte de morceaux (`chunk-map.js`, `D-030`/`D-035`), taille de morceau (`chunk-policy.js`, `D-029`), persistance atomique de la carte (`part-file.js`, `D-024`), fichier de travail (`work-file.js`, `D-026`), modèle de projet et filtres (`project.js`, `D-032`/`D-033`), file de tâches reprenable (`task-queue.js`, `D-036`), nom final et promotion (`promote.js`, `D-037`). **50 tests verts, 17 exigences couvertes** | 1 |
| WP-21 | ✅ **Clos** — client HTTP écrit et testé (`src/http-client.js`, `D-038`) : sonde `bytes=0-0`, repli à une connexion sans `206`, redirections ≤ 10 et URL ≤ 10 239 o, `Accept-Encoding: identity`, `If-Range`, inactivité 30 s ⇒ `IDLE_TIMEOUT` + offset de reprise ; boucle de connexions et détection de divergence (`D-039`). **19/19 exigences du domaine A au vert** | 2 |
| WP-22 | ✅ **Clos** — assemblage (`D-040`) : carte persistée à chaque morceau clos, reprise `mergeResumeChunks` (`A-21`), promotion explicite vérifiée, CLI `bin/xdm.js` | 3 |
| WP-23 | ✅ **Clos** (`D-041`→`D-043`) — grabber : exploration et extraction de liens (`src/crawler.js`), filtres, arborescence locale (`src/grabber.js`), **exécution** (`src/grab-runner.js`) et CLI `bin/xdm-grab.js` | 4 |
| WP-24 | ✅ **Clos** (`D-053`) — arborescence locale, réécriture optionnelle des liens (`--reecrire`), déduplication ; ajout XDM assumé (aucun parseur HTML dans la cible) | 5 |
| WP-25 | ✅ **Clos** (`D-054`) — planification recalculée (`--planifier`, quotas octets/tâches), statistiques et export (texte/JSON/CSV/Markdown/HTML) | 6 |
| WP-27 | ✅ **Clos** (`D-047`→`D-052`) — cookies, `If-Range`, en-têtes et compression, FTP passif, proxys HTTP/HTTPS/SOCKS5/FTP, Digest, PAC. `EX-C-08` (RTMP/MMS) hors périmètre (`H-18`) | 7 bis |
| WP-26 | ✅ **Clos** (`D-046`, `D-048`) — HLS (`src/hls.js`, `src/media.js`) et DASH par `sidx` (`src/sidx.js`, `src/dash.js`), CLI `bin/xdm-media.js` (`--dash`) : **domaine D 10/10** | 7 |

**Porte G3** : ✅ **franchie** (`D-057`, [`specs/porte-g3.md`](specs/porte-g3.md)) — banc
`tools/gate-g3.mjs` : site synthétique de contenu déterministe, **200 pages / 200 fichiers
(205,0 Mio)**, coupure de socket en plein transfert, comparaison **empreinte par empreinte**
du disque et du serveur. Mesure : **401/401 tâches `DONE` en une passe**, 0 doublon, aucun
résidu de travail, rapport égal au disque, **1 105 requêtes**, **13,9 s**. La porte a trouvé
un vrai défaut (une coupure de socket condamnait la tâche au lieu d'être reprise) et un
défaut dans le banc lui-même (index oublié dans le calcul d'octets). Deux profils
supplémentaires : `--sans-plages` (repli 1 connexion : la coupure coûte un redémarrage, la
reprise de tâche le rattrape) et `--saturer N` (refus `429` absorbés par `--tentatives` ; il a
révélé que le `Retry-After` de la sonde était jeté — 6,3 s → 0,23 s). Reproduire :
`npm run gate -- --pages 200 --max 200M`.

---

### P4 — Validation croisée (~10 %)

| Lot | Contenu |
|---|---|
| WP-30 | Comparaison avec le grabber IDM sur 3 sites témoins (mêmes filtres) : ensembles de fichiers, profondeur, ordre — ⏳ **bloqué** : exige la VM Windows (`A-09`), aucune comparaison possible sans IDM exécutable |
| WP-31 | ✅ **Clos** (`D-055`) — 429/503 diagnostiqués (`HTTP_STATUS`, `retryable`, `Retry-After`), reprise bornée **par la file** (`--tentatives`), redirections en boucle, `416`, `gzip`, cookies. **Formulaires POST : hors périmètre** — l'aspirateur n'émet que des `GET` ; c'est écrit, pas oublié |
| WP-32 | ✅ **Clos** (`D-056`) — `tools/audit-conformance.mjs` (6 contrôles, testé sur un jeu fautif) : 5 écarts réels trouvés et corrigés (domaine B annoncé clos avec 4 lignes « bloqué », `T-B-07` inexistant, `EX-C-08` citant `T-C-08`, trois « preuves » qui étaient des chemins de code, deux modules sans référence) ; `docs/specs/revue-clean-room.md` publie la méthode, le résultat et 8 écarts assumés |
| WP-43 | ✅ **Clos** (`D-069`) — en-têtes personnalisés : validation unique (`parseHeaderOption`), deux CLI, sonde **et** plages (`EX-B-33`) |
| WP-44 | ✅ **Clos** (`D-070`) — aspiration incrémentale (`--incremental`, `304`), crédit d'essais cumulés, progression, audit JSON (`EX-B-34`→`36`) |
| WP-45 | ✅ **Clos** (`D-071`) — reprise de fichier par défaut mesurée, `--sans-reprise`, carte d'une autre URL refusée (`EX-A-20`) |
| WP-46 | ✅ **Clos** (`D-072`) — nom par `Content-Disposition` et `--nom` (`EX-A-21`) |
| WP-47 | ✅ **Clos** (`D-073`) — `xdm --sortie json` : un objet sur stdout, le reste sur stderr (`EX-A-22`) |
| WP-48 | ✅ **Clos** (`D-074`) — `--proxy` appliqué au HTTP, rapport de vérification (`EX-A-23`, `EX-B-37`) |

---

### P5 — Validation dynamique optionnelle (débloquée par une VM Windows)

| Lot | Contenu |
|---|---|
| WP-40 | VM Windows 10 isolée + IDM installé, **usage conforme à la licence** ; captures Process Monitor/Frida des seules actions du grabber |
| WP-41 | Validation des hypothèses ouvertes `H-01..H-12` (protocole de capture de liens, formats de projet, cache) |
| WP-42 | Mesures de performance pour calibrer nos seuils (connexions/serveur, tailles de tampon) |

**Porte G5** : toutes les hypothèses P0 tranchées, ou explicitement abandonnées.

---

## 4. Jalons

| Jalon | Contenu | Dépend de | Critère |
|---|---|---|---|
| **M1 — Carte** | Anatomie + cartographie fonctionnelle + protocoles + modules (fait) | — | ✅ annexes 01-05 |
| **M2 — Squelette** | Table `classe → méthode → chaînes` extraite (422 classes / 13 760 méthodes) ✅ ; Ghidra opérationnel ⛔ (bloqué) | A-02, WP-04 | WP-04 atteint ; le volet décompilation reste ouvert |
| **M3 — Spécifications** | Specs moteur + grabber + protocoles revues | M2 | Porte G1 |
| **M4 — Prototype** | Parcours complet sur site local | M3 | Porte G3 |
| **M3.6 — Domaines A+B** | 32 exigences, 30 vertes, 108 tests | D-041, D-042, D-043, D-044 | ✅ `npm test` |
| **M3.7 — Domaines C+D** | 20 exigences, 19 vertes, 172 tests | D-045→D-052 | ✅ D 10/10, C 9/10 (1 hors périmètre) |
| **M3.8 — Grabber complet** | 16 exigences du domaine B, **16 vertes**, 220 tests | D-053, D-054 | ✅ réécriture (ajout XDM), rapport, planification sans démon |
| **M4 — Prototype (porte G3)** | 200 pages, 1 Ko → 200 Mo, coupure réseau | D-057 | ✅ **franchie** : 401/401 en une passe, 205,0 Mio, empreintes conformes |
| **M3.9 — Traçabilité auditée** | 84 exigences, 83 vertes, 0 écart | D-056 | ✅ `npm run audit --strict` |
| **M3.10 — Parcours outillé** | `robots.txt` RFC 9309, élagage `--exclure`, `Crawl-delay`, exploration parallèle bornée, cookies persistants, FTP en CLI | D-059→D-062 | ✅ domaine B **20/20**, C **12/13**, 233 tests |
| **M3.11 — Parcours exact et borné** | `<base href>`, `--entete` (injection refusée), `--arret-erreurs`, `--essai`, diagnostic d'exploration dans le rapport | D-063, D-064 | ✅ domaine B **23/23**, C **13/14**, 240 tests |
| **M3.12 — Ce que personne ne cite, et l'interruption** | plans de site → amorces, `--sous-domaines`, reprise pendant l'exploration, Ctrl-C propre (code 130), `--aide`/`--version` | D-065, D-066 | ✅ domaine B **28/28**, 250 tests |
| **M3.13 — Robustesse et audit** | reprise après arrêt brutal, `--taille-max`, espace disque, `--verifier`, rapport HTML | D-067, D-068 | ✅ domaine B **32/32**, 257 tests |
| **M3.14 — En-têtes partout, rien de retéléchargé** | validation d'en-tête **unique** (`parseHeaderOption`) partagée par les deux CLI, `--entete` dans `xdm.js`, en-têtes sur la sonde **et** chaque plage ; `--incremental` (`If-Modified-Since`, `304` = fichier intact), `reopenDone`, `--tentatives-total`, `--progression` par paliers, `--verifier --sortie json` | D-069, D-070 | ✅ domaine B **36/36**, 265 tests |
| **M3.15 — L'outil ne ment plus sur ses options** | reprise de fichier par défaut + `--sans-reprise` + carte d'une autre URL refusée, nom par `Content-Disposition`, `--sortie json`, `--proxy` réellement appliqué, rapport de vérification | D-071→D-074 | ✅ domaine A **23/23**, B **37/37**, 274 tests |
| **M3.5 — Socle** | Moteur complet : données, projet, file, HTTP, boucle, reprise, promotion, CLI — 79 cas verts | D-034, D-038, D-039, D-040 | ✅ `npm test` |
| **M5 — Conformance** | Comparaison IDM vs XDM documentée | M4 + VM | Porte G4 |

---

## 5. Risques et parades

| ID | Risque | Impact | Parade |
|---|---|---|---|
| R-01 | Version de REA/Ghidra qui dérive dans le temps | reproductibilité | lockfile + `docs/REA.md` §1 (versions figées) |
| R-02 | Absence de symboles → attribution classe↔fonction laborieuse | planning P1 | RTTI + vtables + pattern matching des constructeurs ; s'appuyer sur les chaînes d'erreur par classe |
| R-03 | Ghidra non installable (réseau/Java) | P1 bloquée | repli : `radare2/rizin` si fourni, sinon analyse manuelle Capstone sur les zones chaudes (imposé par `rea execute-rizin-command` si l'outil existe) |
| R-04 | Sur-interprétation des preuves statiques | specs fausses | étiquetage `Observé/Dérivé/Hypothèse` (`D-014`) + revue WP-32 |
| R-05 | Écarts 32/64 bits (modules `*64`) | fidélité | documenter l'écart, cibler le comportement, pas le binaire |
| R-06 | Dérive juridique (licence, anti-fraude) | arrêt du projet | `D-004` gelé, revue à chaque jalon |
| R-07 | Volume des captures/plans de site dans Git | maintenabilité | `analysis/raw/` ignoré ; décider du stockage externe (D-018) |
| R-08 | Node 22.22.3 < exigence REA 22.23.4 | `rea update`, SQLite natif | ne pas dépendre de ces fonctions ; prévoir montée de version hors sandbox |

---

## 6. Estimation d'effort (ordre de grandeur, une personne)

| Phase | Effort | Commentaire |
|---|---|---|
| P0 | 1 j | fait |
| P1 (WP-03→07) | 8-12 j | dépend de l'installation de Ghidra et de la qualité des vtables |
| P2 (WP-10→12) | 4-6 j | rédaction, exigeante en rigueur |
| P3 (WP-20→26) | 15-25 j | le grabber est la partie « produit » ; les médias ajoutent du risque |
| P4 | 4-6 j | comparaisons, résilience |
| P5 | 3-5 j | sous réserve de la VM |

**Chemin critique** : `A-09` (VM Windows) → `WP-30` (comparaison témoin) → P5. Tout le reste
est fait ou explicitement hors périmètre : la seule chose qui manque au projet n'est plus du
code, c'est une **preuve d'exécution de la cible** — impossible dans cet environnement.

---

## 7. État réel et prochaines actions

### 7.1 Ce qui est fait (mesuré, pas déclaré)

| Phase | Sortie | Preuve |
|---|---|---|
| **P0** Cadrage | périmètre, décisions, hygiène | `JOURNAL` `D-001`→`D-019` ; `analysis/idman/00…08` |
| **P1** Cartographie | anatomie, 422 classes, chaînes, protocoles, états de connexion | annexes 01–08 ; `classes.json`, `states.json`, `chunks.json` |
| **P2** Spécifications | 4 fiches (A, B, C, D), **84 exigences**, matrice auditée | `docs/specs/`, `conformance.md` v1.14, `npm run audit` |
| **P3** Reconstruction | moteur, file, transports, grabber, médias, CLI ; **porte G3 franchie** | `src/` (27 modules), `bin/` (3 CLI), `npm run gate` |
| **P4** Parcours outillé | `robots.txt` RFC 9309, `--exclure` (élagage), `Crawl-delay`, `--paralleles`, `--cookies`, `xdm ftp://` | `D-059`→`D-062`, `EX-B-17`→`EX-B-20`, `EX-C-12`/`EX-C-13` |
| **P4** Parcours exact | `<base href>`, `--entete`, `--arret-erreurs`, `--essai`, diagnostic du rapport | `D-063`, `D-064`, `EX-B-21`→`EX-B-23`, `EX-C-14` |
| **P4** Parcours complet et interruptible | plans de site, sous-domaines, reprise de l'exploration, Ctrl-C propre, aide/version | `D-065`, `D-066`, `EX-B-24`→`EX-B-28` |
| **P4** Robustesse | reprise après arrêt brutal, plafond de taille, espace disque, vérification, rapport HTML | `D-067`, `D-068`, `EX-B-29`→`EX-B-32` |
| **P4** En-têtes et incrémental | validation partagée, `--entete` aux deux CLI, en-têtes sur toute plage, `304` = intact, crédit d'essais cumulés, progression par paliers, audit JSON | `D-069`, `D-070`, `EX-B-33`→`EX-B-36` |
| **P4** Outil honnête | reprise par défaut + `--sans-reprise` + carte étrangère refusée, nom par `Content-Disposition`, `--sortie json`, `--proxy` appliqué, rapport de vérification | `D-071`→`D-074`, `EX-A-20`→`EX-A-23`, `EX-B-37` |
| **P4** Résilience + revue | `429`/`503`, coupures, `416`, boucles ; revue clean-room publiée | `D-055`, `D-056`, `revue-clean-room.md` |
| **P5** Dynamique | **non commencée** — aucune VM Windows dans cet environnement | `A-09` |

Chiffres au 2026-10-29 : **274 tests verts**, **269 exports**, **84 exigences (83 vertes,
1 hors périmètre)**, **0 écart de traçabilité**, **29 documents `.md` sans lien cassé**,
porte G3 à 200 pages / 205,0 Mio.

### 7.2 Ce qui reste, et pourquoi c'est bloqué

| # | Action | Blocage | Ce qu'il faudrait |
|---|---|---|---|
| 1 | `WP-30` — comparaison avec le grabber IDM sur 3 sites témoins | ⛔ **bloqué** : aucun IDM exécutable ici | VM Windows (`A-09`), même filtres, mêmes URLs |
| 2 | `P5` — validation dynamique (ordre des requêtes, temporisations, `robots.txt`) | ⛔ **bloqué** (même cause) | protocole déjà écrit : annexe 16, 6 phases |
| 3 | `A-09-bis` — format binaire du `.gsd` | ⛔ **bloqué** : aucun échantillon | un fichier projet produit par IDM |
| 4 | `A-02`/`WP-03` — décompilation | ⛔ **bloqué** : ni JVM ni CDN GitHub depuis ce sandbox (`D-019`) | `GHIDRA_INSTALL_DIR` hors sandbox |
| 5 | `Q-B-02`/`Q-B-03`/`Q-B-04`/`Q-B-05` — `robots.txt`, défaut `nLevels`, rôle d'`empty.html`, parallélisme du crawl | 🟡 **sans effet** : tranchées par décision XDM (`D-059`, `D-061`), marquées comme telles | VM (même protocole) |
| 6 | `Q-B-06` — `Crawl-delay` : la cible le lit-elle, et l'applique-t-elle ? | 🟡 **sans effet** : XDM l'applique comme un conseil borné (`D-060`) | capture réseau d'une aspiration lente (annexe 16) |

Aucune de ces cinq lignes ne bloque **le produit** : elles bloquent la **fidélité prouvée**.
C'est la distinction que le projet tient depuis `D-041`, et elle est écrite noir sur blanc dans
chaque fiche concernée.

### 7.3 Si la VM devient disponible (ordre d'exécution)

1. **Annexe 16, phases 1–3** — installer, capturer le trafic d'une aspiration témoin, relever
   l'ordre exact des requêtes et les temporisations ; lever `Q-C-01`→`Q-C-05`.
2. **`A-09-bis`** — produire trois `.gsd` (projets vides, avec filtres, avec planification) et
   les déverser ; vérifier ou infirmer `EX-B-01`/`EX-B-02`.
3. **`WP-30`** — rejouer les 3 sites témoins des deux côtés, comparer ensembles de fichiers,
   profondeur et ordre ; consigner les écarts **avant** de les corriger.
4. **P5** — réévaluer `Q-B-*`, puis mettre à jour les fiches C et D (`Observé` au lieu de
   `Décision`) et relancer `npm run audit` : toute ligne qui change de niveau doit changer de
   preuve.
