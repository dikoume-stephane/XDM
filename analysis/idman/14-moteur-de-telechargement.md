# 14 — Moteur de téléchargement : architecture, morceaux, reprise

> **Statut** : 🟡 v0.3 (WP-05) · **Dernière revue** : 2026-10-27
> **Cible** : `cible/IDMan.exe` — IDM 6.42.22.3, sha256 `5f78da5a…2f11c9`
> **Preuves principales** : `analysis/idman/symbols.json` (§1), `methods.json` (noms →
> adresses), `states.json` (machine à états, §4), `classes.json`,
> `analysis/raw/idman/strings-*.txt`, désassemblage `capstone` ciblé.
> **Niveau** : chaque affirmation est **Observé** (lu dans le binaire : chaîne, vtable,
> instruction) ou **Dérivé** (interprétation explicitement signalée). Aucune ligne
> n'est issue d'une documentation externe ni d'une supposition sur IDM.

But de l'annexe : donner à `WP-05` de quoi écrire une spécification exécutable du
moteur (cycle de vie, découpage en morceaux, reprise, multi-connexion) **sans
décompilateur**, puisqu'un tel outil reste indisponible ici (D-019). Elle prolonge
l'annexe 10 (vtables) et l'annexe 11 (modèle de données).

---

## 1. Une source de preuve nouvelle : les noms que le binaire se donne (Observé)

La cible n'a **pas** de symboles (annexe 01), mais ses messages de journal et d'erreur
contiennent des noms qualifiés à la C++ : `HTTPConnection::GetRetrRangeReply()`,
`ChunksList::JoinFile()`, `SessionManager::DoDownload()`… C'est le seul vocabulaire
interne accessible sans décompilateur.

`tools/idman_symbols.py` (nouveau) extrait ces noms :

| Mesure | Valeur |
|---|---|
| Classes citées par un message | **71** |
| Noms `Classe::Méthode` distincts | **323** |
| Messages bruts conservés (RVA + texte) | 323 |
| Sortie | `analysis/idman/symbols.json` (non versionné) |

**Limite à ne pas oublier (Observé)** : ces noms sont des **chaînes**, pas des
adresses. Chaque message `"Unknown error during X::Y()"` est poussé par un *helper de
journalisation de la classe X* (ex. `push 0x6adc7c` en `0x15da9a`, suivi d'un appel au
formateur `0x555450`), pas par `X::Y()` elle-même. Conclusion méthodologique :

- ✅ les noms prouvent **l'existence et le rôle** des méthodes non virtuelles
  (absentes des vtables, donc invisibles pour `classes.json`) ;
- ❌ ils ne donnent **pas** l'adresse de ces méthodes : tout raisonnement de flux qui
  exigerait l'adresse reste bloqué par l'absence de décompilateur (D-019).

Les noms se répartissent en cinq familles cohérentes avec `classes.json`, ce qui
confirme la lecture :

| Famille | Classes nommées (extrait) | Noms |
|---|---|---|
| Transport | `FTPConnection` (58), `HTTPConnection` (24), `Connection` (8), `ProxyConnection` (3) | 93 |
| Sessions | `FTPSession` (11), `Session` (7), `HTTPSession` (5), `SessionManager` (13) | 36 |
| Stockage | `ChunksList` (13), `ChunksListItem` (2), `ReplyQueue` (3) | 18 |
| Interface | `CDownloaderDlg` (34), `CDownload` (9), `CDDlg` (10), `CDwnlDlg` (7) | 60+ |
| Grabber | `GrbFsDlg` (1), `GrSh` (2), `CDDlg::AddGrLinks`… | ~6 |

`tools/idman_attrib.py` va plus loin : il rattache chaque message à la **fonction** qui
le pousse (`analysis/idman/methods.json`), en s'appuyant sur des ancrages de fonctions
(adresses de vtables, prologues `55 8B EC` précédés de remplissage). Résultat :
**253 fonctions nommées**, **246 attributions confirmées** sur 323 messages (les 77
autres ont un `gap` > 0x800, donc une frontière probablement manquée : ne pas les citer
comme des adresses exactes). C'est ce qui permet, en §4 et §9, de donner des adresses
de méthodes.

**Conséquence quantitative (Observé)** : les vtables ne montrent qu'une **minorité** des
méthodes. `tools/idman_class_profile.py --pattern '^(HTTPConnection|FTPSession|Session)$'`
donne 11 / 4 / 4 méthodes virtuelles, alors que les messages nomment 24 / 11 / 7
méthodes pour ces trois classes. Autrement dit, l'essentiel du moteur est en méthodes
**non virtuelles** : `classes.json` seul ne peut pas suffire à spécifier `WP-05`, et
c'est précisément ce que comble `symbols.json`.

---

## 2. Architecture réelle : quatre anneaux (Observé sur les RTTI)

`classes.json` donne la matrice complète des classes de transport et de session — le
moteur est **polymorphe à deux étages** :

