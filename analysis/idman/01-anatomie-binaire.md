# 01 — Anatomie binaire

> **Statut** : ✅ complet (statique) · **Dernière revue** : 2026-10-26
> **Sources** : `EV-triage-*`, `EV-inspect-*`, `EV-objdump-*` (voir `00-preuves.md`).
> **Niveau** : toutes les lignes ci-dessous sont **Observé** sauf mention « Dérivé ».

## 1. En-têtes

| Champ | Valeur | Lecture |
|---|---|---|
| Format | PE32 (`0x10b`) | 32 bits |
| Machine | `0x014c` (i386) | x86 |
| Caractéristiques | `0x0102` | `EXECUTABLE_IMAGE`, `32BIT_MACHINE` |
| Sous-système | `2` (GUI) | application de bureau Windows |
| `DllCharacteristics` | `0x8140` | `DYNAMIC_BASE` (ASLR), `NX_COMPAT` (DEP), `TERMINAL_SERVER_AWARE` |
| Image base / entry | `0x00400000` / `0x229d6e` | entrée C++ runtime → `WinMain` |
| Taille | 6 017 024 o | 1 024 o d'en-têtes + 6 016 000 o de sections |
| Checksum PE | `0x5c7c0c` | cohérent (téléchargement intact) |
| Horodatage | 2024-09-16 19:19:45 UTC | build de la version 6.42.22 |

**Mitigations manquantes** (Observé) : pas de `GUARD_CF` (Control Flow Guard),
pas de `HIGH_ENTROPY_VA`. En revanche `/GS`
(cookie `0x75a898`) et **SafeSEH** sont actifs (table SEH de **2 245 entrées**,
`EV-inspect-pe-load-config`).

## 2. Sections

| Section | VA | Virtuel | Brut | Entropie | Drapeaux | Rôle |
|---|---|---|---|---|---|---|
| `.text` | `0x1000` | 2 581 852 | 2 582 016 | **6.586** | code · exéc · lecture | cœur applicatif (~2,5 Mo de code) |
| `.rdata` | `0x278000` | 897 126 | 897 536 | 5.193 | lecture | constantes, chaînes, vtables, imports |
| `.data` | `0x354000` | 70 748 | 33 280 | 4.767 | lecture/écriture | globals (dont cookie `0x75a898`) |
| `.rsrc` | `0x366000` | 2 283 328 | 2 283 520 | 5.502 | lecture | **2,28 Mo de ressources** (diagrammes, icônes, dialogues, chaînes) |
| `.reloc` | `0x594000` | 219 168 | 219 648 | 6.177 | lecture, jetable | 219 Ko de relocations → ASLR réellement utilisable |

