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

> **Complément du 2026-10-27 (`A-13`).** Le plafond de 12 s est confirmé comme **borne du
> délai de sommeil** (`cmp ecx, 0x2ee0` / `mov ecx, 0x2ee0`, `0x1958a7`), et non comme
> timeout de transfert : celui-ci est un **délai d'inactivité de 30 s** (`cmp eax, 0x1e`,
> `0x1a139f` / `0x18adad`), porté à **300 s** quand `[conn+0x13c] == 2` (`0x18becf`),
> suivi d'un redémarrage de connexion ; les reprises sont bornées par le réglage
> `mAttempts` (annexe 14 §4.5). XDM adopte les deux valeurs : `select ≤ 12 s`,
> `inactivité 30 s ⇒ reconnexion`.

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

### D-032 — Un filtre = `{id, motif, type, actif}`, projection des 16 octets observés
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-11` (`A-10`)

**Contexte.** `CArray<IDM_SPIDERFILTER>::SetAtGrow` (`0xc2bc0`) prouve un pas de
**16 octets** et quatre champs copiés : `CString nom` (`+0`), `CString motif` (`+4`),
`int id` (`+8`), `BYTE actif` (`+0xC`). La portée inclusion/exclusion n'est **pas** dans
l'enregistrement : elle est portée par deux tableaux distincts (`dialogue+0x124` /
`+0x138`) et par deux clés de registre.

**Options.** (a) filtre = objet riche (portée + activation + priorité, comme le laisse
deviner l'IHM) ; (b) filtre = projection stricte des quatre champs observés.

**Décision.** **(b)** : `{ id: number, motif: string, type: "include"|"exclude",
actif: boolean }`, `motif` étant un masque glob pouvant contenir une liste séparée par des
virgules (forme des défauts observés).

**Justification.** Toute donnée supplémentaire serait inventée : le binaire ne stocke que
ces quatre champs. La portée est une propriété de la **liste**, pas de la règle.

**Conséquence.** `WP-11` valide `motif ≠ ""`, `id ≠ 0`, unicité de `id` ; les tests
prennent les 11 motifs d'exclusion par défaut observés comme jeu de départ.

---

### D-033 — Les filtres de XDM vivent dans le projet, pas dans le registre
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-11` (`A-10`)

**Contexte.** IDM sérialise ses filtres en deux clés
`GrabberSts\IncludeFilters` / `\ExcludeFilters`, une valeur `REG_SZ` par filtre dont le
**nom** vaut `"<id> <motif>"` et les **données** le nom du filtre (annexe 13 §4 bis).

**Décision.** Les deux listes appartiennent au **projet** (`.xdmspider.json`), avec un
compteur d'identifiants persistant qui démarre à **100** (valeur de repli observée en
`0xc2cc9`).

**Justification.** Portabilité et « un projet = un fichier » (annexe 11) ; le registre
n'est pas disponible hors Windows — même raisonnement que `D-024`.

**Conséquence.** Importer un projet IDM = lire les deux clés et remplir les deux tableaux ;
aucun `.gsd` n'est requis pour les filtres.

---

---

### D-034 — Socle XDM en Node 22 + ES modules + JSDoc, **zéro dépendance**, `node --test`
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-20`+ (ferme `D-017`, `A-07`)

**Contexte.** `D-017` laissait ouvert le choix de stack (Java/Kotlin, Rust, TypeScript/Node) et
bloquait `WP-20`. Le dépôt est déjà un espace Node (REA 6.8.0, `package.json`, Node 22.22.3
présent dans la sandbox), mais sans aucun code applicatif.

**Options.** (a) Rust (moteur performant, mais compilation et outillage absents ici) ;
(b) TypeScript + build (`tsc`/`esbuild`) ; (c) Node 22 + ES modules + JSDoc, sans build ;
(d) Java/Kotlin.

**Décision.** **(c)**. Le socle s'écrit en `.js` ES modules typés par JSDoc, sans aucune
dépendance d'exécution ni de développement ; les tests utilisent le lanceur intégré
(`node --test`).

**Justification.** (a) impose une chaîne de compilation que la sandbox n'a pas et ajoute un
risque de planning sur la partie déjà la plus incertaine ; (b) ajoute un build dont aucun
besoin n'est démontré et deux dépendances (compilateur, résolveur) ; (d) est hors de
l'écosystème du dépôt. (c) permet d'écrire **et d'exécuter** les tests de spécification
immédiatement, sans réseau ni installation, ce qui est exactement ce que la porte G1
demande. Les types JSDoc gardent l'essentiel de la sécurité de TypeScript, et un passage
ultérieur à TypeScript reste possible fichier par fichier (même syntaxe de modules).

**Conséquence.** `package.json` déclare `"type": "module"` et `npm test` → `node --test` ;
aucun `node_modules` n'est nécessaire au socle. La contrainte « 128 sockets / un `select`
par session » (`D-028`) reste à réévaluer sur la boucle d'E/S de Node : ce point est
explicitement reporté à `WP-21` et devra être mesuré, pas supposé.

---

### D-035 — Rollback : la zone perdue est **rouverte en morceau de reprise**
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-05`/`WP-20` (`EX-A-09`)

**Contexte.** `D-030` supprime le champ `end` : la fin d'un morceau est le `start` du
maillon suivant. Un test de spécification (`T-A-09`) a montré la conséquence non prévue :
*avancer le `start` d'un morceau en cours de rollback étend artificiellement le morceau
précédent, déjà clos*, qui annonce alors des octets qu'il ne possède pas.

**Options.** (a) réintroduire un champ `end` explicite ; (b) laisser le morceau précédent
« hériter » de la zone perdue et rouvrir les deux ; (c) insérer un **nouveau morceau**
couvrant la zone perdue, devant celui qu'on reprend.

**Décision.** **(c)** : `P [0,40) clos → R [40,55) à refaire → N [55,100) en cours`.
Le morceau `R` reçoit l'identifiant maximal + 1 et devient le prédécesseur de `N` dans la
chaîne ; un rollback sans octet acquis (offset = borne basse) ne crée rien.

**Justification.** (a) contredit la preuve binaire (`ChList` ne stocke que `ID`,
`startPos`, `nextID`) et `D-030` ; (b) ferait mentir l'indicateur `completed`, donc la
progression dérivée (`D-031`). (c) préserve les trois invariants d'un coup : chaîne
strictement croissante, aucun morceau clos n'annonce d'octets absents, progression
inchangée pour les parties réellement acquises. Le coût est un morceau de plus par
incident, borné par le nombre de reconnexions.

**Conséquence.** `applyRollback()` renvoie une **nouvelle** carte (jamais de mutation) ;
`T-A-09` vérifie la forme de la chaîne, et `WP-22` doit fusionner les morceaux de reprise
adjacents (`R` clos + `N`…) pour éviter l'accumulation après de nombreuses coupures —
tâche ajoutée au lot, test `T-A-27` à écrire.

---

---

### D-036 — La file de tâches est **un fichier unique**, FIFO, à transitions explicites
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-20`

**Contexte.** IDM répartit l'état des téléchargements entre la liste en mémoire, la clé
`Software\DownloadManager\<id>` et le registre `ChList` (annexe 14 §5.1). XDM a déjà
choisi de mettre l'état **d'un** téléchargement dans `<cible>.xdm-part.json` (`D-024`) ;
il manquait l'état de **la file**.

**Options.** (a) un fichier par tâche ; (b) un fichier `queue.json` unique à la racine de
travail ; (c) une base SQLite.

**Décision.** **(b)**, avec : ordre d'exécution **FIFO** sur l'ordre d'insertion, table de
transitions **explicite** (`PENDING → ACTIVE → VERIFYING → DONE`, `ACTIVE ↔ PAUSED`,
`FAILED → PENDING` seulement sur action manuelle), plafond de téléchargements actifs
**8** par défaut (valeur observée, `0x0fbe17`), et récupération au démarrage : toute tâche
restée `ACTIVE` repasse en `PENDING` en conservant son compteur de tentatives.

**Justification.** (a) impose de lister le dossier et rend l'ordre dépendant du système de
fichiers ; (c) ajoute une dépendance native (`D-034`) pour un besoin qui reste sous
quelques milliers de lignes. (b) s'écrit atomiquement avec le même motif que la carte, se
lit à l'œil, et un fichier `queue.json` corrompu est **refusé** sans faire perdre les
cartes de morceaux, qui restent valides à côté.

**Conséquence.** Un test vérifie qu'une transition illégale (`ACTIVE → DONE`) **lève** au
lieu d'être absorbée : les bugs d'appelant deviennent visibles. La récupération après
coupure est testée (`recoverAfterCrash`), et `WP-22` doit appeler cette fonction avant
toute reprise.

---

### D-037 — Assainissement du nom final : **dernière composante**, jamais un chemin
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-20` (`EX-A-14`)

**Contexte.** Le nom du fichier final est déduit de l'URL (`SessionManager::GetDefaultlocalName`
côté IDM). Une URL forgée peut contenir `../`, un séparateur, un caractère interdit
Windows, un nom réservé (`CON`, `LPT1`) ou une longueur excessive.

**Options.** (a) remplacer les séparateurs par `_` en conservant tout le reste ; (b) ne
garder que la **dernière composante** de chemin, puis nettoyer ; (c) rejeter l'URL.

**Décision.** **(b)** : décodage défensif (`%2e%2e`), découpage sur `/` et `\`, conservation
du dernier segment non vide, suppression des caractères de contrôle, remplacement des
caractères interdits (`<>:"|?*`), compression des suites de points, retrait des points et
espaces finaux, préfixe `_` pour les noms réservés DOS, troncature à **200 octets** en
conservant l'extension, repli `download` si le résultat est vide. Une URL terminée par `/`
retombe sur le nom d'hôte.

**Justification.** (a) produisait des noms illisibles (`.../etc/passwd` → `._._etc_passwd`)
et laissait la porte ouverte à des collisions ; (c) priverait l'utilisateur d'un
téléchargement légitime à cause d'un caractère. (b) est la règle des navigateurs, testable
par table de cas.

**Conséquence.** Aucun nom produit ne peut sortir du dossier cible : la garantie ne repose
plus sur une validation à l'écriture mais sur la **construction** du nom. `T-A-14` couvre
huit formes d'attaque ou de cas limite.

### D-038 — Le client HTTP est **une couche sans état, à transport injectable**
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-21`

**Contexte.** `EX-A-08`, `EX-A-15`→`EX-A-18` décrivent le comportement réseau face aux
serveurs réels. Les tester contre Internet serait non déterministe ; ne pas les tester
laisserait la promotion au vert sur du code jamais exécuté.

**Décision.** `src/http-client.js` sépare strictement :
1. les **fonctions pures** du protocole — `rangeHeader`, `resumeRangeHeader`,
   `parseContentRange`, `resolveLocation`, `acceptsRanges`, `announcedSize`,
   `planConnections` — testables sans réseau ;
2. un **transport** `(url, {method, headers}) => {status, headers, stream}` dont le défaut
   est `defaultTransport` (`node:http`/`node:https`) ; les tests l'injectent pour simuler
   des `206`, `200`, chaînes de `302` et flux divergents ;
3. deux **opérations** : `probe()` (sonder la ressource en suivant les redirections) et
   `openSegment()` (`Range` + `If-Range` sur un morceau).

**Règles attachées.**
- Sonder se fait avec `Range: bytes=0-0` : un `206` + `Content-Range` prouve le support,
  un `200` le nie ⇒ une seule connexion (`EX-A-08`).
- `Accept-Encoding: identity` est **toujours** envoyé (`EX-A-16`) : un corps compressé ne
  respecte pas les offsets de la carte.
- Redirections : `Location` résolue par `new URL(location, base)`, 10 sauts au plus,
  `Location` non `http(s)` refusée, URL > 10 239 octets refusée **avant** tout appel
  réseau (`EX-A-15`).
- Inactivité : `readWithIdleTimeout` borne chaque attente à 30 s et lève `IDLE_TIMEOUT`
  avec `resumeAt` = dernier offset confirmé ; l'appelant rouvre une `Range` à cet offset
  (`EX-A-18`), jamais depuis zéro (`EX-A-19`).
- Aucun appel réseau n'est émis en dehors de la ressource demandée : pas de télémétrie,
  pas de résolution annexe (`EX-A-17`, cohérent avec `D-004`/`D-012`).

**Conséquence.** `T-A-08`, `T-A-15`, `T-A-16`, `T-A-17`, `T-A-25` passent au vert
(61 tests au total). `WP-21` reste ouvert sur la **boucle de connexions** (allocation
dynamique des morceaux aux sockets, `EX-A-13`) et sur `T-A-10` (divergence de contenus).

### D-039 — Divergence : comparaison des **fenêtres de recouvrement**, repli à une connexion
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-21`/`WP-22`

**Contexte.** `EX-A-10` : deux connexions peuvent recevoir des contenus différents du même
URL (CDN mal synchronisé, ressource remplacée en cours de route). Écrire les deux flux dans
le même fichier produirait un fichier cohérent en apparence et corrompu en fait.

**Décision.** Chaque connexion demande `overlap` octets **avant** son morceau
(`Range: bytes=<début-overlap>-<fin>`, 1 024 octets par défaut, plancher 64). La fenêtre
`[début-overlap, début)` est déjà écrite par le morceau précédent : les deux vues sont
hachées en SHA-256 et comparées **à la même clé absolue** (`DivergenceGuard`). Une
contradiction lève `DIVERGENT` ; la boucle abandonne le multi-connexion, reconstruit un
morceau unique et **reprend le fichier entier à une seule connexion** — la vue unique devient
alors la référence.

**Règles attachées.**
- Les octets de recouvrement ne sont **jamais réécrits** : `pumpSegment` les saute (`skip`).
  Les ignorer décalerait tout le morceau d'un `overlap` (défaut trouvé par un test).
- Seules les fenêtres **pleines** sont comparées : une fenêtre courte a deux clés
  différentes de part et d'autre, donc rien à confronter (faux positifs sinon, cf. le cas
  `chunkSize = 1` de `T-A-13`).
- L'inactivité (`EX-A-18`) n'annule pas la garde : la reprise réutilise le même registre.
- Après repli, `connections = 1` et `chunkSize = totalSize` sont **rapportés** dans le
  résultat : la décision est visible, pas silencieuse.