```
UI        CDownloaderDlg ─────────────► CDownload (dialogue de suivi)
          (89 slots)                    CDownloadComponents, CDownloadingTab, CQueueTab

orchestr. SessionManager  (13 noms, aucun vtable)
          CSessionsArray = CArray<CDownloadSession>

sessions  Session (4 slots) ──┬── HTTPSession (4)
                              ├── FTPSession (4)
                              ├── MMSSession (4)
                              └── RTMPSession (4)

transport Connection (8) ──┬── HTTPConnection (11) ── ProxyConnection (11)
                           ├── FTPConnection (9) ── CFTPProxyConnection (9)
                           ├── MMSConnection (9)
                           └── RTMPConnection (9)

stockage  ChunksList (13 noms, aucun vtable), ChunksListItem, ReplyQueue
métadonnée URL (7 noms)
```

Faits vérifiables :

| Constat | Preuve |
|---|---|
| `Session` est une **base abstraite** de 4 slots virtuels | vtable `0x2b47b0`, 3 slots sur 4 pointent le **même** stub `0x228f85` |
| `Connection` est également abstraite | vtable `0x2af24c`, 2 slots sur 8 = `0x228f85` |
| `HTTPConnection` ajoute 4 virtuelles à `Connection` (11 vs 8, dont 2 stubs hérités) | `0x2b0ae4` vs `0x2af24c` |
| `ProxyConnection` ne fait qu'**hériter** de `HTTPConnection` (même compte de slots) | `.?AVProxyConnection@@` ← `.?AVHTTPConnection@@` |
| `CDownload` **n'est pas** le moteur : c'est un `CDialog` | `bases = CDialog → CWnd → CCmdTarget → CObject`, 89 slots (gabarit de dialogue MFC) |
| `SessionManager` et `ChunksList` sont **non polymorphes** (aucune entrée RTTI) | absents de `classes.json`, présents dans `symbols.json` |

