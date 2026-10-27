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

### D-022 — Le projet de grabber est un **fichier `.gsd`** ; le registre n'est qu'un état auxiliaire
**Statut** : appliquée · **Date** : 2026-10-27

**Contexte.** L'annexe 12 avait établi que le grabber lit/écrit son projet dans le
registre (`GrabberSts\Projects\%ld\%ld\ChList`, valeurs `LocalFileName`/`LocalPath`/
`LogFileName`) et laissait ouverte la piste d'un fichier (`H-08`).

**Découverte (A-06).** La classe `GrSh` (« Grabber Shell », fonction `0xc30??`) construit
`"%sGrabber\Projects\"`, crée le dossier si `GetFileAttributesW` échoue, puis formate
`"%sproject%s.gsd"`. Chaînes d'erreur voisines : `GrSh::CFN exc 111` (*Create File*),
`GrSh::Lk exc 164` (*Lock*). Par ailleurs `GrbFsDlg::OnAddF` maintient
`HKCU\Software\DownloadManager\GrabberSts\nextFilterID` par
`RegQueryValueExA`/`RegSetValueExA`.

**Décision.** Corriger le modèle : **le projet persistant est un fichier `.gsd`** dans
`<dossier IDM>\Grabber\Projects\` ; le registre porte l'état de travail (miroir d'un
élément en cours de promotion) et les **compteurs d'identifiants** (`nextFilterID`).
Notre implémentation adoptera un fichier de projet unique (JSON/SQLite, `D-017`) plus une
base d'état, sans reproduire le couple `.gsd` + registre.

**Justification.** Le couple fichier+registre d'IDM est fragile (perte de cohérence,
nécessite `KEY_ALL_ACCESS`) ; un stockage transactionnel unique est plus simple à
spécifier et à tester (`WP-20`).

**Conséquence.** `H-08` **confirmée** ; annexe 11 créée (modèle de données) ; l'annexe 12
§3 renvoie désormais à l'annexe 11.

---

### D-023 — `empty.html` : comportement reproduit, sous forme configurable
**Statut** : appliquée · **Date** : 2026-10-27

**Contexte.** IDM écrit, dans son **propre** dossier d'installation, un fichier
`empty.html` contenant exactement `<HTML><BODY> </BODY></HTML>` (fonction `0xd1ed0`,
annexe 13 §4), s'il n'existe pas déjà.

**Options.** (a) ignorer ; (b) le recopier à l'identique dans `<install>/empty.html` ;
(c) le produire **dans le dossier de destination du projet**, avec un contenu
configurable, pour servir de page de remplacement des liens non téléchargés.

**Décision.** **(c)**. XDM n'écrit rien dans son dossier d'installation ; il peut
générer, à la demande, une page de remplacement dans chaque dossier de projet (option
désactivée par défaut), et l'utiliser pour réécrire les liens morts lors de
l'aspiration (`WP-24`).

**Justification.** Reproduire le comportement observable qui a du sens pour
l'utilisateur (site consultable hors ligne), sans hériter du placement discutable
d'IDM (écriture dans le dossier du programme, souvent protégé par UAC).

**Conséquence.** `WP-24` porte une exigence « page de remplacement optionnelle » ;
l'annexe 13 §4 sert de référence de contenu par défaut.

---

### D-024 — Le magasin de morceaux de XDM est un **fichier annexe**, pas le registre
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-05`

**Contexte.** IDM persiste l'état de découpage dans
`HKCU\Software\DownloadManager\<id>\ChList` (8 sites de construction de la clé,
`RegSetValueExA` + `RegFlushKey`, relecture `RegQueryValueExA`/`RegQueryInfoKeyA`,
suppression `RegDeleteKeyA`) — annexe 14 §5.1. Le format d'une valeur n'est pas
entièrement connu (A-11).

**Options.** (a) reproduire le registre ; (b) écrire un fichier annexe à côté du
fichier téléchargé ; (c) base de données unique pour tous les téléchargements.

**Décision.** **(b)** : `<fichier>.xdm-part.json`, écrit de façon atomique
(fichier temporaire + `rename`), versionné par un champ `version`.

**Justification.** Le registre Windows n'existe pas sur toutes les cibles de XDM ; le
format IDM est inconnu dans le détail ; un état qui **voyage avec le fichier** rend la
reprise portable et testable sans mock système.

**Conséquence.** L'annexe 11 §2 (modèle de données) devient la référence du schéma ;
`WP-05` définit son propre format ; le registre IDM n'est plus cité que comme preuve
historique.

---

