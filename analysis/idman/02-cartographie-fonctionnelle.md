# 02 — Cartographie fonctionnelle

> **Statut** : ✅ v1 (issue du statique seul) · **Dernière revue** : 2026-10-26
> **Sources** : `triage.json` §rtti, §resources, §rt_string, §protocol_markers,
> §registry_hits ; `EV-local-dialogs` ; `EV-inspect-pe-imports`.
> **Convention** : chaque domaine liste ce qui est **Observé** (existe), ce qui est
> **Dérivé** (rôle probable) et ce qui reste **Hypothèse** (`H-xx`, annexe 06).

---

## Vue d'ensemble

Le binaire se lit comme un produit construit en couches, avec trois sources de
connaissance qui se recoupent :

1. **439 noms RTTI** (390 classes + 49 templates) → le *design objet* (MFC `C…`, mais
   aussi types métier : `CDownload`, `CIDMSpider`, `HTTPSession`, `AMFObject`,
   `RTMPPacket`, `IDMSPIDER_STRUCT_LINK_INFO`…).
2. **105 dialogues + 156 chaînes `RT_STRING` + 2 menus** → le *vocabulaire produit*
   (les libellés décrivent l'intention : « Start Exploring », « Schedule the grabber
   project »…).
3. **Imports + marqueurs de protocole + 124 clés de registre** → les *points de
   contact avec le système* (sockets, shell, navigateurs, registre).

---

## Domaine A — Moteur de téléchargement (priorité **P0**)

| Élément | Preuve | Lecture |
|---|---|---|
| Classes (27) | `CDownload`, `CDownloadQueue`, `CDownloadComponents`, `CDownloadLimits`, `CFilePart`, `CSessionsArray`, `Session`, `CCacheManager`, `CCanceledDownloadsList`, `CProgressItem`, `CDownlProgressDlg3`, `CDownloadCompleteDlg`, `CBatchDownloadDlg`, `CQueueTab`, `CQueuesArray`, `CDownloaderApp`, `DownloaderCmdLine`… | file d'attente, découpage en parties, sessions parallèles, cache |
| Dialogues | 103 « Download progress », 130 « Download File Info », 135 « File Properties », 194 « Download limits exceeded! », 226 « Max. connections number for a server », 303/304 exceptions d'adresse, 307 « Files in the queue », 363 « Download status », 364 « Options on completion » | réglages et états visibles du moteur |
| Imports | `CreateThread`, `VirtualAlloc`, `SetTimer`, `WS2_32` (23 fonctions, delay-load) | concurrence + sockets |
| Chaînes | `Range:`, `Content-Range`, `multipart/byteranges`, `Accept-Ranges`?, `Content-Length` | reprise de téléchargement par plages HTTP |

**Dérivé** : le moteur repose sur des **parties de fichier** (`CFilePart`) écrites en
parallèle dans un fichier temporaire, avec un nombre de connexions par serveur
paramétrable (`CMaxConnNumbers`, dialogue 226) et une limite globale (`CDownloadLimits`).

**Inconnu (→ H-03, H-04)** : politique exacte de découpage (taille de segment, seuil de
passage en multi-connexions), algorithme de reprise après crash, format des fichiers
`.part`/`.tmp`.

---

## Domaine B — Site Grabber (« çonage », priorité **P0**)

