# XDM

Projet de **réimplémentation du « Site Grabber » d'Internet Download Manager** (aspirateur
de site, « çonage ») dans XDM, mené en **analyse statique outillée** : la cible
`cible/IDMan.exe` (IDM 6.42.22.3) est inspectée sans jamais être exécutée, chaque
constat étant rattaché à une preuve reproductible.

Outil principal : **[REA](https://github.com/morluto/rea)** (*Reverse Engineer Anything*),
CLI + serveur MCP qui produit des bundles *Evidence* (constats, couverture, limites).

## Démarrage

```bash
npm install                        # rea-agents épinglé (6.8.0)
npm run doctor                     # état de l'environnement et des providers
bash tools/collect-idman-evidence.sh   # preuves REA sur la cible  -> analysis/raw/idman/
python3 tools/idman_triage.py          # agrégats déterministes    -> analysis/idman/triage.json
python3 tools/idman_extract.py         # chaînes/RTTI/dialogues    -> analysis/raw/idman/
```

Dépendances Python : `pefile`, `capstone` (`python3 -m pip install --break-system-packages pefile capstone`).

## Où lire quoi

| Objectif | Fichier |
|---|---|
| **Décisions prises et pourquoi** | [`docs/JOURNAL.md`](docs/JOURNAL.md) |
| **Plan de travail (phases, lots, portes)** | [`docs/ROADMAP-IDM.md`](docs/ROADMAP-IDM.md) |
| **Index de la mémoire du projet** | [`docs/MEMOIRE.md`](docs/MEMOIRE.md) |
| Anatomie du binaire | [`analysis/idman/01-anatomie-binaire.md`](analysis/idman/01-anatomie-binaire.md) |
| Fonctionnalités cartographiées | [`analysis/idman/02-cartographie-fonctionnelle.md`](analysis/idman/02-cartographie-fonctionnelle.md) |
| Protocoles et formats attestés | [`analysis/idman/03-protocoles-et-formats.md`](analysis/idman/03-protocoles-et-formats.md) |
| Modules de la suite IDM | [`analysis/idman/04-modules-et-composants.md`](analysis/idman/04-modules-et-composants.md) |
| Registre, navigateurs, état du grabber | [`analysis/idman/05-integrations-et-registre.md`](analysis/idman/05-integrations-et-registre.md) |
| Hypothèses à vérifier | [`analysis/idman/06-hypotheses.md`](analysis/idman/06-hypotheses.md) |
| Gabarit de fiche de spécification | [`docs/specs/TEMPLATE.md`](docs/specs/TEMPLATE.md) |
| Installation et usage de REA | [`docs/REA.md`](docs/REA.md) |

## Structure

```text
cible/IDMan.exe            cible d'analyse (fournie sur main)
docs/                      journal, roadmap, index mémoire, specs, doc REA
analysis/idman/            annexes de mémoire (00 → 09) + triage.json
analysis/raw/              bundles Evidence + extractions brutes (non versionnés)
samples/demo-electron-app  app témoin pour valider REA
tools/                     collecte de preuves, triage, extractions
```

## État actuel

- ✅ Outillage REA installé, épinglé et validé (app Electron témoin + 11 bundles Evidence
  sur `IDMan.exe`).
- ✅ Triage statique complet : PE, sections, mitigations, imports (509 + 111), ressources
  (436), 439 noms RTTI, 105 dialogues, marqueurs de protocoles, 124 clés de registre.
- ✅ Journal, roadmap, index mémoire et 10 annexes rédigés.
- ⏳ Prochaine étape bloquante : installation de **Ghidra 12.1.x** (lot WP-03) et
  confirmation du périmètre par le porteur de projet (action A-01).
- ⛔ Hors périmètre par décision : licence/activation, contournement anti-débogage,
  extraction des cookies de navigateurs (voir `docs/JOURNAL.md` D-004).
