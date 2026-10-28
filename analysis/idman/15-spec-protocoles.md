# Annexe 15 — Transports (fiche C) et médias (fiche D)

> **Statut** : 🟡 v1 — **Dernière revue** : 2026-10-28
> **Lot** : `WP-07` (`A-05`, fiches C et D) · **Décisions liées** : `D-004`, `D-041`, `D-045`
> **Preuves** : `cible/IDMan.exe` (SHA-256 `5f78da5a…2f11c9`), `analysis/idman/classes.json`,
> chaînes extraites (`tools/` → `analysis/raw/idman/strings-*.txt`, non versionnées),
> annexes 03 (protocoles et formats), 08 (index des citations), 14 (moteur).
> **Règle** : chaque affirmation porte son statut — **Observé** (lu dans le binaire, avec
> RVA), **Dérivé** (interprétation explicite), **Hypothèse** (non prouvé), **Décision**
> (choix XDM). Aucune exigence `Hypothèse` n'est déclarée conforme.

---

## 1. Ce que la mesure donne

Extraction des chaînes du binaire (20 738 chaînes ASCII ≥ 5 caractères, 1 630 chaînes
UTF-16) puis recherche des marqueurs de protocole. Les compteurs ci-dessous sont des
**occurrences de chaînes**, pas des appels : ils prouvent la présence, pas l'usage.

| Marqueur | Occurrences | Exemple |
|---|---|---|
| `FTP` | 87 | `FTPConnection::TryConnect()` |
| `Proxy` | 78 | `UseHttpProxy`, `FtpProxy`, `Socks5ProxyDNS` |
| `RTMP` | 31 | `Unkerr in RTMPConn ln877`, `RTMPT_Ident` |
| `MMS` | 11 | `Unkerr in MMSS:TrStNCn` |
| `ftp://` | 6 | `idmfcftp://` |
| `rtmp://` / `rtmpt://` / `rtmpe://` | 11 / 2 / 1 | `send rtmp packet` |
| `mms://` | 4 | — |
| `#EXT-X-*` (HLS) | 12 balises | voir §3.1 |
| `sidx` | 2 | `=sidxub` (fragment de chaîne binaire, **non concluant**) |
| `HLS`, `DASH`, `m3u8`, `rtsp` | 0 | absence de chaîne, pas absence de fonction |

L'architecture des transports est lisible dans les RTTI (`classes.json`) : quatre familles
de **sessions**, chacune avec sa **connexion**.