**Dérivé (fort)** : `CDownload` est la **fenêtre de progression** d'un téléchargement
(vtable de gabarit dialogue, méthode `OnZipPreview`, `OnDownloadLater`), et le moteur
vit dans `SessionManager` + `Session`/`Connection` + `ChunksList`. La feuille de route
doit donc porter la spécification sur ces trois-là, pas sur `CDownload` (correction de
l'intitulé de `WP-05` dans `ROADMAP-IDM.md`).

**Note** : `CSessionsArray` est un `CArray<CDownloadSession>` alors qu'aucun RTTI
`CDownloadSession` n'existe. **Dérivé** : `CDownloadSession` est la classe réellement
instanciée dans le tableau, sans fonctions virtuelles propres (donc sans RTTI) ;
`Session` est sa base polymorphe. Les deux noms coexistent dans le binaire.

---

## 3. Cycle de vie d'un téléchargement (Observé : verbes de `SessionManager`)

Les 13 messages de `SessionManager` forment une séquence complète, dans l'ordre d'un
téléchargement :

| Étape | Verbe | Rôle déduit du nom |
|---|---|---|
| 1 | `LoadUrlFromReg` | recharge un téléchargement interrompu depuis le registre |
| 2 | `SetURL`, `SetLogin` | URL + identifiants (proxy/FTP/HTTP auth) |
| 3 | `SetLocalName`, `GetDefaultlocalName` | nom local, ou nom par défaut dérivé de l'URL |
| 4 | `SetDescription`, `SetStatus` | métadonnées affichées (liste, colonnes) |
| 5 | `DoDownload` | démarrage effectif : création des sessions/connexions |
| 6 | `ConvertSizeToString` | formatage (`1.2 MB`) pour l'UI |
| 7 | `CancelDownload` → `ProcessCancelDownload` | demande d'annulation puis traitement (asynchrone : deux méthodes distinctes) |
| 8 | `DeleteFromRegistry`, `CoverUpTheTraces` | purge de l'état persistant après succès/annulation |

**Dérivé** : `CancelDownload` / `ProcessCancelDownload` séparés = l'annulation est
**différée** (drapeau posé par l'UI, traité par la boucle du moteur), pas une
interruption brutale des sockets. C'est un point de conception à reprendre (annulation
coopérative, jamais de `TerminateThread`).

---

## 4. Machine à états d'une connexion (Observé, `tools/idman_states.py`)

### 4.1 Le champ d'état et sa distribution (Observé)

`Connection` (générique) et ses dérivées fournissent le squelette :

| Groupe | Méthodes (attribuées par `methods.json`) |
|---|---|
| Établissement | `Connection::CheckConnect` (`0x166a00`), `ProxyConnection::Connect` (`0x1774f0`), `FTPConnection::TryConnect` (`0x16d7d0`), `BindSocket` (`0x16e8a0`), `Accept` (`0x16eb30`), `HTTPConnection::HttpsProxyConnect` |
| Boucle d'E/S | `Connection::SelectForRead` ; fonction `0x165140` (message `Connection::ProcessRecv`), fonction `0x16f710` (message `Connection::ReceiveData`) |
| Émission | fonction `0x186180` (`HTTPConnection::SendGet`), `0x1dbd30` (`SendHTTPSGet`) ; `FTPConnection::Send*` (16 fonctions distinctes nommées) |
| En-têtes | fonction `0x18a4f0` (messages `RecvAllHeaders`, `HandleStatus`, `GetInfo`), `0x17d710` (`SkipAllHeaders`), `0x17de20` (`SkipAllHeaders2`), `0x17c3a0` (`GetNextReplyLine`), `0x17b3a0` (`GetReplyIntoStorage`) |
| Interprétation | `0x17c730` (`RecvState`), `0x17faf0` (`GetRetrRangeReply`), `0x17ba80` (`GetTempEndPos`), `0x182900` (`Set_szURL`/`setNewLocation`), `ProcessState`, `GetState` |
| Fin | `Connection::SetCompleted` (`0x17f4d0`), `OnComplete` (`0x1649b0`), `FTPConnection::Disconnect` (`0x170400`), `RollBack` (`0x16f9e0`), `Restart` (`0x16fa70`) |

*Note de lecture* : une adresse n'est donnée que lorsque `methods.json` l'attribue au nom
cité **et** que le `gap` est faible ; les fonctions qui portent plusieurs messages sont
désignées par leur adresse suivie de la liste des messages qu'elles contiennent, sans
prétendre qu'elles *sont* l'une de ces méthodes.

**L'état est un entier en `this + 0xa4`** — et non une abstraction cachée :

| Constat | Preuve |
|---|---|
| Champ | `mov eax, dword ptr [esi + 0xa4]` en `0x180de6` (HTTP) et `0x18a7fa` (HTTP) |
| Taille | `cmp eax, 0x26` avant chaque `switch` ⇒ **39 états, indices 0 à 38** |
| Distribution | compilée par MSVC en **table d'octets → table de sauts** : `movzx eax, byte ptr [eax + B]` puis `jmp dword ptr [eax*4 + T]` |
| Switch sur ce champ | **8** (`states.json` §`dispatchers`), tous bornés entre 0..28 et 0..38 |
| Écritures (transitions) | **115 sites**, **30** valeurs distinctes écrites |

Détail des huit distributeurs (`analysis/idman/states.json`) :

| Site | Table de sauts | Gestionnaires | États couverts | Zone |
|---|---|---|---|---|
| `0x170b99` | `0x170e08` | 7 | 0..36 | FTP |
| `0x1753e6` | `0x17656c` | 22 | 0..37 | FTP (fonction contenant `FTPConnection::HandleStatus`) |
| `0x178af4` | `0x178e40` | 10 | 0..37 | `FTPSession` |
| `0x180e07` | `0x1812c4` | 6 | 0..38 | HTTP, avant `GetRetrRangeReply` |
| `0x18a809` | `0x18d230` | 15 | 0..38 | HTTP, fonction `0x18a4f0` (`HandleStatus`) |
| `0x1a1244` | `0x1a1ca0` | 14 | 0..32 | MMS |
| `0x1ad546` | `0x1ad664` | 4 | 0..28 | RTMP |
| `0x1b28df` | `0x1b3014` | 18 | 0..32 | `Session` |

Sur le switch HTTP de `HandleStatus` (`0x18a809`), **25 des 39 états retombent sur le
même gestionnaire par défaut** (`0x18d1d7`) : la machine n'a donc qu'une quinzaine
d'états « vivants » pour HTTP.

### 4.2 Lectures des états (Dérivé, adossé aux sites d'écriture)

Chaque ligne lie un état aux méthodes qui l'écrivent (`states.json` §`by_state`) ; la
sémantique est une **déduction**, pas une lecture de nom d'énumération (il n'y en a pas).

| État | Écrit par (extrait) | Lecture proposée |
|---|---|---|
| 1 | `ProxyConnection::Connect` | connexion en cours vers le proxy |
| 2 | `Connection::CheckConnect` (chemin de succès, après `call 0x562830`) | **connecté** |
| 3 | `CDownloadComponents::StartDownload` | démarrage demandé par l'interface |
| 4 | tous les `FTPConnection::Send*` (`User`, `Password`, `Type`, `Cwd`, `Pasv`, `Rest`, `Retr`, `Size`, `Port`, `ListFile`…) | **commande envoyée, réponse attendue** |
| 5 | `SkipAllHeaders`, `SkipAllHeaders2`, `RecvAllHeaders`, `MNSP` | lecture/saut des en-têtes |
| 6 | `CheckRetrReply`, `SendSize`, `GetRetrRangeReply`, `GetInfo` | réponse interprétée |
| 7 | `Connection::SetCompleted` (après remise à zéro de `+0xc0`), `RollBack`, `ProcessWaitTestSequ`, `GetRetrRangeReply` | **terminé / clôturé** |
| 10 | `ProcessPasvOK` | `PASV` accepté |
| 11 | `SendTestSequences` | test des séquences FTP |
| 12 | `ProcessWaitTestSequ` | séquences testées |
| 13 | `CheckListReply` | réponse de `LIST` reçue |
| 14 | 25 sites (dont `HandleStatus`, `AuditForRestart`, `InsInChunksList`, `ProcessPasvReply`) | **transfert de données en cours** |
| 15 | `RecvHTTPSData` | données lues dans le tunnel TLS |
| 16 | `HttpsProxyConnect`, `GetState`, `GetInfo`, `HandleStatus` | tunnel proxy établi / état interrogé |
| 17..19 | `MMSCn::HndlSt`, `HTTPSession::ReceiveData` | états MMS/RTMP (non nommés) |
| 31, 32 | `Connection::SelectForRead` | **E/S en attente** (deux variantes lecture/écriture) |
| 38 | `RecvAllHeaders`, `GetInfo`, `HandleStatus` | fin de réception des en-têtes |

