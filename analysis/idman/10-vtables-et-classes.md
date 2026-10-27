# 10 — Vtables, classes et attribution des comportements

> **Statut** : ✅ v1 (lot **WP-04**) · **Dernière revue** : 2026-10-27
> **Source de vérité** : `analysis/idman/classes.json` (généré par `tools/idman_classes.py`,
> 461 Ko, déterministe). Cette annexe est une **lecture** de ce fichier : en cas d'écart,
> le JSON et le script font foi.
> **Cible** : `cible/IDMan.exe`, SHA-256 `5f78da5a…2f11c9` (valable pour cette version seule).

---

## 1. Pourquoi cette annexe débloque la suite

REA ne peut pas décompiler ici : Ghidra/JDK sont **inaccessibles depuis ce sandbox**
(les releases GitHub redirigent vers `release-assets.githubusercontent.com`, non routé —
décision `D-019`). La roadmap prévoyait WP-04 (« classe RTTI → vtable → fonctions »)
comme prérequis de toute spécification. Ce lot est donc exécuté avec un outil maison
(capstone/pefile), sans exécuter la cible.

**Résultat** : 422 classes sur 439 ont une vtable résolue, 427 vtables, **13 760 méthodes**
virtuelles adressées, et 45 chaînes fonctionnelles rattachées à des classes ou des
fonctions (255 sites de référence).

---

## 2. Méthode (reproductible)

```
nom ".?AV<Classe>@@" (inline, en .data)
   └─ type_info = nom − 8            (vftbl(4), 0(4), nom inline)
       └─ COL = ref(VA type_info) − 12   (signature 0, offset, cdOffset, pTD, pCHD)
           └─ vtable = ref(VA COL) ; méthodes = les dwords .text qui suivent
```

Constats de format à conserver si la cible change :

| Fait vérifié | Conséquence |
|---|---|
| Les noms RTTI sont dans **`.data`** (pas `.rdata`) | un scan restreint à `.rdata` ne trouve rien |
| Tous les pointeurs stockés sont des **VA absolues** (image base `0x400000`) | indexer en RVA exige de soustraire l'image base |
| Le nom est **inline** dans le `type_info` | pas de pointeur vers la chaîne à chercher |
| Les `COL` sont suivis de la `CHD` (`pClassDescriptor`) puis des `BCD` | permet de valider chaque COL (3 contrôles indépendants) |
| Les vtables sont **contiguës** en `.rdata` | les comptes de méthodes élevés peuvent inclure la vtable voisine |

Contrôles appliqués à chaque classe : signature ∈ {0,1}, `pTD` = VA du type_info,
`pCHD` dans `.data`, et `ref(VA COL)` suivi d'au moins un pointeur `.text`.

Attribution d'une chaîne → fonction : `push imm32` (`0x68`) dont l'immédiat est la VA de
la chaîne ; deux bornes concurrentes sont rapportées : la **méthode de vtable** la plus
proche (frontière exacte) et le **prologue** `55 8B EC` le plus proche.
`classes_method` et `classes_prologue` sont séparés dans le JSON pour ne pas mélanger
les niveaux de confiance.

---

## 3. Comptages

| Mesure | Valeur |
|---|---|
| Noms RTTI | 439 |
| Classes avec vtable résolue | **422** (427 vtables) |
| Classes sans vtable dans ce module | 17 |
| Méthodes virtuelles adressées | **13 760** |
| Médiane de méthodes par vtable | 5 |
| Vtables à 1 seule méthode | 128 |
| Chaînes fonctionnelles localisées | 73 |
| Chaînes avec au moins une référence | 45 |
| Sites de référence (`push`) | 255 |

Les 17 classes non résolues sont toutes des **classes de base MFC/ATL** :
`CObject`, `CCmdTarget`, `CControlBar`, `CException`, `CDHtmlSinkHandler{,Base1,Base2}`,
`COleDialog`, `SE_Exception`, `_com_error`, et 7 templates ATL (`CStringT<wchar_t>`,
`CSimpleStringT`, `CComObjectRootEx<…>`, `IAccessibleProxyImpl<…>`, `CAccessibleProxy@ATL`).
Explication retenue (**Dérivé**) : MFC est lié **dynamiquement** (`mfcm90.dll`), donc ces
vtables vivent dans la DLL et non dans l'exécutable. Ce n'est pas une lacune de l'outil.

---

## 4. Attribution des comportements (lecture curatée)

Seules les lignes **cohérentes avec l'annexe 02** sont retenues ici ; la confiance est
celle du JSON (`élevée` = méthode de vtable seule, `moyenne` = méthode et prologue
concordants, `faible` = ambigu). Tout le reste est dans `classes.json` → `xrefs`.