| Élément | Preuve | Lecture |
|---|---|---|
| Classes (22) | `CIDMSpider`, `CIDMSpiderDlg`, `CSpiderSettings`, `CSpiderSettingsDlg`, `CSpiderOptionsDlg`, `CSpiderSelectNameDlg`, `CSpiderSelectSaveToDlg`, `CSpiderSiteMapDlg`, `CSpiderWhereToSearchDlg`, `CGrabbersSchedulers`, `CSchedulerOfGrabberProject`, `CScheduleGrabberDlg`, `CLoadGrabberProjectDlg`, `CSavedGrabberProjects`, `CRecentGrabberProjects`, `CCustomGrabberTemplates`, `CGrabberFiltersDlg`, `CGrabberStatsDlg`, `CConfirmGrabberProjectName`, `CSelectGrabberTemplNameDlg`, `CNewSchedulerDlg`, `CSchedulerInfo` | exploration + projets + modèles + filtres + statistiques + planification |
| État persistant | registre `Software\DownloadManager\GrabberSts` (+ `IncludeFilters`, `ExcludeFilters`, `Projects\%ld\%ld\ChList`, `RecentProjects`) — annexe 05 §3 | **Observé** |
| Structures | `IDMSPIDER_STRUCT_LINK_INFO`, `IDMSPIDER_STRUCT_LI2`, `IDMSPIDER_STRUCT_RL`, `IDMSPIDER_STRUCT_SPL`, `IDMSPIDER_STRUCT_RELPARSERINFO`, `IDMGRABBER_PROJECTINFO`, `IDMGRABBER_CUSTOMTEMPLATE`, `IDM_SPIDERFILTER` | modèle de données interne du grabber |
| Dialogues | 239 et 241 « IDM Site Grabber », 262 « Settings of IDM Grabber », 268 « Template Name », 269 « Saving the project of IDM Grabber », 270 « Load project », 271 « IDM Grabber Statistics », 279 « Connecting to the site », 284 « Schedule the grabber project », 244/245 « Filters » | parcours utilisateur complet |
| Chaînes | `IDM Site Grabber` (offset `0x297d40`), `Settings of IDM Grabber`, `Template Name`, `Load project`, `Grabber Statistics`, `Schedule the grabber project`, `Start Exploring`, `Stop Exploring`, `Start Downloading the checked files`, `Add checked files to the main IDM list and to the download queue`, `Hide categories`, `Check All Files` | vocabulaire fonctionnel : explorer → vérifier → télécharger |

**Dérivé** : le grabber est un **explorateur en deux temps** — (1) parcours du site pour
construire un plan (`CSpiderSiteMapDlg`), (2) sélection des fichiers à télécharger
(`Check All Files`/`Uncheck All Files`), avec ré-injection dans la file principale d'IDM.
Les `IDMSPIDER_STRUCT_RL/SPL/LI2` suggèrent des listes de liens, d'URL de pages et de
fichiers par niveau.

**Inconnu (→ H-01, H-02, H-05, H-08)** : algorithme de frontière (BFS/DFS), gestion des
`robots.txt`, profondeur par défaut, format de sauvegarde du projet, sémantique exacte
des filtres (regex ? extensions ? chemins ?).

---

## Domaine C — Transports et proxys (priorité **P0**)

| Élément | Preuve | Lecture |
|---|---|---|
| Classes (28) | `Connection`, `HTTPConnection`, `HTTPSession`, `FTPConnection`, `FTPSession`, `MMSConnection`, `MMSSession`, `RTMPConnection`, `RTMPSession`, `RTMPPacket`, `ProxyConnection`, `CFTPProxyConnection`, `CSocks`, `CInetConnector`, `CIDMProxySettings2`, `CSystemProxySettings2`, `CIDMProxyScript`, `CPersonalProxyScript`, `CLatestPersonalProxyScript`, `CAdvancedProxyConfigDlg`, `CDialUpProcessor`… | 6 familles de transport + proxys (y compris **scripts PAC**) |
| Dialogues | 140 « Proxy / Socks », 185 « Dial Up / VPN », 186 « Dial Up Options », 369 « Advanced proxy settings », 279 « Connecting to the site » | configuration réseau complète |
| Imports | `WS2_32` (sockets), `WININET` (7, cas de bord), `schannel.dll` (chaîne) | TLS probablement via SChannel |
| Chaînes | `Proxy-Authorization`, `Cookie:`, `Set-Cookie`, `Referer`, `User-Agent`, `http://` ×82, `https://` ×54, `ftp://` ×5 | en-têtes manipulés explicitement |

**Dérivé** : moteur réseau **maison sur sockets** (et non WinINet), avec implémentations
HTTP et FTP distinctes, proxys HTTP/SOCKS, scripts PAC, et éventuellement accès
dial-up/VPN.

**Inconnu (→ H-07)** : prise en charge HTTP/2, HTTP/3, QUIC ; comportement TLS détaillé
(versions, SNI, ALPN) ; gestion fine des redirections.

---

## Domaine D — Parsing de liens, formats et médias (priorité **P1**)

