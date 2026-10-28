# 12 — Spécification du grabber (brouillon v0.2, WP-06)

> **⚠ Mise à jour 2026-10-27** : le §3 ci-dessous est **tranché** par l'annexe 11 — le
> projet est un fichier `.gsd` dans `<IDM>\Grabber\Projects\` (classe `GrSh`), le registre
> n'est qu'un état auxiliaire.
>
> **Statut** : 🟡 **brouillon partiel** — ce qui est prouvé par désassemblage ciblé, et
> rien de plus. **Dernière revue** : 2026-10-28. **Nouveau** : §6 mesure ce que le module
> contient réellement du grabber (`tools/idman_grabber.py` → `grabber.json`) et tranche une
> question de méthode : le moteur d'exploration **n'est pas localisable dans `IDMan.exe`**
> (`D-041`).
> **Preuves** : `classes.json` (annexe 10), `tools/idman_function.py`, désassemblage
> `capstone` des routines de persistance. **Cible** : `IDMan.exe` `5f78da5a…2f11c9`.
> **Rappel** : aucune de ces conclusions ne prouve un comportement *à l'exécution*.
> Le décompilateur (Ghidra) reste indisponible ici (`D-019`) : ce qui suit est lu dans
> le code machine, fonction par fonction, sans reconstruction de types.

---

## 1. Fait central : le projet de grabber est stocké **dans le registre**, pas dans un fichier

**Observé** dans la fonction `0x1bbea0` (419 instructions, un seul corps de fonction) :

| Élément | Preuve |
|---|---|
| Hive `0x80000001` = `HKEY_CURRENT_USER`, masque `0xf003f` = `KEY_ALL_ACCESS` | poussés avant chaque `Reg*` |
| API utilisées | `RegOpenKeyExA`, `RegCreateKeyExA`, `RegQueryValueExA`, `RegSetValueExA`, `RegQueryInfoKeyA`, `RegDeleteKeyA`, `RegCloseKey` |
| Clés formatées | `Software\DownloadManager\GrabberSts\Projects\%ld\%ld\ChList`, `…\GrabberSts\Projects\%ld\%ld`, `Software\DownloadManager\%ld\ChList`, `Software\DownloadManager\%ld` |
| Noms de valeurs | `LocalFileName`, `LocalPath`, `LogFileName` |

**Lecture de la séquence d'appels (Dérivé, confiance moyenne)** — la routine ressemble à
« **retirer un élément d'un projet de grabber** » :

1. ouvre `…\GrabberSts\Projects\<projet>\<élément>\ChList` ;
2. supprime la clé `…\GrabberSts\Projects\<projet>\<élément>` (`RegDeleteKeyA`) ;
3. lit une valeur puis `RegQueryInfoKeyA` (comptage d'éléments) sur la même clé ;
4. crée `Software\DownloadManager\<id>\ChList` (l'élément devient une **téléchargement
   ordinaire** dans la file principale) ;
5. recopie des valeurs (`RegQueryValueExA` → `RegSetValueExA`) : `LocalFileName`,
   `LocalPath`, `LogFileName` ;
6. supprime les clés devenues vides.

Autrement dit : **un élément de projet de grabber et un téléchargement partagent le même
schéma de valeurs**, et le grabber « promeut » ses éléments dans la file principale
(c'est le pendant exact de la chaîne d'interface « Add checked files to the main IDM list
and to the download queue », annexe 02 §B).

## 2. Schéma de données observé (noms de valeurs contigus en `.rdata`)

Zone mémoire autour de `0x688bf0` (VA), dans l'ordre du binaire :

```
ChList | nExpectedSize | Duration | FileSize | nAggrV | TPswitch | LocalFileName | LocalPath | LogFileName
```

**Interprétation prudente** :

| Nom | Type probable | Sémantique | Confiance |
|---|---|---|---|
| `ChList` | sous-clé | liste des fichiers d'un projet / d'un téléchargement | **Observé** (utilisé comme clé) |
| `FileSize` | DWORD/QWORD | taille attendue du fichier | Dérivé |
| `nExpectedSize` | DWORD | taille annoncée par le serveur (Content-Length) | Dérivé |
| `Duration`, `nAggrV`, `TPswitch` | numériques | métadonnées multimédia (durée, agrégat, bascule TP) | **Hypothèse** (`H-16`) |
| `LocalFileName`, `LocalPath` | chaînes | nom et chemin locaux | **Observé** (lus/écrits) |
| `LogFileName` | chaîne | journal d'exploration du projet | Dérivé |

> Ces noms apparaissent **contigus** dans la section de données, ce qui est cohérent avec
> une table de constantes partagée par le code de sérialisation — mais cela ne prouve pas
> que tous appartiennent au *même* enregistrement (voir §5).

## 3. Ce que le grabber **ne** stocke pas dans le registre (piste de fichier)

La fonction `0x156670` appelle `CreateFileW` puis `GetLastError`. Le chemin, construit
dynamiquement, n'est pas résolu par simple lecture de constante. Deux hypothèses
subsistent, et **H-08 reste donc ouverte** :

- (a) il s'agit d'un fichier annexe (journal du projet, `LogFileName`) ;
- (b) il s'agit d'un export/import de projet (dialogue 269 « Saving the project of IDM
  Grabber »).

Trancher demande soit un `RegQueryValueExA` complet dépilé, soit une exécution contrôlée.

## 4. Ce qui reste inconnu (à ne pas combler)

| Question | État | Moyen de la trancher |
|---|---|---|
| Format de `ChList` : sous-clés numérotées ? un blob binaire ? | **Inconnu** | lire le code qui énumère `ChList` (appelant de `RegQueryInfoKeyA`), ou observer le registre après une exploration |
| ~~Où sont stockés `IncludeFilters` / `ExcludeFilters`~~ | ✅ **levée le 2026-10-27** (`A-10`) : `GrabberSts\IncludeFilters` et `\ExcludeFilters`, une valeur `REG_SZ` par filtre (`"<id> <motif>"`), voir annexe 13 §4 bis | — |
| Comment le plan de site (arborescence explorée) est conservé | **Inconnu** | `CSpiderSiteMapDlg` / `CArray<IDMSPIDER_STRUCT_LI2>` |
| Algorithme d'exploration (BFS/DFS, profondeur, robots.txt) | **Inconnu** (`H-05`) | décompilation de `CIDMSpider` (1 seule méthode virtuelle : le gros du code est en méthodes non virtuelles) |
| Rôle de `nAggrV`, `TPswitch` | Hypothèse `H-16` | décompilation du producteur de ces valeurs |

## 5. Limites de ce brouillon

1. **Pas de reconstruction de types** : on lit des appels et des constantes, pas des
   structures. Les tailles/champs ne sont pas vérifiés.
2. **Une seule fonction analysée en profondeur** (`0x1bbea0`) ; les 3 autres
   (`0x156670`, `0x1b5c30`, `0x1d26b0`) n'ont livré que leurs API immédiates.
3. La contiguïté des noms de valeurs en `.rdata` est un indice, **pas** une preuve
   d'appartenance à un même enregistrement.
4. Aucune exécution : le comportement décrit est une **lecture du code**.

## 6. Artefacts du dossier cible

IDM dépose `empty.html` (`<HTML><BODY> </BODY></HTML>`) — voir annexe 13 §4 et la
décision `D-023` (XDM le génère dans le dossier du projet, en option).

## 7. Prochaines actions (WP-06)

| # | Action | Outil | Sortie attendue |
|---|---|---|---|
| 1 | Désassembler les appelants de `0x1bbea0` (xrefs) pour nommer l'action utilisateur | `tools/idman_function.py` + `classes.json` | table action UI → routine |
| 2 | Lire la boucle d'énumération de `ChList` (`RegQueryInfoKeyA` → clés numérotées ?) | capstone | format `ChList` |
| 3 | Analyser `CSpiderSettings` (`0x1381c0`) et `CGrabberFiltersDlg` | capstone | format des filtres |
| 4 | Comparer avec le registre réel sur une VM Windows (phase 6) | VM isolée | validation de §1-2 |

## 6. Où vit le grabber : mesures statiques (`grabber.json`)

> **Producteur** : `python3 tools/idman_grabber.py` → `analysis/idman/grabber.json`
> (déterministe). **But** : distinguer « le code est là et lisible » de « le code est là mais
> demande un décompilateur » et de « **le code n'est pas dans ce module** ». La distinction
> commande le plan (`D-041`), pas seulement l'effort.

### 6.1 Réglages du grabber : 10 champs, carte complète

Le chargeur de réglages `0x1381e0` lit `HKCU\Software\DownloadManager\GrabberSts` range
chaque valeur dans un champ de l'objet `CGrabberSettings` (construit par `0x137e20`) :

| Valeur de registre | Offset | Largeur | Écriture observée |
|---|---|---|---|
| `nATSTFiles` | `+0xb0` | 4 o | `0x138297` |
| `nLevels` | `+0xb8` | 4 o | `0x138270` |
| `bUseTL` | `+0x112` | 1 o | `0x138312` |
| `bUseIEC` | `+0x113` | 1 o | `0x13833c` |
| `bUseAdvWPP` | `+0x114` | 1 o | `0x138366` |
| `nDwnlATSTFiles` | `+0x11c` | 4 o | `0x1382be` |
| `bAutoAddFOnCl` | `+0x120` | 1 o | `0x138390` |
| `bDontShowCnfNameDlg` | `+0x121` | 1 o | `0x1382e8` |
| `includeFilter` | `+0x12c` | 4 o | `0x1383e0` |
| `excludeFilter` | `+0x140` | 4 o | `0x1384e4` |

**Observé** : la profondeur d'exploration est bien un **entier 32 bits** (`nLevels`, `+0xb8`),
et les deux listes de filtres sont chargées dans les deux sous-objets `CArray` construits en
`+0x124` et `+0x138` (`0x137e20`). **Non déterminé** : la **valeur par défaut** de `nLevels`
— le chargeur ne l'initialise pas (il ne l'écrit que si `RegQueryValueExA` réussit), et
l'initialisation par défaut n'a pas été localisée (`Q-B-03`). `nATSTFiles` /
`nDwnlATSTFiles` = nombre de fichiers explorés / téléchargés simultanément (« at the same
time »), ce que confirment les messages de validation voisins
(« Invalid number of files explored at the same time… »).

### 6.2 Conteneurs du spider : présents en RTTI, **aucun appel**

| Classe RTTI | Vtable | Méthodes | Réf. code | Réf. données |
|---|---|---|---|---|
| `CArray<IDMSPIDER_STRUCT_SPL>` | `0x28c738` | 3 | **0** | 0 |
| `CArray<IDMSPIDER_STRUCT_RL>` | `0x28c728` | 3 | **0** | 0 |
| `CArray<IDMSPIDER_STRUCT_LI2>` | `0x28c708` | 3 | **0** | 0 |
| `CList<IDMSPIDER_STRUCT_RELPARSERINFO, CParsersReleaseController>` | `0x2a37c0` | 3 | **0** | 0 |
| `CIDMSpider` | `0x28d0c0` | 1 | **1** (`0xc79ac`) | 0 |
| `IDMSPIDER_STRUCT_LINK_INFO` | `0x2844f8` | 1 | **0** | 0 |

**Lecture** : les structures qui porteraient un plan de site (`SPL` = *site page list*), les
listes de relations (`RL`) et les liens de second niveau (`LI2`) existent bien, mais aucune
méthode de conteneur n'est appelée directement dans `.text`, et aucune vtable n'est stockée
par du code. La seule référence à `CIDMSpider` est un `push 0x68d0c0` en `0xc79ac`, du type
« enregistrement de classe d'exécution », pas une instanciation suivie d'un parcours.

Deux explications restent ouvertes, et **aucune ne se tranche avec un décompilateur** :
(a) les opérations `CArray::Add`/`GetSize` sont **inline** dans l'en-tête MFC, donc invisibles
comme appels — mais alors le code qui les inline devrait référencer les mêmes structures de
données, ce qui n'est pas observé non plus ; (b) le moteur d'exploration vit dans **un autre
module** (le binaire référence `IDMGrHlp.exe` et enregistre les classes de fenêtres
« IDM Grabber Hidden Window », « IDM Grabber class », « IDM GrabberHlp class2 »).

### 6.3 Ce que le module contient réellement du grabber

| Élément | Preuve | Rôle |
|---|---|---|
| 4 boîtes de dialogue (`CSpiderOptionsDlg`, `CSpiderSelectNameDlg`, `CSpiderSelectSaveToDlg`, `CSpiderSettingsDlg`, `CSpiderSiteMapDlg`, `CSpiderWhereToSearchDlg`) | `grabber.json` §containers | interface |
| `CGrabberSettings` + 10 champs | §6.1 | configuration |
| Deux `CArray<IDM_SPIDERFILTER>` + `nextFilterID` | annexe 13 | filtres (implémentés, `D-032`/`D-033`) |
| Clés `…\GrabberSts\Projects\%ld\%ld[\ChList]`, chemins `%sGrabber\Projects\`, `%sproject%s.gsd` | `0x1bbea0`, `0xc3119`, `0xc3690`, `0xc33dd` | persistance du projet |
| `ptrSpider` — **32 références** code entre `0xdf9bf` et `0xdfb8a` | `grabber.json` §symbols | chargement d'une configuration « spider » (grappe de réglages, non décompilée) |
| Chaîne `robots` (`0x28b978`), **1 référence** code en `0xb2410` | `grabber.json` §symbols | politique `robots.txt` : existe, sémantique **non établie** (`Q-B-02`) |

### 6.4 Corollaire pour le transport : pas de WinINet de transfert

Les imports différés de `WININET.dll` sont **sept** et aucun ne transfère de données
(`GetUrlCacheEntryInfoW`, `InternetCrackUrlA`, `InternetCanonicalizeUrlA/W`,
`InternetSetCookieA`, `InternetCombineUrlA`, `InternetGetCookieA`). Le transfert passe par
`WS2_32.dll` (`socket`, `connect`, `select`, `recv`, `send`, `gethostbyname`) — ce qui
corrobore le réacteur `select` de l'annexe 14 (`A-13`, `D-028`) et **exclut** l'hypothèse
d'un grabber bâti sur les API WinINet de haut niveau.

### 6.5 Conclusion de méthode

Dans `IDMan.exe`, le grabber est **interface + configuration + persistance de projet +
filtres** ; le **moteur d'exploration** n'y est pas localisable par référence de code. Ce
n'est donc pas `Q-B-01` « à lire » mais `Q-B-01` **hors de portée de ce binaire** : un
décompilateur montrerait la même absence. La conséquence est une décision de périmètre
(`D-041`) : le grabber est **spécifié comme produit**, avec ses écarts assumés, au lieu
d'être présenté comme un clone fidèle d'un algorithme non observé.
