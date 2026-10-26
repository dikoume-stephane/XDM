# 03 — Protocoles et formats attestés

> **Statut** : ✅ v2 (comptages refaits sur le corpus de chaînes) · **Dernière revue** : 2026-10-26
> **Sources** : `EV-triage-protocols`, `EV-triage-rtti`, `EV-inspect-pe-imports`,
> `EV-local-strings` (14 384 chaînes ASCII + 1 630 UTF-16).
> **Méthode de comptage** : occurrences **dans les chaînes extraites**, insensibles à la
> casse. Un comptage sur les octets bruts du fichier donne des faux positifs (ex.
> `quic` dans `x-quicktimeplayer`) : ne pas l'utiliser.

## 1. Transports

| Protocole | Attestation (chaînes / classes) | Niveau |
|---|---|---|
| **HTTP/1.1** | `"%s %s HTTP/1.1"`, `"CONNECT %s:%ld HTTP/1.1"` (tunnel), `accept-ranges:`, `Range`/`bytes=%I64d-%I64d`, `Content-Range:`, `Content-Length:` ×6, `Content-Encoding:`, `Content-Disposition:`, `chunked` (`Recv transfer encoding chunked`), `multipart/byteranges` | **Observé** |
| **HTTPS** | `https://` ×54, `Schannel` (7 chaînes), `SYSTEM\…\SCHANNEL\Protocols\TLS 1.3` | **Observé** (chaînes) / **Dérivé** : TLS via SChannel, et **IDM modifie les clés SChannel** (`H-12`) |
| **FTP / FTPS** | `ftp://` ×5, `FTPConnection`, `FTPSession`, `CFTPProxyConnection`, chaîne « Use FTP protocol in passive mode (needed behind firewalls) » | **Observé** |
| **Socks / proxy** | `CSocks`, `ProxyConnection`, `Proxy-Authorization:` ×4, dialogue 140 « Proxy / Socks », `CONNECT` (tunnel) | **Observé** |
| **PAC (proxy auto-config)** | `CIDMProxyScript`, `CPersonalProxyScript`, `CLatestPersonalProxyScript` | **Observé** (classes) → évaluation de JavaScript (`H-12`) |
| **RTMP / RTMPT / RTMPE** | `rtmp://` ×2, `rtmpt://` ×2, `rtmpe://`, `RTMPConnection/Session/Packet`, `AMF{Object,ObjectProperty,3ClassDefinition,PropertiesArray}` | **Observé** |
| **MMS** | `mms://` ×4, `MMSConnection`, `MMSSession` | **Observé** |
| HTTP/2, HTTP/3, QUIC | aucun marqueur (`HTTP/2`, `:authority`, `h2`, `quic` absent des chaînes réseau) | **Inconnu → probablement absent** (`H-07`) |

## 2. HLS : client complet (résultat le plus net de cette annexe)

Toutes les balises d'une playlist HLS sont présentes comme chaînes :

| Balise | Attestation | Ce qu'elle implique |
|---|---|---|
| `#EXTM3U`, `#EXT-X-VERSION:` | 1 / 1 | parseur de playlist |
| `#EXT-X-STREAM-INF:` | 1 | **playlists maîtres** (variantes de débit) → `MasterPlaylist` |
| `#EXTINF:`, `#EXT-X-TARGETDURATION:` | 1 / 1 | segmentation temporelle |
| `#EXT-X-MEDIA-SEQUENCE:` | 1 | playlists glissantes (live) |
| `#EXT-X-ENDLIST` | 1 | fin de flux VOD |
| `#EXT-X-BYTERANGE:` | 1 | **segments par plage d'octets** → réutilise le moteur HTTP Range |
| `#EXT-X-MAP:` | 1 | segment d'initialisation (fMP4) |
| `#EXT-X-KEY:` | 1 | **chiffrement AES-128 HLS** (standard) — à distinguer de tout DRM |

