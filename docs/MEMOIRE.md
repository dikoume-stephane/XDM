# Mémoire du projet — index et conventions

> Ce fichier est la **carte** de tout ce qui est su sur la cible et sur les décisions
> prises. Il ne contient pas d'analyse : il dit *où* trouver quoi, *à quel point* c'est
> fiable, et *comment* mettre à jour sans casser la traçabilité.

- **Projet** : clonage du Site Grabber (« çonage ») d'Internet Download Manager dans XDM.
- **Cible** : `cible/IDMan.exe` — IDM 6.42.22.3, PE32 i386, 6 017 024 octets,
  SHA-256 `5f78da5a63604a3fefba6577ef6b2af976ec4d2fc4d0f219a72099a0da2f11c9`.
- **Dernière revue** : 2026-10-26.

---

## 1. Les quatre niveaux de mémoire

| Niveau | Fichier | Nature | Règle de mise à jour |
|---|---|---|---|
| Décisions | [`JOURNAL.md`](JOURNAL.md) | chronologique, **immuable** | on ajoute une entrée ; on ne réécrit jamais une décision passée (on la remplace) |
| Plan | [`ROADMAP-IDM.md`](ROADMAP-IDM.md) | vivant | révisé à chaque jalon / changement de périmètre |
| Index | ce fichier | vivant | mis à jour dès qu'une annexe est créée ou déplacée |
| Connaissances | `analysis/idman/NN-*.md` | thématique, versionnée | enrichie par ajout de lignes sourcées ; jamais « de mémoire » |

---

## 2. Annexes thématiques

| Fichier | Contenu | Statut | Source de vérité |
|---|---|---|---|
| [`analysis/idman/00-preuves.md`](../analysis/idman/00-preuves.md) | Registre des preuves : commande REA, `evidence_id`, ce qu'elle établit, ses limites | ✅ | bundles `analysis/raw/idman/*.json` |
| [`01-anatomie-binaire.md`](../analysis/idman/01-anatomie-binaire.md) | Format PE, sections, entropies, mitigations, build, imports, ressources | ✅ | `triage.json` + bundles REA |
| [`02-cartographie-fonctionnelle.md`](../analysis/idman/02-cartographie-fonctionnelle.md) | 8 domaines fonctionnels, classes RTTI, dialogues, marqueurs | ✅ | `triage.json` §rtti, §resources |
| [`03-protocoles-et-formats.md`](../analysis/idman/03-protocoles-et-formats.md) | HTTP/FTP/HLS/DASH/RTMP/MMS/TS : ce qui est attesté, ce qui reste à prouver | ✅ | `triage.json` §protocol_markers |
| [`04-modules-et-composants.md`](../analysis/idman/04-modules-et-composants.md) | Cartographie de la suite IDM (exe/dll, rôles inférés) | ✅ | chaînes + imports |
| [`05-integrations-et-registre.md`](../analysis/idman/05-integrations-et-registre.md) | Navigation native (`com.tonec.idm`), BHO/extension, clés de registre | ✅ | `triage.json` §registry_hits |
| [`06-hypotheses.md`](../analysis/idman/06-hypotheses.md) | Hypothèses ouvertes `H-xx` avec protocole de vérification | ✅ | — |
| [`07-glossaire.md`](../analysis/idman/07-glossaire.md) | Sigles (MFC, RTTI, DASH, SIDX, LSP, AMF…) et vocabulaire Evidence | ✅ | — |
| [`08-index-citations.md`](../analysis/idman/08-index-citations.md) | Offsets, IDs de ressources, offsets de chaînes : de quoi rejouer chaque citation | ✅ | `triage.json` |
| [`09-registre-decisions.md`](../analysis/idman/09-registre-decisions.md) | Tableau récapitulatif des décisions (vue dense du journal) | ✅ | `JOURNAL.md` |
| `analysis/idman/10-vtables-et-classes.md` | Table `classe RTTI → vtable → fonctions` | ⛔ à venir (WP-04) | Ghidra |
| `analysis/idman/11-spec-moteur.md` | Spécification du moteur de téléchargement | ⛔ à venir (WP-05) | Ghidra + REA |
| `analysis/idman/12-spec-grabber.md` | Spécification du grabber | ⛔ à venir (WP-06) | Ghidra + REA |
| `analysis/idman/13-spec-protocoles.md` | Spécification des transports et médias | ⛔ à venir (WP-07) | Ghidra + REA |

