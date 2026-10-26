# 00 — Registre des preuves

> **Statut** : ✅ à jour · **Dernière revue** : 2026-10-26 ·
> **Cible** : `cible/IDMan.exe`, SHA-256 `5f78da5a63604a3fefba6577ef6b2af976ec4d2fc4d0f219a72099a0da2f11c9`
> **Règle** : toute affirmation des annexes 01-13 doit citer une ligne de ce registre ou
> un offset de l'annexe 08.

## 1. Bundles REA (autorité principale)

Collecte : `bash tools/collect-idman-evidence.sh` → `analysis/raw/idman/<nom>.json`.
Les `evidence_id` sont **déterministes** (même cible ⇒ même identifiant), donc citables.

| Réf. | Commande REA | `evidence_id` (tronqué) | Ce que la preuve établit | Limites déclarées (extrait) |
|---|---|---|---|---|
| `EV-inspect-artifact` | `rea inspect-artifact` | `ev_1115764e2622f6c0…` | Inventaire de l'artefact : format `pe`, manifeste, digest | inventaire seul, aucune sémantique |
| `EV-inspect-pe-imports` | `rea inspect-pe-imports` | `ev_933b420299e05fcc…` | 14 DLL, **509 imports + 111 delay-imports**, `imphash` `ccbcd3b80e9c1172fbf90eb66a5d86f0` | ne prouve pas qu'un import est lié/appelé à l'exécution |
| `EV-inspect-pe-resources` | `rea inspect-pe-resources` | `ev_86e5bb80296fb129…` | 887 entrées examinées → **436 ressources**, types et offsets | identités de ressources, pas leur usage |
| `EV-inspect-pe-load-config` | `rea inspect-pe-load-config` | `ev_3a024b36bb557a58…` | **pas de callback TLS**, cookie `/GS` `0x75a898`, **table SEH de 2245 handlers**, `GuardFlags` absents | ne prouve pas qu'une mitigation est appliquée au chargement |
| `EV-inspect-pe-certificates` | `rea inspect-pe-certificates` | `ev_82d498dbe61d3055…` | `IMAGE_DIRECTORY_ENTRY_SECURITY` **absent** → aucune signature Authenticode embarquée | absence de table ≠ absence de signature catalogue |
| `EV-inspect-native-exports` | `rea inspect-native-exports` | `ev_86e0c48322ed6c93…` | **aucune exportation** (pas de répertoire d'export) | — |
| `EV-inspect-managed-artifact` | `rea inspect-managed-artifact` | `ev_ed7547af1cb58858…` | **non managé** : pas de répertoire CLI, pas de métadonnées .NET | — |
| `EV-inspect-byte-entropy` | `rea inspect-byte-entropy` | `ev_73f7975a80afa3cc…` | entropie globale **6.3884** (seuil « haut » 7.2), blocs de 4 096 o | entropie basse ≠ absence de chiffrement localisé |
| `EV-objdump-file_headers` | `rea inspect-with-objdump … file_headers` | `ev_47f149c40b97c764…` | `pei-i386`, `start address 0x00629d6e`, drapeaux `HAS_DEBUG`, `HAS_LINENO`, `HAS_LOCALS` | — |
| `EV-objdump-section_headers` | `rea inspect-with-objdump … section_headers` | `ev_3cf7e181611df447…` | 5 sections, alignements, drapeaux (confirme `triage.json`) | — |
| `EV-objdump-symbols` | `rea inspect-with-objdump … symbols` | `ev_44f5421c2b7ecbb3…` | **`SYMBOL TABLE: no symbols`** → aucune info de debug exploitable | — |

## 2. Mesures locales déterministes

Producteur unique : `tools/idman_triage.py` → `analysis/idman/triage.json`
(pefile 2024.8.26). Toute mesure citée hors `triage.json` est reproduite par la
commande indiquée.

| Réf. | Mesure | Où | Reproduction |
|---|---|---|---|
| `EV-triage-headers` | machine `0x14c`, `DllCharacteristics 0x8140`, subsystem GUI, timestamp `2024-09-16T19:19:45Z` | `triage.json` §headers | `python3 tools/idman_triage.py` |
| `EV-triage-sections` | 5 sections + entropies (`.text` 6.586 … `.rsrc` 5.502) | §sections | idem |
| `EV-triage-debug` | CodeView type 2 : `s:\IDM_projects\IDM_vs2008_2\Release\IDMan.pdb` | §debug | idem |
| `EV-triage-version` | `FileVersion 6, 42, 22, 3`, éditeur `Tonec Inc.`, © 1999-2024 | §version_info | idem |
| `EV-triage-rtti` | **439** noms RTTI (390 classes simples + 49 templates) | §rtti | idem |
| `EV-triage-rt_string` | 37 tables `RT_STRING`, **156 chaînes** d'aide/UI | §rt_string | idem |
| `EV-triage-registry` | **124** chaînes de clés de registre | §registry_hits | idem |
| `EV-triage-protocols` | marqueurs HTTP/FTP/RTMP/MMS/HLS/DASH avec offsets | §protocol_markers | idem |
| `EV-triage-modules` | 39 noms de modules (`*.exe`, `*.dll`, `*.xpi`) | §strings_summary.module_names | idem |
| `EV-local-dialogs` | **105** modèles de dialogue + légendes | `analysis/raw/idman/dialog-captions.txt` | voir annexe 08 §3 (script de parsing) |
| `EV-local-strings` | 14 384 chaînes ASCII, 1 630 chaînes UTF-16 | `analysis/raw/idman/strings-*.txt` | voir annexe 08 §3 |
| `EV-local-overlay` | aucune donnée après la dernière section (1 024 + 6 016 000 = 6 017 024) | calcul | `triage.json` §sections |

## 3. Ce que ces preuves ne disent **pas**

- Elles n'exécutent pas la cible : aucun comportement à l'exécution n'est prouvé.
- Elles ne relient pas encore les classes RTTI aux fonctions (pas de vtables) → `H-01`.
- Elles ne disent rien de la licence d'utilisation du binaire par l'utilisateur
  (cf. `JOURNAL.md` D-004).
- Une absence (pas de TLS, pas d'export, pas de signature) n'est pas une preuve
  d'absence de comportement équivalent par un autre chemin.
