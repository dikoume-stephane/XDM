# Matrice de conformité (WP-12, v0.1)

> **Statut** : 🟡 v0.1 — **Dernière revue** : 2026-10-27
> **Rôle** : relier, pour chaque exigence de spécification, la **preuve** statique qui la
> fonde et le **test** qui la vérifiera. Aucune ligne d'implémentation ne référence une
> exigence absente de ce fichier.
> **Sources** : `docs/specs/A-moteur-de-telechargement.md` (v0.2),
> `docs/specs/B-grabber.md` (v0.1), annexes 13 et 14.
> **Rappel** : « preuve » ne veut pas dire « comportement validé ». Une exigence
> **Hypothèse** n'a pas de preuve et ne peut pas être marquée conforme.

## 1. Légende

| Colonne | Sens |
|---|---|
| Niveau | `Observé` (lu dans le binaire), `Dérivé` (interprétation explicite), `Décision` (choix XDM), `Hypothèse` (non prouvé) |
| Test | identifiant du test prévu ; `—` = pas encore écrit |
| État | `à faire`, `écrit`, `vert`, `rouge` |

## 2. Domaine A — moteur de téléchargement

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-A-01` fichier unique écrit en place | Observé | annexe 14 §5.2, §7 (`CreateFileW` `0x156d48`) | `T-A-01` | à faire |
| `EX-A-02` état dans `<cible>.xdm-part.json` | Décision | `D-024` | `T-A-02` | à faire |
| `EX-A-03` carte = liste de bornes | Observé + Décision | annexe 14 §5.1 ; `D-030` | `T-A-03` | à faire |
| `EX-A-04` rejet des cartes incohérentes | Dérivé | `D-030` | `T-A-04` | à faire |
| `EX-A-05` progression dérivée | Dérivé | `D-031` | `T-A-05` | à faire |
| `EX-A-06` morceau 1–10 MiB, paliers 2/10 MiB | Observé + Décision | annexe 14 §5.4 ; `chunks.json` ; `D-029` | `T-A-06` | à faire |
| `EX-A-07` 1 → N connexions, plafond 8 par défaut | Observé + Décision | annexe 14 §6 ; `0x0fbe17` | `T-A-07` | à faire |
| `EX-A-08` `Range` par morceau, repli 1 connexion sans `206` | Observé | annexe 14 §8 | `T-A-08` | à faire |
| `EX-A-09` rollback = troncature | Observé | annexe 14 §5.3 (`0x15fee5`, `0x15ff52`, `0x15ff9b`) | `T-A-09` | à faire |
| `EX-A-10` divergence → empreinte → repli | Observé + Décision | annexe 14 §5.5 ; `D-025` | `T-A-10` | à faire |
| `EX-A-11` morceau incomplet jamais finalisé | Observé | annexe 14 §7 (`isCmpleted = 0`) | `T-A-11` | à faire |
| `EX-A-12` promotion conditionnée à la vérification | Observé + Décision | annexe 14 §7 ; `D-026` | `T-A-12` | à faire |
| `EX-A-13` réacteur unique, 128 sockets, délai ≤ 12 s | Observé + Décision | annexe 14 §4.4 ; `io-model.json` ; `D-028` | `T-A-13` | à faire |
| `EX-A-14` nom final assaini | Observé + Dérivé | annexe 14 §3 | `T-A-14` | à faire |
| `EX-A-15` URL relative résolue, ≤ 10 redirections, ≤ 10 239 o | Observé | annexe 14 §8.1 (`0x17dc90`) | `T-A-15` | à faire |
| `EX-A-16` `Accept-Encoding: identity` | Observé | annexe 14 §8 | `T-A-16` | à faire |
| `EX-A-17` aucune télémétrie | Décision | `D-004`, `D-012` | `T-A-17` | à faire |
| `EX-A-18` inactivité > 30 s ⇒ reconnexion | Observé | annexe 14 §4.5 (`0x1a139f`, `0x18adad`) | `T-A-25` | à faire |
| `EX-A-19` reprise sans retour à zéro | Observé + Décision | annexe 14 §4.5, §5.3 ; `D-030` | `T-A-26` | à faire |

**Couverture** : 19 exigences, **19 sans test écrit**. Aucune exigence `Hypothèse` dans ce
domaine.

## 3. Domaine B — grabber

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-B-01` projet = un artefact | Observé + Décision | annexe 11 §1 (`%sproject%s.gsd`) | `T-B-01` | à faire |
| `EX-B-02` contenu du projet | Dérivé | annexe 11 §4 | `T-B-02` | à faire |
| `EX-B-03` filtre sans portée propre | Observé + Décision | annexe 13 §2 bis ; `D-032` | `T-B-03` | à faire |
| `EX-B-04` identifiants à partir de 100 | Observé + Décision | annexe 13 §2 ter ; `D-033` | `T-B-04` | à faire |
| `EX-B-05` motif = masque glob | Observé | annexe 13 §4 bis | `T-B-05` | à faire |
| `EX-B-06` champs d'une entrée | Observé | annexe 12 §2 | `T-B-06` | à faire |
| `EX-B-07` profondeur paramétrable (`nLevels`) | Observé / Hypothèse | annexe 13 §4 bis | `T-B-07` | à faire |
| `EX-B-08` exploration HTML → liens → classement | **Hypothèse** | — (`H-05`) | `T-B-08` | **bloqué** (`Q-B-01`) |
| `EX-B-09` dédoublonnage des URL | **Hypothèse** | — | `T-B-09` | **bloqué** |
| `EX-B-10` entrée = tâche de téléchargement | Observé | annexe 12 §1 | `T-B-10` | à faire |
| `EX-B-11` arborescence locale | Observé / Dérivé | annexe 12 §2 | `T-B-11` | à faire |
| `EX-B-12` `empty.html` | Observé | annexe 13 §4 (`0xd1ed0`) | `T-B-12` | à faire |
| `EX-B-13` pas de sortie de domaine | **Hypothèse** | — | `T-B-13` | **bloqué** |

