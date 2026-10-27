# 09 — Registre des décisions (vue dense)

> **Statut** : ✅ synchronisé avec `docs/JOURNAL.md` · **Dernière revue** : 2026-10-26
> **Règle** : ce tableau est un **résumé** ; en cas de divergence, le journal fait foi.
> Les décisions ne sont jamais supprimées : on ajoute une ligne « remplace » / « remplacée par ».

| ID | Décision | Statut | Impact | Réf. |
|---|---|---|---|---|
| D-001 | REA (`rea-agents`) comme outil principal d'analyse et de preuve | ✅ appliquée | tout | `docs/REA.md` |
| D-002 | Version de REA épinglée dans le projet (6.8.0) | ✅ appliquée | reproductibilité | `package.json` |
| D-003 | Bundles Evidence bruts hors Git (`analysis/raw/`) | ✅ appliquée | dépôt léger | `.gitignore` |
| D-004 | Périmètre légal : interopérabilité seulement, **licence/DRM gelés** | ✅ appliquée | WP-07/12 gelés | journal §D-004 |
| D-005 | Méthode « statique d'abord, preuve avant intuition » | ✅ appliquée | tout | `00-preuves.md` |
| D-006 | Cible = `IDMan.exe` 32 bits seul | ✅ appliquée | fidélité | `04-modules…` |
| D-007 | Fonctionnalité clonée = **Site Grabber + moteur** (à confirmer) | 🟡 à confirmer | périmètre | `ROADMAP` §1 |
| D-008 | Cible non packée, MFC 9.0 / VS2008 : cartographie par RTTI + ressources | ✅ appliquée | méthode | `01-anatomie…` |
| D-009 | `triage.json` = source de vérité déterministe | ✅ appliquée | annexes | `tools/idman_triage.py` |
| D-010 | Corpus de chaînes non versionné, seuls marqueurs + offsets | ✅ appliquée | dépôt | `08-index-citations.md` |
| D-011 | Moteur natif = Ghidra 12.1.x headless | ⏳ en attente d'install | phases P1+ | A-02 |
| D-012 | Analyse dynamique différée hors sandbox (VM Windows) | ✅ appliquée | hypothèses | `ROADMAP` §P5 |
| D-013 | Mémoire à 4 niveaux (journal / roadmap / index / annexes) | ✅ appliquée | gouvernance | `MEMOIRE.md` |
| D-014 | Étiquetage obligatoire Observé / Dérivé / Hypothèse / Inconnu | ✅ appliquée | fiabilité | annexes |
| D-015 | Objectif = compatibilité de comportement, pas clone bit-à-bit | ✅ appliquée | livrables | `ROADMAP` §0 |
| D-016 | Convention d'identifiants (D/WP/EV/H/R/A) | ✅ appliquée | tout | `MEMOIRE.md` §4 |
| D-017 | Stack de réimplémentation | ⛔ ouverte | WP-20+ | journal |
| D-018 | Stockage des artefacts lourds | ⛔ ouverte | WP-23+ | journal |
| D-019 | Ghidra non installable ici → outils maison (`idman_classes`, `idman_args`, `idman_symbols`) | ✅ appliquée | WP-04/05 | `tools/` |
| D-020 | Attribution chaîne→fonction à deux niveaux (certaine / probable) | ✅ appliquée | annexes 10-14 | annexe 10 |
| D-021 | `classes.json` = source de vérité de la carte objets | ✅ appliquée | WP-04+ | `tools/idman_classes.py` |
| D-022 | Projet de grabber = fichier `.gsd`, registre = état auxiliaire | ✅ appliquée | WP-06/WP-11 | annexe 11 |
| D-023 | `empty.html` généré **dans le dossier du projet**, en option | ✅ appliquée | WP-24 | annexe 13 |
| D-024 | État de reprise XDM = `<fichier>.xdm-part.json`, jamais le registre | ✅ appliquée | WP-05 | annexe 14 §10 |
| D-025 | Anti-corruption par empreinte + repli à une connexion | ✅ appliquée | WP-05 | annexe 14 §5.4 |
| D-026 | Fichier préalloué + carte de morceaux, sans `.tmp` par morceau | ✅ appliquée | WP-05 | annexe 14 §10 |

## Points de vigilance associés

| Sujet | Décision liée | Rappel |
|---|---|---|
| Cookies de navigateurs (`Local State` + `cookies`) | D-004 | le mécanisme est **documenté**, jamais implémenté |
| Modules `CRegistration`, `CProtection`, `CSignVerifier`, `CHardwareSNs` | D-004 | gel total |
| Interception réseau par LSP (`sporder.dll`) | D-007 | **ne pas reproduire** : passer par l'API d'extension navigateur |
| Interface (105 dialogues, 174 bitmaps) | D-015 | réutiliser le vocabulaire, pas les ressources |
| Bundles Evidence cités | D-009 / D-010 | toujours avec `evidence_id` et SHA-256 de la cible |