---

## 3. Données générées (ne pas éditer à la main)

| Fichier | Producteur | Versionné | Régénération |
|---|---|---|---|
| `analysis/idman/triage.json` | `tools/idman_triage.py` | ✅ (déterministe, 74 Ko) | `python3 tools/idman_triage.py` |
| `analysis/raw/idman/*.json` | `tools/collect-idman-evidence.sh` | ❌ (ignoré) | `bash tools/collect-idman-evidence.sh` |
| `analysis/raw/idman/strings-*.txt`, `rtti-classes.txt`, `rt-string.txt`, `dialog-captions.txt`, `menus.txt` | scripts ad hoc documentés en annexe 08 | ❌ (ignoré) | voir annexe 08 §3 |

**Règle** : si une donnée doit être citée plus d'une fois, elle passe dans
`tools/idman_triage.py` (donc dans `triage.json`), jamais dans une note manuelle.

---

## 4. Conventions d'identifiants

| Préfixe | Sens | Exemple |
|---|---|---|
| `D-xxx` | décision (journal) | `D-004` périmètre légal |
| `WP-xx` | lot de travail (roadmap) | `WP-06` grabber |
| `EV-xxx` | preuve (bundle REA ou mesure) | `EV-inspect-pe-imports` |
| `H-xx` | hypothèse ouverte | `H-02` format de projet binaire |
| `R-xx` | risque | `R-02` attribution classe↔fonction |
| `A-xx` | action | `A-02` installer Ghidra |

Un identifiant n'est **jamais** réutilisé, même après abandon d'un lot.

### Niveaux de confiance (obligatoires dans les annexes)

| Étiquette | Définition | Exemple |
|---|---|---|
| **Observé** | mesuré directement dans le fichier | « la ressource 5 (DIALOG) contient 105 modèles » |
| **Dérivé** | conséquence d'observations, raisonnement explicite | « `mfcm90.dll` ⇒ VS2008 SP1 » |
| **Hypothèse** | plausible, non prouvé → `H-xx` | « `CIDMSpider` gère la file de frontière » |
| **Inconnu** | on ne sait pas, et on l'écrit | « format exact du fichier projet » |

---

## 5. Règles de fraîcheur

1. Une annexe dont une affirmation a été **invalidée** porte en tête
   `⚠ ANNEXE PARTIELLEMENT PÉRIMÉE — voir JOURNAL D-0xx`.
2. Les preuves REA sont valables **pour ce SHA-256** uniquement ; si la cible change,
   relancer `tools/collect-idman-evidence.sh` et mettre à jour `00-preuves.md`.
3. Les faits marqués **Hypothèse** n'entrent dans une spécification qu'après
   validation (phase 6) ou décision explicite du porteur de projet.
4. Aucune capture binaire, aucun dump de chaînes complet dans Git (`D-003`, `D-010`).

---

## 6. Par où commencer la lecture

- **Nouveau sur le projet** → `ROADMAP-IDM.md` §0-1, puis `02-cartographie-fonctionnelle.md`.
- **Je veux vérifier une affirmation** → `00-preuves.md` puis `08-index-citations.md`.
- **Je veux coder** → `ROADMAP-IDM.md` §3 (P3) + la fiche `docs/specs/` du domaine.
- **Je veux savoir pourquoi un choix a été fait** → `JOURNAL.md`.