### D-025 — Vérification anti-corruption par **empreinte**, pas comparaison d'octets
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-05`

**Contexte.** À chaque écriture, IDM compare les octets de recouvrement entre morceaux
voisins (`"Check w_st_o_n_cn failed!"`, tampon `Buff3`, annexe 14 §5.4) ; en cas de
divergence il réaffecte le morceau, réduit la taille de morceau, puis peut **revenir à
une seule connexion** (message observé : *« IDM started to download the file using one
connection because of data corruption… »*).

**Options.** (a) comparaison d'octets bruts comme IDM ; (b) empreinte SHA-256 par bloc
de recouvrement ; (c) aucune vérification, confiance dans `Content-Range`.

**Décision.** **(b)**, avec le comportement de repli (a→c) conservé comme exigence.

**Justification.** Même garantie fonctionnelle pour un coût mémoire constant, et
testable unitairement sans réseau réel (on injecte deux flux divergents).

**Conséquence.** `WP-05` porte une exigence « détection de divergence + repli à une
connexion », avec un test dédié. `(c)` est rejeté : c'est précisément le cas que les
serveurs produisent en pratique (compression, cache régional).

---

### D-026 — Un fichier préalloué + carte de morceaux, écrit en place
**Statut** : appliquée · **Date** : 2026-10-27 · **Corrigée** : 2026-10-27 (`A-11`) · **Portée** : `WP-05`

**Contexte.** IDM ouvre **un seul** fichier `<local>.tmp`
(`CreateFileW(…, 0xC0020000, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL)`,
`0x156d48`) dans `<IDM>\DwnlData\<nom>\`, l'écrit **en place** (`SetFilePointer` avant
chaque écriture) puis le promeut par renommage (annexe 14 §5.2 et §7).

> **Correction du 2026-10-27 (`A-11`).** La version initiale de cette décision affirmait
> « un fichier `.tmp` **par morceau**, puis assemblage ». C'était **faux** : le champ
> `file` d'un morceau est partagé par toute la session, et le binaire ne contient aucun
> modèle de nom numéroté (`%s%d.tmp` absent ; seuls `%s.tmp`, `%s_tmp`, `%s.tmpv0`,
> `%s.tmpa`, `%s.tmpv`, `%s.result.tmp` existent). La décision reste valable mais elle
> **aligne** XDM sur IDM au lieu de s'en écarter.

**Options.** (a) reproduire ; (b) un fichier préalloué, écriture à l'offset du morceau
(`pwrite`), état dans un fichier annexe (D-024).

**Décision.** **(b)**. Le rollback devient un `ftruncate` — équivalent exact de
`SetFilePointer` + `SetEndOfFile` observé en `0x15fee5`/`0x15ff52`.

**Justification.** Supprime l'étape de promotion conditionnelle, donc deux modes d'échec
observés chez IDM (`"Can not rename temp file %s"`, `"Not enough disk space to rebuild
downloaded chunks."`) ; pas de double espace disque ; reprise triviale.

**Conséquence.** `ChunksList::JoinFile` n'a **pas** d'équivalent dans XDM ; `WP-05`
n'implémente que la vérification de la carte et le rollback par troncature.

---

### D-027 — Une machine à états **unique**, mais exposée en 6 états + sous-états de transport
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-05` (A-12)

**Contexte.** L'état d'une connexion IDM est un entier en `this + 0xa4` avec **39 valeurs**
(0..38), distribué par 8 `switch` compilés en tables de sauts (annexe 14 §4). Les états
4, 5, 6, 7 et 14 sont écrits par **tous** les transports (HTTP, FTP, MMS, RTMP) ; les
états 10-13 sont propres à FTP, 15-16 à HTTP/TLS, 17-19 à MMS/RTMP. Sur le switch de
`HandleStatus`, 25 des 39 états tombent sur le même gestionnaire par défaut.

**Options.** (a) reproduire l'énumération de 39 états ; (b) un état générique à 6 valeurs
+ des sous-états par transport ; (c) une machine à états indépendante par protocole.

**Décision.** **(b)** : `CONNECTING`, `READY`, `SENDING`, `AWAITING_REPLY`, `TRANSFERRING`,
`COMPLETED` (+ `FAILED`), chaque transport pouvant ajouter des sous-états internes
(`FTP: PASV_OK`, `HTTP: TUNNEL`, …).

**Justification.** (a) ferait fuiter des concepts FTP dans le moteur HTTP pour 39 cas dont
la majorité est inatteignable hors d'un transport donné ; (c) dupliquerait la boucle
d'E/S, alors que l'observation montre qu'elle est commune (états 4-7, 14 partagés) et que
`Connection::SelectForRead` est unique pour toutes les classes.

**Conséquence.** `WP-05` spécifie une seule machine, paramétrée par un descripteur de
transport ; la table de correspondance état IDM ↔ état XDM vit dans le test de
conformité (les 39 états restent la référence côté analyse).

---

### D-028 — Un **réacteur unique par session**, plafond de sockets explicite, échéance ≤ 12 s
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-05` (A-13)