**Couverture** : 13 exigences, 10 testables, **3 bloquées** par `Q-B-01`/`Q-B-02`.

## 4. Ce que cette matrice révèle

1. **Le domaine A est spécifiable et testable immédiatement** : 19 exigences, aucune
   hypothèse, chaque test peut s'écrire sans réseau réel (serveur local + fichiers).
2. **Le domaine B ne l'est pas** : 3 exigences sur 13 reposent sur l'algorithme
   d'exploration, qui n'est pas établi (`Q-B-01`, `A-09`).
3. **Aucun test n'existe encore** : la porte G1 exige une fiche validée ; or `WP-05` peut
   commencer par les tests de `T-A-01`→`T-A-13` **avant** toute ligne de code produit,
   sous forme de tests de spécification (serveur factice + fichiers témoins).

## 5. Ordre de mise en œuvre proposé

| Rang | Test | Pourquoi d'abord |
|---|---|---|
| 1 | `T-A-03`, `T-A-04` | la carte est le contrat de données ; tout le reste en dépend |
| 2 | `T-A-01`, `T-A-09` | écriture en place + troncature : cœur du modèle |
| 3 | `T-A-06`, `T-A-07`, `T-A-13` | valeurs par défaut et plafonds (observés) |
| 4 | `T-A-08`, `T-A-15`, `T-A-16` | contrat HTTP minimal |
| 5 | `T-A-10`, `T-A-25`, `T-A-26` | robustesse (divergence, inactivité, reprise) |
| 6 | `T-B-*` (sauf bloqués) | après `Q-B-01` |

## 6. Journal des révisions

| Date | Changement |
|---|---|
| 2026-10-27 | création v0.1 : 32 exigences recensées (19 domaine A, 13 domaine B), 3 bloquées, 0 test écrit |