Classes associées : `CM3UParser`, `MasterPlaylist@CM3UParser`, `MediaPlaylist@CM3UParser`,
`MediaSegment@CM3UParser`, `MPLVariant@CM3UParser`, `decodingState@CM3UParser`.

> **Point de conformité** : prendre en charge `#EXT-X-KEY` (AES-128) est du traitement de
> flux standard, pas un contournement de DRM. En revanche, **aucune** trace de Widevine,
> PlayReady, FairPlay ou d'un déchiffreur de contenu protégé n'apparaît → à documenter
> comme *non reproduit* (et à ne pas ajouter).

## 3. DASH / MP4

| Élément | Attestation | Remarque |
|---|---|---|
| boîtes `sidx`, `moof`, `moov` | 3 / 1 / 1 occurrences (souvent dans du code binaire : `=sidx`, `D$4=moof`) | lecture binaire de l'index de segments |
| `CSidxParser`, `CMp4DashReader`, `CMp4Converter` | classes RTTI | parseur + assemblage |
| `.mpd`, `.m3u8` (extension) | **absents** en tant que chaînes | la détection se fait par **contenu/MIME**, pas par extension → cohérent avec `CContentTypeChecker` |
| `application/x-quicktimeplayer`, `application/vnd.lumberjack.manifest` | chaînes MIME | table MIME interne (`CContentTypesDatabase`) |

## 4. Autres formats

| Famille | Attestation |
|---|---|
| MPEG-TS | `CPMTStream`, `CPMTNetworksPIDs`, `CTSReader`, `CTSAVMixer`, `CTSOutBeffer` |
| MP4 fragmenté | `moof`/`moov`, `CMp4Converter` |
| AMF0/AMF3 | `AMFObject`, `AMF3ClassDefinition` (usage RTMP probable) |
| ZIP / GZip | `CZipFormat`, `CGzipDecoder`, dialogue 196 « Zip preview » |
| Audio/vidéo simples | `CMp3Format`, `CMpgFormat`, `CAviFormat`, `CWavFormat` |
| MIME particulier | `Content-Type: application/x-fcs` ×3 (`H-13` : serveur FCS/Flash Media ?) |

## 5. En-têtes HTTP manipulés explicitement (revue finale)

| En-tête | Occurrences (chaînes) | Usage attendu |
|---|---|---|
| `Range` (format `bytes=%I64d-%I64d`) | 8 lignes contenant `range` | découpage multi-connexions / reprise |
| `Content-Range` | 1 | validation des réponses 206 |
| `Content-Length` | 6 | taille totale, intégrité |
| `Content-Type` | 7 | classification (`CContentTypesDatabase`, dialogue 294 « File types ») |
| `Content-Encoding` | 1 | gzip/deflate |
| `Content-Disposition` | 1 | nom de fichier proposé |
| `Accept-Ranges` | 1 | autorisation de paralléliser |
| `Cookie:` / `Set-Cookie` | 5 / 2 | sessions |
| `Referer` | 7 | anti-hotlink |
| `User-Agent` | 10 | compatibilité |
| `Proxy-Authorization` | 4 | proxys authentifiés |
| `Connection:` | ~100 occurrences (dont libellés UI « Data connection: OK ») | garde/fermeture — **comptage bruité, à ne pas citer** |

## 6. Priorisation pour l'implémentation

1. **HTTP/1.1 + plages** (reprise, multi-connexions) → socle de tout, y compris HLS `BYTERANGE`.
2. **HLS complet** (variantes, `MAP`, `KEY` AES-128, `MEDIA-SEQUENCE` pour le live).
3. **DASH/SIDX** (lecture `sidx` puis segments).
4. **FTP / Socks / PAC**.
5. **Non reproduit et assumé** : RTMP/RTMPT/MMS/AMF (protocoles obsolètes, valeur produit
   quasi nulle), DRM (absent et hors périmètre légal).
