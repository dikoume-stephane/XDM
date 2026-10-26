# 05 — Intégrations navigateurs, registre et état persistant

> **Statut** : ✅ v1 · **Dernière revue** : 2026-10-26
> **Sources** : `EV-triage-registry` (124 chaînes de clés), `EV-triage-rtti`,
> `EV-local-strings`, `EV-local-dialogs`.
> **Apport majeur** : la configuration du **Site Grabber** est en **grande partie dans le
> registre** (`Software\DownloadManager\GrabberSts\…`), ce qui simplifie énormément la
> spécification du projet sauvegardé (voir §3).

## 1. Nature des chaînes citées

`HKEY_CURRENT_USER` / `HKEY_LOCAL_MACHINE` ne figurent pas dans ces chaînes : l'API
`Reg*` reçoit une racine séparée. On note donc les chemins **relatifs**. Les chaînes
`%s` / `%ld` sont des formats d'arguments (`sprintf`).

## 2. Intégration navigateurs

| Navigateur (famille) | Mécanisme attesté | Chaîne / clé |
|---|---|---|
| Chrome / Edge / Brave / Opera / Vivaldi / CocCoc | **hôte de messagerie native** | `SOFTWARE\Google\Chrome\NativeMessagingHosts\com.tonec.idm`, `…\Microsoft\Edge\…`, `…\Mozilla\…`, `…\CocCoc\Browser\…` + `idmnmcl.dll` |
| Chrome / Edge | installation d'extension (registre) | `SOFTWARE\Google\Chrome\Extensions\%s`, `SOFTWARE\Microsoft\Edge\Extensions\%s` |
| Firefox / Waterfox / PaleMoon / SeaMonkey | extension XPI + messagerie native | `%sextensions\mozilla_cc3@internetdownloadmanager.com.xpi`, `idmmzcc*.xpi`, `SOFTWARE\Mozilla\NativeMessagingHosts\com.tonec.idm`, `SOFTWARE\Mozilla\{Firefox, Mozilla Firefox, Mozilla Firefox ESR, Nightly, Aurora, SeaMonkey, Waterfox, Flock}` |
| Internet Explorer | **BHO** + menu contextuel + « Low Rights » | `…\Explorer\Browser Helper Objects`, `Software\Microsoft\Internet Explorer\MenuExt`, `…\Low Rights\ElevationPolicy\{GUID}` |
| Explorateur Windows | extension shell + protocole | `Software\Classes\CLSID\{07999AC3-…}`, `{6DDF00DB-…}`, `{79873CC5-…}`, `{E6871B76-…}`, `…\ShellIconOverlayIdentifiers`, `Software\Classes\PROTOCOLS\Name-Space Handler\` |
| Désintégration / réparation | blocage des extensions | `…\Shell Extensions\Blocked`, `Software\Backup_IDM`, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Google Chrome` |

**Dérivé** : IDM installe un pont par navigateur, et **sauvegarde** (`Backup_IDM`) les
clés qu'il modifie — signature d'un installateur qui veut pouvoir revenir en arrière.
C'est un comportement à imiter dans notre installateur (hygiène), pas à analyser.

## 3. Site Grabber : l'état est dans le registre (découverte structurante)