**Contexte.** IDM ne crée pas de thread par connexion : la boucle est un `select()`
unique par session (2 sites d'appel, `0x19503c` et `0x1959bd`), sur trois `fd_set` de
516 octets (`session+0x278`, `+0x47c`, `+0x680`) — donc **128 sockets** au plus —, avec
un délai plafonné à **12 000 ms**, divisé par 10 quand l'échéance est loin, par 2 quand
elle est passée, et un `Sleep()` de repli si `select` échoue (annexe 14 §4.4). Trois
`CreateThread` existent dans tout le binaire, aucun dans le transfert.

**Options.** (a) un thread par connexion ; (b) un réacteur unique par session ;
(c) une pile asynchrone (io_uring / async runtime) ; (d) un pool de workers.

**Décision.** **(b)**, avec un plafond de sockets **explicite et configurable**
(valeur par défaut alignée sur l'observation : 8 connexions par téléchargement), une
échéance maximale d'attente et un repli sur attente bornée.

**Justification.** (a) coûte une pile par connexion et complique l'annulation et le
rollback (état partagé entre sockets) ; (c) ajoute une dépendance et une abstraction
dont on n'a pas besoin pour ≤ 128 sockets ; (d) n'apporte rien sans (a). (b) reproduit
le modèle observé, qui explique aussi pourquoi IDM plafonne en pratique autour de la
centaine de connexions.

**Conséquence.** `WP-05` spécifie **un** réacteur par téléchargement, une constante
« sockets max » vérifiée par test, et l'échéance maximale comme paramètre ; le nombre de
connexions par défaut (8) est une valeur de configuration, pas une constante de code.

---

### D-029 — Taille de morceau **adaptative bornée** : 1 → 10 MiB, choisie par classe de taille
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-05` (A-16)

**Contexte.** IDM calcule la taille d'un morceau par une table indexée par classe
(`0x1559e0`, 171 valeurs, `classe − 0xA7`), rend une valeur 64 bits puis l'encadre :
**plancher 1 MiB** (`0x100000`), **plafond 10 MiB** (`0xA00000`). Table observée
(annexe 14 §5.4, reproduite par `tools/idman_chunks.py`) :

| Classes | Fichier ≤ 512 Mio / 2 Gio | Au-delà |
|---|---|---|
| 15 | **1 MiB** | 5 MiB |
| 9 | **5 MiB** | 10 MiB |
| 147 (défaut, y compris hors table) | **2 MiB** | 10 MiB |

**Options.** (a) taille fixe (ex. 1 MiB) ; (b) taille adaptative bornée, dérivée de la
taille du fichier ; (c) taille adaptative dynamique (réajustée pendant le transfert selon
le débit).

**Décision.** **(b)** : `chunk = clamp(1 MiB, 10 MiB, f(classe, taille_fichier))`, avec
les trois paliers observés (2 MiB par défaut jusqu'à 512 Mio, 10 MiB au-delà, 1 MiB ou
5 MiB pour les classes qui découpent plus fin). (c) est reporté : le comportement observé d'IDM réduit déjà la taille
en cas d'incohérence (« Change chunk size to %ld »), ce que XDM fait par rollback — un
réajustement dynamique serait une optimisation à mesurer, pas un prérequis.

**Justification.** (a) gaspille des connexions sur les gros fichiers et multiplie les
recouvrements à vérifier ; (c) ajoute un asservissement dont on n'a pas de preuve
d'utilité. (b) reproduit le comportement observé avec deux bornes simples à tester.

**Conséquence.** `WP-05` expose `minChunkSize` / `maxChunkSize` en configuration, avec
pour valeurs par défaut celles observées (1 MiB / 10 MiB) et un test unitaire vérifiant
l'encadrement.

---

### D-030 — La carte persistée est une **liste de bornes**, sans champ `end`
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-05` (`A-11`)

**Contexte.** L'enregistrement `ChList` observé contient exactement trois nombres par
morceau — `ID`, `startPos`, `nextID` (annexe 14 §5.1 : `"Adding record to registry with
ID %ld, startPos %I64d, nextID %ld"`, `"Read record num. %s from registry: ID = %ld,
startPos = %I64d, nextID = %ld"`). La fin d'un morceau n'est donc **pas** stockée : elle
est le `startPos` du morceau chaîné.

**Options.** (a) tableau de morceaux avec `{start, end}` explicites ; (b) liste de bornes
`{id, startOffset, nextId}` dont la fin est dérivée.

**Décision.** **(b)** dans `<cible>.xdm-part.json` (D-024), plus la taille cible du
fichier et un horodatage de version.

**Justification.** C'est la seule forme dont le contenu est **prouvé** par le binaire ;
(b) rend en outre impossible l'état incohérent « deux morceaux qui se chevauchent » : une
carte valide est une chaîne strictement croissante, vérifiable par un parcours unique.

**Conséquence.** Validation obligatoire au chargement : `nextId` orphelin, cycle,
`startOffset` non monotone ⇒ carte rejetée, téléchargement repris de zéro après
confirmation (pas de réparation silencieuse). Trois tests unitaires correspondants.

---

### D-031 — Le compteur de progression est une donnée **dérivée**
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-05` (`A-11`)

**Contexte.** IDM maintient un compteur 64 bits en mémoire et doit le **corriger à la
main** après un rollback (`add [esi+0xa0], ecx` / `adc [esi+0xa4], edx`, `0x15ff9b`).

**Décision.** XDM ne persiste jamais le nombre d'octets reçus ; il le recalcule en
sommant les intervalles marqués `completed` de la carte (D-030) au chargement et après
chaque rollback.

**Justification.** Une valeur dérivée ne peut pas diverger de la carte ; la classe de
bug « progression fausse après reprise » disparaît par construction.

**Conséquence.** L'IHM affiche une valeur recalculée (pas d'écriture concurrente), et le
seul état mutable partagé entre connexions est la carte, protégée par un verrou unique.

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
| A-06 | Lire en capstone les helpers de persistance du projet | WP-06/WP-11 | ✅ fait → annexes 11 & 12 |
| A-08 | Format d'un filtre | WP-11 | ✅ partiel : compteur `nextFilterID` = `REG_DWORD`, deux listes UI (annexe 13) ; corps du filtre inconnu |
| A-09 | Récupérer un vrai `.gsd` sur VM Windows et le dumper | WP-11, WP-30 | ⏳ phase 6 |
| A-10 | Lire `0xc2e00`+ (producteur du corps de filtre) et `CArray<IDM_SPIDERFILTER>` | WP-11 | ⏳ prochaine étape |
| A-07 | Trancher la stack d'implémentation (D-017) avant WP-20 | WP-20+ | ⏳ |
| A-05 | Ouvrir les fiches de spécification WP-10 (une par domaine P0) | WP-05+ | ⏳ |
| A-11 | Structure logique d'un enregistrement `ChList` | lecture d'un état IDM existant | ✅ fait : `{ID, startPos, nextID}` = **liste de bornes** ; le morceau est un **intervalle** dans un fichier unique (preuve : aucun modèle `%s%d.tmp`, champ `file` partagé), assemblage = promotion du `.tmp` (annexe 14 §5, §7) → `D-030`, `D-031` ; reste l'encodage binaire exact, sans intérêt (D-024) |
| A-12 | Énumérer les états de `Connection` | spécification de `WP-05` | ✅ fait : 39 états (0..38) en `this+0xa4`, 8 distributeurs, 115 transitions (annexe 14 §4) → `D-027` |
| A-13 | Seuils et modèle d'E/S | valeurs par défaut de `WP-05` | 🟡 défaut **8** connexions (`0x0fbe17`), **128** sockets par session, `select` plafonné à **12 000 ms** (annexe 14 §4.4) → `D-028` ; reste la taille minimale de morceau |
| A-14 | Identifier `HTTPConnection::MNSP` | complétude HTTP | ✅ fait : `0x17dc90` = combinaison d'URL via **`InternetCombineUrlA`** (ICU_ENCODE_SPACES_ONLY puis ICU_BROWSER_MODE), tampon ≤ 10 239 o (annexe 14 §8.1) |
| A-15 | Nommer les états 17..27 | complétude de la machine | ✅ fait : libellés tirés des chaînes de statut écrites juste avant l'état (annexe 14 §4.2) |
| A-16 | Taille minimale de morceau | politique de découpage | ✅ fait : table `0x1559e0` (1/2/5 MiB) encadrée à **1–10 MiB** (`0x155bd0`), annexe 14 §5.4 → `D-029` |