**Constat de conception (Dérivé)** : les états 4, 5, 6, 7 et 14 sont écrits par *toutes*
les classes de transport (HTTP, FTP, MMS, RTMP) — la machine est donc **commune** à tous
les protocoles, chaque transport n'ayant que quelques états propres (10-13 pour FTP,
15-16 pour HTTP/TLS, 17-19 pour MMS/RTMP). C'est un point important pour XDM : une seule
machine à états paramétrée par transport, pas quatre machines.

### 4.3 Robustesse (Observé, voisinage des transitions)

- `"Select failed, err code = %d, socket = %d"` → `SelectForRead` journalise l'échec de
  `select()` (sockets non bloquantes ; pas de thread par connexion) ;
- `"Connection restarted because of timeout"` → reprise sur expiration ;
- `"File write error! Received %d bytes, wrote %d bytes, errCode = %ld"` → l'écriture
  partielle est un cas normal, pas une erreur fatale ;
- le chemin d'erreur de `Connection::CheckConnect` passe par un gestionnaire SEH qui
  journalise `"Unknown error during Connection::CheckConnect"` puis retourne `-1`
  (`0x166f66`–`0x166f93`) : **aucune exception ne remonte** au moteur.

### 4.4 Modèle d'E/S et seuils (Observé, `A-13`)

Le moteur n'ouvre pas un thread par connexion : il fait **un `select()` pour toute la
session**. Deux sites d'appel seulement (`0x19503c`, `0x1959bd`) et trois
`CreateThread` dans tout le binaire (aucun dans la boucle de transfert).

| Élément | Valeur | Preuve |
|---|---|---|
| Tableau des connexions | pointeur `session+0x274`, **compte `session+0x1b0`** | boucle `cmp edi, [esi+0x1b0]` en `0x194fe4` ; `mov eax, [esi+0x274]` puis `imul edx, edx, 0x3488` |
| **Taille d'un objet connexion** | **`0x3488` octets** (13 448) | `imul edx, edx, 0x3488` en `0x194fee` — pas de division, c'est bien un pas de tableau |
| `fd_set` de lecture / écriture / exceptions | `session+0x278`, `+0x47c`, `+0x680` | remis à zéro en `0x1958fe`–`0x19590a` |
| **Taille d'un `fd_set`** | **516 octets** = 4 + **128**×4 | `0x47c − 0x278 = 0x204` (idem `0x680 − 0x47c`), et garde `cmp edx, 0x80` en `0x195930` |
| **Sockets max par session** | **128** | la garde `jae` saute l'ajout au-delà de `0x80` entrées |
| Sockets | non bloquantes | `ioctlsocket` appelé en `0x190786`, `0x19a1e8` |
| **Plafond du délai `select()`** | **12 000 ms** (`0x2EE0`) | `cmp ecx, 0x2ee0` / `jle` en `0x1958a7` |
| Ajustement du délai | **÷10** si l'échéance n'est pas atteinte, **÷2** sinon | division par 10 (magie `0x66666667`, `sar edx,3`) en `0x19588d` ; `sub eax,edx; sar eax,1` en `0x1958d8` |
| Échéance | 64 bits en `session+0x1d0`, comparée à l'horloge (`0x625460`) | `mov eax, [esi+0x1d0]` + comparaison 64 bits en `0x195869`–`0x19588b` |
| Repli si `select` échoue | `Sleep(délai)` | `push ecx; call dword ptr [0x6784a0]` en `0x1959c5` |
| Conversion en `timeval` | `sec = ms/1000`, `usec = (ms%1000)×1000` | magie `0x10624dd3` + `imul eax,eax,0x3e8` en `0x195984`–`0x1959a6` |

Toutes ces valeurs sont reproduites par `tools/idman_io.py`
(`analysis/idman/io-model.json`) : sites d'appel des primitives d'E/S, constantes
comparées autour de chaque `select`, décalages d'objets de la boucle, pas de tableau,
et valeur par défaut du nombre de connexions. Le balayage des constantes est
alignement-insensible (lecture des encodages `cmp`), donc il peut remonter du bruit :
ne retenir que les valeurs cohérentes avec le code voisin (`0x80`, `0x2EE0`, `0x12C`,
`0xFA` ici).

