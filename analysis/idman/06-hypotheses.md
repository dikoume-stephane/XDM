# 06 — Hypothèses ouvertes et protocole de vérification

> **Statut** : ✅ v2 · **Dernière revue** : 2026-10-28
> **Règle** : une hypothèse n'entre dans une spécification (`docs/specs/`) qu'une fois
> **confirmée** (preuve ajoutée ici) ou **abandonnée** (statut `réfutée`, avec la preuve).
> Chaque hypothèse indique *comment* la trancher sans ambiguïté.

| ID | Hypothèse | Pourquoi on le croit | Comment trancher | Statut |
|---|---|---|---|---|
| **H-01** | Les 439 noms RTTI correspondent à des vtables, donc à des objets instanciables dont on peut retrouver les méthodes | RTTI activé, `.?AV…@@` complet | WP-04 : fait — **422/439 classes résolues**, 427 vtables, 13 760 méthodes (annexe 10). 17 classes = bases MFC/ATL sans vtable dans le module | ✅ **confirmée** |
| **H-02** | Le projet du grabber est stocké **dans le registre** | clés très structurées | **vérifié par code** : `0x1bbea0` ouvre/crée/supprime `…\GrabberSts\Projects\%ld\%ld[\ChList]` et y lit/écrit `LocalFileName`/`LocalPath`/`LogFileName` (annexe 12 §1) | ✅ **confirmée** (format de `ChList` encore inconnu) |
| **H-03** | Le moteur découpe un fichier en **segments de taille fixe** (constante globale) avec N connexions par serveur | `CFilePart`, `CMaxConnNumbers`, `CDownloadLimits`, dialogue 226 | **tranchée en statique** : table de tailles en `0x153000`–`0x162000` (147 classes de fichiers, 2 MiB ≤ 512 Mio puis 10 MiB, bornes 1–10 MiB), aucun palier < 1 MiB (annexe 14 §5.4, `chunks.json`, `D-029`, `A-16`) | ✅ **confirmée** |
| **H-04** | Le nombre de connexions par serveur par défaut est **8**, et la limite « download limits » porte sur des fichiers/serveurs distincts | dialogue 194 « Download limits exceeded! », `CDownloadLimits` | **tranchée en statique** : le code écrit `8` en `0x0fbe17` (setter dédié), plafond 128 sockets (annexe 14 §4.4/§6, `A-13`, `D-036`) ; la sémantique fine des « download limits » n'est pas instruite | ✅ **confirmée** (défaut) / hors périmètre (limites) |
| **H-17** | Les filtres du grabber sont des enregistrements **indexés** (identifiant croissant maintenu par `nextFilterID`), pas de simples listes de chaînes | `RegQueryValueExA`/`RegSetValueExA` sur `nextFilterID` dans `GrbFsDlg::OnAddF` (annexe 11 §2) | **tranchée en statique** : enregistrement de 16 o lu/écrit à `+0x4` (motif) et `+0x8` (identifiant), `nextFilterID` en `REG_DWORD` incrémental, premier identifiant **100** (annexe 13 §2–§2 ter, `D-032`, `D-033`, `T-B-02`→`T-B-05`) | ✅ **confirmée** |
| **H-05** | `CIDMSpider` construit le plan de site en **BFS par niveau** (profondeur paramétrable), avec `IDMSPIDER_STRUCT_SPL` = « site page list » et `RL`/`LI2` = listes de liens par niveau | noms des structures + `CSpiderWhereToSearchDlg` | **mesurée puis close** : les conteneurs `SPL`/`RL`/`LI2` ont **0 référence code** dans `IDMan.exe` (annexe 12 §6.2, `grabber.json`) ; le moteur est hors de ce module ⇒ l'exploration devient un **choix XDM** (`D-041`) | ⛔ **hors de portée de ce module** |
| **H-06** | `IDMVMPrs.dll`/`idmvs.dll` détectent les vidéos par heuristiques (MIME + taille + motifs de flux) mais **ne déchiffrent aucun DRM** | `application/x-quicktimeplayer`, absence totale de Widevine/PlayReady/FairPlay dans les chaînes | recherche de chaînes DRM dans les modules (non disponibles) ; dynamique sur une page protégée | 🔎 ouverte |
| **H-07** | Pas de HTTP/2 ni HTTP/3 ; TLS via SChannel avec réglages système modifiés par IDM | aucun marqueur `:authority`/`h2`/`quic` ; clés `SCHANNEL\Protocols\TLS 1.3` | Ghidra : chercher l'appel à `SCHANNEL`/`InitializeSecurityContext` ; dynamique : capture réseau | 🔎 ouverte |
| **H-08** | Le grabber enregistre un **fichier** de projet | dialogues 269/270 | **vérifié** : `GrSh` construit `%sGrabber\\Projects\\` + `%sproject%s.gsd` (annexe 11 §1) | ✅ **confirmée** (format interne encore inconnu) |
| **H-09** | Les ressources de type nommé `IMAGE` (5) et `PNG` (1) sont des **captures d'écran d'aide** ou des gabarits de barres | type de ressource non standard, taille dans `.rsrc` | extraire les 6 blobs et les ouvrir (annexe 08 §3) | 🔎 ouverte |
| **H-10** | Le protocole `com.tonec.idm` est du JSON `{action, url, referer, cookies}` sur stdin/stdout (format *native messaging* Chrome) | standard Chrome natif + classes `CBrowsersIntegration` | `idmnmcl.dll` absent → à faire sur VM : lancer Chrome, capturer stdin/stdout | 🔎 ouverte |
| **H-11** | La lecture des cookies de navigateurs sert à la **reprise authentifiée**, pas à l'exfiltration | chemins `cookies`+`Local State` + `CPasswordsMap` (identifiants de site) | analyse dynamique du flux réseau après lecture | ⚠ **sensible — non instruite** (voir D-004) |
| **H-12** | Les réglages `SCHANNEL\Protocols` sont écrits pour **activer TLS 1.2/1.3** sur des Windows anciens, pas pour abaisser la sécurité | présence de `TLS 1.3` seule (pas de `SSL 3`/`TLS 1.0` en chaîne) | Ghidra : chercher `RegSetValueExW` sur ces clés + valeur écrite | 🔎 ouverte |
| **H-13** | `Content-Type: application/x-fcs` correspond à un serveur de streaming Flash (`fcs` = Flash Communication Server) et n'a plus d'usage | 3 occurrences isolées | Ghidra : contexte d'utilisation | 🔎 ouverte |
| **H-14** | `idmmkb.dll`, `idmmbc.dll`, `idmfsa.dll` = raccourcis clavier, « browser communication », « file system access » | noms seulement | pas prioritaire ; ignorer tant que rien ne bloque | 🔎 ouverte (basse) |
| **H-16** | `Duration`, `nAggrV`, `TPswitch` (noms de valeurs contigus à `ChList`) décrivent des métadonnées multimédia d'un élément | contiguïté en `.rdata` (annexe 12 §2) | décompiler le producteur de ces valeurs | 🔎 ouverte |
| **H-15** | `IDMGrHlp.exe` est le **worker d'exploration** du grabber | nom « Gr » = Grabber ? | **affaiblie** : ses 5 sites de référence pointent vers `CBrowsersIntegrator`/`CDownloaderDlg`, pas vers les classes du grabber (annexe 10 §4). Reste à lire les arguments `CreateProcess` | 🟡 **affaiblie** |