**Aucune section n'est à la fois inscriptible et exécutable** ; `.reloc` est
`MEM_DISCARDABLE`. Aucune donnée après la dernière section (pas d'overlay).

## 3. Empaquetage / obfuscation : aucun (Dérivé, confiance élevée)

- Entropie globale **6.3884** vs seuil haut 7.2 (`EV-inspect-byte-entropy`) ; max par
  section 6.586 → code compilé classique, pas de packer.
- Taille de `.text` cohérente avec du MFC statique + logique métier (2,5 Mo).
- 439 noms RTTI et 14 384 chaînes lisibles en clair → aucun chiffrement de chaînes
  global.
- Importations complètes (620 fonctions) visibles, pas de résolution dynamique
  exclusive.

**Conséquence de planification** : Ghidra peut attaquer le binaire directement ; aucune
phase de désobfuscation n'est nécessaire (`JOURNAL.md` D-008).

## 4. Chaîne de compilation (Dérivé)

| Indice | Valeur | Interprétation |
|---|---|---|
| Import `mfcm90.dll` | MFC 9.0 | Visual Studio 2008 (SP1) |
| PDB | `s:\IDM_projects\IDM_vs2008_2\Release\IDMan.pdb` | projet `IDM_vs2008_2`, configuration `Release`, lecteur `S:` |
| RTTI | `. ?AVCStringT@DV?$StrTraitMFC@…@ATL@@`, `AFX_MODULE_STATE` | C++/MFC + ATL, RTTI activé |
| Rich header | présent (`Rich`/`DanS`) | en-tête d'outils MSVC non nettoyé |
| Symboles | `SYMBOL TABLE: no symbols` | PDB non livré → pas de noms de fonctions |

> Piste : parser le *Rich header* (clé XOR connue) donnerait le **numéro de build exact
> de MSVC** (produit/version). Non fait ici : apport faible pour le clonage, à
> mentionner si l'on doit dater précisément le compilateur.

## 5. Importations

**Importations statiques (509 fonctions, 7 DLL)**

| DLL | Fonctions | Ce que cela implique |
|---|---|---|
| `KERNEL32.dll` | 208 | threads, fichiers, mémoire, sync, locale |
| `USER32.dll` | 188 | fenêtres, messages, hooks (`SetWindowsHookExA`) |
| `GDI32.dll` | 62 | rendu des contrôles MFC |
| `ADVAPI32.dll` | 39 | registre (`Reg*` complet), services, sécurité |
| `SHLWAPI.dll` | 5 | chemins/URL (`Path*`, `StrCmp*`) |
| `COMDLG32.dll` | 5 | boîtes fichier/couleur |
| `COMCTL32.dll` | 2 | contrôles communs (ListView/TreeView via MFC) |

**Delay-load (111 fonctions, 7 DLL)** — chargées seulement à l'usage, ce qui est un
indice d'architecture :

| DLL | Fonctions | Interprétation |
|---|---|---|
| `WS2_32.dll` | 23 | pile réseau directe (sockets) — **c'est ici que vit le transfert réel** |
| `ole32.dll` / `OLEAUT32.dll` | 32 / 26 | COM : shell, drag&drop, automation |
| `SHELL32.dll` | 20 | intégration Explorateur, icônes, menus |
| `WININET.dll` | 7 | API HTTP WinInet (utilisée pour des cas de bord, pas pour le moteur) |
| `OLEDLG.dll`, `OLEACC.dll` | 1 / 2 | boîtes OLE, accessibilité |

**Imphash** (pefile) : `ccbcd3b80e9c1172fbf90eb66a5d86f0` → empreinte de la version,
utile pour détecter d'autres builds d'IDM et comparer.

**Absences notables** (Observé) : pas de `WinHTTP.dll`, pas de `CRYPT32.dll` en import
statique, pas de `urlmon.dll`. Le chiffrement TLS est vraisemblablement délégué à
`schannel.dll` **chargé dynamiquement** (`schannel.dll` apparaît en chaîne — annexe
04) et/ou aux modules `IDMNetMon.dll` / `IDMIECC.dll`.

## 6. Exports, signature, .NET

| Question | Réponse | Réf. |
|---|---|---|
| Exportations | **aucune** | `EV-inspect-native-exports` |
| Signature Authenticode embarquée | **aucune** table | `EV-inspect-pe-certificates` |
| .NET / CIL | **non managé** | `EV-inspect-managed-artifact` |
| TLS callbacks | **aucun** | `EV-inspect-pe-load-config` |

L'absence de signature sur ce fichier ne préjuge pas de la version distribuée par
l'éditeur (les installeurs signent généralement l'exécutable) : la cible du dépôt est
peut-être un extrait ou un rebuild. **À noter comme risque de représentativité** (R-09,
à ajouter au journal si confirmé).

## 7. Ressources (436 entrées)

| Type | Nombre | Usage pour le clonage |
|---|---|---|
| `BITMAP` | 174 | habillage des barres/panneaux de progression |
| `DIALOG` | **105** | **carte de l'interface** : chaque dialogue nomme une fonction (annexe 02) |
| `ICON` / `GROUP_ICON` | 48 / 24 | icônes (fichiers, états, navigateurs) |
| `STRING` | 37 tables → **156 chaînes** | infobulles/menus : décrivent les actions en clair |
| `CURSOR` / `GROUP_CURSOR` | 16 / 15 | curseurs de drag&drop |
| `TOOLBAR` | 3 | barres d'outils |
| `DLGINIT` | 3 | valeurs initiales de contrôles |
| `MENU` | 2 | menus contextuels partiels (catalogue de commandes) |
| `HTML` | 1 | page embarquée (aide/à propos) |
| `MANIFEST` | 1 | manifeste d'application (thème, élévation) |
| `VERSION` | 1 | `FileVersion 6, 42, 22, 3`, `Tonec Inc.`, `© 1999-2024` |
| `NAMED:IMAGE` / `NAMED:PNG` | 5 / 1 | types de ressources propres à IDM (à examiner, `H-09`) |

**Note importante** : 2,28 Mo de ressources pour 6 Mo de binaire → l'UI pèse plus lourd
que le code réseau. Cela confirme la stratégie `D-007` : cloner le *comportement*, pas
l'interface.

## 8. Limites de cette annexe

- Aucune attribution classe/fonction (pas encore de vtables → `H-01`).
- Les « interprétations » de la colonne droite des imports sont des **Dérivés**
  plausibles, pas des observations d'appels.
- Rien ici ne prouve un comportement à l'exécution : la cible n'a jamais été lancée.