**Défaut du nombre de connexions (Observé)** : propriété `MaxConnectionsNumber` lue par
`RegQueryValueExA` dans le constructeur des options (`0xfbdff`) ; en cas d'absence de la
valeur, le code écrit **`8`** (`0x0fbe17`). L'écriture se fait par un *setter* dédié
(`0x0fb4c0`, `RegSetValueExA` type 4, `cbData = 4`).

**Note pour éviter une fausse piste (Observé)** : la fonction `0x1b0ed0` est un
**dispatcher de journalisation** (switch sur `byte [esi+5]`, 20 cas, table
`0x1b10a0`/`0x1b10cc`), dont le cas 1 appelle le loggueur `0x1ac8d0`
(« Change chunk size to %ld »). Ce n'est **pas** l'algorithme de taille de morceau :
celui-ci est calculé par l'appelant et transmis en argument. Les messages
« The file chunk %d is reassigned to connection %d » et « Change chunk size to %ld »
appartiennent à ce canal de journalisation, pas à la boucle de transfert.

**Dérivé** : le couple « un `select` par session / 128 sockets / échéance plafonnée à
12 s » explique pourquoi IDM plafonne pratiquement le nombre de connexions simultanées
autour de la centaine même si l'utilisateur demande davantage (`CMaxConnNumbers` borne
déjà par site, annexe 12).

---

## 5. Modèle de morceaux (Observé : traces de `ChunksList`)

Le binaire contient les chaînes de **trace** qui impriment ses propres structures :
c'est la meilleure description disponible du modèle de données des morceaux.

```text
Item id=%ld, next=%ld, start=%I64d, end=%I64d, conn=%ld, isCompl=%ld,
alt=%ld, altN=%ld, sttm=%ld, etm=%ld, niid=%ld, file=%s        ("Trace list.")
Item id=%ld, conn=%ld, next=%ld, compl=%ld, start=%I64d, fsize=%I64d, total=%I64d
first listitem id = %ld, startpos = %I64d, file %s, endpos = %I64d
new listitem id=%ld, startpos=%I64d, file %s, dwnl=%I64d, endpos=%I64d, ttdwnl=%I64d,
sttm=%ld, etm=%ld
```

| Champ | Type | Sens déduit | Preuve |
|---|---|---|---|
| `id` | `long` | identifiant du morceau dans la liste chaînée | `Item id=%ld, next=%ld` |
| `next` / `niid` | `long` | chaînage (ordre de reconstitution) | `nextID` dans le registre |
| `start`, `end` | `int64` | bornes dans le **fichier final** | `start=%I64d, end=%I64d` |
| `fsize` | `int64` | taille totale du fichier | `fsize=%I64d` |
| `dwnl`, `ttdwnl` | `int64` | octets déjà reçus / total à recevoir | `dwnl=%I64d, ttdwnl=%I64d` |
| `conn` | `long` | connexion propriétaire (index) | `conn=%ld` |
| `isCompl` / `compl` | `long` | morceau terminé | `isCompl=%ld` |
| `alt`, `altN` | `long` | **connexion alternative** (reprise sur une autre socket) | `alt=%ld, altN=%ld`, `AddAlternative` |
| `sttm`, `etm` | `long` | horodatages début/fin (débit, `totalDuration`) | `sttm=%ld, etm=%ld` |
| `file` | chaîne | **fichier temporaire** du morceau | `file=%s`, `%s.tmp` |

**Dérivé** : un morceau n'est pas seulement une paire d'offsets, il possède son propre
fichier temporaire et peut être « doublé » (`alt`) par une connexion de secours. Le
`ChunksList` est donc une **liste chaînée persistante** dont chaque nœud est un
descripteur de transfert partiel.

Opérations observées (noms de `symbols.json`) :

