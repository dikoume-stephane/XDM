# Journal des décisions — projet « clonage IDM »

> **Rôle du fichier** : registre chronologique et *immuable* des décisions importantes.
> On n'y réécrit pas une décision passée : on ajoute une entrée qui la remplace
> (`statut: remplacée par D-0xx`). Index complet : [`MEMOIRE.md`](MEMOIRE.md).
> Tableau récapitulatif : [`../analysis/idman/09-registre-decisions.md`](../analysis/idman/09-registre-decisions.md).

- **Cible** : `cible/IDMan.exe` — Internet Download Manager 6.42.22.3 (*Tonec Inc.*),
  PE32 i386, 6 017 024 octets, SHA-256 `5f78da5a63604a3fefba6577ef6b2af976ec4d2fc4d0f219a72099a0da2f11c9`.
- **Branche de travail** : `arena/c3b095dd-xdm` (branche de session).
- **Date de session** : 2026-10-26.
- **Conventions** : `D-xxx` décision · `H-xxx` hypothèse · `WP-xx` lot de travail ·
  `EV-xxx` preuve (bundle REA ou mesure locale) · `R-xx` risque · `A-xx` action.

---

## Phase 0 — Outillage

### D-001 — Retenir REA (`rea-agents`) comme outil d'analyse principal
**Statut** : appliquée · **Date** : 2026-10-26

**Contexte.** Le dépôt était vide (README de 5 octets). Aucun outil de
rétro-ingénierie n'était disponible.

**Options.** (a) Capstone/pefile maison ; (b) Ghidra seul ; (c) REA, qui expose CLI +
serveur MCP au-dessus de Hopper/Ghidra/IDA, et surtout des providers *intégrés* pour
PE/ELF/JS/.NET/APK dont les résultats sont des bundles Evidence signés.

**Décision.** Installer REA `6.8.0` en dépendance de projet épinglée **et** en global,
puis l'utiliser comme source de preuve principale.

**Justification.** (1) Chaque sortie porte un `evidence_id`, une couverture et des
`limitations` → citables dans nos annexes et reproductibles ; (2) il couvre déjà le
triage PE sans moteur natif ; (3) il orchestre Ghidra plus tard sans changer d'outil.

**Conséquence.** Toute affirmation d'annexe doit citer soit un `evidence_id` REA, soit
un offset/ID de ressource vérifiable (voir D-018).

---

### D-002 — Épingler la version de REA et ne pas dépendre d'une installation globale
**Statut** : appliquée

**Décision.** `package.json` déclare `rea-agents@6.8.0` en `devDependencies` + lockfile ;
les commandes du dépôt passent par `./node_modules/.bin/rea` (`npm run doctor`,
`npm run analyze:demo`).

**Justification.** Reproductibilité ; le bac à sable bloque `nodejs.org`, donc une
réinstallation globale ultérieure n'est pas garantie.

**Conséquence.** Si `npm install` est relancé sans lockfile, la version peut dériver →
voir R-01.

---

### D-003 — Sortir les bundles Evidence du dépôt Git
**Statut** : appliquée

**Décision.** Les JSON/MD bruts vont dans `analysis/raw/` et `analysis/raw/idman/`,
déclarés dans `.gitignore`. Seuls des résumés (≤ quelques Ko) et les données
déterministes utiles (`analysis/idman/triage.json`, 74 Ko) sont versionnés.

**Justification.** Un bundle `analyze-javascript-application` de démonstration pesait
321 Ko, les strings extraites d'IDMan.exe ~14 000 lignes ; au-delà de quelques mois,
le dépôt deviendrait ingérable. Les bundles sont régénérables par script.

**Conséquence.** `tools/collect-idman-evidence.sh` devient obligatoire pour reconstruire
l'état de preuve (voir D-005).

---

## Phase 1 — Cadrage

### D-004 — Périmètre légal : interopérabilité et réimplémentation, jamais le contournement de licence
**Statut** : appliquée · **Criticité** : haute

**Contexte.** Le binaire contient des classes explicitement liées à la protection
commerciale : `CRegistration`, `CRegistrationDlg`, `CSignVerifier`, `CSignVerifier_2`,
`CProtection`, `CHardwareSNs`, `CHardwareHDSN`, `CShowEndTrialDlg`, `CStupidSitesList`,
`CRegAccessMaker` (preuves : `analysis/raw/idman/rtti-classes.txt`, offsets cités en
`analysis/idman/08-index-citations.md`).

