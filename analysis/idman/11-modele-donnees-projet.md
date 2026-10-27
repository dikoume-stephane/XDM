# 11 — Modèle de données du projet de grabber (brouillon v0.1, WP-11)

> **Statut** : 🟡 brouillon (A-06) · **Dernière revue** : 2026-10-27
> **Preuves** : désassemblage `capstone` (`tools/idman_args.py`), `classes.json`,
> chaînes voisines en `.rdata`. **Cible** : `IDMan.exe` `5f78da5a…2f11c9`.
> **Niveau** : chaque ligne est étiquetée **Observé** (lu dans le code) ou **Dérivé**.

---

## 1. Résultat principal : projet = **fichier `.gsd`** + miroir registre

**Observé** dans la fonction `0xc30??` (classe `GrSh`, « Grabber Shell ») et son voisin
`0xc31a0` :

| Élément | Preuve |
|---|---|
| Modèle de chemin | `"%sGrabber\\Projects\\"` (`0x68c96c`), préfixé par le dossier global d'IDM (`[0x75fc3c]`/`0x75fc40`) |
| Création du dossier | `GetFileAttributesW` → si absent, `mkdir` (`0x622ff0`, séparateur `'\'` = `0x5c`) |
| Modèle de nom | `"%sproject%s.gsd"` (`0x68c948`) — deux `%s`, formatés par `sprintf` (`0x402320`) |
| Erreurs propres | `"GrSh::CFN exc 111"`, `"GrSh::Lk exc 164"`, `".gsd"` (voisins immédiats en `.rdata`) |

**Conclusion (Dérivé, confiance élevée)** : un projet de grabber est un **fichier `.gsd`**
dans `<dossier IDM>\Grabber\Projects\`, dont la fonction `GrSh` assure la création
(`CFN` ≈ *CreateFile*), le verrouillage (`Lk` ≈ *Lock*) et la gestion d'exceptions.
L'extension `.gsd` = **G**rabber **S**ite **D**… (nommage interne, non documenté).

**Correction d'une conclusion antérieure** : l'annexe 12 §3 laissait ouverte la piste du
fichier ; elle est maintenant **tranchée** : le fichier existe, le registre ne contient
que l'état auxiliaire (annexe 12 §1). **H-08 passe de « ouverte » à « confirmée ».**

## 2. Ce que le registre contient (état auxiliaire, pas le projet)

| Clé / valeur | Rôle | Preuve |
|---|---|---|
| `HKCU\Software\DownloadManager\GrabberSts` | racine d'état du grabber | `RegCreateKeyExA` avec `KEY_ALL_ACCESS` dans `GrbFsDlg::OnAddF` (`0xc2ba0`) et `CSpiderSettings` (`0x1381e0`) |
| `…\GrabberSts\nextFilterID` | **compteur d'identifiants de filtres** | `RegQueryValueExA` puis `RegSetValueExA` sur `"nextFilterID"` (0xc2d3a / 0xc2db4) |
| `…\GrabberSts\{IncludeFilters, ExcludeFilters}` | listes de filtres | chaînes en `.data` + `CArray<IDM_SPIDERFILTER>` (annexe 10) |
| `…\GrabberSts\Projects\%ld\%ld[\ChList]` | **miroir de travail** d'un élément de projet (valeurs nommées) | boucle `RegEnumValueA` dans `0x1bbea0` (annexe 12 §1) |
| `…\GrabberSts\RecentProjects` | liste des projets récents | chaîne + `CRebootProgress` (attribution faible) |

**Dérivé** : `nextFilterID` implique que chaque filtre est identifié par un entier
croissant — les filtres ne sont donc pas de simples listes de chaînes mais des
**enregistrements indexés** (`IDM_SPIDERFILTER`).

## 3. Ce qui distingue un élément de projet d'un téléchargement

La promotion d'un élément vers la file principale réutilise les mêmes noms de valeurs
(`LocalFileName`, `LocalPath`, `LogFileName`) et le même sous-nom `ChList` : **la
structure d'un élément de grabber est un sur-ensemble de celle d'un téléchargement**
(annexe 12 §1). Conséquence pour notre modèle : un seul type « tâche » avec un champ
`origine ∈ {manuel, grabber}` évite d'écrire deux schémas.

## 4. Modèle proposé pour XDM (indépendant du format binaire d'IDM)

```text
Project
├─ id            (entier, incrémental — cf. nextFilterID)
├─ name          (chaîne, utilisée dans <name>project<…>.gsd)
├─ root_url      (URL de départ)
├─ filters       [Filter]
├─ sitemap       Sitemap        (pages découvertes, arbre)
├─ entries       [Entry]        (fichiers retenus, cochés/décochés)
└─ schedule      Schedule?      (annexe 02 §G)

Filter { id, pattern, actif }        // la portée est la liste qui le contient (D-032)
Sitemap { nodes: [ { url, depth, status, content_type, size } ] }
Entry { url, local_path, local_file_name, expected_size, status, log }
```

> Ce schéma est **notre** choix de conception (D-015) : il s'inspire des noms observés
> (`ChList`, `nExpectedSize`, `LocalPath`, `LogFileName`) sans prétendre reproduire le
> binaire `.gsd`, dont le format est **inconnu** (aucun décompileur disponible, `D-019`).

## 5. Ce qui reste inconnu

| Question | État | Moyen |
|---|---|---|
| Format binaire de `.gsd` (en-tête, version, sérialisation MFC `CArchive` ?) | **Inconnu** | observer un fichier réel (VM) ou décompiler `GrSh` |
| Ordre exact des deux `%s` de `"%sproject%s.gsd"` | **Dérivé** : `(nom, identifiant)` | lire le producteur du 1er argument (`0x6241e2`, format `%d`) |
| Format de `ChList` : valeurs nommées de 8/16 octets (observé), rôle de chaque nom | **Partiel** | lire les producteurs (`0x1b5c30`, `0x1d26b0`) |
| ~~Sémantique exacte d'un filtre~~ | ✅ **levée le 2026-10-27** (`A-10`) : un filtre = 16 octets `{CString nom, CString motif, int id, BYTE actif}`, motif = masque glob ; portée portée par la **liste** (clé de registre) | annexe 13 §2 bis et §4 bis |
| Plan de site persistant ou recalculé à chaque session | **Inconnu** | `CArray<IDMSPIDER_STRUCT_LI2>` (`0xd1eb0`), qui écrit aussi `%sempty.html` |

## 6. Prochaines actions

1. ~~Lire `0xc2450` (« Filters ») et `CArray<IDM_SPIDERFILTER>` pour le format d'un filtre.~~
   ✅ fait : voir annexe 13 §2 bis / §4 bis (`D-032`, `D-033`).
2. Lire `0xd1eb0` : il manipule `%sempty.html` et `GetFileAttributesW` → probablement la
   génération d'une **page d'index vide** dans le dossier cible (comportement à spécifier).
3. Sur VM Windows (phase 6) : créer un projet, récupérer le `.gsd`, le dumper en hexadécimal
   et le comparer à notre modèle.