| Opération | Rôle |
|---|---|
| `InitFirst` | crée le premier morceau (toute la taille du fichier) |
| `CreateNewItem` (+ `set_fileName`) | instancie un morceau et nomme son fichier temporaire |
| `InsertFromReg` | reconstruit la liste depuis le registre (reprise) |
| `FindMaxFreeChunk` | choisit le plus gros morceau libre pour une nouvelle connexion |
| `NeedNewConnection` | décide s'il faut ouvrir une connexion supplémentaire |
| `AppendFile`, `JoinFile` | concaténation des morceaux → fichier final |
| `Erase`, `EraseRegSubKey` | purge mémoire + clé de registre |
| `AddAlternative`, `CheckAlternative`, `ApplyAlternative` | bascule d'un morceau vers une connexion alternative |
| `FindChunkWithZipCentralDir` | localise la « fin de zip » (reprise d'une archive partielle) |
| `SaveDataFromRAM` | vidage mémoire → disque |

### 5.1 Persistance : le registre, pas un fichier d'état (Observé)

| Élément | Preuve |
|---|---|
| Clé | `Software\DownloadManager\%ld\ChList` — poussée en **8 endroits** (`0x1567cd`, `0x15df01`, `0x15ef4c`, `0x15f64a`, `0x1b69bf`, `0x1b83a4`, `0x1bc043`, `0x1d2aca`) ; variante grabber `Software\DownloadManager\GrabberSts\Projects\%ld\%ld\ChList` (annexe 13) |
| Écriture | `RegSetValueExA`, puis `RegFlushKey` (`0x15dee1`) et `RegCloseKey` (`0x15df37`) |
| Relecture | `RegQueryValueExA` (`0x15d98e`, `0x15f5eb`) + `RegQueryInfoKeyA` (`"Values counter in the registry subkey = %ld"`) |
| Suppression | `RegDeleteKeyA` (`0x15682c`) après assemblage réussi |
| Journal | `"Adding record to registry with ID %ld, startPos %I64d, nextID %ld"`, `"Read record num. %s from registry: ID = %ld, startPos = %I64d, nextID = %ld"` |

**Dérivé** : les valeurs sont nommées par un compteur (`%s`) et contiennent au minimum
`ID`, `startPos`, `nextID`; le contenu exact (binaire ou chaîne formatée) reste à
trancher (A-11).

### 5.2 Fichiers temporaires (Observé)

| Constat | Preuve |
|---|---|
| Modèle `%s.tmp` | poussé en `0x156d21`, `0x1bcf79`, `0x1bd34a`, `0x19776f`, `0x1bd9b2`, `0x1bd6b0` |
| Modèle `%s_tmp` (repli) | `0x15ce1a` |
| Création | `CreateFileW(<local>.tmp, 0xC0020000, 0, NULL, 1, 0x80, 0)` en `0x156d42`–`0x156d4e` — `GENERIC_READ|GENERIC_WRITE|READ_CONTROL`, partage 0, `CREATE_NEW` (échoue si présent), `FILE_ATTRIBUTE_NORMAL` |
| Dossier | `%sDwnlData\%s\` (`0x6e031`, `0x6e078`), préfixé par la racine IDM lue en `[0x75fc3c]` |

**Dérivé** : chaque téléchargement possède un **dossier temporaire** `<IDM>\DwnlData\<nom>\`
contenant un fichier `.tmp` par morceau ; l'assemblage final produit le fichier
demandé par renommage/concaténation, le `.tmp` étant supprimé ensuite
(`"Delete temp file %s"`).

### 5.3 Rollback = troncature du fichier (Observé, désassemblage `0x15fe9e`–`0x15ff52`)

| RVA | Instruction / API | Effet |
|---|---|---|
| `0x15fe9e`–`0x15feaa` | `sub`/`sbb` 64 bits puis clamp | calcule `end − start`, borné à 0 |
| `0x15febe` | `push "Try rollback, set chunksize to %I64d"` | journalise la nouvelle taille |
| `0x15fee5` | `SetFilePointer(hFile, low, &high, FILE_BEGIN)` | replace le pointeur sur la dernière position **validée** |
| `0x15feee` | `GetLastError` | échec si `-1` |
| `0x15ff22`, `0x15ff29` | `CloseHandle` ×2 | libère les deux fichiers temporaires concernés |
| `0x15ff52` | `SetEndOfFile(hFile)` | **tronque** le `.tmp` à la position validée |

C'est la preuve directe que la reprise repose sur une **troncature au dernier octet
confirmé**, et non sur un journal de transactions.

### 5.4 Vérification de recouvrement entre connexions (Observé + Dérivé)

Chaînes de diagnostic, toutes dans le voisinage immédiat du code de réception :

```text
"Check w_st_o_n_cn failed!"      "posInCmpBuff3=%ld, bytes_read=%ld"     "Buff3:"
"tmpBuff:"                       "Chunk order violation error, cInf.ID %ld, startPos %I64d"
">Some chunks matched with start of file! Deleting all, except first."
"Strart data for this chunk is matched with start of the file!!!"       (faute de frappe d'origine)
"IDM started to download the file using one connection because of data corruption when newly
 received data in several connections did not match the same data downloaded earlier."
"The file chunk %d is reassigned to connection %d."      "Change chunk size to %ld"
```

**Dérivé (fort)** : `w_st_o_n_cn` se lit *write start of next connection* : à chaque
écriture, le moteur **compare les octets de recouvrement** entre la fin du morceau
courant et le début du suivant (tampon `Buff3`). Toute divergence ⇒
(a) réaffectation du morceau, (b) réduction de la taille de morceau, voire
(c) **repli à une seule connexion** si l'incohérence persiste. C'est la parade au
serveur qui renvoie des contenus différents selon la socket.

---

## 6. Multi-connexion et limites (Observé + Dérivé)

| Élément | Preuve | Lecture |
|---|---|---|
| Nombre max | valeur de registre `MaxConnectionsNumber` (`0xfb4d6`) | réglage global, pas une constante |
| CArray dédiée | `CMaxConnNumbers` = `CArray<IDM_STRUCT_SITE_MCN>` (annexe 12) | plafond **par site** pour le grabber |
| Connexions « optionnelles » | `HTTPSession::TryStartNewOptionalConnections`, `"Optional connections, connecting..."`, `"Optional connections have been created."` | une connexion initiale, puis ajout progressif |
| Allocation | `ChunksList::NeedNewConnection`, `FindMaxFreeChunk` | la nouvelle connexion prend le plus gros morceau libre |
| Arbitrage | `HTTPSession::GetSlowestConnection`, `SendAllConnInfo` | les morceaux du plus lent sont redistribués |
| Garde-fou | `"Too many open network connections. Please wait for some downloads to finish."` | plafond global de sockets |
| Avertissement UI | `"Please use a high number of connections with caution. Some servers may have specific limitations…"` | IDM assume le risque côté serveur |

**Dérivé** : la stratégie est *1 connexion d'abord, montée en charge ensuite* (donc le
serveur n'est pas agressé si le fichier est petit ou si les plages ne sont pas
supportées), avec redistribution dynamique. C'est exactement le comportement à
reproduire pour `WP-05` (et non « N connexions dès le départ »).

---

## 7. Assemblage final (Observé)

Séquence déduite des traces de `ChunksList::JoinFile` et des chaînes voisines :

1. `"Rebuilding old downloaded files before resume."` → `InsertFromReg` ;
2. `"Assembling all downloaded portions into one file..."` ;
3. `"Skip first bytes via temp file %s"` → saute l'en-tête déjà présent dans le fichier
   cible (cas d'une reprise sur fichier préexistant) ;
4. `"Rename temp file %s to %s."` / `"Rename2 temp file %s to %s."` puis
   `"Can not rename temp file %s, errno = %ld"` ;
5. `"Delete temp file %s"`, `"Delete old file %s"` ;
6. `RegDeleteKeyA` sur `ChList` (`0x15682c`) → l'état de reprise disparaît ;
7. cas d'échec disque : `"Not enough disk space to rebuild downloaded chunks."`,
   `"Disk is full. Cannot add next chunks."` ⇒ arrêt propre, **pas** de fichier
   partiel promu.

---

## 8. Spécificités HTTP du moteur (Observé)

| Sujet | Preuve |
|---|---|
| Plages | `Range: bytes=0-%I64d`, `Range: bytes=0-`, `Range: bytes=%I64d-`, `Range: bytes=%I64d-%I64d` |
| Réponse multi-plages | `Content-Range:`, `multipart/byteranges`, `multipart/x-byteranges` (poussés en `0x17d135` et `0x189619`) |
| Découpage en morceaux HTTP | `Transfer-Encoding:`, `chunked`, `"Recv transfer encoding chunked, size=0, eb:"` |
| Compression | `Accept-Encoding: identity` par défaut, `gzip, deflate` seulement en repli (l'identité garantit l'exactitude des offsets) |
| Fraîcheur | `If-Modified-Since: %s` + `HTTPConnection::OnNewLastModified` |
| Cookies | `ProcessSetCookieHeader`, `Cookie: ` |
| Authentification | `qop=%s, nc=%s, cnonce="%s", ` / `", opaque="%s"` (digest), `HTTPConnection::base64_encode` (basic), `Proxy-Authorization: ` |
| Proxy HTTPS | `CONNECT %s:%ld HTTP/1.1`, `HTTPConnection::HttpsProxyConnect` |
| Redirection | `HTTPConnection::setNewLocation` (`Location:`) |
| MMS | `MMSConnection`, `"Downloading via proxy server"`, `mmsPacketSize`, `mmsIndex` |

**Dérivé** : le moteur est conçu pour des transferts **reprenables octet-pour-octet**
(identité, `Range`, vérification de `Content-Range`), ce qui est incompatible avec une
négociation de compression. Toute implémentation qui accepterait `gzip` sur une
requête `Range` casserait la reprise : à retenir comme exigence.

---

## 9. Spécificités FTP (Observé — 58 verbes)

| Phase | Méthodes |
|---|---|
| Connexion | `TryConnect`, `CheckConnectReply`, `SendUser`, `CheckUserReply`, `SendPassword`, `CheckPasswordReply`, `BindSocket`, `Accept`, `ProcessPasvReply`, `ProcessPasvOK`, `OpenDataConnection`, `CloseDataConnection` |
| Négociation | `SendType`, `CheckTypeReply`, `SendSize`, `CheckSizeReply`, `GetFileSize`, `SendCWD`, `CheckCWDReply`, `SendPasv`, `SendPort`, `CheckPortReply`, `SendNoop`, `SendListFile`, `CheckListReply`, `RecvListData` |
| Transfert | `SendRest`, `CheckRestReply`, `SendRetr`, `CheckRetrReply`, `StartRetr`, `StartGetChunk`, `InsInChunksList`, `CheckTransferEndReply`, `SendQuit` |
| Reprise | `AuditForRestart`, `Restart`, `RollBack`, `FindSizeInRetrReply` |
| Capacités | `set_sequence_cpbl`, `try_set_pasv_cpbl`, `set_rest_cpbl`, `set_pass_need`, `set_MDTM`, `SendTestSequences`, `CheckOthersReplies` |
| Diagnostic | `"RETR failed."`, `"Trying to find file size in reply on RETR..."`, `"time %s, sizetype %d, size %I64d, name %s…"` |

**Dérivé** : FTP est le transport **le plus instrumenté** du binaire (58 noms, plus que
tout autre). La reprise y passe par `REST` + vérification de taille (`SIZE`/`MDTM`),
avec un `AuditForRestart` qui refuse la reprise si le serveur ne confirme pas.

---

## 10. Conséquences pour XDM

### D-024 — Le magasin de morceaux de XDM est un fichier annexe, pas le registre
**Décision** : XDM stocke l'état de reprise dans `<fichier>.xdm-part.json` (atomique,
versionné, lisible) au lieu d'une clé `Software\DownloadManager\<id>\ChList`.
**Justification** : le registre Windows n'existe pas sur les cibles visées ; le format
IDM est de toute façon inconnu dans le détail (A-11). Le fichier annexe voyage avec le
téléchargement, ce qui rend la reprise portable.
**Conséquence** : `WP-05` définit son propre schéma ; l'annexe 11 §2 (modèle de
données) devient la référence, le registre n'est plus qu'une preuve historique.