**Conséquence.** `EX-A-10` et `EX-A-13` passent au vert ; `EX-A-09`/`EX-A-19` sont couverts
de bout en bout par la boucle (`T-A-25`). **73 tests verts.**

### D-040 — La carte est persistée **à chaque morceau clos**, la CLI promeut explicitement
**Statut** : appliquée · **Date** : 2026-10-27 · **Portée** : `WP-22`

**Contexte.** `EX-A-02`/`EX-A-19` exigent qu'une coupure ne coûte que le morceau en cours.
Écrire la carte à la fin du téléchargement rendrait toute interruption totale ; l'écrire à
chaque morceau, sans ordre, expose à deux écritures concurrentes dans le même fichier
temporaire.

**Décision.**
1. La boucle écrit `<cible>.xdm-part.json` après **chaque** morceau clos (`savePartFile`,
   écriture atomique `tmp` + `fsync` + `rename`). Les écritures sont **sérialisées** par une
   chaîne de promesses, et le nom du fichier temporaire est unique
   (`.<pid>.<compteur>.<horodatage>.tmp.part`) — deux travailleurs ne peuvent plus se voler
   leur fichier (défaut observé par un test avant correction).
2. La reprise (`resume: true` par défaut) relit la carte ; elle n'est acceptée que si
   `totalSize` correspond à ce qu'annonce la sonde. La carte est **fusionnée**
   (`mergeResumeChunks`, `A-21`) avant usage : les morceaux incomplets adjacents ne forment
   plus qu'un seul morceau, ce qui évite de rouvrir une connexion par coupure passée.
3. Le fichier de travail est rouvert en `r+` (`fresh: false`) : la reprise **conserve** les
   octets déjà écrits. Un fichier absent est recréé, une carte refusée est ignorée.
4. La promotion n'est **jamais implicite** dans la boucle : `promote: true` la demande, et
   elle passe par `checkReadyToPromote` + `rename` (`EX-A-12`). La CLI `bin/xdm.js` la
   demande parce que c'est son métier ; un appelant qui veut inspecter le fichier de travail
   avant de le livrer ne la demande pas.
5. `npm test` devient `node --test` (sans argument de répertoire) : `node --test test/`
   échoue en ESM (`MODULE_NOT_FOUND`).

**Conséquence.** `T-A-21`/`T-A-27` (fusion), `T-A-19` (reprise sans redemander un morceau
clos) et la promotion de bout en bout sont couverts ; **79 tests verts**. `WP-22` est clos,
`A-21` fermée.

### D-041 — Le grabber est **spécifié comme produit**, pas cloné depuis un algorithme non observé
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-11`, fiche B

**Contexte.** `Q-B-01` (algorithme d'exploration) bloquait la fiche B depuis le début : 6 de
ses 13 exigences étaient des hypothèses. La question posée était « quel outil faut-il pour le
lire ? ». La mesure (`tools/idman_grabber.py` → `analysis/idman/grabber.json`, annexe 12 §6)
invalide la prémisse : dans `IDMan.exe`, **aucune méthode des conteneurs du spider n'est
appelée** (`CArray<IDMSPIDER_STRUCT_SPL|RL|LI2>` : 0 référence code ; `CList<…RELPARSERINFO>` :
0 ; `CIDMSpider` : 1 seule référence, de type enregistrement de classe d'exécution). Le
module contient l'interface (6 dialogues), la configuration (`CGrabberSettings`, 10 champs
cartographiés), la persistance du projet (`.gsd` + `GrabberSts\Projects`) et les filtres —
**pas** le moteur d'exploration. Un décompilateur montrerait la même absence.

**Décision.** Le grabber est **spécifié comme produit XDM**, pas comme clone :
1. ce qui est **observé** et déjà écrit reste la référence : modèle de projet, filtres
   `{id, motif, actif}` avec ids dès 100, promotion d'une entrée en téléchargement ordinaire,
   `empty.html` (`EX-B-01`→`EX-B-07`, `EX-B-10`→`EX-B-12`) ;
2. l'**exploration** (ordre de parcours, dédoublonnage, politique `robots.txt`, profondeur
   par défaut, parallélisme) devient un **choix documenté de XDM** : BFS par niveau, une
   file, `nLevels` par défaut 2, `robots.txt` respecté, une connexion de crawl (les
   téléchargements, eux, restent multi-connexions). Ces choix sont marqués **Décision**, plus
   **Hypothèse** : une hypothèse prétend décrire IDM, une décision décrit XDM ;
3. `Q-B-01` est **close comme non instruite dans ce module** ; `Q-B-03` (défaut de `nLevels`)
   reste ouverte mais **sans effet** sur XDM, qui fixe sa propre valeur ;
4. la fidélité au clone reste revendiquée pour le **moteur de téléchargement** (domaine A,
   19/19 exigences) et pour **tout ce qui est observé** du grabber ; elle n'est plus
   revendiquée pour l'algorithme d'exploration.

**Portée de vérification.** Toute exigence de la fiche B passe en **Observé** (preuve citée)
ou en **Décision** (choix XDM + test) ; aucune ne reste **Hypothèse**. La matrice de
conformité distingue ces deux statuts.

**Alternative écartée.** Installer un décompilateur *ici* pour « quand même essayer » : sans
le module qui contient le moteur, il n'y a rien à décompiler — le coût serait payé sans
résultat. Si `IDMGrHlp.exe` (ou un autre binaire de la suite) devient disponible, `D-041`
sera réévaluée : la mesure de `grabber.json` est reproductible et dira immédiatement si le
moteur y est.

### D-042 — Arborescence locale : chemin **relatif à la racine du site**, segments assainis, collisions suffixées
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-11`

**Contexte.** `EX-B-11` (« l'arborescence locale reproduit celle du site ») et `EX-B-12`
(`empty.html`) restaient à trancher : deux URL peuvent désigner le même chemin local
(`/a` et `/a?x=1`, `/docs/` et `/docs/index.html`), et un segment d'URL peut contenir de
quoi sortir du dossier cible (`..`, `%2F`).

**Décision.**
1. Le chemin local est le **chemin relatif à la racine du projet** : sous `http://h/site/`,
   `http://h/site/a/b.zip` donne `a/b.zip`. Hors du préfixe de la racine, on retombe sur le
   chemin absolu de l'URL, élagué de son `/` initial.
2. Une URL de **répertoire** (`…/docs/`) donne `docs/index.html` ; la racine donne
   `index.html`.
3. Chaque segment est décodé puis **assaini** par `sanitizeFileName` (mêmes règles que le nom
   final, `D-037`) : un `..` ne peut pas remonter. Vérifié par test (`../../etc/passwd`).
4. La requête (`?…`) ne fait pas partie du chemin : **collision** détectée, le premier arrivé
   garde le chemin, les suivants reçoivent `-2`, `-3`… avant l'extension. Aucun écrasement
   silencieux.
5. `empty.html` est écrit **sans écraser** (`flag: 'wx'`), contenu exact
   `<HTML><BODY> </BODY></HTML>`. Un fichier existant appartient à l'utilisateur.
6. Une entrée retenue devient une **tâche ordinaire** de la file (`EX-B-10`) : même schéma,
   mêmes états, mêmes exigences `EX-A-*` que les tâches créées à la main. Aucun chemin
   parallèle de téléchargement n'existe.

**Conséquence.** `EX-B-01`, `EX-B-06`, `EX-B-10`, `EX-B-11`, `EX-B-12` passent au vert ;
**domaine B clos (13/13)**, **97 tests**.

### D-043 — L'aspiration s'exécute **par la file**, avec les mêmes états que le moteur
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-23`

**Contexte.** Après `WP-11`, le grabber produisait un plan (projet + file) mais rien ne
l'exécutait : il manquait le lien entre « tâche `PENDING` » et « fichier sur disque ».

**Décision.** `src/grab-runner.js` exécute une file sans dupliquer de logique :
1. **respect strict des états** : `PENDING → ACTIVE → VERIFYING → DONE`; une tâche ne passe
   jamais directement de `ACTIVE` à `DONE` (leçon de `T-A-05`, `D-036`) ;
2. **une tâche en échec n'arrête pas les autres** : `ACTIVE → FAILED` avec le message, la
   file continue ; `FAILED → PENDING` reste possible pour une reprise manuelle ;
3. **concurrence bornée** par `maxActive` (défaut 8, `EX-A-07`) : le runner n'ouvre jamais
   plus de tâches actives que la file ne l'autorise ;
4. **le dossier cible est créé** avant la promotion : l'arborescence d'un site est profonde
   (`rootDir/a/b/c.zip`) et `rename` échoue dans un dossier absent ;
5. **seules les pages sont explorées** : `isPageUrl` distingue une page (extension HTML, ou
   pas d'extension, ou barre finale) d'un fichier à télécharger — sinon chaque `.zip` serait
   « visité » comme une page, une requête gaspillée par fichier ;
6. **persistance en fin d'exécution** : projet (`<hôte>.xdmspider.json`) et file (`queue.json`)
   sont réécrits une fois, par les écritures atomiques existantes ; une interruption laisse
   l'état précédent intact.

**Conséquence.** `bin/xdm-grab.js` rend le domaine B utilisable : parcours → arborescence →
file → téléchargements → promotion, en une commande. **106 tests.**

### D-044 — Aspiration **reprenable** et **scriptable** : `--reprendre`, `--sortie json`
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-23` (suite)

**Contexte.** `xdm-grab` ne savait faire qu'un parcours complet : relancer une aspiration
interrompue obligeait à tout re-parcourir, et lire le résultat depuis un script demandait
d'analyser des lignes de texte.

**Décision.**
1. **`--reprendre`** : le couple projet (`<hôte>.xdmspider.json`) + file (`queue.json`) sur
   disque fait foi ; le parcours n'est **pas** relancé. Rejouer un parcours produirait un
   autre plan et invaliderait les chemins locaux déjà calculés.
2. **Les échecs sont rejouables, les succès non** : `retryFailed` ne remet en `PENDING` que
   les tâches `FAILED` (`FAILED → PENDING`, seule transition arrière autorisée par `D-036`) ;
   une tâche `DONE` garde son fichier promu. Les transitions de `task-queue.js` étant
   **pures**, `retryFailed` renvoie une nouvelle file — le muter en place ne faisait rien.
3. **`--sortie json`** : `stdout` ne contient **que** l'objet (`url`, `directory`, `pages`,
   `retained`, `done`, `failed`, `tasks`) ; la progression part sur `stderr`. Un script peut
   donc rediriger `stdout` sans le polluer.

**Conséquence.** L'aspiration se comporte comme un outil Unix : reprenable, filtrable,
composable. **108 tests** (`T-B-21`, `T-B-22`).