| Élément | Preuve | Lecture |
|---|---|---|
| Classes (37) | `CM3UParser` (+ `MasterPlaylist`, `MediaPlaylist`, `MediaSegment`, `MPLVariant`, `decodingState`), `CSidxParser`, `CMp4DashReader`, `CMp4Converter`, `CMp3Format`, `CMpgFormat`, `CAviFormat`, `CWavFormat`, `CZipFormat`, `CGzipDecoder`, `CContentTypeChecker`, `CContentTypesDatabase`, `CFormatParsing`, `CDateParser`, `CHttpDateHeader`, `CLinksInJavaParser`, `CLinksArray`, `CFirstParser`, `CGzipDecoder` | HLS (M3U8), DASH (SIDX/MP4), RTMP/AMF, converters, classification MIME |
| AMF / RTMP | `AMFObject`, `AMFObjectProperty`, `AMF3ClassDefinition`, `AMFPropertiesArray`, `RTMPPacket` | implémentation **AMF0/AMF3** maison → streaming Flash/RTMP |
| Médias TS | `CPMTStream`, `CPMTNetworksPIDs`, `CTSReader`, `CTSAVMixer`, `CTSOutBeffer` | démultiplexage MPEG-TS (PMT/PID) et muxing AV |
| Marqueurs | `EXT-X-` ×12 (offset `0x2b275d`), `.m3u8`, `.mpd`, `sidx` ×2 (`0x1a62a9`), `moov` ×2, `moof`, `rtmp://` ×2, `rtmpe://` (`0x27e250`), `mms://` ×3 | formats réellement traités |
| Dialogues | 196 « Zip preview », 294 « File types », 341 « Add file type », 342/344 « IDM » (convertisseur ?) | classification et prévisualisation |

**Dérivé** : IDM embarque un **lecteur de playlists HLS + DASH segmenté + TS** et un
client **AMF/RTMP**, avec réassemblage des segments en fichier final.

**Inconnu (→ H-06)** : critères de détection « c'est une vidéo » (taille, MIME, durée),
politique de nommage des segments, gestion des DRM (probablement absente).

---

## Domaine E — Intégration navigateurs (priorité **P1**)

| Élément | Preuve | Lecture |
|---|---|---|
| Classes (9) | `CBrowsersIntegration`, `CBrowsersIntegrator`, `CBrowserDetailsDlg`, `CDetectedBrowsersDlg`, `CCheckIEDlg`, `CEditBrowsersDwnlPanelDlg`, `CEditBrowsersMenuDlg`, `CIEContextMenuProcessor`, `CGetAllLinksFromIEDlg` | détection et greffe dans les navigateurs |
| Dialogues | 296 « Browsers integration », 297 « Browser details », 334 « Chrome, Edge, IE », 335 « Firefox and other Mozilla based », 381 « Google Chrome Integration », 489 « Integration into Microsoft Edge browser », 228 « Download All Links with IDM » | un dialogue par famille de navigateurs |
| Registre | `SOFTWARE\Google\Chrome\NativeMessagingHosts\com.tonec.idm`, `…\Microsoft\Edge\…`, `…\Mozilla\…`, `…\CocCoc\…`, `…\Explorer\Browser Helper Objects`, `…\Shell Extensions\Blocked` | hôte de messagerie native + extension + BHO |
| Chaînes navigateurs | chrome 34, mozilla 47, opera 46, edge 31, firefox 31, netscape 11, brave 7, seamonkey 6, vivaldi 4, coccoc 2, palemoon 1, waterfox 1 | couverture produit |
| Modules | `idmnmcl.dll` (native messaging client), `idmmzcc*.xpi` (extension Mozilla), `idmcchandler2*.dll` / `idmbrbtn*.dll` (ponts navigateurs), `IDMNetMon.dll` | architecture d'intégration |

Détail complet : annexe 05.

**Inconnu (→ H-10)** : protocole exact échangé sur le canal de messagerie native
(noms de méthodes, schéma JSON).

---

## Domaine F — Persistance, cookies, sessions (priorité **P1**)

