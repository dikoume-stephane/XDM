# 13 — Filtres du grabber et artefacts produits dans le dossier cible

> **Statut** : 🟢 v0.2 (A-08 / A-10 levées, A-09 ouverte) · **Dernière revue** : 2026-10-27
> **Reproductible** : `python3 tools/idman_filters.py` → `analysis/idman/filters.json`
> **Preuves** : désassemblage `capstone` (`tools/idman_args.py`), `classes.json`,
> chaînes voisines en `.rdata`. **Cible** : `IDMan.exe` `5f78da5a…2f11c9`.
> **Niveau** : chaque ligne est **Observé** (lu dans le code) ou **Dérivé**.

---

## 1. Le compteur de filtres est un `REG_DWORD` (Observé)

Fonction `GrbFsDlg::OnAddF` (`0xc2ba0`), séquence exacte des arguments :

| Instruction | API | Argument |
|---|---|---|
| `0xc2cb8`-`0xc2cce` | `RegCreateKeyExA` | `HKCU`, `"Software\DownloadManager\GrabberSts"`, `KEY_ALL_ACCESS` |
| `0xc2d36`-`0xc2d48` | `RegQueryValueExA` | valeur `"nextFilterID"` (lecture, type/cbData non contraints) |
| `0xc2da9` | `push 4` | **`cbData = 4`** |
| `0xc2db0` | `push 4` | **`dwType = 4` = `REG_DWORD`** |
| `0xc2db4` | `RegSetValueExA` | écrit l'identifiant **incrémenté** sous `"nextFilterID"` |
| `0xc2dc9` | `RegCloseKey` | — |

**Conclusion** : `nextFilterID` est un **entier 32 bits** utilisé comme séquence
d'identifiants de filtres. Chaque nouveau filtre reçoit `ancienne_valeur + 1`.
**H-17 est donc confirmée sur ce point** (filtres indexés), le format du *corps* du filtre
restant inconnu.

## 2. L'écran « Filters » présente deux listes (Observé / Dérivé)