### D-045 — Fiches C et D : **transports** et **médias** séparés, observé ≠ dérivé
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-07` / `A-05`

**Contexte.** Il restait à spécifier ce qui n'est ni le moteur (fiche A) ni le grabber
(fiche B). Deux matières très différentes s'y mélangeaient : les transports (HTTP, FTP,
RTMP, MMS, proxys) et les médias (HLS, DASH, conteneurs).

**Décision.**
1. **Deux fiches, un document** (`analysis/idman/15-spec-protocoles.md`) : C = transports
   (10 exigences), D = médias (10 exigences), avec la même règle de traçabilité que A et B.
2. **Ce qui est mesuré est daté** : 13 classes de transport/média avec leur vtable
   (`HTTPSession 0x2b1dd4`, `CM3UParser 0x2b2720`, `CMp4DashReader 0x2b3408`,
   `CSidxParser 0x2b5aa8`…), 12 balises HLS localisées dans un bloc contigu de `.rdata`.
3. **HLS est observé, DASH est dérivé** : `HLS`, `DASH`, `m3u8`, `MPD`, `SegmentTemplate`
   n'existent **pas** comme chaînes ; ce sont les balises `#EXT-X-*` et les classes
   `CM3UParser`/`CMp4DashReader`/`CSidxParser` qui prouvent le support. Deux hypothèses
   sont ouvertes : `H-18` (RTMP/MMS servent l'enregistrement de flux, pas le grabber) et
   `H-19` (pas de parseur de manifeste DASH — cohérent avec l'absence de parseur XML/HTML,
   `Q-B-01`).
4. **`EX-A-16` n'est pas généralisée** : `Accept-Encoding: identity` vaut pour le moteur de
   morceaux, `gzip, deflate` existe ailleurs dans le binaire. La nuance devient `Q-C-01`
   plutôt qu'une affirmation élargie.

**Conséquence.** `A-05` couvre désormais quatre domaines (A, B, C, D), dont **deux
implémentés** (30 exigences vertes sur 52) et **deux spécifiés seulement** (0/20). Ce qui
reste à lever est comportemental : `A-09` (VM) pour C et D, `WP-26` pour l'implémentation.

### D-046 — Médias : une playlist HLS est **une liste de fichiers**, pas un fichier
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-26` (fiche D)

**Contexte.** La fiche D dit ce qu'IDM reconnaît (12 balises HLS, `CM3UParser`,
`CMp4DashReader`, `CSidxParser`) sans dire comment XDM l'exécute.

**Décision.**
1. **Découpage en tâches ordinaires** : chaque segment est téléchargé par le moteur existant
   (`connection-loop.js` : plages, reprise, promotion). Aucun second moteur, aucune
   parallélisation des segments — l'ordre de la playlist est la seule vérité.
2. **`#EXT-X-BYTERANGE` passe par `openSegment`** : un segment peut être une plage d'un
   fichier plus gros ; c'est le seul endroit où le code de flux n'appelle pas `download()`.
3. **Variante par défaut = débit le plus élevé** (`selectVariant`), surchargeable par
   `--qualite` (débit minimal visé). Choix XDM : aucune preuve de la règle d'IDM (`Q-D-04`).
4. **Aucun déchiffrement** : `#EXT-X-KEY` est lu, la clé n'est jamais demandée ; le flux est
   téléchargé tel quel et le résumé porte `encrypted: true` (`D-004`, `EX-D-10`).
5. **L'assemblage est explicite** (`--assembler`) et reste un `cat` : valide pour MPEG-TS,
   sans valeur pour du fMP4 sans son init. Aucun assemblage automatique.
6. **DASH : l'index seulement** : `src/sidx.js` lit une boîte `sidx` (versions 0 et 1) et
   calcule les plages des sous-segments. Le manifeste `MPD` n'est pas analysé — cohérent
   avec `H-19`. Le câblage DASH de bout en bout reste ouvert (`EX-D-08` partielle).

**Conséquence.** Le domaine D passe de 0 à **9 exigences vertes sur 10** ; l'outil
`bin/xdm-media.js` télécharge un flux HLS complet, playlists conservées, segments nommés
`segment-00001.ts`. **128 tests.**

### D-047 — Fiche C, première moitié : **cookies de session** et **reprise conditionnelle**
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-27` (fiche C)

**Contexte.** La fiche C décrivait dix exigences de transport sans qu'aucune ne soit
implémentée. Deux d'entre elles sont utilisables **sans** toucher au moteur : les cookies
(`EX-C-04`) et `If-Range` (`EX-C-03`).

**Décision.**
1. **Cookies RFC 6265, en mémoire** (`src/cookies.js`) : domaine, chemin, `Max-Age`/`Expires`,
   `Secure`. Pas de persistance — une aspiration est une session, et `D-004` interdit de
   stocker des secrets.
2. **Cookie d'hôte vs cookie de domaine** : sans attribut `Domain`, le cookie n'est **jamais**
   envoyé à un sous-domaine (RFC 6265 §5.3). Bug réel trouvé par le test : la première
   version fuyait `sid` vers `autre.example.com`.
3. **`withCookies(transport, jar)`** : enveloppe un transport, enregistre `Set-Cookie` et
   injecte `Cookie`. Le moteur n'en sait rien — aucune signature modifiée.
4. **`If-Range` porte le validateur enregistré dans la carte**, pas celui de la sonde : la
   sonde voit déjà le nouveau fichier et ne pourrait donc rien détecter. Si le validateur de
   la carte diffère de celui du serveur, la carte est **périmée** et le téléchargement repart
   à zéro (`stats.restarts`), sans mélanger deux versions.
5. **Filet de sécurité** : un serveur qui répond `200` à une plage demandée au milieu du
   fichier déclenche un `RESTART` explicite (`EX-C-03`), même sans `ETag`.

**Conséquence.** `EX-C-01`, `EX-C-03`, `EX-C-04` passent au vert ; `EX-C-02` reste partielle
(cookie envoyé, mais `User-Agent`/`Accept`/`Referer` ne sont pas encore paramétrables).

### D-048 — Fiche D, dernier point : **DASH par `sidx`**, sans manifeste
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-26` (fin)

**Contexte.** `EX-D-08` était partielle : l'index `sidx` se lisait (`src/sidx.js`) mais rien
ne s'en servait.

**Décision.**
1. **L'entrée est un fichier, pas un `MPD`** (`H-19`, `D-046`) : on lit les 64 Kio d'en-tête,
   on y trouve `ftyp`/`moov`/`sidx`, et l'index donne les plages exactes.
2. **Init = tout ce qui précède le `sidx`**, sauf si une URL d'initialisation est fournie
   (profil *live* où les deux sont séparés).
3. **Aucune fusion** : init et segments restent côte à côte. Un `moov` fragmenté ne se
   concatène pas comme des MPEG-TS — l'assemblage de `media.js` ne s'applique pas ici.
4. **Refus explicite** : sans `sidx` dans la fenêtre, sans support des plages, ou si un
   segment est incomplet, l'outil **lève** ; il ne produit jamais un fichier d'apparence
   valide.

**Conséquence.** Domaine D **10/10**. `bin/xdm-media.js --dash [--init URL]` rend le mode
utilisable ; **140 tests**.

### D-049 — En-têtes et compression : **deux politiques**, jamais une seule
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-27` (fiche C)

**Contexte.** Le binaire d'IDM porte à la fois `identity` (`0x6b2699`) et
`gzip, deflate` (`0x6b26bc`) : `Q-C-01` demandait de trancher.

**Décision.**
1. **Deux jeux d'en-têtes, pas un compromis** : `buildChunkHeaders` impose `identity`
   (`EX-A-16` : un `Range` sur un corps compressé ne serait pas aligné sur les octets du
   fichier) ; `buildPageHeaders` annonce `gzip, deflate` (`EX-C-05`).
2. **`fetchText` décompresse** (`decodeBody` : gzip, deflate, brotli) et retourne
   `encoding`. En cas d'en-tête menteur, il rend les octets tels quels : mieux vaut un texte
   bizarre qu'une exception sur un serveur mal configuré.
3. **L'agent s'annonce** : `XDM/1.0 (+grabber)`, jamais « IDM ». Usurper l'agent d'IDM
   serait une contrefaçon d'identité (`D-004`), et ce n'est pas ce qu'on clone.

**Conséquence.** `EX-C-02` et `EX-C-05` au vert ; `Q-C-01` est close —
non pas « l'un ou l'autre », mais **selon la nature de la requête**.

### D-050 — FTP : la séquence **observée**, mode passif obligatoire
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-27` (fiche C)

**Contexte.** L'annexe 15 §2.3 a lu le dialogue instrumental d'IDM : `CWD` → `TYPE I` →
`SIZE` → (`REST`) → `RETR`, `PASV` obligatoire, pas d'`EPSV` ni d'`AUTH TLS`.

**Décision.**
1. **On implémente exactement cette séquence**, dans cet ordre, avec des tests qui
   l'affirment ligne par ligne (`T-C-06`).
2. **Pas de mode actif** : il ferait entrer le serveur chez le client, et la cible ne
   l'utilise pas.
3. **Refus de `PASV` = échec explicite** (`PASV_UNSUPPORTED`, `EX-C-07`) : aucun repli
   silencieux vers un autre mode.
4. **Reprise par `REST`** sur la taille du fichier local, et **contrôle final** de taille :
   un transfert tronqué est signalé (`INCOMPLETE`), jamais promu.

**Conséquence.** `EX-C-06` et `EX-C-07` au vert. Le FTP passe par proxy reste à faire
(`CFTPProxyConnection` dans IDM, `EX-C-09` partielle pour cette famille).

### D-051 — Proxys : **tunnel d'abord**, SOCKS5 avec DNS distant, Digest différé
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-27` (fiche C)

**Contexte.** IDM déclare HTTP/HTTPS/FTP/SOCKS4/SOCKS5, `Proxy-Authorization: Basic` et
`Digest`, et une configuration PAC système. XDM n'a aucun de ces mécanismes.

**Décision.**
1. **Un proxy se compose comme un transport** (`createProxyTransport`) : la forme est celle
   de `http-client.js`, donc `probe`, `openSegment`, `fetchText` et `withCookies`
   fonctionnent sans modification. Aucune couche réseau parallèle.
2. **`CONNECT` pour HTTP/HTTPS** : pour une cible `https:`, TLS est établi **au-dessus** du
   tunnel (`tls.connect` sur la socket du proxy) — le tunnel ne voit que du chiffré.
3. **SOCKS5 avec résolution côté proxy** (`ATYP=3`, nom d'hôte) : c'est ce que fait IDM avec
   `Socks5ProxyDNS`. Envoyer l'IP gaspillerait la propriété (le proxy est souvent le seul à
   pouvoir résoudre le nom).
4. **Basic seulement** ; Digest est explicitement différé (`Q-C-06`) : il demande un
   aller-retour `407` et un nonce, donc un état par proxy.
5. **SOCKS4 non implémenté, refusé net** (`PROXY_UNSUPPORTED`) : approximer un protocole
   qu'on ne teste pas serait pire que de ne pas le proposer.

**Conséquence.** `EX-C-09` et `EX-C-10` au vert (hors FTP-proxy et PAC). `EX-C-08`
(RTMP/MMS) reste le seul point ouvert du domaine C, et il est **hors périmètre**
(`H-18` : ces transports servent l'enregistrement de flux).

### D-052 — Le domaine C se ferme : **Digest**, **FTP derrière proxy**, **PAC**
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-27` (fin)

**Contexte.** Trois points restaient ouverts : l'authentification `Digest` (`Q-C-06`), le
FTP derrière proxy (`CFTPProxyConnection`) et le PAC système (`WinHttpGetProxyForUrl`).

**Décision.**
1. **Digest en un seul aller-retour** : `CONNECT` part en Basic ; si le proxy répond `407`
   avec un défi exploitable, on recalcule (`MD5`, `qop=auth`, `nc=00000001`, `cnonce`
   aléatoire) et on **rejoue une fois**. Jamais de boucle : un second `407` est un échec.
2. **FTP derrière proxy** : le canal de **contrôle** passe par le tunnel (`CONNECT` ou
   SOCKS5), le canal de **données** reste direct — le `PASV` renvoie l'adresse du serveur
   FTP, qu'un proxy `CONNECT` ne peut pas relayer. C'est la limite du protocole, pas un
   raccourci : IDM a la même (`CFTPProxyConnection` ne change que le contrôle).
3. **PAC : un sous-ensemble explicite**, pas un interpréteur JavaScript. Sont acceptés
   `if`/`else if`/`else`/`return`, `&&`, `||`, `!`, `==`, `!=`, `<`, `>`, `<=`, `>=`,
   `host`, `url`, `dnsDomain` et cinq fonctions (`isPlainHostName`, `dnsDomainIs`,
   `localHostOrDomainIs`, `shExpMatch`, `dnsDomainLevels`). Tout le reste
   (`isResolvable`, `myIpAddress`, `new Date()`, expressions régulières…) lève
   `UNSUPPORTED`. Deviner un PAC vaut moins qu'échouer bruyamment : une mauvaise route
   proxy est indiscernable d'une panne réseau.
4. **Les directives PAC sont ordonnées et essayées** (`PROXY a; PROXY b; DIRECT`) ; un
   proxy muet ne condamne pas la requête, et `DIRECT` n'est utilisé que si le PAC le dit.

**Bug réel trouvé par les tests** (non déterministe, donc précieux) : `httpConnectTunnel`
ignorait le troisième argument `head` de l'événement `connect`. Quand le serveur FTP
envoyait son `220` **dans le même paquet** que la réponse `200` du proxy, la salutation
était perdue et le client attendait indéfiniment. Corrigé par `socket.unshift(head)` ;
trois exécutions consécutives du fichier de test confirment la stabilité.

**Conséquence.** `EX-C-09` et `EX-C-10` passent au vert, `Q-C-06` est close. Domaine C :
**9 exigences vertes sur 10**, la dixième (`EX-C-08`, RTMP/MMS) étant **hors périmètre**
(`H-18`). Total : **51 vertes / 52**.

---

### D-053 — La réécriture des liens est un **ajout XDM**, pas un clone
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-24`

**Contexte.** Un site aspiré reste lisible seulement si ses pages pointent vers les fichiers
locaux. IDM, lui, ne le fait pas : `Q-B-01` a établi qu'**aucun parseur HTML** n'est présent
dans `IDMan.exe` (0 référence code aux conteneurs `SPL`/`RL`/`LI2`, annexe 12 §6) — l'outil
livre une arborescence de fichiers, pas un miroir navigable.

**Décision.** La réécriture est implémentée **et optionnelle** (`--reecrire`, `D-053`) :
1. **Ce qui est réécrit** : les attributs d'URL d'un document HTML (`href`, `src`, `action`,
   `poster`, `data`, `srcset`, …) et les `url(...)`/`@import` d'une feuille de style.
2. **Ce qui ne l'est pas** : `<script>`, `<style>`, `<pre>`, `<textarea>` et les commentaires,
   ainsi que toute référence **inconnue** du plan de site — elle est laissée **intacte**.
   Une page ne doit pas devenir fausse sous prétexte de devenir locale.
3. **Forme du lien** : chemin **relatif** entre la page et la cible (`../img/a.png`), `./`
   quand la cible est la page elle-même ; jamais d'URL `file://` (non portable, et un site
   copié sur un serveur resterait faux).
4. **Aucun parseur HTML externe** : la transformation est un balayage de balises, les
   attributs inconnus étant conservés tels quels. Conséquence assumée : un document
   malformé (balise jamais fermée) reste tel quel plutôt que d'être « réparé ».
5. **La page de départ n'est aspirée que si les filtres la retiennent**, et seulement
   lorsqu'une **inclusion** est déclarée : la racine (`/`) n'a pas d'extension, donc les
   exclusions par défaut (`*.html`, …) ne la visent pas — la retenir sans condition
   aspirerait l'accueil d'un site dont l'utilisateur a exclu toutes les pages. Le CLI expose
   donc `--inclure MOTIF` (répétable) et `--sans-exclusions` (vider le masque par défaut),
   les deux nécessaires : l'exclusion l'emporte (`D-032`).

**Mesure de bout en bout** (site local de 3 pages/fichiers, `--sans-exclusions --inclure '*'`) :
4 fichiers aspirés, **5 liens réécrits** — `index.html` pointe vers `style.css`,
`page2.html`, `img/a.png` ; `page2.html` revient à `index.html` ; `style.css` réécrit son
`url()` ; le lien externe et le lien vers une cible **404 non retenue** restent **intacts**.

**Conséquence.** `EX-B-14` est verte (`src/rewrite.js`, `T-B-24`). Cette exigence est marquée
**Décision XDM** : elle n'a **aucun précédent** dans la cible, et la documentation le dit.

---

