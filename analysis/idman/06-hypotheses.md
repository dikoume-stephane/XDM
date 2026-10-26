# 06 — Hypothèses ouvertes et protocole de vérification

> **Statut** : ✅ v1 · **Dernière revue** : 2026-10-26
> **Règle** : une hypothèse n'entre dans une spécification (`docs/specs/`) qu'une fois
> **confirmée** (preuve ajoutée ici) ou **abandonnée** (statut `réfutée`, avec la preuve).
> Chaque hypothèse indique *comment* la trancher sans ambiguïté.

| ID | Hypothèse | Pourquoi on le croit | Comment trancher | Statut |
|---|---|---|---|---|
| **H-01** | Les 439 noms RTTI correspondent à des vtables dans `.rdata`, donc à des objets instanciables dont on peut retrouver constructeur + méthodes | RTTI activé, `.?AV…@@` complet, `type_info` présent | WP-04 : scanner `.rdata` pour les `Complete Object Locator` (signature `0x00`+RVA), reconstruire `vtable → classe` | 🔎 ouverte |
| **H-02** | Le projet du grabber est stocké **dans le registre** (`GrabberSts\Projects\%ld\%ld\ChList`) et non dans un fichier propriétaire ; « Save project » = export | clés très structurées (annexe 05 §3) | lire les clés sur une VM Windows après création d'un projet ; comparer avec le contenu du dialogue 269 | 🔎 ouverte |
| **H-03** | Le moteur découpe un fichier en **segments de taille fixe** (constante globale) avec N connexions par serveur | `CFilePart`, `CMaxConnNumbers`, `CDownloadLimits`, dialogue 226 | Ghidra : chercher la constante de taille de partie, le seuil de passage en multi-connexion | 🔎 ouverte |
| **H-04** | Le nombre de connexions par serveur par défaut est **8**, et la limite « download limits » porte sur des fichiers/serveurs distincts | dialogue 194 « Download limits exceeded! », `CDownloadLimits` | lire la valeur par défaut dans le code ou sur une installation neuve | 🔎 ouverte |
| **H-05** | `CIDMSpider` construit le plan de site en **BFS par niveau** (profondeur paramétrable), avec `IDMSPIDER_STRUCT_SPL` = « site page list » et `RL`/`LI2` = listes de liens par niveau | noms des structures + `CSpiderWhereToSearchDlg` | Ghidra sur les méthodes de `CIDMSpider` (file d'attente, marquage visited) | 🔎 ouverte |
| **H-06** | `IDMVMPrs.dll`/`idmvs.dll` détectent les vidéos par heuristiques (MIME + taille + motifs de flux) mais **ne déchiffrent aucun DRM** | `application/x-quicktimeplayer`, absence totale de Widevine/PlayReady/FairPlay dans les chaînes | recherche de chaînes DRM dans les modules (non disponibles) ; dynamique sur une page protégée | 🔎 ouverte |
| **H-07** | Pas de HTTP/2 ni HTTP/3 ; TLS via SChannel avec réglages système modifiés par IDM | aucun marqueur `:authority`/`h2`/`quic` ; clés `SCHANNEL\Protocols\TLS 1.3` | Ghidra : chercher l'appel à `SCHANNEL`/`InitializeSecurityContext` ; dynamique : capture réseau | 🔎 ouverte |
| **H-08** | Le grabber enregistre aussi un **fichier** (`.idm`/`.grabber`) en plus du registre pour l'export/import | dialogues 269 « Saving the project », 270 « Load project », `CSavedGrabberProjects` | observer le disque pendant un « Save » sur VM | 🔎 ouverte |
| **H-09** | Les ressources de type nommé `IMAGE` (5) et `PNG` (1) sont des **captures d'écran d'aide** ou des gabarits de barres | type de ressource non standard, taille dans `.rsrc` | extraire les 6 blobs et les ouvrir (annexe 08 §3) | 🔎 ouverte |
| **H-10** | Le protocole `com.tonec.idm` est du JSON `{action, url, referer, cookies}` sur stdin/stdout (format *native messaging* Chrome) | standard Chrome natif + classes `CBrowsersIntegration` | `idmnmcl.dll` absent → à faire sur VM : lancer Chrome, capturer stdin/stdout | 🔎 ouverte |
| **H-11** | La lecture des cookies de navigateurs sert à la **reprise authentifiée**, pas à l'exfiltration | chemins `cookies`+`Local State` + `CPasswordsMap` (identifiants de site) | analyse dynamique du flux réseau après lecture | ⚠ **sensible — non instruite** (voir D-004) |
| **H-12** | Les réglages `SCHANNEL\Protocols` sont écrits pour **activer TLS 1.2/1.3** sur des Windows anciens, pas pour abaisser la sécurité | présence de `TLS 1.3` seule (pas de `SSL 3`/`TLS 1.0` en chaîne) | Ghidra : chercher `RegSetValueExW` sur ces clés + valeur écrite | 🔎 ouverte |
| **H-13** | `Content-Type: application/x-fcs` correspond à un serveur de streaming Flash (`fcs` = Flash Communication Server) et n'a plus d'usage | 3 occurrences isolées | Ghidra : contexte d'utilisation | 🔎 ouverte |
| **H-14** | `idmmkb.dll`, `idmmbc.dll`, `idmfsa.dll` = raccourcis clavier, « browser communication », « file system access » | noms seulement | pas prioritaire ; ignorer tant que rien ne bloque | 🔎 ouverte (basse) |
| **H-15** | `IDMGrHlp.exe` est le **worker d'exploration** du grabber (et non un helper d'installation) | nom « Gr » = Grabber ? ; `CContinueElevatedFSADlg` suggère des privilèges séparés | inspecter ses arguments (chaînes `CreateProcess`), puis l'observer en VM pendant un çonage | 🔎 ouverte (**bloquant pour WP-06**) |

## Protocole général de vérification

1. **Statique (Ghidra)** pour toute hypothèse de structure de données ou de constante
   (H-01, H-03, H-04, H-05, H-12, H-13).
2. **Ressources/offset** pour les hypothèses de contenu (H-02 partiellement, H-09).
3. **Dynamique (VM Windows isolée)** uniquement pour les hypothèses de comportement
   externe (H-02, H-08, H-10, H-11, H-15).
4. Toute hypothèse non tranchée au jalon M3 est **explicitement laissée ouverte** dans la
   spécification, avec la mention « comportement non déterminé ».

## Hypothèses volontairement non instruites

- **H-11** (cookies navigateurs) : le fait est documenté ; l'expérimentation (extraire et
  déchiffrer une base de cookies) ne sera pas menée. Motif : `D-004`.
- Tout ce qui touche à `CRegistration`, `CSignVerifier`, `CHardwareSNs` : **gelé**.