**Options.** (a) Analyser tout, y compris la vérification de clés ; (b) exclure ces
sous-systèmes ; (c) les mentionner sans les instrumenter.

**Décision.** **(c)**. Le projet documente *l'existence* et la *frontière* de ces
sous-systèmes (pour ne pas les casser par erreur et pour comprendre les contraintes
d'interopérabilité), mais **aucun travail** n'est planifié pour analyser, contourner ou
reproduire la vérification de licence, le fingerprint matériel ou les mécanismes
anti-fraude.

**Justification.** Contourner une mesure technique de protection et un système de
licence est illégal dans la plupart des juridictions (dont le Cameroun : loi n° 2019/020
sur la cybercriminalité ; et les législations type DMCA/EUCD côté fournisseurs). Le
risque juridique n'apporte aucune valeur au projet : nous voulons reproduire des
*comportements fonctionnels*, pas des *mesures de contrôle d'accès*.

**Conséquence.** Les lots WP-07 (licence) et WP-12 (anti-analyse/anti-débogage) sont
**gelés**. Toute demande future de les activer devra être refusée et renvoyée ici.

---

### D-005 — Méthode : statique d'abord, preuve avant intuition
**Statut** : appliquée

**Contexte.** Aucune machine Windows, aucun accès réseau sortant large, pas de licence
IDM → l'analyse dynamique est impossible dans cet environnement.

**Décision.** Pipeline en trois étages :
1. **REA** → preuves normalisées (`inspect-*`, `objdump`, plus tard `function`,
   `decompile` via Ghidra) ;
2. **outillage complémentaire déterministe** (`tools/idman_triage.py`, pefile + capstone)
   pour les vues agrégées que REA ne produit pas encore ;
3. **notes structurées** (annexes `analysis/idman/`).

**Justification.** Le statique ne modifie ni n'exécute la cible : reproductible,
citable, sans risque d'infection ni de violation d'EULA liée à l'exécution.

**Conséquence.** Toute conclusion est formulée comme *candidat* tant que non validée
dynamiquement ; la colonne « statut » des annexes reste `hypothèse` par défaut.

---

### D-006 — Cible primaire : `IDMan.exe` 32 bits uniquement
**Statut** : appliquée

**Décision.** Ne pas attendre les modules 64 bits (`IDM64.dll`, `IDMNetMon64.dll`,
`IDMVMPrs64.dll`, `IDMShellExt64.dll`, `IDMIECC64.dll`, `idmcchandler2_64.dll`,
`IDMGetAll64.dll`, `idmbrbtn64.dll`, `IDMFType64.dll` — tous attestés par chaînes, cf.
`analysis/idman/04-modules-et-composants.md`). Le PE 32 bits est le cœur applicatif et
suffit pour cartographier le comportement.

**Justification.** Un seul binaire présent dans le dépôt ; les modules 64 bits sont des
ponts vers les navigateurs 64 bits (mêmes rôles, cf. suffixes `AA` = « Any CPU/arch
agnostique » ? voir H-06).

**Conséquence.** Les différences 32/64 bits sont notées comme risque de fidélité (R-05).

---

### D-007 — Fonctionnalité à cloner : **Site Grabber (« çonage ») + moteur de téléchargement**
**Statut** : **à confirmer par l'utilisateur** (voir A-01)

**Contexte.** « réaliser le conage » désigne, dans le vocabulaire d'IDM, le **Site
Grabber** : aspirer un site entier (arborescence, filtres, projets, planification).
Le binaire le prouve massivement : 22 classes RTTI dédiées (`CIDMSpider`,
`CSpiderSettings`, `CSpiderSiteMapDlg`, `CSpiderWhereToSearchDlg`,
`CGrabbersSchedulers`, `CSchedulerOfGrabberProject`, `CLoadGrabberProjectDlg`,
`CCustomGrabberTemplates`, `CRecentGrabberProjects`, `CGrabberStatsDlg`…), 8 boîtes de
dialogue (IDs 239, 241, 244/245, 262, 268, 269, 270, 271, 284) et les chaînes
`IDM Site Grabber`, `Settings of IDM Grabber`, `Template Name`, `Load project`,
`Grabber Statistics`, `Schedule the grabber project`.

**Options.** (a) cloner tout IDM ; (b) cloner le Site Grabber + le moteur qui le sert ;
(c) cloner le seul moteur de téléchargement.

**Décision.** **(b)**, avec le moteur de téléchargement et les protocoles (HTTP/FTP/
DASH/HLS/RTMP/MMS) traités comme *dépendances fonctionnelles* du grabber, pas comme
la finalité. Priorités : P0 = moteur + grabber, P1 = protocoles médias, P2 = UI/annexes.

**Justification.** Un grabber sans moteur robuste ni gestion de reprise ne fonctionne
pas ; à l'inverse, cloner les 105 boîtes de dialogue serait un coût sans valeur
différenciante.

**Conséquence.** La roadmap (`docs/ROADMAP-IDM.md`) est découpée sur ce périmètre ;
si l'utilisateur visait autre chose (ex. accélérateur multi-connexions seul), seuls
WP-01/02/03 restent et l'effort baisse d'environ 60 %.

---

### D-008 — Chaîne de compilation : MSVC x86 + MFC 9.0 (VS2008 SP1), pas de packer
**Statut** : appliquée · **Confiance** : élevée

**Preuves.**
| Fait | Source |
|---|---|
| PDB `s:\IDM_projects\IDM_vs2008_2\Release\IDMan.pdb` (CodeView, type 2) | pefile, `analysis/idman/01-anatomie-binaire.md` |
| Import `mfcm90.dll` (MFC 9.0 = VS2008) | `EV-inspect-pe-imports` (delay-imports) |
| Chaînes `.?AVCStringT@…@ATL@@`, `AFX_MODULE_STATE`, 390 classes RTTI « C… » | RTTI extrait, 439 noms |
| Absence de symboles publics | `rea inspect-with-objdump … symbols` → `no symbols` |
| Entropie globale **6.3884** (seuil haut REA : 7.2), aucune section > 6.6, pas d'overlay | `EV-inspect-byte-entropy`, `inspect-binary-layout` (pefile) |

**Décision.** Traiter la cible comme du C++/MFC **non packé**, donc analysable par
Ghidra directement ; **ne pas** investir en désobfuscation. Baser la cartographie
fonctionnelle sur les **noms de classes RTTI** (ils sont conservés), les **ressources**
(dialogues/menus/chaînes) et les **chaînes de protocole** — pas sur des symboles.

**Justification.** 439 noms RTTI ≈ une carte gratuite du design objet ; c'est ce qui
rend le clonage réaliste sans debug info.

**Conséquence.** Phases 3-4 de la roadmap portent sur l'**attribution des
comportements aux classes RTTI**, pas sur une reconstruction de symboles.

---

### D-009 — Registre de preuve unique : le script de triage
**Statut** : appliquée

**Décision.** `tools/idman_triage.py` devient la source de vérité *déterministe* pour
les faits agrégés (sections, entropies, mitigations, imports, ressources, RTTI,
marqueurs de protocole, offsets). Sortie : `analysis/idman/triage.json` (versionné,
74 Ko, sans horodatage).

**Justification.** Deux exécutions produisent le même JSON → les annexes peuvent citer
« triage.json §sections » de façon stable. REA reste l'autorité pour les bundles
Evidence (`evidence_id`), mais ne fournit pas ces agrégats.

**Conséquence.** Toute nouvelle mesure doit être ajoutée **au script**, pas saisie à la
main dans une annexe.

---

### D-010 — Le corpus de chaînes n'est pas versionné, seuls les marqueurs le sont
**Statut** : appliquée

**Décision.** `analysis/raw/idman/strings-*.txt` (14 384 chaînes ASCII, 1 630 UTF-16)
restent hors Git ; les annexes ne citent que des marqueurs + offsets.

**Justification.** Volume, et contenu potentiellement sensible (chemins d'utilisateurs,
URLs de licence, contenu HTML embarqué ressemblant à du texte générique).

**Conséquence.** Pour rejouer une citation, utiliser l'offset fourni en
`analysis/idman/08-index-citations.md`.

---

## Phase 2 — Choix techniques pour la suite

### D-011 — Moteur natif : **Ghidra headless 12.1.x**, pas Hopper ni IDA
**Statut** : **en attente d'installation** (A-02)

**Options.** Hopper (indisponible hors macOS), IDA (payant, absent), Ghidra (gratuit,
scriptable, supporté par REA via `GHIDRA_INSTALL_DIR` — `rea doctor` attend la branche
12.1.x).

**Décision.** Ghidra headless, piloté par REA (`rea function`, `rea decompile`,
`rea analyze`) **et** par scripts d'export maison (CSV graphe d'appels) pour la
cartographie.

