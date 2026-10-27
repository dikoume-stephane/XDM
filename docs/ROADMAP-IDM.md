# Roadmap — clonage du Site Grabber d'IDM (« çonage »)

> **Cible** : `cible/IDMan.exe` — IDM 6.42.22.3, PE32 i386, SHA-256 `5f78da5a…2f11c9`.
> **Projet** : XDM (dépôt `dikoume-stephane/XDM`), branche `arena/c3b095dd-xdm`.
> **Version du plan** : v1 — 2026-10-26 · **Révision** : à chaque jalon atteint.
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
| **WP-05** | 🟡 **Moteur de téléchargement** — `CDownload` est un **dialogue de suivi**, le moteur est `SessionManager` + `Session`/`Connection` + `ChunksList` (annexe 14 §2). v0.5 : architecture en anneaux, noms→adresses (246/323 confirmés), machine à états (39 états en `this+0xa4`, 8 switch, 115 transitions → `D-027`), modèle de morceaux (`A-11` : le morceau est un **intervalle** dans un fichier unique, carte = liste de bornes `{id, startPos, nextID}` → `D-030`), persistance, rollback par troncature (`0x15ff52`), anti-corruption, assemblage = promotion du `.tmp`, multi-connexion progressive, HTTP/FTP. Modèle d'E/S et seuils (`A-13`) → `D-028`. Taille de morceau 1–10 MiB → `D-029`. États 17..27 nommés (`A-15`) ; `MNSP` identifié (`A-14`). Reste hors WP-05 : A-10 (corps du filtre du grabber), A-09 (`.gsd` réels) | capstone, `classes.json`, `symbols.json`, `methods.json`, `states.json`, `chunks.json`, `io-model.json` | `analysis/idman/14-moteur-de-telechargement.md` (v0.5) |
| **WP-06** | 🟡 **Grabber** : stockage du projet **résolu** (fichier `.gsd` + miroir registre, annexe 11) (registre `GrabberSts\Projects\%ld\%ld[\ChList]`, valeurs `LocalFileName`/`LocalPath`/`LogFileName`) ; restent exploration, filtres, plan de site | capstone, `classes.json` | `analysis/idman/12-spec-grabber.md` (v0.1) |
| **WP-07** | **Transports + médias** : HTTP/FTP (en-têtes, redirections, cookies), HLS/DASH (M3U8, SIDX, MP4), RTMP/MMS/TS | Ghidra, marqueurs | `analysis/idman/15-spec-protocoles.md` |

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

**Prochaine marche** : les actions de recherche de WP-05 (`A-11` → `A-16`) **et** celles
de WP-11 (`A-08`, `A-10`) sont levées. Deux chantiers restent ouverts, dans cet ordre :

1. **`A-05` — ouvrir les fiches de spécification** (une par domaine P0) : la fiche
   `docs/specs/A-moteur-de-telechargement.md` est ouverte (domaine A, 17 exigences,
   4 questions ouvertes) ; la fiche du domaine B (filtres / projet) peut être écrite de
   la même façon à partir de l'annexe 13 v0.2, sans nouvelle rétro-ingénierie ;
2. **`A-09` — lever les incertitudes d'exécution** sur VM Windows (sémantique du champ
   `actif`, `empty.html`, `.gsd` réels), qui ne peuvent pas être tranchées en statique.

**Porte G1** : pour chaque domaine P0, un document de spécification avec
(a) entrées/sorties, (b) machine à états, (c) structures de données, (d) cas d'erreur,
(e) preuves. Aucune ligne d'implémentation avant G1 sur le domaine concerné.

---

### P2 — Spécifications de comportement (~20 %)

| Lot | Contenu | Sortie |
|---|---|---|
| WP-10 | Fiches de spécification par domaine (format imposé : but, entrées, états, erreurs, preuves, questions ouvertes) — **1ʳᵉ fiche ouverte** : domaine A (moteur), `A-05` | `docs/specs/` (`A-moteur-de-telechargement.md`) |
| WP-11 | 🟡 Modèle de données : persistance résolue (`.gsd` + registre) ; **filtres entièrement décrits** (`A-10` : `IDM_SPIDERFILTER` 16 o, sérialisation `REG_SZ` sous `IncludeFilters`/`ExcludeFilters`, premier id = 100 → `D-032`/`D-033`) ; page de remplacement `empty.html` | `analysis/idman/11-…` + `13-…` (v0.2) |
| WP-12 | Matrice de conformité : comportement observé → exigence → test | `docs/specs/conformance.md` |

---

### P3 — Reconstruction dans XDM (~30 %)

| Lot | Contenu | Ordre |
|---|---|---|
| WP-20 | Socle : modèle de projet, persistance, file de tâches reprenable | 1 |
| WP-21 | Client HTTP/FTP : Range, reprise, multi-connexions, proxy, cookies | 2 |
| WP-22 | Machine à états du téléchargement + intégrité + reprise après crash | 3 |
| WP-23 | Grabber : exploration, extraction de liens (HTML/CSS/JS/robots/sitemap), filtres, plan de site | 4 |
| WP-24 | Téléchargement d'arborescence : mapping URL→chemin, réécriture optionnelle des liens, déduplication | 5 |
| WP-25 | Planification, statistiques, export de rapport | 6 |
| WP-26 | Médias (HLS/DASH segmenté) — réutilise WP-21/22 | 7 |

**Porte G3** : parcours complet sur un site local (≥ 200 pages, fichiers de 1 Ko à
200 Mo, coupures réseau simulées) sans perte ni doublon.

---

### P4 — Validation croisée (~10 %)

| Lot | Contenu |
|---|---|
| WP-30 | Comparaison avec le grabber IDM sur 3 sites témoins (mêmes filtres) : ensembles de fichiers, profondeur, ordre |
| WP-31 | Tests de résilience : 429/503, redirections en boucle, cookies, formulaires POST, contenus compressés, plages invalides |
| WP-32 | Revue « clean-room » : chaque exigence remonte à une description de comportement, pas à du code copié |

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

**Chemin critique** : A-02 (Ghidra) → WP-04 (vtables) → WP-06 (grabber) → WP-23.

---

## 7. Prochaines actions (ordre d'exécution)

1. **A-01** — confirmer le périmètre (Site Grabber ? projet XDM ?) → conditionne tout.
2. **A-02** — installer Ghidra 12.1.x, exporter `GHIDRA_INSTALL_DIR`, vérifier
   `rea doctor` puis `rea function cible/IDMan.exe --address <entry>`.
3. **WP-04** — script d'extraction des vtables (pefile), première table
   `classe → RVA` sur 20 classes du grabber.
4. **WP-06** — ouvrir la fiche `docs/specs/grabber.md` avec les 22 classes et les 9
   dialogues déjà identifiés.
5. **A-05** — créer le gabarit de fiche de spécification et l'appliquer d'abord au
   moteur (WP-05), pour valider le format avant de le multiplier.
