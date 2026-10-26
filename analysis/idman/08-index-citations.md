# 08 — Index des citations (offsets, IDs, reproduction)

> **Statut** : ✅ v1 · **Dernière revue** : 2026-10-26
> **Rôle** : permettre de **rejouer** n'importe quelle citation des annexes 01-06 sur le
> fichier, sans dépendre d'un outil particulier.
> **Cible** : `cible/IDMan.exe`, SHA-256 `5f78da5a…2f11c9`, 6 017 024 octets.

## 1. Conversion RVA ↔ offset fichier

Sections (Observé, `triage.json` §sections) :

| Section | RVA | Offset brut | Formule valable dans la section |
|---|---|---|---|
| `.text` | `0x001000` | `0x000400` | `offset = RVA − 0xC00` |
| `.rdata` | `0x278000` | `0x278400` | `offset = RVA + 0x400` |
| `.data` | `0x354000` | `0x354400` | `offset = RVA + 0x400` |
| `.rsrc` | `0x366000` | `0x366400` | `offset = RVA + 0x400` |
| `.reloc` | `0x594000` | `0x594400` | `offset = RVA + 0x400` |

Vérification : `image base 0x400000 + RVA 0x229d6e` = `0x629d6e`, identique au
`start address 0x00629d6e` d'`objdump` (`EV-objdump-file_headers`) → formule cohérente.

## 2. Chaînes structurantes (offsets **exacts** dans le fichier)

| Chaîne | ASCII | UTF-16 | Où c'est utilisé |
|---|---|---|---|
| `IDM Site Grabber` | `0x297d40` | `0x36aaf8` | annexe 02 §B, preuve du périmètre |
| `Settings of IDM Grabber` | — | `0x36c4b6` | dialogue 262 |
| `Schedule the grabber project` | `0x298180` | `0x36e2b6` | dialogue 284 |
| `Template Name` | — | `0x36d08e` | dialogue 268 |
| `Load project` | — | `0x36d35e` | dialogue 270 |
| `Grabber Statistics` | — | `0x36d436` | dialogue 271 |
| `GrabberSts` | `0x28b281` | — | arbre de registre du grabber |
| `IncludeFilters` | `0x2a8900` | — | filtres d'inclusion |
| `ExcludeFilters` | `0x2a88f0` | — | filtres d'exclusion |
| `ChList` | `0x287600` | — | liste cochée d'un projet |
| `RecentProjects` | `0x2a49bc` | — | projets récents |
| `com.tonec.idm` | `0x27be78` | — | nom d'hôte de messagerie native |
| `SOFTWARE\Google\Chrome\NativeMessagingHosts\com.tonec.idm` | `0x27bf4c` | — | déclaration Chrome |
| `mozilla_cc3@internetdownloadmanager.com.xpi` | `0x27bac9` | — | extension Mozilla |
| `idmmzcc3.xpi` | — | `0x27bb28` | extension (variante) |
| `sporder.dll` | `0x27abf0` | — | réordonnancement LSP |
| `SYSTEM\…\Protocol_Catalog9\Catalog_Entries` | `0x27ab30` | — | catalogue Winsock |
| `SYSTEM\…\SecurityProviders\SCHANNEL\Protocols` | `0x27af48` | — | réglages TLS |
| `SOFTWARE\Internet Download Manager` | `0x278810` | `0x2a54b8` | racine des réglages |
| `IDMNetMon.dll` | — | `0x27d2b8` | module de surveillance réseau |
| `IDMVMPrs.dll` | — | `0x27cf58` | analyseur média |
| `idmcchandler2.dll` | `0x27c034` | `0x27bff8` | cache navigateur |
| `IDMGrHlp.exe` | `0x27bbca` | `0x27d128` | worker supposé du grabber (`H-15`) |
| `idmnmcl.dll` | `0x284172` | `0x284438` | client de messagerie native |
| `bytes=%I64d-%I64d` | `0x27e1b1` | — | **format exact** des en-têtes `Range` |
| `multipart/byteranges` | `0x2b08d4` | — | réponses multi-plages |
| `#EXTM3U` | `0x2b2790` | — | playlists HLS |
| `#EXT-X-MAP:` | `0x2b27c8` | — | segment d'initialisation fMP4 |
| `#EXT-X-BYTERANGE:` | `0x2b27f8` | — | segments par plage |
| `#EXT-X-KEY:` | `0x2b2828` | — | chiffrement HLS (AES-128 possible) |
| `s:\IDM_projects\IDM_vs2008_2\Release\IDMan.pdb` | `0x30d4d0` | — | chaîne de build (debug directory) |