Fonction `0x1378d0` (initialisation d'un dialogue) :

| Élément | Preuve |
|---|---|
| Chargement des listes | `mov` de `"IncludeFilters"` (`0x6a9f00`) et `"ExcludeFilters"` (`0x6a9ef0`) en `0x137f61`…`0x137f84` |
| Trois contrôles renseignés | `SetWindowTextA`/`SetWindowTextW` + identifiants `0x54d`, `0x54e`, `0x54f` (= 1357-1359) |
| Contenu affiché | texte d'un contrôle construit depuis la liste correspondante |

**Dérivé** : le dialogue « Filters » (ID de ressource 245, annexe 08 §4) montre
**inclusion et exclusion côte à côte**, avec un troisième champ (probablement le motif
saisi ou l'aperçu). Pour notre implémentation, cela justifie un modèle à deux listes
typées (`include` / `exclude`) plutôt qu'un unique champ « filtre » (voir annexe 11 §4).

## 2 bis. Le corps d'un filtre : `IDM_SPIDERFILTER`, 16 octets (Observé, `A-10`)

La structure est prouvée par `CArray<IDM_SPIDERFILTER>::SetAtGrow` en **`0xc2bc0`** : le pas
d'élément y est calculé par `shl esi, 4` (⇒ **16 octets**), puis les champs sont recopiés
un par un.

| Offset | Type | Sens | Preuve |
|---|---|---|---|
| `+0x0` | `CString` | **nom** du filtre (chaîne affichée) | copie via `ecx = esi` puis `call 0x405980` |
| `+0x4` | `CString` | **motif** (masque de fichiers, ex. `*.png`) | `lea ecx, [esi + 4]` + `call 0x405980` |
| `+0x8` | `int` | **identifiant** (celui de `nextFilterID`) | `mov dword ptr [esi + 8], edx` |
| `+0xC` | `BYTE` | **actif** (1 = enregistré/coché) | `mov byte ptr [esi + 0xc], al` ; le chargeur écrit toujours `1` |

Deux tableaux distincts portent les listes : `dialogue + 0x124` (inclusion) et
`dialogue + 0x138` (exclusion) — prouvé par les deux `lea ecx, [esi + 0x124]` /
`[esi + 0x138]` du destructeur (`0x137e56`, `0x137e66`) et du chargeur (`0x1387c7`,
`0x1387cf`).

**Correction de la v0.1** : la piste « le producteur du corps est à `0xc2e00`+ » était
fausse. `0xc2e00` est un **remplissage `int3`** suivi du code générique des templates
`CArray` (`0xc2e60` accesseur statique, `0xc2e80` constructeur, `0xc2ea0` `RemoveAt`,
`0xc2f00` destructeur) — code **fusionné par ICF**, donc partagé entre instantiations :
il ne dit rien de `IDM_SPIDERFILTER`. Les fonctions réelles sont `0xc2c10`
(`GrbFsDlg::OnAddF`, saisie) et `0x137f00` / `0x1385f0` (sérialisation / chargement).

### 2 ter. Identifiants de filtre (Observé)

`GrbFsDlg::OnAddF` = **`0xc2c10`** (et non `0xc2ba0`, qui n'est pas un début de fonction) :

| Instruction | Effet |
|---|---|
| `0xc2c69` `call 0x4c2450` | lit les champs saisis ; `al = 0` ⇒ abandon, rien n'est ajouté (`0xc2c70`) |
| `0xc2cce` `RegCreateKeyExA("Software\DownloadManager\GrabberSts")` | clé des réglages du grabber |
| `0xc2d48` `RegQueryValueExA("nextFilterID")` | lit le compteur |
| `0xc2cc9` `mov edi, 0x64` + `0xc2d5b` `cmp ebp, 2` | **valeur absente (`ERROR_FILE_NOT_FOUND`) ⇒ premier identifiant = 100** |
| `0xc2d58` `inc edi` | sinon **ancienne valeur + 1** |
| `0xc2dbe` `RegSetValueExA("nextFilterID", REG_DWORD, 4)` | écrit le compteur incrémenté |

## 3. Les éléments de liste portent au moins 0x24 octets (Observé)

Fonction `0x137600` : itère une liste stockée à `[edi + 0x23c]` via un accesseur
(`0x43c490`), lit un champ à `+0x04`, puis `add eax, 0x20` et lit un second champ.

**Dérivé** : la structure d'un élément de projet contient au minimum des champs à
`+0x04` et `+0x20` (taille ≥ `0x24`), ce qui est cohérent avec un enregistrement
« URL + drapeaux + taille + durée » du type de ceux vus en annexe 12 §2
(`nExpectedSize`, `FileSize`, `Duration`).

## 4. IDM dépose une page vide dans le dossier cible (Observé)

Fonction `0xd1ed0` :

1. construit `"%sempty.html"` (`0x68df3c`) à partir du dossier global d'IDM (`[0x75fc3c]`) ;
2. teste `GetFileAttributesW` : si le fichier **n'existe pas** (`-1`) ;
3. recopie **28 octets** d'une constante (`rep movsd`, `ecx = 7`) située en `0x68df20` ;
4. calcule la longueur (`strlen`) et écrit le fichier via le helper `0x624005`
   (`CreateFile`/écriture), puis ferme (`0x623e27`) ;
5. en cas d'échec, journalise un message formaté (`0x68def8`) dans l'objet `[0x76022c]`.

**Contenu exact écrit** (lu dans `.rdata`) :

```html
<HTML><BODY> </BODY></HTML>
```

**Dérivé** : cette page sert de **cible de remplacement** pour les liens d'un site aspiré
qui ne peuvent pas être téléchargés (page « vide » consultable hors ligne), et/ou de
détection de dossier déjà initialisé. À reproduire dans WP-23/WP-24 comme
« page de remplacement » configurable — **pas** comme dépendance à notre dossier
d'installation.

## 4 bis. Persistance des filtres : deux clés, une valeur `REG_SZ` par filtre (Observé, `A-10`)

**Sérialisation** (`0x137f00`, arg1 = 0 ⇒ exclusion, ≠ 0 ⇒ inclusion) :

| Étape | Preuve |
|---|---|
| Clé | `RegCreateKeyExA("Software\DownloadManager\GrabberSts\ExcludeFilters")` (`0x2a9f48`) ou `…\IncludeFilters` (`0x2a9f7c`) |
| Repartir de zéro | `RegDeleteKeyA` de la clé (même nom) avant de la recréer (`0x137f75`) |
| Parcours | tableau `+0x124` (inclusion) ou `+0x138` (exclusion), pas `add edi, 0x10` (`0x138098`) |
| Nom de valeur | `sprintf(buf, "%ld %s", element.id, element.motif)` (`"%ld %s"` en `0x284838`, site `0x13803e`) |
| Données | la chaîne `element.nom`, type **`REG_SZ`** (`push 1` en `0x13807e`), `cbData = strlen+1` |
| Écriture | `RegSetValueExA` (site `0x138084`) |

**Chargement** (`0x1385f0`) :

| Étape | Preuve |
|---|---|
| Clé choisie | `mov eax, 0x6a9f7c` (inclusion) / `0x6a9f48` (exclusion) puis `RegCreateKeyExA` |
| Capacité | `RegQueryInfoKeyA` → longueur max des valeurs, **repli `0x800`** si erreur (`0x1386a3`) |
| Énumération | boucle `RegEnumValueA` (slot `[0x678054]`), tampon de nom de `0x104` octets |
| Filtre de type | **type ≠ 1 (`REG_SZ`) ⇒ valeur ignorée** (`cmp dword ptr [esp + 0x30], 1`) |
| Identifiant | `sscanf(nom, "%ld", &id)` (`"%ld"` en `0x27a5fc`), **`id == 0` ⇒ ignoré** |
| Motif | `strchr(nom, ' ')` (0x20) ; motif de longueur < 2 ⇒ ignoré |
| Insertion | élément de 16 octets reconstruit sur la pile, `actif = 1`, puis `SetAtGrow` (`0xc2bc0`) |

**Conséquence** : un filtre tient en **deux chaînes et un entier** — rien de plus. La
« portée » (inclusion/exclusion) est portée par la **clé**, pas par l'enregistrement.

**Défauts observés** (littéraux du binaire) :

* exclusion par défaut : `*.html,*.htm,*.js,*.css,*.gif,*.jpg,*.jpeg,*.jpe,*.bmp,*.png,*.tif`
  (`0x2a9fb0`, 66 octets) ;
* réglages voisins dans la même zone : `nLevels` (`0x2a9f40`), `bAutoAddFOnCl` (`0x2a9f30`),
  `includeFilter`, `excludeFilter` (`0x2a9f20`, `0x2a9f10`).

## 5. Synthèse des acquis de cette passe

| Question (annexe 11 §5) | Réponse |
|---|---|
| `nextFilterID` : type ? | **`REG_DWORD`** (entier 32 bits incrémental), premier identifiant = **100** |
| Filtres : liste simple ou enregistrements ? | **enregistrements de 16 octets** (`IDM_SPIDERFILTER`), deux listes (inclusion / exclusion) |
| Corps d'un filtre | `CString nom` + `CString motif` + `int id` + `BYTE actif` |
| Persistance | `GrabberSts\IncludeFilters` / `\ExcludeFilters`, une valeur `REG_SZ` par filtre, nom = `"<id> <motif>"`, données = nom |
| Taille d'un élément de projet | ≥ `0x24` octets, champs à `+0x04` et `+0x20` |
| Artefact écrit dans le dossier cible | **`empty.html`** = `<HTML><BODY> </BODY></HTML>` |

## 6. Ce qui reste inconnu

| Question | Moyen de la trancher |
|---|---|
| ~~Format du corps d'un filtre~~ | ✅ levé (§2 bis et §4 bis, `A-10`) |
| Sémantique exacte du champ `actif` (`+0xC`) : « coché » ou « à appliquer » ? | observation UI sur VM (`A-09`) |
| Les listes de filtres d'un **projet** (`.gsd`) sont-elles les mêmes que celles du dialogue « Filters » ? | lire le sérialiseur `.gsd` (`0x12e471` = un `RegEnumValueA` voisin, `GrSh::…`) |
| `empty.html` : remplacement de liens morts **ou** marqueur d'initialisation ? | observer un dossier aspiré réel (VM) |
| Faut-il recopier `empty.html` dans XDM ? | décision produit → `JOURNAL` **D-023** |

---

## 7. Conséquences pour XDM (décisions)

### D-032 — Le filtre est une règle texte typée, pas un objet à portée
**Décision** : dans XDM, un filtre = `{ id: number, motif: string, type: "include" | "exclude", actif: boolean }`,
exactement la projection des 16 octets observés (`D-030` : aucune donnée de plus n'est
prouvée). Le motif est un masque glob (`*.png`), éventuellement une liste séparée par
des virgules (forme des défauts observés).
**Justification** : la structure observée ne contient que ces quatre champs ; inventer une
« portée » par filtre contredirait la preuve (la portée est la clé de registre).
**Conséquence** : `WP-11` définit sa validation (masque non vide, `id ≠ 0`, unicité),
et les tests reprennent les 11 motifs d'exclusion par défaut observés comme jeu de
départ.

### D-033 — Les filtres de XDM vivent dans le projet, pas dans le registre
**Décision** : `include`/`exclude` sont deux tableaux du projet `.xdmspider.json` (ou du
`.gsd` cloné), et non deux clés de registre ; l'identifiant est attribué par un compteur
persistant qui démarre à **100** comme celui observé.
**Justification** : portabilité (le registre n'existe pas sur les cibles visées) et
traçabilité (un projet = un fichier, cf. annexe 11). Le démarrage à 100 évite de
réutiliser les identifiants qu'un utilisateur aurait vus dans IDM, et simplifie la
reprise d'un projet importé.
**Conséquence** : migration d'un projet IDM = lecture des deux clés, écriture des deux
tableaux ; aucun fichier `.gsd` n'est nécessaire pour cela.

---

## 8. Journal des versions

| Version | Date | Changement |
|---|---|---|
| v0.1 | 2026-10-27 | `A-08` partiel : `nextFilterID` = `REG_DWORD`, deux listes, `empty.html` |
| v0.2 | 2026-10-27 | `A-10` levée : structure `IDM_SPIDERFILTER` (16 o), sérialisation `REG_SZ`, chargement, défauts, `D-032`, `D-033` ; correction de la piste `0xc2e00` |
