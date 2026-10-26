# 07 — Glossaire

> **Statut** : ✅ v1 · **Dernière revue** : 2026-10-26
> Deux familles : vocabulaire de la **cible** (IDM/Windows) et vocabulaire de la
> **méthode** (REA/Evidence). Les sigles propres à IDM sont marqués 🅸.

## A. Binaire et compilation

| Terme | Définition |
|---|---|
| **PE / PE32** | *Portable Executable* 32 bits : format des `.exe`/`.dll` Windows. |
| **RVA** | *Relative Virtual Address* : adresse relative à l'image base (`0x400000` ici). Conversion fichier : `offset = RVA − VirtualAddress(section) + PointerToRawData(section)`. |
| **Overlay** | Données ajoutées après la dernière section (installeurs, payloads). **Absent** ici. |
| **Entropie** | Mesure d'imprévisibilité des octets (bits/octet). > 7.2 ⇒ souvent compressé/chiffré. Fichier : **6.3884**. |
| **ASLR / DEP** | Randomisation d'adresse / non-exécution de la pile. Actifs (`0x8140`). |
| **CFG** | *Control Flow Guard* : **absent** ici. |
| **`/GS` cookie** | Canari de protection de pile (`0x75a898` ici). |
| **SafeSEH** | Table des gestionnaires d'exceptions légitimes (2 245 entrées ici). |
| **Rich header** | En-tête non documenté de MSVC décrivant les outils/versions utilisés ; non nettoyé ici. |
| **PDB** | Fichier de symboles MSVC. Chemin **livré dans le binaire** : `s:\IDM_projects\IDM_vs2008_2\Release\IDMan.pdb`. |
| **RTTI** | *Run-Time Type Information* : noms de types encodés (`.?AVClasse@@`) conservés ⇒ **439 noms** exploitables. |
| **Vtable** | Table de pointeurs de méthodes virtuelles ; relie une classe RTTI à ses fonctions (à extraire : WP-04). |
| **MFC / ATL** | Bibliothèques C++ Microsoft (fenêtrage / COM). Version `mfcm90` ⇒ VS2008. |
| **Import / delay-import** | Fonctions d'une DLL utilisées, liées au chargement / au premier appel (509 / 111 ici). |
| **Imphash** | Empreinte MD5 de la table d'imports : `ccbcd3b80e9c1172fbf90eb66a5d86f0`. |

## B. Réseau et formats

| Terme | Définition |
|---|---|
| **Range / 206** | En-tête HTTP demandant une plage d'octets ; réponse `206 Partial Content`. Base de la reprise et du multi-connexions. |
| **`multipart/byteranges`** | Réponse unique contenant plusieurs plages. |
| **HLS (M3U8)** | *HTTP Live Streaming* : playlist texte (`#EXTM3U`, `#EXTINF`, `#EXT-X-KEY`…) + segments. |
| **DASH / MPD / SIDX** | *Dynamic Adaptive Streaming* : manifeste XML (`mpd`) + index binaire `sidx` dans les MP4. |
| **fMP4** | MP4 fragmenté (`moof`+`mdat`), utilisé par HLS/DASH. |
| **MPEG-TS / PMT / PID** | Flux transport : paquets de 188 o, table `PMT` décrivant les `PID` de chaque piste. |
| **AMF0 / AMF3** | *Action Message Format* : sérialisation binaire Adobe, utilisée par RTMP. |
| **RTMP / RTMPT / RTMPE** | Streaming Flash : TCP brut / tunnel HTTP / chiffré. |
| **MMS** | *Microsoft Media Server* : streaming Windows Media (obsolète). |
| **PAC** | *Proxy Auto-Config* : script JavaScript choisissant le proxy. |
| **LSP** 🅸 | *Layered Service Provider* : DLL Winsock insérée dans la pile pour observer le trafic (via `sporder.dll`). |
| **Native messaging** | Mécanisme Chrome/Edge/Firefox : une extension parle à un exécutable local via stdin/stdout JSON. Hôte déclaré : `com.tonec.idm`. |
| **BHO** | *Browser Helper Object* : DLL chargée dans Internet Explorer. |

## C. Vocabulaire du produit (IDM)

| Terme | Sens dérivé |
|---|---|
| **Grabber / Site Grabber** 🅸 | Aspirateur de site : explorer, lister, filtrer, télécharger une arborescence. |
| **`GrabberSts`** 🅸 | Nœud de registre où le grabber stocke filtres, projets et état. |
| **`ChList`** 🅸 | Liste « cochée » des fichiers d'un projet de grabber. |
| **Queue / file** | Liste ordonnée de téléchargements, démarrée/arrêtée en bloc. |
| **Part / `CFilePart`** 🅸 | Segment d'un fichier téléchargé en parallèle. |
| **MCN** 🅸 | *Max Connections Number* : connexions simultanées par serveur. |
| **Speed Limiter** 🅸 | Limitation de débit globale. |
| **Trial / Registration** 🅸 | Gestion de licence — **hors périmètre** (D-004). |

## D. Vocabulaire de la méthode

| Terme | Définition |
|---|---|
| **REA** | Outil d'analyse (`rea-agents`) : CLI + serveur MCP, providers par format. |
| **Bundle Evidence** | Résultat normalisé : `evidence_id`, sujet + digest, provider, `normalized_result`, `confidence`, `coverage`, `limitations`. |
| **`confidence`** | `observed` (mesuré) ou `derived` (déduit) — même échelle que nos étiquettes. |
| **`coverage`** | État de complétude d'une analyse (`complete`, éléments omis). |
| **`limitations`** | Ce que l'outil déclare ne pas prouver — **à recopier**, jamais à résumer. |
| **Triage** | Première passe large (en-têtes, imports, ressources, chaînes) avant analyse profonde. |
| **Clean-room** | Réimplémentation à partir d'une spécification de comportement, sans copie de code. |