### D-025 — Vérification anti-corruption par empreinte, pas par comparaison brute
**Décision** : là où IDM compare les octets de recouvrement en mémoire (`Buff3`,
`w_st_o_n_cn`), XDM calcule une empreinte (SHA-256 par bloc de recouvrement) et compare
les empreintes.
**Justification** : même garantie fonctionnelle (détecter deux contenus divergents
entre connexions), coût mémoire constant et testable unitairement.
**Conséquence** : exigence « repli à une connexion » conservée (comportement observé
`"IDM started to download the file using one connection because of data corruption…"`)
et testable sans réseau réel.

### D-026 — Un fichier préalloué + carte de morceaux, pas un `.tmp` par morceau
**Décision** : XDM ouvre **un seul** fichier de travail préalloué et écrit chaque
morceau à son offset (`pwrite`), au lieu du schéma IDM « un `.tmp` par morceau puis
`JoinFile` ».
**Justification** : supprime l'étape d'assemblage (source de deux modes d'échec
observés : `"Can not rename temp file %s"`, `"Not enough disk space to rebuild
downloaded chunks."`), rend la reprise triviale (`ftruncate` + carte) et divise par
deux l'espace disque temporaire.
**Conséquence** : `ChunksList::JoinFile` n'a **pas** d'équivalent dans XDM ; `WP-05`
n'implémente que le rollback (`ftruncate`) — équivalent de `0x15ff52`.