| Classe | Vtable | Méthodes | Famille |
|---|---|---|---|
| `HTTPSession` | `0x2b1dd4` | 4 | HTTP |
| `HTTPConnection` | `0x2b0ae4` | 11 | HTTP |
| `CHttpDateHeader` | `0x2b1ce8` | 1 | HTTP (dates d'en-tête) |
| `FTPSession` | `0x2afcc4` | 4 | FTP |
| `FTPConnection` | `0x2af2b4` | 9 | FTP |
| `CFTPProxyConnection` | `0x2b4af8` | 9 | FTP via proxy |
| `RTMPSession` | `0x2b4524` | 4 | RTMP |
| `RTMPConnection` | `0x2b4e74` | 9 | RTMP |
| `RTMPPacket` | `0x2b44fc` | 1 | RTMP (paquet) |
| `MMSSession` | `0x2b31fc` | 4 | MMS |
| `MMSConnection` | `0x2b4e4c` | 9 | MMS |

Le motif est net : **session (4 méthodes) + connexion (9 ou 11 méthodes)**. Les connexions
FTP, RTMP et MMS ont exactement 9 méthodes ; `HTTPConnection` en a 11 — deux de plus, ce
qui est cohérent avec `PASV`/`REST` d'un côté et redirections/cookies de l'autre (Dérivé).

---

## 2. Fiche C — transports

### 2.1 HTTP/1.1, un seul protocole de niveau application

**Observé.** Toutes les lignes de requête du binaire sont en `HTTP/1.1` :
`%s %s HTTP/1.1` (`0x6b26f0` env.), `CONNECT %s:%ld HTTP/1.1`. Aucune occurrence de
`HTTP/2`, `QUIC` ou `WebSocket`. **Dérivé** : IDM 6.42 ne parle qu'HTTP/1.1 ; le
multiplexage se fait par connexions parallèles, pas par flux.

**En-têtes demandés** (chaînes de format présentes) : `User-Agent: %s`, `Accept: %s`,
`Referer: %s`, `Accept-Encoding` (trois variantes contiguës en `.rdata` : `identity` à
`0x6b2699`, une forme vide, et `gzip, deflate` à `0x6b26bc`), `Cookie`, `Content-Length: %d`,
`Content-Type: %s`.

**En-têtes lus** : `Content-Length`, `Content-Range` (`0x6b1e24`), `If-Range` (`0x6b8018`),
`Location` (et le message `Error during HTTPConnection::setNewLocation()`),
`Set-Cookie:` (`0x6b2958`), `ETag:` (`0x6b1e34`), `Last-Modified:` (`0x6b2910`),
`WWW-Authenticate:` (une occurrence : l'authentification serveur existe, sa mise en œuvre
n'est pas décrite ici).

**Nuance à ne pas perdre.** `identity` et `gzip, deflate` coexistent : notre exigence
`EX-A-16` (« `Accept-Encoding: identity` ») reste vraie **pour le moteur de morceaux**
(annexe 14 §8), mais elle ne peut pas être généralisée à toutes les requêtes du produit.
C'est l'objet de `Q-C-01`.

### 2.2 Reprise et cohérence

**Observé.** `REST %I64d%s` (`0x6b03bc`) pour FTP ; `Range`/`Content-Range`/`If-Range` pour
HTTP. `If-Range` n'existe que pour la reprise conditionnelle : envoyer un `Range` sans
`If-Range` sur une ressource modifiée produit un fichier mélangé — c'est précisément le
risque que `D-025` (empreinte de divergence) traite côté XDM.

### 2.3 FTP

**Observé.** Dialogue de commandes complet et instrumenté (`SIZE OK/failed`, `REST OK`,
`PASV OK, extracting address...`, `LIST OK`, `RETR failed.`, `TYPE I`, `NOOP`) :
`TYPE I%sNOOP%s` et `CWD %s%sTYPE I%s` montrent une séquence figée
`CWD` → `TYPE I` → (`NOOP`). Le mode passif est **obligatoire** dans au moins un cas :
`Cannot open data connection because ftp server does not support PASV command`. Aucune
trace de `EPSV`, `MLSD`, `AUTH TLS`, `PBSZ`, `PROT` : le FTPS explicite n'apparaît pas.

**Dérivé.** `CFTPProxyConnection` (9 méthodes, vtable `0x2b4af8`) duplique la connexion FTP
pour passer par un proxy : un `FTPConnection` et un `CFTPProxyConnection` par session.

### 2.4 RTMP et MMS

**Observé.** `rtmp://`, `rtmpt://` (RTMP sur HTTP), `rtmpe://`, `mms://` ; journaux
`send rtmp header`, `send rtmp packet`, `Sending RTMPT ident`, `RTMPT_Ident_s2`. Les
classes `RTMPPacket`, `RTMPConnection`, `RTMPSession`, `MMSConnection`, `MMSSession`
existent. **Hypothèse `H-12`** : ces transports servent l'enregistrement de flux, pas le
Site Grabber ; rien dans les chaînes ne les relie au grabber.

### 2.5 Proxys

**Observé.** `SOCKS `, `SOCKS4 `, `SOCKS5 `, `sending socks5 CONNECT`,
`Socks5ProxyDNS` (résolution DNS côté proxy), `UseHttpProxy`/`HttpProxy`,
`UseHttpsProxy`/`HttpsProxy`, `UseFtpProxy`/`FtpProxy`, `Proxy-Authorization: Basic %s` et
`Proxy-Authorization: Digest username=…`, `WinHttpGetProxyForUrl` (PAC système) et les
fichiers `%sproxy.pac` / `%sp_proxy%ld.pac`. **Dérivé** : quatre types de proxy
(HTTP, HTTPS, FTP, SOCKS 4/5), authentification Basic ou Digest, configuration manuelle ou
PAC auto-configuré.

### 2.6 Exigences du domaine C

| Id | Exigence | Niveau | Preuve | Test prévu |
|---|---|---|---|---|
| `EX-C-01` | HTTP/1.1 uniquement, pas de HTTP/2 ni WebSocket | Observé | §2.1 | `T-C-01` |
| `EX-C-02` | en-têtes de requête : `User-Agent`, `Accept`, `Referer`, `Cookie` | Observé | §2.1 | `T-C-02` |
| `EX-C-03` | reprise conditionnelle par `If-Range` + `Content-Range` | Observé | §2.2, `0x6b8018` | `T-C-03` |
| `EX-C-04` | `Cookie` reçu (`Set-Cookie`) renvoyé sur la même session | Observé (chaînes) / Dérivé (portée) | §2.1 | `T-C-04` |
| `EX-C-05` | compression acceptée (`gzip, deflate`) sur les requêtes non-morceau | Observé | §2.1, `0x6b26bc` | `T-C-05` |
| `EX-C-06` | FTP : `CWD` → `TYPE I` → `SIZE` → `REST` → `RETR`, mode passif | Observé | §2.3 | `T-C-06` |
| `EX-C-07` | FTP : échec explicite si le serveur refuse `PASV` | Observé | §2.3 | `T-C-07` |
| `EX-C-08` | RTMP/RTMPT/MMS : transports présents, hors grabber | Observé + Hypothèse `H-12` | §2.4 | `T-C-08` |
| `EX-C-09` | proxys HTTP/HTTPS/FTP/SOCKS4/SOCKS5, PAC système | Observé | §2.5 | `T-C-09` |
| `EX-C-10` | authentification proxy Basic ou Digest | Observé | §2.5 | `T-C-10` |

**Couverture : 0 / 10.** Ce domaine est **spécifié, non implémenté** : XDM n'a aujourd'hui
que HTTP/1.1 sans proxy (`src/http-client.js`). Les tests `T-C-*` relèvent de `WP-26` et
d'un lot « transports » non planifié.

---

## 3. Fiche D — médias

### 3.1 HLS : observé, et de première main

`CM3UParser` (vtable `0x2b2720`) porte cinq classes internes (`MediaSegment`,
`MediaPlaylist`, `MasterPlaylist`, `MPLVariant`, `decodingState`) — la structure même d'un
analyseur HLS. Les balises reconnues sont dans un **bloc contigu de `.rdata`**
(`0x6b275c`–`0x6b284c`), ce qui trahit une table de comparaison :

| Balise | RVA | Ce qu'elle implique |
|---|---|---|
| `#EXTM3U` | `0x6b2790` | format identifié |
| `#EXT-X-STREAM-INF:` | `0x6b275c` | variantes de débit (`MasterPlaylist`) |
| `#EXT-X-MEDIA:` | `0x6b2770` | pistes audio/sous-titres alternatives |
| `#EXT-X-VERSION:` | `0x6b2780` | version de playlist |
| `#EXT-X-DISCONTINUITY` | `0x6b2798` | ruptures de timeline |
| `#EXT-X-MAP:` | `0x6b27c8` | segment d'initialisation (fMP4) |
| `#EXTINF:` | `0x6b27d4` | durée de segment |
| `#EXT-X-BYTERANGE:` | `0x6b27f8` | segments dans un même fichier |
| `#EXT-X-PROGRAM-DATE-TIME:` | `0x6b280c` | horodatage absolu |
| `#EXT-X-KEY:` | `0x6b2828` | chiffrement annoncé |
| `#EXT-X-PLAYLIST-TYPE:` | `0x6b2834` | VOD ou événement |
| `#EXT-X-MEDIA-SEQUENCE:` | `0x6b284c` | direct (fenêtre glissante) |

Le type MIME `application/vnd.apple.mpegurl` (`0x6b2f48`) sert de critère de capture.
**Dérivé** : IDM télécharge le flux HLS **segment par segment** (chaque segment est une
tâche), reconstruit la playlist locale, et gère les variantes ; la présence de
`#EXT-X-MEDIA-SEQUENCE` indique un support du direct.

### 3.2 DASH : dérivé, pas observé

`CMp4DashReader` (vtable `0x2b3408`), `CSidxParser` (vtable `0x2b5aa8`) et la chaîne
`-tmp_dashinit` (`0x6b3100`) montrent la lecture de **MP4 fragmenté** (boîte `sidx` =
index de segments) et l'écriture d'un fichier d'initialisation temporaire. En revanche :
**aucune chaîne `MPD`, `SegmentTemplate`, `Representation` ou `BaseURL`**. `sidx` n'existe
que comme fragment de chaîne (`=sidxub`), non concluant.

**Hypothèse `H-13`** : IDM ne parse pas le manifeste DASH ; il reçoit du navigateur les URL
de segments (comme pour les flux `mpdatoidm://`), puis utilise `CMp4DashReader`/`CSidxParser`
pour lire les index et écrire l'init segment. C'est cohérent avec l'absence de parseur XML
de manifeste dans tout le binaire (`Q-B-01` : aucun parseur HTML non plus).

### 3.3 Conteneurs et extensions

Chaîne de filtres observée : `FLV MP3 MP4 M4V F4V M4A MPG MPEG AVI WMV WMA WAV ASF RM OGG
OGV MOV 3GP QT WEBM TS MKV AAC VTT TTML TTML2 DFXP SRT`. Le grabber, lui, ne filtre que par
masque (`*.html` exclu par défaut, `D-042`) : cette liste est celle des **médias
reconnus**, pas des filtres du grabber (`D-041`).

### 3.4 Exigences du domaine D

| Id | Exigence | Niveau | Preuve | Test prévu |
|---|---|---|---|---|
| `EX-D-01` | playlist HLS reconnue par `#EXTM3U` et MIME `application/vnd.apple.mpegurl` | Observé | §3.1 | `T-D-01` |
| `EX-D-02` | variantes (`#EXT-X-STREAM-INF`) résolues, une playlist par variante | Observé + Dérivé | `0x6b275c` | `T-D-02` |
| `EX-D-03` | segments listés par `#EXTINF`, URL relatives résolues | Dérivé | §3.1 | `T-D-03` |
| `EX-D-04` | `#EXT-X-MAP` téléchargé comme initialisation, avant les segments | Observé + Dérivé | `0x6b27c8`, `-tmp_dashinit` | `T-D-04` |
| `EX-D-05` | `#EXT-X-BYTERANGE` : segments extraits d'un même fichier par plages | Observé | `0x6b27f8` | `T-D-05` |
| `EX-D-06` | `#EXT-X-KEY` : clé annoncée, téléchargement sans déchiffrement | Observé + Décision `D-004` | `0x6b2828` | `T-D-06` |
| `EX-D-07` | `#EXT-X-MEDIA-SEQUENCE` : direct suivi par fenêtre glissante | Observé + Dérivé | `0x6b284c` | `T-D-07` |
| `EX-D-08` | DASH : index `sidx` lu, init segment écrit ; manifeste `MPD` non parsé | Observé + Hypothèse `H-13` | `CMp4DashReader`, `CSidxParser` | `T-D-08` |
| `EX-D-09` | `#EXT-X-DISCONTINUITY` : frontière de concaténation conservée | Dérivé | `0x6b2798` | `T-D-09` |
| `EX-D-10` | aucun déchiffrement DRM ; limite écrite | Décision `D-004` | — | `T-D-10` |

**Couverture : 0 / 10.** Spécifié, non implémenté (`WP-26`).

---

## 4. Ce que ces fiches ne disent pas

- **Le sens des méthodes.** On connaît les RVA de vtables et le nombre de méthodes, pas leur
  sémantique : sans décompilateur (`WP-03`, bloqué), `HTTPConnection::setNewLocation()` est
  un nom dans une chaîne de journal, pas un algorithme.
- **Les seuils.** Aucune valeur numérique n'est attachée ici : ni taille de tampon, ni délai
  de reprise, ni limite de redirections. Ce qui est numérique (10 redirections, 10 239
  octets de ligne) vient de l'annexe 14, mesuré dans `.text`, pas des chaînes.
- **Les protocoles en flux.** RTMP/MMS sont attestés par des classes et des URL ; leur
  grammaire n'est pas décrite. Toute implémentation serait une réécriture, pas un clonage.

---

## 5. Questions ouvertes

| Id | Question | Moyen de la lever |
|---|---|---|
| `Q-C-01` | Quel `Accept-Encoding` pour quelle requête (moteur vs page) ? | VM : capture réseau sur un téléchargement à morceaux et sur une page du grabber (annexe 16, P2) |
| `Q-C-02` | Portée des cookies : par connexion, par session, persistés ? | VM : serveur de test qui change de cookie à chaque requête |
| `Q-C-03` | `If-Range` est-il envoyé systématiquement en reprise ? | VM : serveur qui renvoie un `ETag` modifié (annexe 16, P5) |
| `Q-C-04` | Gestion de l'authentification serveur (`WWW-Authenticate`) ? | VM + capture |
| `Q-C-05` | `REST` est-il précédé de `SIZE` dans tous les cas ? | VM : serveur FTP instrumenté |
| `Q-D-01` | `#EXT-X-KEY` : la clé est-elle téléchargée ? rangée où ? | VM : flux chiffré AES-128, observation du disque |
| `Q-D-02` | Le direct (`MEDIA-SEQUENCE`) est-il suivi en continu ? | VM : playlist glissante |
| `Q-D-03` | `H-13` est-elle juste (pas de parseur MPD) ? | VM : URL `.mpd` directe vs capture navigateur |

---

## 6. Journal des révisions

| Date | Changement |
|---|---|
| 2026-10-28 | v1 : création. Fiche C (10 exigences, 9 observées), fiche D (10 exigences, 5 observées) ; 13 classes de transport/média avec vtables ; 12 balises HLS localisées ; `H-12` (RTMP hors grabber), `H-13` (DASH sans parseur de manifeste) ; 8 questions ouvertes |