### D-054 — Planification sans démon : fenêtres recalculées, quotas explicites
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-25`

**Contexte.** IDM planifie (« Start download at », limites horaires). Un démon ou une tâche
planifiée du système serait une dépendance d'exploitation : le programme tournerait même
quand personne ne l'attend.

**Décision.**
1. **Pas de démon, pas de cron, aucun état de veille.** À chaque exécution, la fenêtre est
   recalculée à partir de l'heure **locale** ; hors fenêtre, rien n'est téléchargé, et
   `xdm-grab` sort avec le code **3** (`--planifier « lun-ven 01:00-06:00 »`).
2. **Fenêtres** : `jours heures-heures`, jours = `*`, `lun-ven`, `sam,dim`, `ven-lun`
   (la plage traverse le week-end), heures `00:00`–`23:59`. Une fenêtre qui traverse
   minuit (`22:00-02:00`) appartient au **jour de son début** : lundi 23:00 et mardi 01:30
   sont tous deux « lundi soir ».
3. **Quotas** : octets et/ou nombre de tâches, valables **pour une exécution**. Les tâches
   non retenues ne sont **pas** retirées de la file : elles restent `PENDING` et repartent
   à la prochaine occasion (`startNext(queue, now, accept)`).
4. **Une tâche de taille inconnue n'est jamais budgétée à zéro** : dès qu'un quota d'octets
   est actif, elle est **reportée** avec la raison « taille inconnue ». La deviner à zéro
   reviendrait à dépasser le quota en silence — exactement ce qu'un quota doit empêcher.
5. **Ordre des candidates** : reprise (`PAUSED`) d'abord, puis priorités, puis petite taille
   d'abord ; `DONE` en fin. Un quota serré sert donc le plus grand nombre de fichiers.
6. **Hors fenêtre, le plan est persisté** (projet + file) avant la sortie : l'aspiration est
   *planifiée*, pas perdue ; une exécution ultérieure la reprend sans re-parcourir le site.

**Conséquence.** `EX-B-16` est verte (`src/schedule.js`, `T-B-25`). La planification est un
**choix XDM** : la sémantique exacte des dialogues d'IDM n'a pas été instruite, et cette
fiche ne prétend pas la reproduire.

---

### D-055 — Statuts transitoires : diagnostic, pas de reprise silencieuse
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-31` (début)

**Contexte.** Une sonde qui reçoit `429` ou `503` ne reçoit **aucune taille** : jusqu'ici
l'échec ressortait comme `UNKNOWN_SIZE`, c'est-à-dire « taille inconnue ». C'est un message
faux — le fichier a une taille, le serveur refuse de le servir — et il envoie chercher le
bug au mauvais endroit.

**Décision.**
1. `probe` refuse tout statut autre que `200`/`206` avec `HTTP_STATUS`, en portant le statut,
   `retryable` et `retryAfterMs`. Un `404` reste un `404`, un `429` reste un `429`.
2. **Aucune nouvelle tentative dans le client HTTP.** Rejouer est une décision de la **file**
   (`attempts`, `D-036`), seule à savoir combien de fois elle a déjà échoué. Un client qui
   attendrait 30 s en silence ferait passer un serveur saturé pour un réseau lent. La file
   rejoue donc elle-même (`runQueue({maxAttempts, sleep})`, `--tentatives N`), en repartant
   de la **sonde** — pas d'un morceau, dont la carte serait périmée par un fichier changé
   entre-temps. L'attente n'a lieu que si `delayMs ≤ maxDelayMs` (30 s) : au-delà, on échoue
   plutôt que d'immobiliser une place de connexion. Une erreur **sans statut** (DNS, coupure)
   n'est pas rejouée automatiquement : elle relève de `retryFailed`, à la demande.
3. `src/retry.js` fournit les faits nécessaires : `isRetryableStatus` (`429`, `408`, `500`,
   `502`, `503`, `504`), `parseRetryAfter` (secondes **ou** date HTTP, plafonné à une heure,
   jamais négatif), `retryDelay` (recul exponentiel plafonné, **sans aléa** pour rester
   testable) et `planRetry` (le `Retry-After` du serveur prime sur notre calcul).
4. Une redirection en boucle s'arrête à 10 (`TOO_MANY_REDIRECTS`), une plage hors fichier
   reste un `416` (`ranged: false`), une page `gzip` reste lisible.

**Mesure.** 11 cas dans `test/resilience.test.js`, dont deux de bout en bout : un `503` puis
`200` ⇒ **2 tentatives**, attente respectant `Retry-After: 1` (1 000 ms, `sleep` injecté donc
instantané en test), fichier final correct ; un `404` ⇒ **une seule** requête, échec franc ;
un `503` permanent avec `maxAttempts: 2` ⇒ exactement 2 requêtes.

**Conséquence.** `EX-C-11` est verte et **branchée** (`src/retry.js`, `src/grab-runner.js`,
`bin/xdm-grab.js --tentatives`).

---

### D-056 — La traçabilité est **vérifiée**, pas racontée
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `WP-32` (clos)

**Contexte.** Le projet revendique, depuis le début, que chaque exigence remonte à une
preuve et que chaque exigence verte possède un test. Cette revendication était **rédigée à la
main** dans trois documents (`conformance.md`, `MEMOIRE.md`, `ROADMAP-IDM.md`) : rien ne
signalait une ligne périmée.

**Décision.** `tools/audit-conformance.mjs` (6 contrôles, 0 dépendance) mesure la chaîne :
preuve citable, test cité **existant**, module citant une exigence/décision/annexe, absence
d'exigence fantôme, totaux de section égaux à leurs propres lignes, hypothèse jamais verte.
`test/audit.test.js` le rejoue sur la matrice réelle **et** sur un jeu volontairement fautif :
un audit qui ne trouve rien n'est pas un audit.

**Ce que l'audit a trouvé au premier passage** (et qui n'était pas cosmétique) :
1. le domaine B était annoncé **clos (16/16)** alors que **quatre lignes** (`EX-B-07`→`13`)
   disaient encore « bloqué » ou « à faire » — un chiffre faux dans le document qui fait foi ;
2. `T-B-07` **n'existait pas** : le test de profondeur portait le numéro de son voisin
   (`T-B-08 (suite)`), donc `EX-B-07` était verte sans test ;
3. `EX-C-08` (RTMP/MMS, hors périmètre) citait `T-C-08`, qui n'a jamais existé ;
4. `EX-B-15`, `EX-B-16` et `EX-C-11` citaient un **chemin de code** dans la colonne
   « preuve » : une décision confondue avec un fichier ;
5. `src/report.js` et `bin/xdm-grab.js` ne citaient **aucune** exigence — deux modules dont
   la justification ne vivait que dans une conversation.