| Clé | Rôle dérivé |
|---|---|
| `Software\DownloadManager\GrabberSts` | état global du grabber |
| `…\GrabberSts\IncludeFilters` / `ExcludeFilters` | **filtres** du grabber (inclusion/exclusion) |
| `…\GrabberSts\Projects` puis `…\Projects\%ld\` et `…\Projects\%ld\%ld` | **liste de projets**, indexés par deux entiers (projet + sous-liste ?) |
| `…\Projects\%ld\%ld\ChList` | **liste des éléments** du projet (« ChList » = *check list* : les fichiers cochés/à télécharger) |
| `…\GrabberSts\RecentProjects` | projets récents (dialogue 270 « Load project ») |
| `…\DownloadManager\GrabberDlgLS` | géométrie/état de la fenêtre du grabber |
| `Software\DownloadManager\Scheduler` | planification (dialogue 284) |
| `Software\DownloadManager\Queue`, `…\maxID`, `…\ListSettings` | file principale et compteurs |

**Conséquence** : la « sauvegarde de projet » (`Saving the project of IDM Grabber`) n'est
probablement **pas** un fichier propriétaire opaque mais un **export du registre**.
`H-08` (format de projet) devient donc : *quel sous-ensemble de clés, et existe-t-il
aussi un fichier `.idm`/`.grabber` ?* — priorité abaissée, gain de temps majeur.

## 4. Configuration générale et réseau

| Clé | Rôle dérivé |
|---|---|
| `SOFTWARE\Internet Download Manager` (ASCII `0x278810`, UTF-16 `0x2a54b8`) | racine des réglages (probablement HKLM, 32 bits) |
| `Software\DownloadManager\ProxyServers\%s`, `…ProxyServers\%s:%s`, `…ProxyPac\%s`, `…WBProxy` | proxys statiques, PAC, proxy « web browser » |
| `Software\DownloadManager\Passwords` (`…\Passwords\`) | identifiants de sites (dialogue 145 « Sites Logins ») |
| `Software\DownloadManager\sites_sf`, `…\netApps`, `…\menuExt`, `…\IDMBI\Firefox\DwnlPanel` | listes de sites, applications réseau, menus, panneaux par navigateur |
| `Software\DownloadManager\MCN\%s`, `…\MCN\%s%s` | « Max Connections Number » par serveur (dialogue 226) |
| `Software\DownloadManager\FoldersTree`, `…\DwnlPanel`, `…\DwnlSelPanel`, `…\ConfigTime` | catégories/dossiers, état des panneaux |
| `SYSTEM\CurrentControlSet\Services\WinSock2\Parameters\Protocol_Catalog9\Catalog_Entries` | **réordonnancement des LSP Winsock** (avec `sporder.dll`) → interception réseau |
| `SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols` (+ `\TLS 1.3`) | réglages TLS système (compatibilité anciens Windows) |
| `SOFTWARE\FullCircle\TalkBack` | couche de compatibilité Microsoft (Application Compatibility) |
| `SOFTWARE\Microsoft\Windows\CurrentVersion\Run` | démarrage automatique (dialogue 141) |
| `…\Policies\System`, `…\Policies\Explorer`, `…\Policies\Network`, `…\Policies\Comdlg32` | lecture de politiques (élévation, UAC, chemins) |
| `…\AppCompatFlags\Layers` | marquage de compatibilité de l'exécutable |
| `…\Windows\DWM`, `…\Accessibility` | thème sombre, accessibilité |
| `Software\Google\Chrome\…`, `Software\Opera Software\…`, `…\BraveSoftware\…` | chemins de profils pour lire/écrire cookies (§5) |

## 5. Frontière sensible : lecture des cookies de navigateurs

| Chaîne | Ce qu'elle permet |
|---|---|
| `%s%sBraveSoftware\Brave-Browser\User Data\Default\Network\cookies` | chemin de la base SQLite des cookies Brave |
| `%s%sBraveSoftware\Brave-Browser\User Data\Default\cookies` | idem, ancien emplacement |
| `%sOpera Software\Opera Stable\cookies` | cookies Opera |
| `…\Local State` (Brave/Opera) | clé maîtresse de déchiffrement des cookies Chromium |
| `CCookieMonster`, `CCookiesChangesTable`, `CSetCookieHeadersArray` | gestion de cookies côté moteur |

**Analyse** : lire `Local State` (clé AES) + la base `cookies` (valeurs chiffrées) est
exactement la technique utilisée par les *infostealers*. Deux lectures sont possibles :
(a) **compatibilité de session** — réutiliser les cookies du navigateur pour que la
reprise d'un téléchargement authentifié fonctionne ; (b) capture de session.

**Décision de projet (`JOURNAL.md` D-004 étendu)** : nous documentons ce mécanisme
comme **fait** (il existe, il est cité), mais **nous ne l'implémentons pas**. Notre
grabber utilisera *notre propre* magasin de cookies, alimenté par notre propre session
HTTP, jamais une extraction depuis les bases du navigateur. Toute demande contraire sera
refusée (voir annexe 06, `H-11`).

## 6. Ce que cette annexe ne prouve pas

- Le contenu réel des valeurs (nous n'avons pas de machine Windows pour lire les clés).
- Que chaque clé est **écrite** (certaines peuvent être seulement lues).
- Le format de sérialisation de `ChList` (binaire ? chaîne délimitée ?) → `H-02`.