**Justification.** Coût nul, exécution sur ce sandbox Linux possible (Ghidra est en
Java), résultats reproductibles côté CI. L'absence de DWARF/symboles n'est pas
bloquante car les RTTI donnent les classes.

**Conséquence.** R-03 (Ghidra non installé → phases 3+ bloquées) ; action A-02.

---

### D-012 — Analyse dynamique différée, hors de ce sandbox
**Statut** : appliquée

**Décision.** Aucune exécution de la cible ici (ni Wine, ni VM Windows). Le plan
dynamique est rédigé (`docs/ROADMAP-IDM.md` § P6) et devra être joué par
l'utilisateur sur une VM Windows isolée, avec Frida Process Monitor + REA
(`capture-process`, `debug-with-gdb` non applicable → voir Frida).

**Justification.** Exécuter un binaire commercial inconnu dans le sandbox est inutile
(pas de Windows), risqué, et ne respecte pas nécessairement l'EULA. Le statique suffit
pour 80 % de la spécification.

**Conséquence.** Les hypothèses marquées `H-xx` restent ouvertes jusqu'à la phase 6.

---

### D-013 — Format de la mémoire du projet (4 niveaux)
**Statut** : appliquée

**Décision.**
1. `docs/JOURNAL.md` — décisions datées et immuables (ce fichier) ;
2. `docs/ROADMAP-IDM.md` — plan vivant, révisé à chaque jalon ;
3. `docs/MEMOIRE.md` — index + conventions + règles de fraîcheur ;
4. `analysis/idman/NN-*.md` — annexes thématiques (preuves, anatomie, cartographie,
   protocoles, modules, intégrations, hypothèses, glossaire, index, décisions).