## Protocole général de vérification

1. **Statique** pour toute hypothèse de structure de données ou de constante : désassemblage
   `capstone` guidé par les RVA (outillage `analysis/idman/tools/`, cf. §« Bilan
   d'outillage »), ou décompilation `Ghidra` quand un décompilateur est disponible — ce qui
   n'est pas le cas dans l'environnement de ce dépôt.
2. **Ressources/offset** pour les hypothèses de contenu (H-02 partiellement, H-09).
3. **Dynamique (VM Windows isolée)** uniquement pour les hypothèses de comportement
   externe (H-02, H-08, H-10, H-11, H-15).
4. Toute hypothèse non tranchée au jalon M3 est **explicitement laissée ouverte** dans la
   spécification, avec la mention « comportement non déterminé ».

## Bilan d'outillage : ce que `pefile` + `capstone` tranchent, et ce qu'ils ne tranchent pas

**Constat, mesuré sur ce dépôt.** Avec `pefile` (structure PE, sections, imports, ressources,
RTTI) et `capstone` (désassemblage guidé par RVA, tables de saut MSVC, constantes
immédiates) — sans décompilateur et **sans jamais exécuter la cible** — les **19 exigences du
domaine A** de la fiche A ont toutes été établies, ainsi que 422 classes sur 439, 427 vtables
et 13 760 méthodes (annexe 10) ; `H-01`, `H-02`, `H-03`, `H-04`, `H-08`, `H-17` sont
tranchées. Sur les 17 hypothèses du registre, **10 restent ouvertes ou affaiblies**, dont
**6 relèvent du comportement externe** ou d'un choix de périmètre (`H-06`, `H-10`, `H-11`,
`H-14`, `H-15`, `H-16`).