**Conséquence.** `docs/specs/revue-clean-room.md` (v1.0) publie la méthode, le résultat
mesuré (**56 exigences, 55 vertes, 0 écart**) et — surtout — ce que l'audit **ne peut pas**
prouver (l'absence de copie), traité séparément en cinq questions de lecture manuelle, et
huit écarts assumés listés exhaustivement.

---

### D-057 — Porte G3 : la coupure réseau est une **reprise**, pas un échec
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : porte G3, sortie de la phase P3

**Contexte.** La porte G3 (« parcours complet sur site local, ≥ 200 pages, fichiers de 1 Ko à
200 Mo, coupures réseau simulées, sans perte ni doublon ») n'avait jamais été exécutée : les
217 tests couvraient des comportements isolés, aucun ne comparait une arborescence entière
au serveur.

**Mesure avant décision.** `tools/gate-g3.mjs` génère le site (contenu déterministe, empreintes
SHA-256), aspire, coupe la **première** requête de plage du plus gros fichier après 16 Kio, et
compare le disque au serveur. Premier passage : `48 terminé(s), 1 échec(s)` — la tâche coupée
était condamnée, puis réparée par une passe de reprise.

**Cause.** `pumpSegment` signalait déjà le dernier octet écrit (`SEGMENT_FAILED` avec
`resumeAt`), mais la boucle ne rattrapait que `IDLE_TIMEOUT` : une coupure franche traversait
les tentatives et remontait jusqu'à la file, qui marquait la tâche `FAILED`. Un incident
réseau transitoire devenait donc un échec définitif **avant** que la reprise interne n'ait
servi à quoi que ce soit.

**Décision.** `SEGMENT_FAILED` est traité comme `IDLE_TIMEOUT` : la plage est rouverte au
dernier octet écrit, dans la limite des `maxAttempts` du morceau. Ce n'est pas une nouveauté
de modèle, c'est la même règle appliquée à la même situation vue de la carte. La reprise de
**tâche** (`retryFailed`, `--reprendre`) reste le filet pour ce qui n'est pas récupérable :
fichier changé (`RESTART`), divergence (`DIVERGENT`), tentatives épuisées.

**Résultat mesuré après correction** — profil de porte (`--pages 200 --max 200M`, 205,0 Mio) :
**401/401 tâches `DONE` en une passe**, 0 doublon, 200 empreintes conformes, aucun résidu de
travail, rapport égal au disque, coupure réellement infligée (**1 105 requêtes**, dont la
requête coupée reprise à l'octet 16 384) ; **13,9 s** en boucle locale. Profil de test
(24 pages, 2,1 Mio) : 0,6 s, rejoué par `T-G3`.

**Deuxième défaut réel — le `Retry-After` de la sonde était jeté.** Le profil saturé
(`--saturer 2`) a montré des reprises attendant un recul exponentiel alors que le serveur
disait `Retry-After: 0` : `probe` transportait `details.retryAfterMs`, mais la file ne lisait
que `details.headers`. `planRetry` accepte désormais `retryAfterMs` et le fait primer ; mesure :
**6,3 s → 0,23 s** sur le même profil, à résultat identique (16 refus `429` absorbés, une passe).

**Troisième défaut, dans le banc cette fois.** Le calcul des octets attendus filtrait les pages
sur `.html` et oubliait l'index `/` (217 o). La porte a **refusé** de déclarer victoire pour
217 o sur 7,4 Mio — c'est le comportement attendu d'une mesure, et la raison pour laquelle le
banc recalcule au lieu de recopier les compteurs du programme.

La coupure tombait d'ailleurs sur la **sonde** (`Range: bytes=0-0`) en mode sans plage : le
banc félicitait une exécution qui n'avait rien éprouvé. Corrigé — la sonde n'est plus coupée.

**Profils mesurés.** ① porte : 200 pages/200 fichiers, 205,0 Mio, coupure absorbée dans la
boucle, **401/401 en une passe**, 13,7 s. ② sans plage : 40 fichiers, 8,2 Mio, coupure non
reprenable dans le fichier ⇒ **2 passes** (la reprise de tâche rattrape). ③ saturé : 8 fichiers,
**16 refus `429`**, 1 passe, 0,23 s.

**Conséquence.** Porte G3 **franchie** (`docs/specs/porte-g3.md`), phase P3 close. La phase
P4 ne garde qu'un lot bloqué (`WP-30`, comparaison avec IDM : exige la VM Windows).

---

### D-058 — La roadmap elle-même est un livrable vérifié
**Statut** : appliquée · **Date** : 2026-10-28 · **Portée** : `docs/ROADMAP-IDM.md` v1.3

**Contexte.** La section « Prochaines actions » datait de la phase P0 et proposait encore de
« créer le gabarit de fiche de spécification » et d'« ouvrir la fiche grabber » — deux lots
clos depuis (`D-041`, `D-042`). Une roadmap qui propose du travail fait n'est pas neutre : elle
envoie un lecteur — ou un agent — refaire ce qui existe.

**Décision.** Le §7 devient un **état des lieux** en trois parties, chacune vérifiable :
1. **Ce qui est fait**, phase par phase, avec la **preuve** (commande, fichier, chapitre) et
   non l'intention ;
2. **Ce qui reste**, avec le **blocage nommé** — quatre lignes bloquées par l'absence de VM
   Windows (`WP-30`, P5, `A-09-bis`, décompilation) et une ligne de questions « sans effet »
   tranchées par décision ;
3. **Ce qu'on ferait si la VM devenait disponible**, dans l'ordre, pour que la reprise ne
   dépende pas d'une conversation perdue.

**Clarification ajoutée.** « Bloqué » ne veut plus dire la même chose des deux côtés : ces
lignes ne bloquent pas **le produit** (il fonctionne et il est mesuré), elles bloquent la
**fidélité prouvée** au-delà de ce qui est lisible dans le binaire. C'est la distinction que le
projet applique depuis `D-041` ; elle est désormais visible au niveau du plan, pas seulement
dans chaque fiche.

**Conséquence.** Roadmap v1.3. Les chiffres du §7.1 sont ceux qui se recalculent :
`node --test` (220), `npm run audit` (56 exigences, 0 écart), `npm run gate` (205,0 Mio),
`node -e "import('./src/index.js')"` (231 exports), 29 `.md` et 0 lien cassé.

---

### D-059 — `robots.txt` : lire la RFC 9309, pas « la première ligne qui parle de nous »
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/crawler.js`, `EX-B-17`

**Contexte.** `parseRobots` existait **en deux exemplaires** dans `src/crawler.js` (lignes 132 et
204) et retenait *toutes* les règles de *tous* les groupes, quel que soit l'agent. Conséquence
mesurable : un `User-agent: XDM\nDisallow:` vide (qui n'interdit rien) n'annulait pas un
`Disallow: /` écrit pour `*`, et un `Allow` de même longueur qu'un `Disallow` perdait. Les motifs
`*` et `$` de la RFC n'étaient pas interprétés du tout.

**Décision.** Le fichier est lu selon la RFC 9309 §2.2, avec trois choix explicités :
1. **groupe applicable seulement** — les groupes nommant notre produit (`XDM`) l'emportent sur
   `*`, et plusieurs groupes homonymes sont **fusionnés** ;
2. **métacaractères** `*` (n'importe quelle suite, y compris `/`) et `$` (ancre de fin), le reste
   littéral ; le motif porte sur `chemin + requête`, jamais sur l'hôte ;
3. **règle la plus longue** ; à longueur égale, **`Allow` gagne**. C'est la RFC, et c'est le sens
   pratique : un administrateur qui écrit les deux veut autoriser l'exception.

**Changement assumé.** Le point 3 **change** le comportement précédent (`Disallow` gagnait à
égalité). C'est noté ici parce qu'un `robots.txt` conçu pour l'ancien comportement serait suivi
différemment — mesuré par `T-B-13` (mis à jour) et `T-B-29`.

**Conséquence.** Un seul `parseRobots`, 13 cas de test (`T-B-29`) : groupe `XDM` prioritaire,
fusion, `*.pdf$` qui n'interdit pas `manuel.pdf.html`, jeton de produit insensible à la version
(`xdm/2.0`), `Crawl-delay`/`Sitemap` lu sans erreur. `EX-B-17` verte.

---

### D-060 — `--exclure` **élague**, `Crawl-delay` est un conseil borné
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/crawler.js`, `bin/xdm-grab.js`, `EX-B-19`, `EX-B-20`

**Contexte.** Deux manques symétriques. (1) `--inclure` existait, `--exclure` non : un utilisateur
ne pouvait pas dire « aspire ce site sauf cette branche ». (2) `Crawl-delay` était **lu et jeté**
(`D-059`) — poliment, mais jeté.

**Mesure avant décision.** `--exclure` a d'abord été branché comme un simple filtre du projet,
c'est-à-dire comme les exclusions par défaut. Le test de bout en bout a montré que la page exclue
**était quand même demandée** (`/prive/b.html`), et que le fichier qu'elle citait entrait dans la
file : un filtre de **téléchargement** n'est pas un filtre de **parcours**.

**Décision.** Deux notions distinctes, nommées :
- **élagage** (`prune`) : les motifs de `--exclure` coupent la branche — le lien n'est ni retenu
  ni demandé, donc rien de ce qu'il cite n'entre dans la file (raison `élagage:<motif>`) ;
- **filtre de téléchargement** : les exclusions **par défaut** (`*.html`, `*.jpg`…) continuent de
  ne trier que les entrées. Les transformer en élagage fermerait l'exploration : c'est le défaut
  par défaut qui rend `--inclure` utile (`D-032`).

Pour `Crawl-delay` : lu pour le **groupe applicable** (même règle que `D-059`), ignoré s'il n'est
pas un nombre fini positif, appliqué **entre deux vagues** — jamais avant la première requête ni
après la dernière. Un délai explicite (`--delai`, décimal accepté) l'emporte **toujours**,
y compris `0` qui l'annule : le site est un conseil, l'utilisateur une consigne.

**Conséquence.** `T-B-31` (délai : 3 s sur site muet à `*`, valeurs absurdes ignorées, attentes
comptées : 2 attentes en série, 1 avec `parallelisme: 2`, `[1500]` pour `1,5`), `T-B-32` (aucune
requête vers la branche élaguée ; le filtre seul laisse la page visitée), `T-C-14` (bout en bout :
`/fichiers/b.txt` absent de la file, motif conservé dans `.xdmspider.json`). `EX-B-19`/`20` vertes.

---

### D-061 — Exploration parallèle **bornée**, mais sortie déterministe
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/crawler.js`, `bin/xdm-grab.js` (`--paralleles`), `EX-B-18`

**Contexte.** `Q-B-05` (« le balayage de la cible est-il parallèle ? ») restera sans réponse : le
moteur d'exploration n'est pas dans `IDMan.exe` (`D-041`). L'exploration XDM était donc
**séquentielle par construction**, ce qui est sûr mais lent sur un site distant.

**Décision.** Le parallélisme devient un **paramètre** (`parallelisme`, défaut `1`) et non un
comportement caché. Le parcours reste **par vagues** : une vague prend au plus N URL dans la file,
les interroge en parallèle, puis absorbe les réponses **dans l'ordre de la file**. L'ordre des
pages, des entrées retenues et des motifs d'exclusion ne dépend donc pas du hasard du réseau.

**Conséquence.** Avec `parallelisme: 3`, pic mesuré ≤ 3 **et** ≥ 2 (le parallélisme sert), et
pages/entrées **identiques et dans le même ordre** qu'en série (`T-B-30`). `RangeError` sous 1.
`--paralleles N` l'expose (défaut `1` : reproductible). `EX-B-18` verte.

---

### D-062 — Cookies persistants : opt-in, datés, `0600` — et utiles même sans l'option
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/cookies.js`, `bin/xdm-grab.js`, `bin/xdm.js`, `EX-C-12`, `EX-C-13`

**Contexte.** Le magasin de cookies (`D-047`) vivait le temps d'un processus. Une aspiration
interrompue puis reprise (`--reprendre`) reperdait donc l'authentification : les pages derrière un
formulaire redevenaient `403`, alors que la file, elle, se reprenait correctement.

**Décision.** `--cookies F` rend la persistance **explicite et optionnelle** :
- **ce qui est écrit** : uniquement les cookies **datés** — un cookie de session n'a pas de date,
  l'écrire serait inventer une durée de vie ;
- **comment** : fichier temporaire dans le même dossier puis `rename` (jamais un fichier à moitié
  réécrit), mode **`0600`** (un cookie est un secret de session), format versionné `{version: 1,
  cookies: […]}` ;
- **à la relecture** : fichier absent ⇒ magasin vide (première exécution, ce n'est pas une erreur) ;
  JSON invalide ou version inconnue ⇒ `CookieError('COOKIE_FILE')`, on ne devine pas ; cookies
  expirés écartés ; entrées incomplètes ignorées une par une.

**Correction trouvée par le test.** Le magasin en mémoire n'était branché **que** si `--cookies`
était présent : sans l'option, un site qui pose un cookie sur sa page d'accueil puis protège un
fichier échouait en `403`. Le magasin sert désormais **toujours** dans l'exécution courante (pages
*et* téléchargements, par le même transport) ; `--cookies` n'ajoute que la persistance. Sans
l'option, rien n'est écrit sur le disque (vérifié).

**Même lot — la CLI de téléchargement honore le schéma.** `bin/xdm.js` ne savait faire que HTTP :
`ftp://` partait dans le moteur HTTP et échouait. Le schéma choisit maintenant le transport
(`http`/`https` → moteur, `ftp` → `src/ftp.js`, donc la séquence observée `CWD`→`TYPE I`→`SIZE`→
`REST`→`RETR`), et tout autre schéma (`mailto:`, `file:`, `data:`) est refusé **avant** tout accès
réseau, avec la liste de ce qui est accepté. Une taille distante inconnue est dite, pas inventée :
`taille distante : inconnue`.

**Conséquence.** `T-C-12` (session exclue, `100600`, cookie expiré non rajeuni, fichier corrompu
rejeté, reprise d'un téléchargement **sans** repasser par la page qui pose le cookie, rien d'écrit
sans option), `T-C-13` (schéma inconnu refusé, séquence FTP réelle, `REST 1000` sur reprise,
fichier final complet). `EX-C-12`/`EX-C-13` vertes.

---

### D-063 — Exactitude et bornes du parcours : `<base href>`, en-têtes, arrêt sur échecs
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/crawler.js`, `bin/xdm-grab.js`, `EX-B-21`, `EX-B-22`, `EX-C-14`

**Contexte.** Trois manques mesurés sur le parcours, chacun d'un genre différent : une règle
HTML ignorée, une option absente, et une enveloppe qui perdait ce qu'elle croyait envoyer.

1. **`<base href>`** : `extractLinks` résolvait *tous* les liens contre l'URL du document. Une
   page qui déclare `<base href="/sous/">` voyait donc ses fichiers relatifs résolus au mauvais
   endroit — 404 en série, ou téléchargement sous une arborescence qui n'existe pas.
2. **En-têtes personnalisés** : aucune option pour envoyer un jeton (`Authorization`) ni un
   `Referer` particulier. Un site derrière une clé d'API était hors de portée.
3. **Site en panne** : six pages à `500` ⇒ six requêtes, sans borne ; le parcours ne s'arrêtait
   que par épuisement de la file ou plafond de pages.

**Défaut trouvé en branchant le point 2 — et il était réel.** Le `fetchPage` par défaut était
`(url) => fetchText(url)` : il **ignorait son second argument**. L'enveloppe de cookies
(`D-062`) croyait donc envoyer la session à chaque page ; elle ne l'envoyait pas — seuls les
* téléchargements* recevaient le cookie. Le test de `D-062` passait parce qu'il reprenait un
téléchargement, jamais une page protégée. Corrigé (`fetchText(url, {headers})`), et prouvé par
`T-C-15` : une page qui exige le cookie posé par l'accueil est servie, et le compteur de refus
de page reste à zéro.

**Décision.**
- `documentBase(html, pageUrl)` : **première** balise `<base href>`, résolue contre la page ;
  base vide, relative invalide ou d'un autre protocole ⇒ on garde l'URL de la page. La balise
  est retirée avant l'extraction : déclarer une base n'est pas citer un fichier.
- `--entete « Nom: valeur »` (répétable) : nom validé comme **jeton HTTP**, valeur sans
  `CR`/`LF`/`NUL` — refus explicite plutôt que nettoyage, parce qu'accepter `\r\n` reviendrait
  à laisser un script fabriquer des en-têtes que l'utilisateur n'a pas demandés. Les en-têtes
  du moteur (`Range`, `If-Range`) restent prioritaires.
- `--arret-erreurs N` : N échecs **consécutifs** arrêtent le parcours (`stopped: 'erreurs'`) ;
  une page lue remet le compteur à zéro, une file vidée donne `'épuisement'`, un plafond de
  pages donne `'plafond'`.

**Conséquence.** `T-B-33`, `T-B-34`, `T-C-15`. Mesures : sans garde-fou **7 requêtes** (racine
+ 6 pages à `500`), avec `maxErrors: 3` **4 requêtes** ; un échec isolé au milieu de pages saines
ne déclenche rien. Sans `--entete`, 2 fichiers refusés en `401` ; avec, 2 téléchargés et 0 page
refusée.

---

### D-064 — `--essai` : un plan sans effet de bord, et un rapport qui dit pourquoi
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm-grab.js`, `src/report.js`, `EX-B-23`, `EX-B-15`

**Contexte.** Deux angles morts du même problème : on ne savait pas **prévisualiser** une
aspiration, et une fois lancée, le rapport ne disait pas **pourquoi** un fichier attendu
manquait. Le rapport décrivait la file (états, échecs, taille), pas le parcours — donc il ne
pouvait pas répondre à « mon `.zip` n'est pas là : exclu, élagué, bloqué par `robots.txt` ou
hors profondeur ? ».

**Décision.**
- `--essai` : parcours + plan, **aucune écriture**. Le dossier cible n'est même pas créé
  (`mkdir` sauté), `empty.html` n'est pas déposé (`emptyHtml: false`), ni projet ni file, aucun
  téléchargement. Code de sortie **0** : un essai réussi n'est pas « hors fenêtre » (code 3).
  Les options qui écrivent (`--rapport`) sont neutralisées et le disent.
- **Diagnostic d'exploration** : `buildReport` accepte le résultat de `crawl()` et produit
  `diagnostics` — pages visitées, fichiers retenus, motif d'arrêt, délai, parallélisme, et les
  **motifs de rejet comptés** (`élagage:…`, `robots.txt`, `hors site`, `hors inclusion`…) avec
  trois exemples chacun. Il vaut `null` quand il n'y a pas eu de parcours (reprise) : aucun
  diagnostic n'est inventé.

**Conséquence.** `T-C-16` (dossier absent après coup, `readdir` ⇒ `ENOENT`, zéro requête de
fichier, JSON consommable) et `T-B-35` (comptage par motif, ordre décroissant, exemples,
section Markdown, CSV toujours importable avec les motifs en commentaires `#`). `EX-B-23`
verte, `EX-B-15` étendue.

---

### D-065 — Plans de site, sous-domaines et reprise pendant l'exploration
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/sitemap.js`, `src/crawler.js`, `EX-B-24`, `EX-B-25`, `EX-B-26`

**Contexte.** Trois manques du parcours, mesurés :

1. **Ce que personne ne cite n'était jamais aspiré.** Un fichier publié uniquement dans un
   `sitemap.xml` (archive, PDF, média) restait invisible : le parcours ne suit que les liens.
   Pire, la directive `Sitemap:` du `robots.txt` était déjà **lue puis jetée** (`D-059`).
2. **Un site sur plusieurs hôtes était tronqué.** `www.exemple.test` liant `cdn.exemple.test`
   s'arrêtait à la frontière d'origine, sans que l'utilisateur puisse rien y changer.
3. **`--tentatives` ne couvrait que les téléchargements.** Un `503` passager pendant
   l'exploration faisait perdre une branche entière, sans reprise, alors que la politique
   existait déjà (`src/retry.js`, `D-055`).

**Décision.**
- **`src/sitemap.js`** : lecture des plans de site sans dépendance XML (on extrait `<loc>`,
  cinq entités prédéfinies, XML réel trop irrégulier pour un analyseur strict), directives
  `Sitemap:` d'un `robots.txt`, index suivi **un seul niveau**, plafonds (`MAX_SITEMAPS = 8`,
  `MAX_SITEMAP_URLS = 5000`), URL hors origine écartées. Un `404` sur `/sitemap.xml` n'est
  **pas** une erreur : c'est l'absence de plan, et le dire ainsi évite un faux échec.
- **Amorces** (`crawl({seeds})`) : les URL trouvées n'ont **aucun privilège** — mêmes filtres,
  même `robots.txt`, même contrôle de site, même plafond. Une amorce **fichier** est retenue
  directement (la mettre en file l'aurait « visitée » comme une page sans jamais la
  télécharger) ; une amorce **page** rejoint la file. Une amorce refusée est comptée.
- **`--sous-domaines`** (`sameSiteHost`) : même hôte, hôte et son sous-domaine, ou même parent
  d'au moins deux labels. Opt-in, et **limite nommée** : sans *Public Suffix List*, XDM ne
  distingue pas `a.hote-partage.co.uk` de `b.hote-partage.co.uk` ; l'option est donc un
  élargissement demandé, jamais un défaut.
- **`attempts` dans `crawl`** : la boucle de reprise utilise `isRetryableStatus`/`planRetry`
  — mêmes statuts, même `Retry-After`, même plafond que la file. Une erreur réseau est rejouée
  immédiatement (aucun statut à interpréter). Les reprises sont **comptées** (`retries`).

**Mesures.** `T-C-17` : index de 20 plans ⇒ **8 consultés**, `truncated: true`, `404` signalé,
format inconnu signalé, plafond d'URL à 4 respecté. `T-B-37` : 5 amorces ⇒ 2 retenues, 3
écartées (doublon de départ, tiers, `mailto:`) ; une amorce interdite par `robots.txt` n'est
pas retenue. `T-B-38` : 503 puis 200 ⇒ **0 erreur**, 2 pages, **1 reprise**, attente `2000 ms`
(`Retry-After: 2`) ; sans reprise, l'erreur est remontée. `T-B-36` : `evil-example.test` et
`example.test.autre.test` restent dehors. `T-C-18` : `--sitemap` fait passer de **1 à 2**
fichiers aspirés (l'orphelin du plan est téléchargé, sans doublon pour le fichier cité).

---

### D-066 — Interruption propre et commandes d'usage
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/grab-runner.js`, `bin/xdm-grab.js`, `bin/xdm.js`, `EX-B-27`, `EX-B-28`

**Contexte.** Un `Ctrl-C` sur une aspiration de 205 Mio laissait deux questions sans réponse :
les tâches en cours étaient-elles perdues, et une tâche pouvait-elle rester `ACTIVE` dans la
file (donc jamais reprise) ? Aucun test ne couvrait le signal. Par ailleurs, `xdm-grab --aide`
et `xdm --version` étaient des erreurs d'usage : demander de l'aide commençait par un code 2.

**Décision.**
- **Arrêt coopératif** : `runQueue({shouldStop})` et `crawl({signal})` n'entament **rien de
  nouveau** quand l'interruption est demandée ; ce qui est en vol va au bout (couper une
  écriture en cours laisserait un fichier tronqué pour rien). Projet, file et cookies sont
  sauvegardés, le code de sortie est **130** (convention « tué par SIGINT »), et une **seconde**
  interruption sort immédiatement — un utilisateur ne doit pas être piégé dans une attente.
- **Rien ne reste `ACTIVE`** : c'est l'invariant testé, pas seulement le code de sortie.
- **`--aide`/`-h` et `--version`/`-V`** : répondent sans URL et sans réseau, code **0**, pour
  `xdm-grab` **et** `xdm` ; la version annoncée est celle du paquet (`0.1.0`).

**Mesures.** `T-C-20` : vrai `SIGINT` sur une CLI enfant (4 fichiers, 150 ms chacun, une
connexion) ⇒ code **130**, message d'interruption, file relue avec **0 tâche `ACTIVE`**, des
`PENDING` restantes et `--reprendre` possible. `T-B-39` : interruption au milieu du parcours ⇒
`stopped: 'interrompu'`, **3 requêtes** au total, aucune après le signal. `T-C-21` : `--version`
⇒ `xdm-grab 0.1.0`, code 0 ; `--aide` liste `--sitemap` ; `xdm -h` code 0.

---

### D-067 — Ce qui peut mal tourner pendant une aspiration : arrêt brutal, taille, espace
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/grab-runner.js`, `src/size.js`, `src/diskspace.js`, `src/connection-loop.js`, `EX-B-29`→`EX-B-31`

**Contexte — un défaut réel d'abord.** `D-066` garantit qu'un `Ctrl-C` ne laisse **aucune**
tâche `ACTIVE`. Mais un `SIGKILL`, une coupure de courant ou un plantage n'ont pas cette
politesse : la file sur disque garde alors des tâches `ACTIVE` (ou `VERIFYING`), et plus rien
ne les reprend — `startNext` ne regarde que les `PENDING`, `retryFailed` ne relève que les
`FAILED`. **Le fichier restait inachevé et invisible**, dossier plausible, file cohérente en
apparence. C'est le genre de défaut qu'aucun test ne trouve tant qu'on n'écrit pas celui qui
tue le processus.

**Mesure avant décision.** L'ancien `retryFailed` sur une file `['ACTIVE', 'VERIFYING']` la
rendait **inchangée** : 0 tâche candidate, `runQueue` terminé en 0 requête, code de sortie 0 —
une « reprise » qui ne reprend rien et le dit avec le sourire.

**Décision.**
1. **`recoverOrphans`** relève ces tâches par les transitions **déjà autorisées** par la machine
   à états (`D-036`) : `ACTIVE → PAUSED → PENDING`, `VERIFYING → FAILED → PENDING`, avec
   `startedAt: null` et l'erreur effacée. Aucune transition nouvelle n'est inventée ; ce qui
   change est **qui** décide — la reprise explicite, au lieu d'un processus mort. Le nombre de
   tâches relevées est annoncé, et l'aide précise qu'une reprise suppose qu'aucune autre
   exécution ne travaille dans le dossier.
2. **`--taille-max`** : refus **après la sonde, avant le premier octet écrit**, avec la taille
   réelle et le plafond (`TOO_LARGE`). Les tailles se lisent en unités **binaires** (`K` =
   1 024, comme `humanBytes`) et une unité inconnue est **refusée** : un plafond silencieusement
   à 1 000 au lieu de 1 024 serait un piège.
3. **Espace disque** (`--espace-min`, défaut 64 Mio de réserve) : vérifié **avant la première
   connexion**, sur le plus proche dossier existant (le dossier cible peut ne pas exister
   encore). On lit `bavail × bsize` et non `bfree` : les blocs réservés au superutilisateur ne
   sont pas écrits par un processus ordinaire, les promettre serait mentir. Le refus annonce
   **combien d'octets libérer**, écrit projet et file (l'aspiration est planifiée, pas perdue),
   et sort en code 1. Les fichiers de taille inconnue ne sont **pas** comptés zéro : ils sont
   annoncés à part.

**Mesures.** `T-B-40` : file `ACTIVE`/`VERIFYING` ⇒ 2 tâches relevées, `startedAt` nul, puis
**2 `DONE`** au runner. `T-B-41` : 4 096 o demandés avec plafond 1 000 ⇒ `TOO_LARGE`, **aucun
fichier partiel** ; sous le plafond, 4 096 o écrits ; `--taille-max 2K` ⇒ tâche en échec avec
`fichier trop volumineux`. `T-B-42` : `statfs` factice ⇒ refus **sans aucune requête de
fichier**, file en `PENDING`, `blocked: 'espace'` ; une tâche `DONE` n'est pas recomptée.

---

### D-068 — Vérifier ce qu'on croit avoir aspiré, et le montrer en HTML
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/verify.js`, `bin/xdm-grab.js`, `src/report.js`, `EX-B-32`

**Contexte.** Une aspiration terminée peut être **fausse** sans que rien ne le dise : fichier
supprimé à la main, restauration partielle, écriture tronquée. La file affirme `DONE` — elle
décrit ce qui a été décidé, pas ce qui est sur le disque. Il manquait une commande pour poser
la question, et le rapport manquait d'un format lisible hors d'un terminal.

**Décision.**
- **`--verifier`** compare **file et disque**, sans réseau : `missing` (`DONE` sans fichier),
  `truncated` (taille ≠ annoncée), `partial` (fichier présent, tâche non terminée), `absent`
  (ni fichier ni achèvement — le cas normal d'une aspiration partielle, listé pour que le
  compte soit complet), `unmanaged` (fichiers hors file, avec les fichiers de l'outil exclus :
  `queue.json`, `*.xdmspider.json`, `empty.html`, `*.xdm-part`, `*.xdm-part.json`). Code 1 sur
  écart ; **rien n'est créé ni corrigé** — vérifier une aspiration absente ne doit pas la
  fabriquer (`mkdir` n'est pas appelé avant ce chemin).
- **Rapport HTML** (`--rapport x.html`) : autonome (aucune ressource externe, donc archivable),
  mêmes chiffres que les autres formats, et **tout le texte échappé** — une URL peut contenir
  `"`, `<`, `>`.

**Mesures.** `T-B-43` : file de 4 tâches dont 3 `DONE` ⇒ `ok: 1`, `missing: ['perdu.zip']`,
`truncated: [['sous/b.bin', 3, 2]]`, `absent: ['attente.zip']`, `unmanaged:
['sous/inattendu.txt']` — `empty.html` **n'est pas** signalé ; dossier absent ⇒ `ok_: false` et
l'`ENOENT` est rapporté plutôt que masqué ; la CLI rend `conforms: false` et **ne crée pas** le
dossier vérifié. `T-B-44` : une URL `http://h/?q="<script>alert(1)</script>` et un message
`<b>404</b>` ressortent **échappés**, aucune balise `<script>` dans le document, aucune
ressource externe.

---

### D-069 — Les en-têtes de l'appelant vont partout, ou nulle part
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/headers.js`, `src/connection-loop.js`, `bin/xdm.js`, `bin/xdm-grab.js`, `EX-B-33`

**Contexte.** Une aspiration protégée par un en-tête (jeton `Authorization`, cookie de session,
`X-Api-Key`) avait deux issues, toutes deux mauvaises : soit l'outil ne savait pas l'envoyer
et l'utilisateur contournait le problème par un proxy, soit l'option existait à moitié —
envoyée à la sonde et oubliée sur les plages, ce qui produit un fichier à moitié écrit et un
diagnostic incompréhensible (sonde acceptée, morceaux en `403`).

**Décision.**
1. **`parseHeaderOption`** (`src/headers.js`) est la seule porte d'entrée : `« Nom: valeur »`,
   nom = **jeton RFC 9110**, valeur sans `CR`, `LF` ni `NUL`, refus **explicite** et non
   correction silencieuse. Le refus d'injection d'en-tête est un choix, pas un effet de bord :
   une valeur nettoyée en douce laisserait croire que ce qui a été demandé est ce qui a été
   envoyé. Les deux CLI passent par cette fonction (`bin/xdm-grab.js` y délègue, `bin/xdm.js`
   l'utilise directement) : une seule règle, deux commandes.
2. **`download({headers})`** transmet `callerHeaders` à la **sonde** et à **chaque**
   `openSegment` — jamais à l'un sans l'autre. Les en-têtes du moteur (`Range`,
   `Accept-Encoding`, `If-Range`) gardent la priorité : l'appelant ajoute, il ne remplace pas
   la mécanique de reprise.
3. **`--entete` répétable** dans les deux CLI. Deux en-têtes de même nom : le dernier gagne
   (nom replié en minuscules, comme partout dans le module).

**Mesures.** `T-A-28` : sans en-tête, `HTTP_STATUS` 401 sur la sonde ; avec, 2 requêtes de
données et **toutes** portent `x-secret` ; `T-C-22` : la CLI `xdm.js` écrit le fichier avec
`--entete`, et `--entete 'X: a\r\nY: b'` est refusé.

---

### D-070 — Ne pas retélécharger ce qui n'a pas changé, et le dire
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/http-client.js`, `src/connection-loop.js`, `src/grab-runner.js`, `src/progress.js`, `bin/xdm-grab.js`, `EX-B-34`→`EX-B-36`

**Contexte — trois manques mesurés.**
- Une seconde aspiration du même site **retéléchargeait tout** : 205 Mio pour vérifier qu'un
  fichier n'avait pas bougé.
- `--reprendre` rejouait indéfiniment les mêmes échecs : `retryFailed` ne connaît que l'état,
  pas le nombre d'essais déjà consommés. Sur un site cassé, chaque `--reprendre` relançait
  200 requêtes en échec et le seul signe était un code 1.
- Un fichier de 40 Mio prenait 40 s **en silence** : rien ne distinguait une aspiration qui
  travaille d'une aspiration bloquée.

**Décision.**
1. **`If-Modified-Since`** (`--incremental`) : la date **du fichier local** est envoyée sur la
   sonde. `probe` reconnaît `304` (`{status: 304, notModified: true, size: null}`) et
   `download` s'arrête là : **aucune ouverture, aucune écriture**, retour
   `{size: null, notModified: true, requests: 1}`. La taille n'est pas inventée — un `304` ne
   dit pas la taille, il dit qu'elle n'a pas changé.
2. **Rouvrir ce qui est `DONE`** : avec `--reprendre`, la file sur disque fait foi et les
   tâches terminées seraient ignorées — donc jamais reposées au serveur. `reopenDone`
   (`DONE → PENDING`, seule transition nouvelle de la machine à états) rend la question
   possible, pour les seules tâches dont le fichier est encore sur disque. Sur un parcours
   neuf, ce n'est pas nécessaire : les tâches sont `PENDING` et le fichier local suffit à
   déclencher la condition.
3. **`--tentatives-total`** : `retryFailedCapped` plafonne le **cumul** des essais. Une tâche
   au plafond reste `FAILED` avec son message et est **nommée** : « non rejouée » se dit, au
   lieu de ressembler à une reprise qui n'a rien à faire.
4. **`--progression`** : paliers de 10 %, une ligne par palier et par fichier, via
   `src/progress.js` (module pur, testable sans terminal). Une taille inconnue est annoncée
   **une fois** sans pourcentage inventé (`EX-B-15`). Le rapporteur passe par `log`, donc en
   JSON la progression reste sur `stderr` et `stdout` porte l'objet seul.
5. **`--verifier --sortie json`** : compteurs et **listes de chemins**, pas d'objets de tâche
   entiers. Un script veut `missing: ['b.bin']`, pas la file complète à re-parcourir.

**Mesures.** `T-A-28` (second cas) : `ifModifiedSince` ⇒ `notModified: true`, contenu et
`mtimeMs` **inchangés** ; sans condition, le fichier est réécrit. `T-B-45` : deux aspirations
puis `--reprendre --incremental` ⇒ `failed: 0`, fichier intact, « inchangé » annoncé deux
fois. `T-B-46` : 2 tâches `FAILED` à 3 et 1 essais, plafond 3 ⇒ seule l'essai-1 est rejouée,
l'autre reste `FAILED` avec `HTTP 500` ; la CLI le dit en une ligne + détail. `T-B-47` : 41
appels d'avancement ⇒ **≤ 12 lignes**, dernière à 100 %, taille inconnue ⇒ **1** ligne.
`T-B-48` : `--verifier --sortie json` ⇒ `conforms: false`, `missing: ['b.bin']`, `ok: 1`,
`checked: 2`, y compris via le vrai binaire.

---

### D-071 — La reprise existe : il faut pouvoir la refuser, et refuser une carte étrangère
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/connection-loop.js`, `bin/xdm.js`, `bin/xdm-grab.js`, `src/grab-runner.js`, `EX-A-20`

**Contexte — une hypothèse démentie par la mesure.** J'avais noté qu'« `xdm` ne reprend pas un
fichier interrompu ». Mesure : tuer le processus au milieu d'un fichier de 4 Mio puis relancer
donnait **deux** requêtes et 4 Mio relus. Mais un second essai, avec des morceaux de 4 Kio et
une coupure qui laisse le premier morceau **clos**, montre que la carte est relue et que la
seconde passe ne demande que 61 440 octets. La reprise était donc déjà le comportement par
défaut du moteur (`resume = true`) : c'est la première mesure qui était mal instrumentée — le
`kill` tombait avant la clôture du moindre morceau, et une preuve qui ne mesure rien n'est pas
une preuve.

**Décision.** Ce qui manquait n'est donc pas la reprise, c'est le **contrôle** :
1. **`--sans-reprise`** (les deux CLI) : repartir d'un fichier propre quand la carte ne mérite
   plus confiance (carte tronquée par un disque plein, fichier modifié à la main).
2. **Une carte d'une autre URL n'est jamais recollée.** `loadPartFile` rend aussi l'URL
   d'origine ; si elle diffère de celle demandée, la carte est ignorée. Sans cette garde, deux
   téléchargements successifs vers la même cible se recollent **silencieusement** dès que le
   serveur ne fournit ni `ETag` ni `Last-Modified` — et le fichier livré est un hybride.
3. **La raison du refus est dite** : `resumeDropped: 'url' | 'taille' | 'validateur'`, rendue
   par `download` et annoncée par la CLI (« reprise ignorée (carte d'une autre URL) : lecture
   complète »). Une reprise refusée sans raison ressemble à une reprise qui n'a rien trouvé.

**Mesures.** `T-A-29` : fichier coupé à 4 Kio ⇒ seconde passe **< 32 Kio** demandés pour 32 Kio ;
avec `--sans-reprise`, la totalité est relue. `T-A-30` : carte réécrite avec une autre URL ⇒
`resumeDropped: 'url'`, fichier final identique à la source, aucun morceau de l'autre ressource.

---

### D-072 — Le nom du fichier ne se devine pas toujours dans l'URL
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/promote.js`, `src/http-client.js`, `bin/xdm.js`, `EX-A-21`

**Contexte.** `http://h/download?id=3` produisait `download`, **sans extension** : un fichier
qu'aucun système n'ouvre d'un double-clic, alors que le serveur avait envoyé
`Content-Disposition: attachment; filename="rapport final.pdf"` — donc avait dit son nom.

**Décision.** `probe` expose `contentDisposition` ; `fileNameFromDisposition` lit l'en-tête
(RFC 6266) : `filename*` (RFC 5987, `charset'langue'valeur` encodée) **avant** `filename`
(forme historique), guillemets et échappements retirés, puis **assainissement habituel**
(composante finale seule, `sanitizeFileName`). Ordre des priorités : `--nom`, puis l'URL si elle
a une extension, puis l'en-tête, puis l'URL. La sonde supplémentaire n'a lieu **que** dans le
troisième cas : une URL qui nomme son fichier ne coûte pas une requête de plus. Un nom qui se
réduit à rien (`.`, `..`) est refusé, pas remplacé par « download » : l'appelant garde le nom
de l'URL, ce qui est visible.

**Mesures.** `T-A-30` : `?id=3` + en-tête ⇒ `rapport final.pdf` ; `archive.tar.gz` garde son nom
malgré un en-tête qui dit `autre.zip` ; `--nom force.zip` l'emporte ; `filename="../../etc/passwd"`
⇒ `passwd` **dans** le dossier, rien en dehors.

---

### D-073 — Une CLI qui ne parle qu'aux humains ne sert qu'à moitié
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm.js`, `EX-A-22`

**Contexte.** `xdm-grab --sortie json` existe depuis `D-044` ; `xdm` n'avait rien. Un script qui
télécharge un fichier et veut sa taille devait analyser `écrit /tmp/x (4096 octets, 3 requêtes)`
— c'est-à-dire lire une phrase française avec une expression régulière.

**Décision.** `--sortie json` rend **un seul objet** sur `stdout`
(`{url, target, size, requests, notModified?, resumeDropped?}`) et déplace **tout le reste** sur
`stderr` : progression, messages, refus de reprise. `JSON.parse(stdout)` doit suffire — c'est la
seule définition testable d'une sortie machine. En mode texte, rien ne change.

**Mesures.** `T-A-31` : `stdout` = **1 ligne**, `JSON.parse` réussit, `size` = 4096, et la
progression est bien sur `stderr` ; vérifié aussi sur le **vrai binaire** (`execFile`).

---

### D-074 — `--proxy` était documenté, pas appliqué ; `--verifier --rapport` n'écrivait rien
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm.js`, `bin/xdm-grab.js`, `src/report.js`, `EX-A-23`, `EX-B-37`

**Contexte — deux options qui mentaient.**
1. `xdm --aide` annonçait `--proxy` « proxy HTTP pour le transfert ». Le code ne le passait
   qu'au transport **FTP** : un `xdm <url> --proxy …` téléchargeait en direct, sans un mot. Une
   option documentée et inerte est pire qu'une option absente : elle fait croire à un contrôle
   qui n'existe pas.
2. `xdm-grab … --verifier --rapport r.html` affichait son constat puis **s'arrêtait sans
   écrire** : le retour anticipé du mode vérification court-circuitait la section du rapport.
   Silence total, code 0, aucun fichier.

**Décision.**
1. `--proxy` enveloppe le transport (`createProxyTransport`) et sert donc **à la fois** la
   sonde et les morceaux, puisque le moteur n'a qu'un transport. Le proxy est validé
   (`parseProxyUrl`) **à l'analyse des arguments** : un `--proxy ftp://…` est refusé avant la
   première connexion.
2. Le mode vérification construit un **rapport de vérification** (`buildVerifyReport`) : mêmes
   quatre formats, mêmes fonctions de rendu, mais des lignes qui disent un **état constaté**
   (`MANQUANT`, `TRONQUÉ`, `PARTIEL`, `ABSENT`, `HORS FILE`) et une section de conformité (tâches
   vérifiées, conformes, octets annoncés / sur disque). Seules les **anomalies** sont listées :
   400 lignes « OK » cachent les trois qui comptent.
3. Le format se déduit de l'extension par **une seule** fonction (`reportFormatFor`), et le
   `.htm` est reconnu : l'ancienne expression `\.[ch]tml$` ne correspondait qu'à `.html`, donc
   un `--rapport x.htm` sortait en Markdown sans le dire.

**Mesures.** `T-A-32` : un proxy `CONNECT` local voit passer la connexion, le fichier arrive, et
`--proxy ftp://x` est refusé localement. `T-B-49` : rapport HTML avec `MANQUANT` et `HORS FILE`,
JSON `conforms: false`, CSV, Markdown, et un cas **conforme** dont le rapport ne contient
**aucune** entrée ; `r.htm` ⇒ HTML.

### D-075 — Un flux protégé ne s'ouvrait qu'à moitié : un seul transport, partout
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm-media.js`, `src/media.js`, `src/headers.js`, `EX-D-11`

**Contexte — trois fuites dans la même CLI.**
1. `xdm-media` n'avait **aucune** option d'authentification : ni `--entete`, ni `--cookies`, ni
   `--proxy`. Un flux HLS derrière un jeton ou un tunnel était hors d'atteinte, alors que les
   deux autres CLI savaient le faire depuis `D-062`/`D-069`/`D-074`.
2. Même en passant un en-tête, il n'arrivait pas aux segments : le transport était retenu par
   `fetchToFile` pour les seuls segments portant un `BYTERANGE` explicite, et
   `downloadAndMeasure` — le chemin des segments ordinaires — ne le recevait **pas du tout**.
   Résultat mesuré : `statut 401 pour /seg0.ts` alors que la playlist, elle, passait.
3. Une playlist répondue en `401`/`404` produisait « #EXTM3U attendu » : le message parlait de
   format là où le serveur parlait d'authentification.

**Décision.**
1. **Une** enveloppe partagée `withHeaders(transport, headers)` (`src/headers.js`), qui donne la
   priorité aux en-têtes du moteur (`Range`, `If-Range`, `Accept-Encoding`) : l'appelant ne peut
   pas casser une plage. `xdm-grab` s'en sert aussi — la même règle, une seule fois.
2. Le transport média est **composé une fois** : `withHeaders(proxy ?? défaut, entetes)` puis
   `withCookies(…, jar)`. Il est passé à `downloadMedia`, donc à l'init, à **tous** les segments
   et aux plages, sans exception (§ point 2 ci-dessus corrigé dans `downloadAndMeasure`).
3. Une playlist non-2xx lève `playlist <url> : statut N` — le statut, pas une supposition.

**Mesures.** `T-D-11` en **4 cas** (serveurs locaux) : l'en-tête couvre playlist **et** les deux
segments (refus `401` sans lui) ; le cookie posé **par la playlist** est exigé des seuls segments
et il y arrive ; un segment **sans** `BYTERANGE` reçoit bien le transport (c'était la fuite n° 2) ;
`--proxy` sert playlist et segments, et `--proxy ftp://x` est refusé **localement**, avant tout
réseau.

---

### D-076 — Le cookie que la sonde rapporte doit servir aux morceaux
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm.js`, `EX-A-24`

**Contexte.** `xdm` envoyait déjà un `--entete Cookie: …` si on le lui dictait, mais ne savait pas
retenir ce que le serveur lui donnait : un site qui pose son jeton sur la **sonde** puis l'exige
sur chaque `Range` rendait le téléchargement impossible sans recopier le cookie à la main — et
impossible tout court si le jeton change à chaque session.

**Décision.** `xdm --cookies F` : le magasin (`src/cookies.js`, déjà utilisé par `xdm-grab`,
`D-062`) est relu au départ, **enveloppe le transport** (donc sonde **et** morceaux), et réécrit
à la fin, y compris dans le chemin `304`. Seuls les cookies **datés** sont conservés, fichier en
`0600`, écrit par fichier temporaire puis `rename` : mêmes règles que `xdm-grab`, aucune seconde
politique.

**Mesures.** `T-A-24` : la **première** requête seulement est admise sans jeton ; les quatre
plages suivantes portent `session=ok`, vues côté serveur ; le fichier fait 16 octets et le
magasin relu contient `session`. Sans `--cookies`, les mêmes plages sont refusées `401` — le
défaut n'est pas « magique », il est explicite.

---

### D-077 — Un argument ignoré en silence est un mensonge
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm.js`, `bin/xdm-grab.js`, `bin/xdm-media.js`, `EX-C-15`

**Contexte.** `xdm a.m3u8 dir b.m3u8` téléchargeait `a.m3u8` dans `dir` et **ignorait** `b.m3u8`,
avec un code de sortie 0. Les trois CLI avaient le même défaut. Une faute de frappe dans un
script ne se voyait donc nulle part.

**Décision.** Au-delà du **second** positionnel (`url` puis `dossier`), la CLI refuse :
`trop d'arguments : b.m3u8` puis l'usage, code 1. Le nom du fichier d'arrivée reste ce qu'il
était (`--nom`, `Content-Disposition`, `D-072`) : ce refus ne change rien d'autre.

**Mesures.** `T-A-25` : les trois CLI refusent `['http://h/f', 'dir', 'extra']` avec le message
`trop d'arguments` ; les invocations à deux positionnels continuent de passer (`T-A-31`,
`T-D-03`, `T-B-20` restent verts).

---

### D-078 — Une tâche jamais commencée n'est pas une tâche conforme
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm-grab.js` (`summarize`), `EX-B-38`

**Contexte.** `--verifier --sortie json` publiait cinq listes d'anomalies (`missing`, `truncated`,
`partial`, `unmanaged`, `errors`) et **oubliait** `absent` — la tâche que le disque n'a jamais
vue, c'est-à-dire le cas le plus grave. Le rapport texte, lui, la comptait depuis `D-068`. Un
script qui décidait sur le JSON concluait donc à la conformité d'une aspiration vide.

**Décision.** Le JSON publie les **six** listes, `absent` comprise, avec des **chemins** et non
des objets de tâche (`D-070`). Aucun autre champ ne bouge : le format reste celui que `T-B-47`
a gelé.

**Mesures.** `T-B-50` : une file dont une tâche n'a jamais été téléchargée rend
`absent: ['<chemin>']`, `conforms: false`, et un code de sortie 1.

### D-079 — Les bornes numériques se refusent, elles ne se corrigent pas
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm.js`, `EX-A-25`

**Contexte — trois valeurs absurdes acceptées sans un mot.**
1. `--connexions 0` et `--connexions 200` téléchargeaient normalement : le moteur plafonne à
   128 sockets (`MAX_SOCKETS`) et le dit à personne.
2. `--morceau 20971520` (20 Mio) était accepté alors que l'aide annonce 1–10 Mio : la taille
   était ramenée en silence à la borne haute, ou utilisée telle quelle selon le chemin.
3. `--morceau 100` sur 5 Mio part en **52 429 morceaux** : mesuré à **plus de 400 s** sans un
   seul message. Ce n'est pas un plantage, c'est un transfert qui n'aboutit pas — le pire des
   deux, parce que l'utilisateur attend.

**Décision.**
1. Refus **local** (avant tout réseau) : `--connexions` hors 1..`MAX_SOCKETS`, `--morceau` hors
   1..`MAX_CHUNK_SIZE` (10 485 760 octets). Le message donne la valeur reçue et l'intervalle.
2. Les constantes sont **celles du moteur** (`src/connection-loop.js`, `src/chunk-policy.js`) :
   une seconde table de bornes dans la CLI serait une deuxième vérité.
3. Un découpage qui dépasse **500 morceaux** reste licite — les tests et les petits fichiers
   s'en servent — mais il est **signalé une fois**, dès que la taille totale est connue
   (`avertissement : 5 243 morceaux de 1 000 octets — préférer au moins 1 Mio par morceau`).

**Mesures.** `T-A-33` : les quatre refus, les trois valeurs limites acceptées (1, 128, 1 Mio,
10 Mio) et l'avertissement obtenu sur un vrai serveur (64 Kio découpés en 100 octets).

---

### D-080 — Un fichier qui n'a pas pu être téléchargé n'est pas un succès
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm-grab.js`, `EX-B-39`

**Contexte.** Aspiration de test : 5 fichiers, **3 refusés en `401`**. Le résumé affichait
`failed: 3`, trois lignes `échec http://…`, et le processus sortait en **code 0**. Un script
qui enchaîne (« aspirer, puis archiver ») n'avait aucun moyen de savoir que l'aspiration
était incomplète sans analyser la sortie en français.

**Décision.** Le code de sortie suit le résultat : `1` dès qu'une tâche est `FAILED`, avec le
nombre annoncé et le rappel des deux suites possibles (`--reprendre` rejoue, `--verifier`
nomme). Les codes existants ne bougent pas : `0` succès, `1` écart ou échec, `2` usage,
`3` hors fenêtre de planification, `130` interrompu — et ils sont désormais **écrits dans
l'aide**.

**Mesures.** `T-B-51` (vrai binaire, deux sites) : un fichier en `404` donne `1` et
`1 tâche(s) en échec` ; `--verifier` nomme ensuite `ÉCHEC casse.bin` et sort en `1` ; un site
sans échec sort en `0` — le succès n'est pas devenu une erreur.

---

### D-081 — « Tentée et ratée » n'est pas « pas encore tentée »
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `src/verify.js`, `bin/xdm-grab.js`, `EX-B-40`

**Contexte.** `--verifier` rangeait dans `absent` **deux situations opposées** : la tâche
`PENDING` qu'on n'a jamais essayée (normal après une interruption) et la tâche `FAILED` qui a
échoué trois fois. Seules `missing` et `truncated` comptaient dans `conforms`. Résultat mesuré :
`5 tâche(s), 2 conforme(s)` suivi de « vérification : conforme » et d'un code **0**, alors que
**trois fichiers sur cinq manquaient**. `D-078` venait justement de rendre cette liste visible.

**Décision.** `verifyGrab` compte les `absent` dont l'état est `FAILED` : ce nombre entre dans
`ok_` (donc dans `conforms` et dans le code de sortie) et chaque tâche concernée est nommée
`ÉCHEC … (tâche FAILED : rien écrit sur le disque)`. Une tâche `PENDING` reste **hors** de la
conformité : une file interrompue n'est pas une file fautive.

**Mesures.** `T-B-52` : une file `DONE/FAILED/PENDING` rend `failed: 1` et `ok_: false` ; la
même file sans la tâche en échec rend `ok_: true`.

---

### D-082 — La troisième CLI répond comme les deux autres
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm-media.js`, `src/version.js`, `EX-B-28`

**Contexte.** `xdm-media --aide` sortait en **code 2** (comme une erreur d'usage) et
`xdm-media --version` répondait « option inconnue » en **code 1**, pendant que `xdm` et
`xdm-grab` répondaient en **code 0** sur `stdout`. Trois outils du même paquet, trois réponses
à la même question — et un utilisateur qui commence par `--aide` reçoit une erreur.

**Décision.** `--aide`/`-h` et `--version`/`-V` sont traités **avant** l'analyse des arguments,
comme dans les deux autres CLI : réponse sur `stdout`, code 0, aucun accès réseau. La version
vient d'un module unique (`src/version.js`), exporté par le barillet : trois littéraux dans
trois fichiers finissent toujours par diverger.

**Mesures.** `T-C-21` (étendue) : les trois binaires répondent en 0 (`xdm 0.1.0`,
`xdm-grab 0.1.0`, `xdm-media 0.1.0`), et par appel programmatique `main(['--version'])` rend
un objet, ne lève pas.

---

### D-083 — Un message qui lit un champ inexistant invente un chiffre
**Statut** : appliquée · **Date** : 2026-10-29 · **Portée** : `bin/xdm.js`, `bin/xdm-media.js`, `EX-B-41`

**Contexte.** Après une écriture de magasin, les deux CLI annonçaient
`cookies : /tmp/c.json (undefined cookie(s))`. `saveCookieJar` rend `{path, saved}` ; les CLI
lisaient `saved.count`. Le fichier était correct (1 cookie, vérifié à la main) — seul le
message mentait, c'est-à-dire la seule partie que l'utilisateur lit.

**Décision.** Lire le champ qui existe, et **tester le message** : un compteur faux est un
défaut de même nature qu'un `--proxy` inerte (`D-074`), il se voit simplement moins. Les deux
CLI sont couvertes, parce que le code avait été dupliqué.

**Mesures.** `T-A-34` et `T-D-12` : la ligne annonce `(1 cookie(s))` et ne contient plus
`undefined`, pour `xdm` (cookie posé par la sonde) et pour `xdm-media` (cookie posé par la
playlist).

---

### D-084 — L'interface parle au gestionnaire, jamais au moteur, et n'affiche pas ce qu'elle ne fait pas
**Statut** : appliquée · **Date** : 2026-10-30 · **Portée** : `src/manager.js`, `src/ui-server.js`, `bin/xdm-ui.js`, `WP-51`

**Contexte.** La maquette validée promettait sept écrans. Le moteur sait télécharger, aspirer un
site et vérifier une copie locale ; il ne savait rien de l'**état** de ces travaux : la CLI rend
un objet unique à la fin, puis se termine. Une interface a besoin du contraire — un état qui
survit à un écran, une file qui montre ce qui attend, un historique qui garde les verdicts.

**Décision.** Quatre choix, chacun vérifiable dans le code et les tests :

1. **Trois couches, pas deux.** `src/manager.js` possède l'état (file, journal, historique,
   compteurs), `src/ui-server.js` le traduit en HTTP et en SSE, `bin/xdm-ui.js` ouvre le
   serveur. L'interface ne touche ni au moteur ni au disque. Le jour où Electron remplace le
   navigateur, seule la dernière couche change.
2. **Écoute locale par défaut** (`127.0.0.1`). Une interface qui lance des téléchargements
   arbitraires n'a rien à faire sur un réseau partagé ; `--hote 0.0.0.0` existe pour les
   environnements d'aperçu et affiche un avertissement explicite.
3. **Pas de bouton « pause » menteur.** `connection-loop` n'a pas d'interruption coopérative :
   on peut retirer une tâche **en attente**, pas arrêter un transfert en cours. L'interface ne
   propose donc que ce qui existe, et l'écran File d'attente écrit la limite en toutes lettres.
   La reprise après arrêt du processus reste acquise (fichier `.part`).
4. **On n'affiche pas les écrans non câblés.** Site Grabber et Vérification sont dans la
   maquette, pas dans cette API : ils ne sont pas dans la navigation. Un bouton mort est un
   mensonge plus coûteux qu'un écran absent.

**Mesures.** 27 tests dédiés (`test/manager.test.js`, `test/ui-server.test.js`,
`test/ui-cli.test.js`), dont un **bout en bout** avec le vrai moteur : serveur de test, 256 Kio,
fichier écrit et comparé octet pour octet, historique à `codeSortie 0`. Traçabilité : les
modules citent cette décision (`npm run audit` reste sans écart) plutôt qu'une exigence
inexistante — la fiche de spécification de l'interface reste à écrire (`WP-52`).

---

### D-085 — Les réglages persistent, et l'aspiration a son propre dossier
**Statut** : appliquée · **Date** : 2026-10-30 · **Portée** : `src/reglages.js`, `src/aspiration.js`, `src/verification.js`, `EX-E-03`

**Contexte.** L'interface du lot `WP-51` perdait tout à l'arrêt : dossier, nombre de connexions,
transferts simultanés. Elle ne savait pas non plus aspirer un site ni vérifier une copie locale,
alors que les modules existaient depuis les lots `WP-23`→`WP-25`. Trois problèmes distincts,
une même cause : personne ne possédait ces réglages ni ces travaux.

**Décision.**

1. **Un fichier de réglages validé, pas un sac de valeurs.** `~/.config/xdm/reglages.json`
   (surchargeable par `--reglages`) est relu au démarrage, complété par les défauts, et validé
   champ par champ. Une valeur hors bornes est **refusée** avec le nom du champ : `--actifs 0`
   corrigé en silence en `1` ferait croire à une limite respectée. Un fichier absent n'est pas
   une erreur ; un fichier cassé en est une, sauf si l'appelant a tout précisé en ligne de
   commande.
2. **`robots` n'est pas un réglage.** Il se lit, il ne se désactive pas — ni dans le fichier
   (`ROBOTS_VERROUILLE`), ni par l'API (`D-004`). Le champ existe pour être affiché verrouillé,
   pas pour être coché.
3. **Une aspiration = un dossier.** `<dossier>/aspirations/<hôte>-<horodatage>` contient le
   projet `.xdmspider.json`, la `queue.json` et les fichiers. Deux aspirations dans le même
   dossier écraseraient la même file, et la vérification d'un téléchargement simple lirait une
   file d'aspiration.
4. **La vérification refuse au lieu de rassurer.** Dossier absent (`DOSSIER_ABSENT`), dossier
   sans `queue.json` (`FILE_ABSENTE`), file illisible (`FILE_ILLISIBLE`) : trois refus
   distincts, jamais un rapport vide présenté comme conforme.

**Mesures.** 21 tests ajoutés (`test/reglages.test.js`, `test/verification.test.js`,
`test/aspiration.test.js`, `test/ui-api.test.js`) : persistance relue sur disque, refus de
`robots: false`, dossier créé au démarrage (défaut trouvé en essai réel), aspiration d'un site
témoin avec `robots.txt` respecté, vérification d'un dossier conforme puis tronqué, et
l'enchaînement complet « aspiration → vérification du dossier produit » par l'API.
Domaine **E** ajouté à la matrice (`EX-E-01`→`03`) : l'interface n'est plus seulement tracée
par une décision.

---

## Décisions en attente

### D-017 — Choix du langage/stack de réimplémentation
**Statut** : ✅ **close** — tranchée par `D-034` (Node 22 + ES modules + JSDoc, zéro dépendance),
qui porte la décision et ses raisons ; cette entrée reste comme trace de la question posée.

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
| A-08 | Format d'un filtre | WP-11 | ✅ levée : corps = `IDM_SPIDERFILTER` (16 o : nom, motif, id, actif), persisté en `REG_SZ` sous `IncludeFilters`/`ExcludeFilters` (annexe 13 §2 bis, §4 bis) → `D-032`, `D-033` |
| A-09 | Lever les incertitudes d'exécution en VM Windows (protocole écrit : annexe 16, 6 phases) | WP-07 | 🟡 **protocole prêt**, exécution impossible ici (pas de VM) |
| A-09-bis | Récupérer un vrai `.gsd` sur VM Windows et le dumper | WP-11, WP-30 | ⏳ phase 6 (P4 de l'annexe 16) |
| A-10 | Lire le producteur du corps de filtre et `CArray<IDM_SPIDERFILTER>` | WP-11 | ✅ fait : `0xc2e00` n'est **pas** le producteur (remplissage + templates `CArray` fusionnés) ; structure prouvée par `SetAtGrow` `0xc2bc0` (16 o), saisie `0xc2c10`, sérialisation `0x137f00`, chargement `0x1385f0` ; premier id = **100** (annexe 13 v0.2, `tools/idman_filters.py`) |
| A-07 | Trancher la stack d'implémentation (D-017) avant WP-20 | WP-20+ | ✅ fait : `D-034` — Node 22, ES modules, JSDoc, zéro dépendance, `node --test` |
| A-20 | Écrire les tests de spécification du domaine A | porte G1 | ✅ **79 tests verts** : domaine A **clos** (`T-A-01`→`T-A-19`, `T-A-21`, `T-A-25`→`T-A-27`), domaine B partiel (`T-B-02`→`T-B-05`) |
| A-22 | Client HTTP : `Range`, reprise, redirections, `Accept-Encoding` | `WP-21` | ✅ clos (`D-038`, `D-039`) : 19/19 exigences du domaine A au vert, 73 tests ; la boucle de connexions est livrée dans `src/connection-loop.js` |
| A-21 | Fusion des morceaux de reprise adjacents (suite de `D-035`) | `WP-22` | ✅ clos (`D-040`) : `mergeResumeChunks` recolle les morceaux incomplets adjacents, jamais un morceau clos ; `T-A-27` vert |
| A-05 | Ouvrir les fiches de spécification WP-10 (une par domaine P0) | WP-05+ | 🟢 **4 fiches écrites** : A — moteur (`A-moteur-de-telechargement.md`, 19 exigences, **aucune hypothèse**) et B — grabber (`B-grabber.md`, 13 exigences dont **3 bloquées** par `Q-B-01`). Matrice `docs/specs/conformance.md` (v0.1) : 32 exigences, 3 bloquées, 0 test. Reste : domaines C (transports), D (médias), F (persistance) |
| A-11 | Structure logique d'un enregistrement `ChList` | lecture d'un état IDM existant | ✅ fait : `{ID, startPos, nextID}` = **liste de bornes** ; le morceau est un **intervalle** dans un fichier unique (preuve : aucun modèle `%s%d.tmp`, champ `file` partagé), assemblage = promotion du `.tmp` (annexe 14 §5, §7) → `D-030`, `D-031` ; reste l'encodage binaire exact, sans intérêt (D-024) |
| A-12 | Énumérer les états de `Connection` | spécification de `WP-05` | ✅ fait : 39 états (0..38) en `this+0xa4`, 8 distributeurs, 115 transitions (annexe 14 §4) → `D-027` |
| A-13 | Seuils et modèle d'E/S | valeurs par défaut de `WP-05` | ✅ levée : défaut **8** connexions (`0x0fbe17`), **128** sockets par session, `select` par session (`0x19503c`, `0x1959bd`) avec `délai = écoulé/10` (échéance atteinte) ou `/2`, **plafonné à 12 000 ms** (`0x2ee0`, `0x1958a7`), attente courte de 2–3 s (`0x19505d`) ; **timeout d'inactivité = 30 s** (`0x1e`), **300 s** pour `[conn+0x13c] == 2` (annexe 14 §4.4, §4.5) → `D-028` ; tentatives bornées par le réglage `mAttempts` (défaut non établi) |
| A-14 | Identifier `HTTPConnection::MNSP` | complétude HTTP | ✅ fait : `0x17dc90` = combinaison d'URL via **`InternetCombineUrlA`** (ICU_ENCODE_SPACES_ONLY puis ICU_BROWSER_MODE), tampon ≤ 10 239 o (annexe 14 §8.1) |
| A-15 | Nommer les états 17..27 | complétude de la machine | ✅ fait : libellés tirés des chaînes de statut écrites juste avant l'état (annexe 14 §4.2) |
| A-16 | Taille minimale de morceau | politique de découpage | ✅ clos : table `0x1559e0` (1/2/5 MiB) encadrée à **1–10 MiB** (`0x155bd0`), annexe 14 §5.4 → `D-029`. **Aucun minimum inférieur** : seules autres constantes rondes du bloc = capacité d'un tampon de 2 Kio (`0x155001`) et taille de paquet MMS (`0x15eb9d`) |
