# Gabarit de fiche de spécification

> **Domaine** : `<A — moteur | B — grabber | C — transports | D — médias | E — navigateurs | F — persistance | G — planification>`
> **Lot** : `WP-xx` · **Statut** : `brouillon | en revue | validée` · **Dernière revue** : AAAA-MM-JJ
> **Preuves** : lister ici les `EV-*` et les `H-xx` tranchées.
> **Cible** : `IDMan.exe` SHA-256 `5f78da5a…` — toute référence de code est valable pour cette version seulement.

---

## 1. But fonctionnel (en une phrase)

<Ce que la fonctionnalité permet à l'utilisateur, sans jargon interne.>

## 2. Exigences

| ID | Exigence | Niveau | Preuve | Test prévu |
|---|---|---|---|---|
| `EX-<domaine>-01` | … | **Observé** / **Dérivé** / **Hypothèse** | `EV-…` / offset / `H-xx` | `T-<domaine>-01` |

Règles :
- une exigence sans preuve est marquée **Hypothèse** et ne peut pas être « validée » ;
- une exigence **Observé** doit citer un offset ou un `evidence_id`.

## 3. Modèle de données

| Structure | Champs | Type/dimension | Preuve |
|---|---|---|---|
| … | … | … | … |

Inclure les invariants (unicité, ordre, valeurs par défaut) et ce qui est **Inconnu**.

## 4. Machine à états

```text
<état> --(événement)--> <état>   [garde]
```

| État | Entrées permises | Sorties | Effets persistants |
|---|---|---|---|

## 5. Interfaces externes

| Interface | Sens | Format | Remarques |
|---|---|---|---|
| HTTP | sortant | en-têtes/plages | voir annexe 03 |
| Registre | écriture | clés/valeurs | voir annexe 05 |
| Fichiers | écriture | temporaires + final | nommage, atomicité |

## 6. Cas d'erreur et dégradations

| Cas | Comportement attendu | Preuve | Test |
|---|---|---|---|
| réseau coupé | … | … | … |
| 429/503 | … | … | … |
| disque plein | … | … | … |
| URL redirigée en boucle | … | … | … |

## 7. Écarts assumés avec IDM

| Écart | Motif | Décision |
|---|---|---|
| … | légal / obsolescence / simplification | `D-00x` |

> Rappel : aucun élément lié à la licence, au fingerprint matériel ou à un DRM ne peut
> figurer ici (`JOURNAL.md` D-004).

## 8. Questions ouvertes

| ID | Question | Bloque | Qui/quoi peut trancher |
|---|---|---|---|

## 9. Journal des révisions

| Date | Auteur | Changement |
|---|---|---|