## 3. Classes RTTI (échantillon : nom → offset du nom dans `.rdata`)

| Classe | Offset | Domaine (annexe 02) |
|---|---|---|
| `.?AVCDownload@@` | `0x3528cc` | A — moteur |
| `.?AVCIDMSpider@@` | `0x3538b0` | B — grabber |
| `.?AVCM3UParser@@` | `0x3552e8` | D — médias |
| `.?AVCIDMDatabase@@` | `0x356b38` | F — persistance |
| `.?AVCRegistration@@` | `0x3543bc` | **gelé** (D-004) |

`grep` de l'offset `+ len(nom)` amène au `type_info` suivant : les **vtables** sont dans
`.rdata` à proximité (WP-04).

## 4. Ressources : IDs à connaître

| Type | ID | Légende / usage | Annexe |
|---|---|---|---|
| `DIALOG` | 239, 241 | « IDM Site Grabber » (fenêtre principale du grabber) | 02 §B |
| `DIALOG` | 262 | « Settings of IDM Grabber » | 02 §B |
| `DIALOG` | 244, 245 | « Filters » / « Filter » | 02 §B |
| `DIALOG` | 268, 269, 270, 271 | Template Name / Saving the project / Load project / Grabber Statistics | 02 §B |
| `DIALOG` | 284 | « Schedule the grabber project » | 02 §B / G |
| `DIALOG` | 279 | « Connecting to the site » | 02 §B |
| `DIALOG` | 103 | « Download progress » | 02 §A |
| `DIALOG` | 226 | « Max. connections number for a server » | 02 §A |
| `DIALOG` | 194 | « Download limits exceeded! » | 02 §A |
| `DIALOG` | 296, 297, 334, 335, 381, 489 | intégration navigateurs | 02 §E, 05 |
| `MENU` | 129, 256 | modèles partiels (MFC recharge le reste à l'exécution) | 02 §H |
| `STRING` | 37 tables | 156 chaînes d'aide/menus | 02 §H |
| `VERSION` | 1 | `FileVersion 6, 42, 22, 3` | 01 §1 |
| `NAMED:IMAGE` / `NAMED:PNG` | 5 / 1 | blobs non standard → `H-09` | 01 §7 |

Liste exhaustive : `analysis/raw/idman/dialog-captions.txt` (105 lignes `id<TAB>légende`).

## 5. Reproduction pas à pas

```bash
# 1. Preuves REA (bundles Evidence, non versionnés)
bash tools/collect-idman-evidence.sh          # -> analysis/raw/idman/*.json

# 2. Agrégats déterministes versionnés
python3 tools/idman_triage.py                 # -> analysis/idman/triage.json

# 3. Extractions brutes pour citation
python3 tools/idman_extract.py                # -> analysis/raw/idman/{strings,rtti,rt-string,dialogs,menus}

# 4. Vérifier un offset (exemple : format Range)
python3 - <<'PY'
raw = open('cible/IDMan.exe','rb').read()
print(raw[0x27e1b1:0x27e1b1+20])   # b'bytes=%I64d-%I64d\x00'
PY
```

## 6. Pièges de citation

1. **Ne pas** compter les occurrences sur les octets bruts : `quic` apparaît dans
   `application/x-quicktimeplayer`, `range` dans des libellés d'interface. Compter sur
   les chaînes extraites avec un contexte visible.
2. Les offsets UTF-16 ne coïncident pas avec les offsets ASCII : `IDM Site Grabber` est à
   `0x297d40` (ASCII, `.rdata`) et `0x36aaf8` (UTF-16, `.rsrc`).
3. Un offset valide pour la version 6.42.22.3 **ne l'est pas** pour une autre version :
   citer le SHA-256 avec l'offset.
