# 13 — Filtres du grabber et artefacts produits dans le dossier cible

> **Statut** : 🟡 v0.1 (A-08 / A-09) · **Dernière revue** : 2026-10-27
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

## 5. Synthèse des acquis de cette passe

| Question (annexe 11 §5) | Réponse |
|---|---|
| `nextFilterID` : type ? | **`REG_DWORD`** (entier 32 bits incrémental) |
| Filtres : liste simple ou enregistrements ? | **enregistrements indexés** (compteur dédié) + deux listes distinctes |
| Taille d'un élément de projet | ≥ `0x24` octets, champs à `+0x04` et `+0x20` |
| Artefact écrit dans le dossier cible | **`empty.html`** = `<HTML><BODY> </BODY></HTML>` |

## 6. Ce qui reste inconnu

| Question | Moyen de la trancher |
|---|---|
| Format du **corps** d'un filtre (motif, portée, activation) | lire `CArray<IDM_SPIDERFILTER>` (`0x137e00`) et le producteur écrit après `nextFilterID` (`0xc2e00`+) |
| `empty.html` : remplacement de liens morts **ou** marqueur d'initialisation ? | observer un dossier aspiré réel (VM) |
| Faut-il recopier `empty.html` dans XDM ? | décision produit → `JOURNAL` **D-023** |
