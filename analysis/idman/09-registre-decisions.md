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
| D-026 | Fichier préalloué + carte de morceaux, **écrit en place** (corrigée le 2026-10-27 : IDM n'a pas de `.tmp` par morceau) | ✅ appliquée (corrigée) | WP-05 | annexe 14 §10 |
| D-027 | Machine à états unique (39 états observés) exposée en 6 états + sous-états | ✅ appliquée | WP-05 | annexe 14 §4 |
| D-028 | Un réacteur unique par session, plafond de sockets, échéance ≤ 12 s | ✅ appliquée | WP-05 | annexe 14 §4.4 |
| D-029 | Taille de morceau adaptative bornée (1–10 MiB) par classe de taille | ✅ appliquée | WP-05 | annexe 14 §5.4 |
| D-030 | Carte persistée = liste de bornes `{id, startOffset, nextId}`, sans champ `end` | ✅ appliquée | WP-05 | annexe 14 §5.1 |
| D-031 | Compteur de progression = donnée dérivée de la carte, jamais persistée | ✅ appliquée | WP-05 | annexe 14 §5.3 |
| D-032 | Filtre = `{id, motif, type, actif}` (projection des 16 octets observés) | ✅ appliquée | WP-11 | annexe 13 §2 bis |
| D-033 | Les filtres vivent dans le projet, pas dans le registre ; ids à partir de 100 | ✅ appliquée | WP-11 | annexe 13 §4 bis |
| D-034 | Socle XDM : Node 22 + ES modules + JSDoc, zéro dépendance, `node --test` | ✅ appliquée (ferme D-017) | WP-20+ | `JOURNAL` |
| D-035 | Rollback : la zone perdue est rouverte en morceau de reprise, jamais absorbée par le prédécesseur | ✅ appliquée | WP-05/20 | `JOURNAL`, fiche A §3.1 |
| D-036 | File de tâches : fichier `queue.json` unique, FIFO, transitions explicites, 8 actifs, reprise après coupure | ✅ appliquée | WP-20 | `JOURNAL`, `src/task-queue.js` |
| D-037 | Nom final = dernière composante assainie de l'URL, ≤ 200 octets, noms réservés neutralisés | ✅ appliquée | WP-20 | `JOURNAL`, `src/promote.js` |
| D-038 | Client HTTP sans état, transport injectable : sonde `bytes=0-0`, `identity`, 10 redirections, `IDLE_TIMEOUT` 30 s avec offset de reprise | ✅ appliquée | WP-21 | `JOURNAL`, `src/http-client.js` |
| D-039 | Divergence détectée par hachage des fenêtres de recouvrement (1 024 o), repli à une connexion et reprise entière | ✅ appliquée | WP-21/22 | `JOURNAL`, `src/divergence.js`, `src/connection-loop.js` |
| D-045 | Fiches C (transports) et D (médias) : un document, deux domaines ; HLS observé, DASH dérivé (`H-18`, `H-19`) ; `EX-A-16` non généralisée | ✅ appliquée | WP-07 | `JOURNAL`, annexe 15, `conformance` v1.1 |
| D-044 | Aspiration reprenable et scriptable : `--reprendre` (file sur disque, échecs rejoués) et `--sortie json` (stdout pur) | ✅ appliquée | WP-23 | `JOURNAL`, `bin/xdm-grab.js`, `D-043` |
| D-043 | Exécution d'aspiration par la file : états respectés, échec isolé, concurrence bornée, dossier cible créé, seules les pages sont explorées | ✅ appliquée | WP-23 | `JOURNAL`, `src/grab-runner.js` |
| D-042 | Arborescence locale = chemin relatif à la racine, segments assainis, collisions `-2`, `index.html` pour un répertoire, `empty.html` jamais écrasé | ✅ appliquée | WP-11 | `JOURNAL`, `src/grabber.js` |
| D-041 | Grabber **spécifié comme produit** : l'algorithme d'exploration n'est pas dans `IDMan.exe` (0 réf. code sur les conteneurs) ; choix XDM documentés au lieu d'hypothèses | ✅ appliquée | WP-11 | `JOURNAL`, `grabber.json`, annexe 12 §6 |
| D-040 | Carte persistée à chaque morceau clos (écritures sérialisées, fichier temporaire unique), reprise avec `mergeResumeChunks`, promotion explicite | ✅ appliquée | WP-22 | `JOURNAL`, `src/connection-loop.js`, `src/chunk-map.js` |

## Points de vigilance associés

| Sujet | Décision liée | Rappel |
|---|---|---|
| Cookies de navigateurs (`Local State` + `cookies`) | D-004 | le mécanisme est **documenté**, jamais implémenté |
| Modules `CRegistration`, `CProtection`, `CSignVerifier`, `CHardwareSNs` | D-004 | gel total |
| Interception réseau par LSP (`sporder.dll`) | D-007 | **ne pas reproduire** : passer par l'API d'extension navigateur |
| Interface (105 dialogues, 174 bitmaps) | D-015 | réutiliser le vocabulaire, pas les ressources |
| Bundles Evidence cités | D-009 / D-010 | toujours avec `evidence_id` et SHA-256 de la cible |