| Chaîne / clé | Classes attribuées | Conf. | Lecture |
|---|---|---|---|
| `accept-ranges:`, `Content-Disposition:` | `HTTPConnection` | moyenne/faible | **le parsing d'en-têtes de plages vit dans `HTTPConnection`** |
| `Content-Range:`, `Content-Type:`, `chunked`, `multipart/byteranges` | `HTTPConnection` | moyenne | idem : c'est bien la classe de protocole HTTP |
| `Referer` | `HTTPConnection` (+ `CFirstParser`) | moyenne | en-tête forgé côté moteur |
| `Set-Cookie` | `CFirstParser` | moyenne | découpage des réponses (cookies) |
| `Software\DownloadManager\MCN` | `CMaxConnNumbers` | **élevée** | confirme la lecture des connexions par serveur (annexe 05 §4) |
| `Software\DownloadManager\Passwords` | `CPasswordsMap` | **élevée** | magasin d'identifiants de sites |
| `Software\DownloadManager\ProxyServers` | `CIDMProxySettings2`, `CSystemProxySettings2` | faible | deux couches : proxy IDM / proxy système |
| `Software\DownloadManager\Queue` | `CDownloadQueue` (+ onglets) | moyenne | file principale |
| `Software\DownloadManager\Scheduler` | `CScheduleGrabberDlg`, `CDownloadingTab` | moyenne | planification (grabber et téléchargements) |
| `Software\DownloadManager\GrabberSts` | `CSpiderSettings`, `CGrabberFiltersDlg`, `CSpiderSelectSaveToDlg`, `CArray<IDM_SPIDERFILTER>`, `CArray<IDMSPIDER_STRUCT_LI2>` | moyenne | **le grabber lit/écrit sa config depuis `CSpiderSettings` et ses filtres depuis `CGrabberFiltersDlg`** |
| `Software\DownloadManager\GrabberSts\Projects` | `CArray<IDMSPIDER_STRUCT_LI2>` | moyenne | la liste des projets est un tableau de structures `LI2` |
| `sporder.dll`, `Protocol_Catalog9` | `CBrowsersIntegration` | moyenne | l'installation du LSP Winsock est faite par le module d'intégration |
| `IDMNetMon.dll`, `IDMVMPrs.dll` | `CBrowsersIntegrator` | faible | les ponts navigateurs sont lancés par cette classe |
| `idmcchandler2.dll`, `com.tonec.idm` | `CArray<IDMSTRUCT_BROWSERINT>` | faible | table de descripteurs d'intégration navigateurs |
| `rtmp://`, `rtmpe://`, `rtmpt://`, `mms://`, `ftp://` | `CIDMLinkTransmitter`, `DownloaderCmdLine` | moyenne | schémas d'URL reconnus par le lanceur / transmetteur de liens |

### Ce que cette attribution **ne** donne **pas**

- `Software\DownloadManager\GrabberSts\Projects\%ld\%ld\ChList` : ses 7 sites de référence
  sont dans des fonctions **non virtuelles** (aucune vtable) → pas d'attribution de
  classe. C'est un indice fort que la **persistance du projet** est écrite par des
  helpers statiques (`Dérivé`), et une cible prioritaire pour la décompilation (WP-06).
- `IDMGrHlp.exe` est référencé par `CBrowsersIntegrator` et `CDownloaderDlg`, **pas** par
  les classes du grabber → **H-15 s'affaiblit** : ce module semble lié à l'intégration,
  pas au worker de çonage. À confirmer par les arguments de `CreateProcess`.
- Aucune attribution n'est une preuve d'**exécution** : elle dit « cette chaîne est
  référencée par du code contenu dans cette fonction », pas « ce chemin est emprunté ».

---

## 5. Vérification indépendante (échantillon)

| Contrôle | Résultat |
|---|---|
| `CIDMSpider` → 1 vtable, 1 méthode (`0xd98a0`) | cohérent avec une classe non dérivée de `CObject` |
| `CDownload` → 89 méthodes | classe riche : états, reprise, compteurs, callbacks |
| `CWinApp` → 46 méthodes | attendu pour la classe d'application MFC |
| Chaîne HTTP (`accept-ranges:`) → `HTTPConnection` | recoupe l'annexe 03 §5 |
| Clé `MCN` → `CMaxConnNumbers` | recoupe l'annexe 05 §4 et l'hypothèse H-04 |

Reproduction :

```bash
python3 tools/idman_classes.py                 # -> analysis/idman/classes.json
python3 - <<'PY'
import json; d = json.load(open('analysis/idman/classes.json'))
print(d['counts'])
print([x['string'] for x in d['xrefs']][:10])
PY
```

---

## 6. Limites et prochaines étapes

1. **Bornes de fonctions approximatives** hors vtables : le repérage par prologue
   `55 8B EC` rate les fonctions optimisées sans frame pointer (`push esi/edi` en tête).
   Correctif prévu : détection par remplissage (`CC/90`) + désassemblage linéaire avec
   capstone, ou Ghidra dès qu'un décompilateur est disponible.
2. **Comptes de méthodes gonflés** pour les vtables contiguës : la borne haute n'est pas
   fiable ; seules les premières entrées sont certaines.
3. **Pas de décompilation** : les 13 760 adresses sont des points d'entrée, pas du code
   lisible. Les spécifications (WP-05/06) exigeront soit Ghidra, soit une lecture
   manuelle ciblée (capstone) sur les fonctions prioritaires — liste ci-dessous.
4. **Priorités de décompilation** (issues de cette annexe) :
   `CSpiderSettings` (`0x1381c0`), `CGrabberFiltersDlg`, `CSpiderSelectSaveToDlg`,
   helpers non virtuels de `…\Projects\%ld\%ld\ChList` (`0x156670`, `0x1b5c30`,
   `0x1bbea0`, `0x1d26b0`), `CDownload` (`0x1f7131`…), `HTTPConnection`.