| Élément | Preuve | Lecture |
|---|---|---|
| Classes (13) | `CIDMDatabase`, `CIDMCacheDatabase`, `CDBMainArray`, `CDBIndexArray`, `CDBFileTypeIndexArray`, `CDBSizeIndexArray`, `CDBStatusIndexArray`, `CIDMStringTable`, `CIDMStringDBField`, `CIDMStringsList`, `CIDMWStringsArray`, `CArchiveStream`, `CContentTypesDatabase` | base propriétaire avec index secondaires (statut, taille, type) |
| Sessions web | `CCookieMonster`, `CCookieArray`, `CCookiesChangesTable`, `CSetCookieHeadersArray`, `CPasswordsMap`, `CWebAuthorization`, `CLoginToSiteDlg`, `COptSitesPasswords`, `CNewSiteLogin`, `CAddSiteDlg` | gestion cookies + identifiants de site (comme un navigateur) |
| Import de cookies navigateurs | `%sOpera Software\Opera Stable\cookies`, `%s%sBraveSoftware\Brave-Browser\User Data\Default\Network\cookies`, `…Local State` | lecture directe des bases navigateurs (vol de session ? **vérifier l'usage réel**, `H-11`) |

**Dérivé** : IDM persiste **tout** (file, statuts, tailles, types de fichiers,
statistiques) dans une base propriétaire indexée, et maintient un magasin de cookies
par site pour que les reprises authentifiées fonctionnent.

**Inconnu (→ H-02, H-11)** : format binaire exact de la base, et **finalité** de la
lecture des cookies de navigateurs (reprise authentifiée légitime vs capture de
session). Ce point est **sensible** : à traiter comme une frontière de conformité
(voir `JOURNAL.md` D-004 et annexe 06 H-11).

---

## Domaine G — Planification, files, limites (priorité **P2**)

`CSchedulerInfo`, `CSchedulerOfGrabberProject`, `CNewSchedulerDlg`, `CGrabbersSchedulers`,
`CScheduleTab`, `CQueueTab`, `CQueuesArray`, `CChooseQueueDlg`,
`CEnterNameForNewQueueDlg`, `CSpeedLimiter`, `CSpeedLimiterDlg`, `CLimitMonitor`,
`CLimitsDlg`, `CLimitsExeededDlg`, `CShutDown`, `CExitOnShutdownWindowsDlg`,
`CRebootProgress`, `COptSounds`, `CSoundsSettings` (dialogues 150, 307, 308, 332, 337,
365, 364) → **planification à l'heure**, coupure/démarrage système, arrêt après
téléchargement, faux sonores.

**Dérivé** : le grabber est conçu pour tourner **la nuit / hors ligne** : d'où la
planification, l'option « éteindre le PC », et l'arrêt/reprise automatique.

---

## Domaine H — Interface et shell (priorité **P2**, à ne pas cloner à l'identique)

- 105 dialogues, 3 barres d'outils, 2 menus, 174 bitmaps, 24 groupes d'icônes.
- Classes remarquables : `CIDMListCtrl`, `CIDMStaticControlWithDarkModeSupport`,
  `CListCtrlWithDarkGrid`, `CDropTargetWnd`, `CTrayIconController`,
  `CUserCaptionButton` (fenêtre non standard), `CDHtmlDialog` (UI HTML embarquée).
- Chaînes `RT_STRING` : libellés d'infobulles décrivant chaque commande → **utiles comme
  documentation fonctionnelle** (annexe 08 §4 en donne des extraits).

**Décision rappelée** (`D-007`, `D-015`) : on réutilise ce vocabulaire pour spécifier,
on ne reproduit ni l'apparence ni les ressources graphiques.

---

## Matrice de priorité pour le clonage

| Domaine | Priorité | Justification |
|---|---|---|
| A. Moteur | **P0** | sans lui le grabber est une coquille |
| B. Grabber | **P0** | c'est la fonctionnalité demandée |
| C. Transports | **P0** | dépendance directe du moteur |
| D. Médias | P1 | différenciant mais non bloquant pour « çoner » un site |
| E. Navigateurs | P1 | indispensable en usage réel, contournable en prototype (URL manuelle) |
| F. Persistance | P1 | nécessaire pour projets/reprise |
| G. Planification | P2 | confort |
| H. Interface | P2 | non clonée (D-015) |