**Justification.** Séparer *ce qui est décidé* (journal), *ce qui est prévu* (roadmap),
*ce qui est su* (annexes) et *où le trouver* (index) évite les documents fourre-tout.

**Conséquence.** Chaque annexe commence par un en-tête `Statut / Dernière revue /
Source de vérité`.

---

### D-014 — Toute affirmation d'annexe est étiquetée par son niveau de confiance
**Statut** : appliquée

**Décision.** Vocabulaire imposé :
- **Observé** : mesuré sur le fichier (offset, entrée PE, nom RTTI) → citable tel quel ;
- **Dérivé** : conséquence directe d'observations (ex. « MFC 9 ⇒ VS2008 SP1 ») ;
- **Hypothèse** : plausible, non prouvée (`H-xx`) ;
- **Inconnu** : ni l'un ni l'autre (à ne pas combler par une supposition).

**Justification.** Le risque principal d'un tel projet est de transformer une intuition
en spécification. Le champ `confidence` de REA (`observed` / `derived`) fournit déjà
cette échelle.

---

### D-015 — Pas de « clone bit-à-bit » : objectif = compatibilité de comportement
**Statut** : appliquée

**Décision.** Les livrables sont des **spécifications de comportement** + une
réimplémentation testable (protocoles, formats de projet, sémantique des filtres),
pas une reproduction de l'UI ni du code machine.

**Justification.** Le code d'IDM est propriétaire : la réimplémentation doit être une
œuvre indépendante, écrite à partir de descriptions de comportement (clean-room
partiel : nos annexes jouent le rôle de spécification, l'implémentation ne copie ni
chaîne UI ni code).

**Conséquence.** WP-10 (« spécifications ») est un livrable **à part entière**, revu
avant toute ligne de code d'implémentation.

---

### D-016 — Politique de nommage des futurs lots et documents
**Statut** : appliquée

**Décision.** `WP-xx` pour les lots de la roadmap, `EV-xx` pour les preuves
(`EV-inspect-pe-imports`…), `H-xx` hypothèses, `R-xx` risques, `A-xx` actions.
Un identifiant n'est jamais réutilisé.

---

### D-019 — Ghidra n'est pas installable dans ce sandbox : le lot WP-04 est exécuté avec un outil maison
**Statut** : appliquée · **Date** : 2026-10-27

**Contexte.** `rea doctor` attend Ghidra 12.1.x (`GHIDRA_INSTALL_DIR`). Aucun JVM n'est
présent, et les archives ne sont pas téléchargeables ici :

