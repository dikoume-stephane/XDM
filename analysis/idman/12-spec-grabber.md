# 12 — Spécification du grabber (brouillon v0.1, WP-06)

> **⚠ Mise à jour 2026-10-27** : le §3 ci-dessous est **tranché** par l'annexe 11 — le
> projet est un fichier `.gsd` dans `<IDM>\Grabber\Projects\` (classe `GrSh`), le registre
> n'est qu'un état auxiliaire.
>
> **Statut** : 🟡 **brouillon partiel** — ce qui est prouvé par désassemblage ciblé, et
> rien de plus. **Dernière revue** : 2026-10-27.
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