---

## 11. Trous restants (à lever avant de coder `WP-05` en entier)

| ID | Question | Pourquoi c'est bloquant | Moyen |
|---|---|---|---|
| A-11 | Contenu exact d'un enregistrement `ChList` (binaire ? champs ?) | Aucun intérêt pour XDM (D-024) mais utile pour lire un `.gsd`/état existant | capstone sur `0x15f600` (checkpoint) |
| A-12 | ~~Énumération des états de `Connection`~~ **levée le 2026-10-27** : 39 états (0..38) sur `this+0xa4`, 8 distributeurs, 115 écritures (annexe 14 §4, `states.json`). Reste à nommer les états 17..27 (MMS/RTMP/sessions) | — | `tools/idman_states.py` |
| A-13 | Seuils : taille minimale de morceau, temporisations, nombre de tentatives | Détermine les valeurs par défaut de XDM | lecture des constantes voisines de `"Change chunk size to %ld"` |
| A-14 | Rôle de `HTTPConnection::MNSP` (message `Error %d … step1`) | Inconnu à ce jour | désassemblage ciblé |

Ces quatre points sont **non bloquants pour démarrer** : les décisions D-024→D-026
permettent d'écrire la spécification et les tests de `WP-05` avec des valeurs par
défaut assumées, puis de les réviser.

---

## 12. Ce qui est établi, en une phrase

IDM télécharge par **morceaux persistants** pilotés par un `SessionManager` non
polymorphe, chaque morceau appartenant à une `Connection` polymorphe
(HTTP/FTP/MMS/RTMP, avec variantes proxy) regroupée dans une `Session` par protocole ;
l'état de reprise vit dans le registre, les données dans des `.tmp` par morceau
assemblés à la fin, et la fiabilité repose sur une **comparaison de recouvrement** qui
peut dégrader le transfert à une seule connexion. XDM reprend le modèle logique
(morceaux, reprise, montée en charge progressive, repli) et remplace les trois
artefacts fragiles (registre, `.tmp` multiples, assemblage) par un fichier annexe, une
empreinte et un fichier préalloué.