| Tentative | Résultat |
|---|---|
| `api.adoptium.net` (JDK 21) | HTTP `000` (non routé) |
| `github.com/…/releases/download/ghidra_12.1.4…zip` | HTTP **302** vers `release-assets.githubusercontent.com` |
| `release-assets.githubusercontent.com` | HTTP `000` — hôte **hors** de la liste autorisée |

**Options.** (a) attendre un environnement avec Ghidra ; (b) installer radare2/rizin
(également hors réseau autorisé) ; (c) écrire l'extraction de vtables/RTTI en Python
(pefile + capstone), ce qui est de toute façon le prérequis de WP-04.

**Décision.** **(c)**, et documenter le blocage comme un fait d'environnement, pas comme
un échec d'outil. WP-03 reste **bloqué** (décompilation indisponible) ; WP-04 est
**exécuté** avec `tools/idman_classes.py`.

**Conséquence.** Les spécifications WP-05/06 seront produites soit hors sandbox avec
Ghidra, soit par lecture ciblée capstone sur les fonctions listées en annexe 10 §6.

---

### D-020 — Règles d'attribution chaîne → fonction, avec deux niveaux de confiance
**Statut** : appliquée

**Décision.** Une référence `push imm32` est toujours considérée comme **exacte** (elle
existe dans le code). En revanche la **fonction englobante** est estimée par deux voies
concurrentes, conservées séparément : `classes_method` (méthode de vtable la plus proche,
frontière exacte) et `classes_prologue` (prologue `55 8B EC` le plus proche).
La confiance est `élevée` (méthode seule), `moyenne` (les deux concordent), `faible`
(désaccord ou prologue non vérifié).

**Justification.** Sans décompilateur, une borne de fonction est une hypothèse. Séparer
les deux voies évite de transformer une proximité d'adresse en fait — c'est exactement
le risque `R-04`.

**Conséquence.** Toute affirmation d'attribution dans une spécification doit recopier sa
confiance et la liste des classes concurrentes.

---

### D-021 — `classes.json` devient la source de vérité de la carte objets, l'annexe 10 sa lecture
**Statut** : appliquée

**Décision.** `analysis/idman/classes.json` (461 Ko, déterministe, versionné) porte les
422 classes, 427 vtables, 13 760 méthodes et 255 sites de référence ; l'annexe 10 ne
présente qu'une **sélection curatée**. Toute nouvelle attribution passe par le script.

**Conséquence.** Comme pour `triage.json` (`D-009`) : pas de saisie manuelle d'adresses.

---

## Décisions en attente

### D-017 — Choix du langage/stack de réimplémentation
**Statut** : **ouverte** · **Bloque** : WP-10+ (pas avant)

Options esquissées : (a) Java/Kotlin si le projet XDM l'est déjà ; (b) Rust
(moteur + CLI, performant, sûr, mais plus long) ; (c) TypeScript/Node (rapide, mais
gestion de la concurrence et des gros transferts moins naturelle). Décision reportée
après confirmation du périmètre (D-007) et lecture de la stack existante de XDM.

### D-018 — Stockage des artefacts lourds (grappes de captures, plans de site)
**Statut** : **ouverte** — à trancher avant la phase 5 (sinon R-07 : dépôt qui gonfle).

---

## Actions ouvertes

| ID | Action | Bloquant pour | État |
|---|---|---|---|
| A-01 | Confirmer le périmètre : « çonage » = Site Grabber ? projet = XDM ? | tout | ⏳ demande à l'utilisateur |
| A-02 | Installer Ghidra 12.1.x + `GHIDRA_INSTALL_DIR` — **impossible ici** (D-019) ; à faire hors sandbox | WP-03, décompilation | 🚫 bloqué |
| A-03 | Upgrade Node ≥ 22.23.4 (REA le demande ; bloqué par le réseau) | `rea update`, SQLite | ⏳ |
| A-04 | Préparer la VM Windows isolée + Frida pour la phase 6 | WP-11 | ⏳ |
| A-06 | Lire en capstone les 4 helpers de persistance du projet (`0x156670`, `0x1b5c30`, `0x1bbea0`, `0x1d26b0`) | WP-06 | ⏳ prochaine étape |
| A-07 | Trancher la stack d'implémentation (D-017) avant WP-20 | WP-20+ | ⏳ |
| A-05 | Ouvrir les fiches de spécification WP-10 (une par domaine P0) | WP-05+ | ⏳ |