| Famille de question | Ce que l'outillage donne | Verdict | Exemple dans ce dépôt |
|---|---|---|---|
| Structure de données (champs, tailles, offsets) | lisible dès qu'un champ est accédé avec un déplacement constant (`[esi+8]`) | ✅ **suffisant** | filtre 16 o (`+0x4` motif, `+0x8` id), carte `{ID, startPos, nextID}` |
| Constantes et tables | valeur exacte, table de saut décodée, paliers | ✅ **suffisant** | tailles de morceau 1–10 MiB (147 classes), défaut 8 connexions `0x0fbe17`, 128 sockets, 30 s |
| Protocole réseau | en-têtes et chaînes observés (`Range`, `identity`, `InternetCombineUrlA`) | ✅ **suffisant pour le contrat**, insuffisant pour les cas limites | `EX-A-08`→`EX-A-18` |
| **Algorithme** (crawl, ordonnancement) | un graphe d'instructions sans variables nommées ni structures typées : reconstructible, mais coût prohibitif | ⚠ **insuffisant en pratique** | `Q-B-01` (BFS ? DFS ? files de priorité ?) : `CIDMSpider` n'expose qu'une méthode virtuelle |
| **Pourquoi** une branche plutôt qu'une autre | la condition est lisible, l'**intention** ne l'est pas | ⚠ **insuffisant** | `[conn+0x13c]==2` ⇒ 300 s d'inactivité : le sens du champ reste une hypothèse |
| **Comportement externe** (défauts d'installation, IPC navigateur, format de fichier produit) | rien : ces valeurs ne sont pas dans le code | ❌ **impossible en statique** | `H-10` (native messaging), `Q-B-06` (format `.gsd`), `Q-B-04` (`empty.html`) |

**Conséquence honnête.** « Optimal » n'est pas atteignable avec `pefile` + `capstone` seuls :
le plafond n'est pas la quantité de code analysable, c'est la **nature** de la question. Le
domaine A (moteur) est clos parce qu'il ne demande que des structures, des constantes et un
contrat réseau — trois familles où le désassemblage suffit. Le domaine B (grabber) est bloqué
parce qu'il demande un **algorithme** : la même lecture, à la main, coûterait des milliers
d'instructions pour un résultat incertain.

**Ce qui changerait le verdict**, par ordre de rendement :

1. **Décompilateur** (Ghidra *headless*, hors de cet environnement : son CDN est
   injoignable) sur trois cibles précises — les méthodes non virtuelles de `CIDMSpider`,
   `0x137e00` (`CArray<IDM_SPIDERFILTER>`), `0x1381e0` (initialisation des réglages). Un
   pseudo-code typé rend `Q-B-01`/`Q-B-03` lisibles en minutes là où le désassemblage demande
   des heures.
2. **Observation dynamique en VM Windows isolée** (`A-09`) : la seule voie pour les défauts
   d'installation, le format `.gsd` réel, la trame de *native messaging* et le sens du champ
   `actif`. Aucun outil statique ne la remplace.
3. **Rien** : si le grabber est spécifié comme **produit** (comportement décidé par nous,
   documenté comme écart) plutôt que comme **clone**, `Q-B-01` cesse d'être bloquante. C'est
   un choix de périmètre, pas une limite technique — et le seul qui soit tenable dans cet
   environnement.

## Hypothèses volontairement non instruites

- **H-11** (cookies navigateurs) : le fait est documenté ; l'expérimentation (extraire et
  déchiffrer une base de cookies) ne sera pas menée. Motif : `D-004`.
- Tout ce qui touche à `CRegistration`, `CSignVerifier`, `CHardwareSNs` : **gelé**.
