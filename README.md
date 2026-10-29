# XDM

Projet de **réimplémentation du « Site Grabber » d'Internet Download Manager** (aspirateur
de site, « çonage ») dans XDM, mené en **analyse statique outillée** : la cible
`cible/IDMan.exe` (IDM 6.42.22.3) est inspectée sans jamais être exécutée, chaque
constat étant rattaché à une preuve reproductible.

Outil principal : **[REA](https://github.com/morluto/rea)** (*Reverse Engineer Anything*),
CLI + serveur MCP qui produit des bundles *Evidence* (constats, couverture, limites).

## Démarrage

```bash
npm test                           # socle XDM : 265 tests, sans dépendance (node --test)
npm run audit                      # traçabilité : chaque exigence verte a un test qui existe
npm run gate                       # porte G3 : site local + coupure réseau, comparaison disque/serveur
npm run gate -- --pages 200 --max 200M   # profil de la porte : 200 pages, jusqu'à 200 Mo
node bin/xdm.js <url> [dossier]    # téléchargement réel : plages, reprise, promotion
node bin/xdm-grab.js <url> [dir]   # aspiration de site : parcours, arborescence, file
node bin/xdm-grab.js <url> [dir] --reprendre --sortie json   # reprise + résumé machine
node bin/xdm-grab.js <url> [dir] --exclure '*/prive/*' --paralleles 4 --cookies c.json
node bin/xdm.js ftp://exemple.test/pub/fichier.zip [dossier]  # transport choisi par le schéma
node bin/xdm-grab.js <url> [dir] --essai     # plan complet, aucune écriture ni téléchargement
node bin/xdm-grab.js <url> [dir] --sitemap --sous-domaines   # plans de site + sous-domaines
node bin/xdm-grab.js --aide                  # options complètes (code 0), --version aussi
node bin/xdm-grab.js <url> [dir] --verifier  # auditer une aspiration (file ↔ disque, code 1 si écart)
node bin/xdm-grab.js <url> [dir] --taille-max 200M --espace-min 1G
node bin/xdm-grab.js <url> [dir] --entete 'Authorization: Bearer x' --progression
node bin/xdm-grab.js <url> [dir] --incremental   # If-Modified-Since : un 304 laisse le fichier intact
node bin/xdm-grab.js <url> [dir] --reecrire --rapport r.md   # liens locaux + rapport d'aspiration
node bin/xdm-grab.js <url> [dir] --planifier 'lun-ven 01:00-06:00' --quota-octets 50000000
node bin/xdm-media.js <playlist.m3u8> [dir]   # flux HLS : segments, init, assemblage facultatif
node bin/xdm-media.js <media.mp4> [dir] --dash   # MP4 segmenté : plages lues dans l'index sidx
```

```bash
npm install                        # rea-agents épinglé (6.8.0)
npm run doctor                     # état de l'environnement et des providers
bash tools/collect-idman-evidence.sh   # preuves REA sur la cible  -> analysis/raw/idman/
python3 tools/idman_triage.py          # agrégats déterministes    -> analysis/idman/triage.json
python3 tools/idman_extract.py         # chaînes/RTTI/dialogues    -> analysis/raw/idman/
python3 tools/idman_classes.py         # RTTI -> vtables/méthodes  -> analysis/idman/classes.json
python3 tools/idman_symbols.py         # noms « Classe::Methode »  -> analysis/idman/symbols.json
python3 tools/idman_attrib.py          # noms -> adresses          -> analysis/idman/methods.json
python3 tools/idman_states.py          # machine à états (39)      -> analysis/idman/states.json
python3 tools/idman_io.py             # modèle d'E/S et seuils    -> analysis/idman/io-model.json
python3 tools/idman_io.py --resolve 0x35c0a0   # slot d'import -> DLL!fonction
python3 tools/idman_chunks.py         # politique de morceaux     -> analysis/idman/chunks.json
python3 tools/idman_filters.py        # structure des filtres     -> analysis/idman/filters.json
python3 tools/idman_grabber.py        # où vit le grabber         -> analysis/idman/grabber.json
python3 tools/idman_class_profile.py --pattern 'HTTPConnection'   # fiche par classe
```

Dépendances Python : `pefile`, `capstone` (`python3 -m pip install --break-system-packages pefile capstone`).
Dépendances du socle : **aucune** — Node 22, ES modules, types JSDoc (`D-034`).

## Le logiciel (moteur, domaine A clos)

| Module | Rôle | Décision |
|---|---|---|
| `src/chunk-map.js` | carte de morceaux : liste de bornes `{id, start, next, completed}`, validation des 6 invariants, progression dérivée, rollback | `D-030`, `D-031`, `D-035` |
| `src/chunk-policy.js` | taille de morceau adaptative bornée 1–10 MiB, trois profils observés | `D-029` |
| `src/part-file.js` | persistance atomique de `<cible>.xdm-part.json` | `D-024` |
| `src/work-file.js` | fichier de travail unique, écriture positionnée, rollback par troncature | `D-026` |
| `src/project.js` | projet d'aspiration, filtres (masques glob), compteur d'ids à partir de 100 | `D-032`, `D-033` |
| `src/task-queue.js` | file de tâches reprenable, 8 actifs par défaut, transitions explicites | `D-036` |
| `src/promote.js` | assainissement du nom final, promotion atomique après vérification | `D-037`, `D-026` |
| `src/http-client.js` | sonde de ressource, `Range`/`If-Range`, redirections ≤ 10, `identity`, inactivité 30 s | `D-038` |
| `src/divergence.js` | hachage des fenêtres de recouvrement, détection de divergence entre connexions | `D-039` |
| `src/connection-loop.js` | boucle de connexions : distribution des morceaux, reprise depuis la carte, repli, plafond 128 sockets, promotion optionnelle | `D-039`, `D-040` |
| `src/crawler.js` | aspiration : BFS par niveau, URL canonique, `robots.txt`, filtres du projet | `D-041` |
| `src/grabber.js` | arborescence locale, collisions, `empty.html`, promotion en tâches ordinaires | `D-042` |
| `src/grab-runner.js` | exécution d'une file : états, échec isolé, concurrence bornée, persistance | `D-043` |
| `src/hls.js` | playlist HLS : variantes, segments, plages d'octets, init, clé | `D-046` |
| `src/sidx.js` | boîtes MP4 et index `sidx` des flux DASH | `D-046` |
| `src/media.js` | téléchargement d'un flux HLS segment par segment, assemblage facultatif | `D-046` |
| `src/pac.js` | PAC : sous-ensemble explicite du langage, directives ordonnées | `D-052` |
| `bin/xdm.js` | CLI : `xdm <url> [dossier] [--connexions N] [--morceau T]`, nom déduit de l'URL, promotion finale | `D-037`, `D-040` |

État : **domaines A et B clos** — 97 cas verts, 30 exigences sur 32 couvertes
(`docs/specs/conformance.md`). Le moteur télécharge, reprend, vérifie et promeut ; le grabber
parcourt un site, en déduit l'arborescence locale et alimente la file de téléchargement. La chaîne fonctionne de bout en bout : sonde,
découpage, connexions parallèles, reprise après coupure **depuis la carte persistée**,
détection de divergence, promotion atomique — pilotée par la CLI. Reste le grabber
(`WP-11`, bloqué par l'exploration de `CIDMSpider`, cf. `Q-B-01`).

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
| Vtables, classes, attribution | [`analysis/idman/10-vtables-et-classes.md`](analysis/idman/10-vtables-et-classes.md) |
| Modèle de données du projet (v0.1) | [`analysis/idman/11-modele-donnees-projet.md`](analysis/idman/11-modele-donnees-projet.md) |
| Spécification du grabber (v0.1) | [`analysis/idman/12-spec-grabber.md`](analysis/idman/12-spec-grabber.md) |
| Filtres et artefacts (`empty.html`) | [`analysis/idman/13-filtres-et-artefacts.md`](analysis/idman/13-filtres-et-artefacts.md) |
| Moteur de téléchargement (morceaux, reprise) | [`analysis/idman/14-moteur-de-telechargement.md`](analysis/idman/14-moteur-de-telechargement.md) |
| Hypothèses à vérifier | [`analysis/idman/06-hypotheses.md`](analysis/idman/06-hypotheses.md) |
| Gabarit de fiche de spécification | [`docs/specs/TEMPLATE.md`](docs/specs/TEMPLATE.md) |
| Fiche A — moteur de téléchargement (brouillon, `A-05`) | [`docs/specs/A-moteur-de-telechargement.md`](docs/specs/A-moteur-de-telechargement.md) |
| Fiche B — grabber / aspiration de site (brouillon, `A-05`) | [`docs/specs/B-grabber.md`](docs/specs/B-grabber.md) |
| Matrice de conformité exigence → preuve → test (`WP-12`) | [`docs/specs/conformance.md`](docs/specs/conformance.md) |
| Installation et usage de REA | [`docs/REA.md`](docs/REA.md) |

## Structure

```text
src/                       socle XDM (ESM, zéro dépendance)
test/                      tests de spécification (node --test)
cible/IDMan.exe            cible d'analyse (fournie sur main)
docs/                      journal, roadmap, index mémoire, specs, doc REA
analysis/idman/            annexes de mémoire (00 → 16) + triage.json + classes.json
analysis/raw/              bundles Evidence + extractions brutes (non versionnés)
samples/demo-electron-app  app témoin pour valider REA
tools/                     collecte de preuves, triage, extractions
```

## État actuel

- ✅ Outillage REA installé, épinglé et validé (app Electron témoin + 11 bundles Evidence
  sur `IDMan.exe`).
- ✅ Triage statique complet : PE, sections, mitigations, imports (509 + 111), ressources
  (436), 439 noms RTTI, 105 dialogues, marqueurs de protocoles, 124 clés de registre.
- ✅ Journal, roadmap, index mémoire et 17 annexes rédigés (00 → 16, dont les fiches C et D).
- ✅ WP-04 terminé : **422 classes / 427 vtables / 13 760 méthodes** extraites des RTTI
  (`analysis/idman/classes.json`, annexe 10), 45 chaînes fonctionnelles attribuées.
- 🟡 WP-06/WP-11 démarrés : projet de grabber = **fichier `.gsd`** dans
  `<IDM>\Grabber\Projects\` (classe `GrSh`) + miroir registre
  (`GrabberSts\Projects\%ld\%ld\ChList`, compteur `nextFilterID`) — annexes 11 et 12.
- 🟡 WP-05 (annexe 14 v0.2) : moteur = `SessionManager` → `Session`/`Connection`
  (HTTP/FTP/MMS/RTMP + proxies) → `ChunksList` ; morceaux persistants, rollback par
  troncature, anti-corruption par recouvrement, montée en charge progressive ; état de
  connexion = **entier en `this+0xa4`, 39 valeurs**, 8 `switch` en tables de sauts,
  115 transitions (A-12 levée, `D-027`). Modèle d'E/S : un `select` par session,
  `fd_set` de 516 o (128 sockets), échéance plafonnée à 12 000 ms, 8 connexions par
  défaut (A-13, `D-028`).
- 🟢 WP-05 v0.4 : taille de morceau **1–10 MiB** par classe de taille (`D-029`), états
  17..27 nommés d'après les libellés d'interface, `MNSP` = combinaison d'URL WinINet.
- ✅ WP-20 → WP-27 terminés : moteur de morceaux, boucle de connexions, aspiration de site
  et CLI (`bin/xdm.js`, `bin/xdm-grab.js`), transports (proxys, FTP, PAC), médias (HLS,
  DASH) ; **265 tests**, domaines A, B et D clos, domaine C à **13/14** (1 hors périmètre),
  soit **78 exigences vertes sur 79** ; porte G3 franchie (200 pages, 205 Mio, coupure
  réseau absorbée).
- ✅ WP-43/WP-44 : en-têtes personnalisés (`--entete`, validation unique partagée par les
  deux CLI, envoyés à la sonde **et** à chaque plage) et aspiration incrémentale
  (`--incremental`, `304` = fichier intact ; `--tentatives-total`, `--progression`) —
  `D-069`, `D-070`.
- ✅ WP-24/WP-25 : réécriture des liens (`--reecrire`, `D-053`, ajout XDM assumé), rapport
  d'aspiration (texte/JSON/CSV/Markdown, `--rapport`) et planification sans démon
  (`--planifier`, `--quota-octets`, `--quota-taches`, `D-054`).
- 🟡 WP-07 (annexe 15) : **fiches C (transports) et D (médias)** écrites, 20 exigences
  spécifiées, 0 implémentée — HLS est observé (12 balises), DASH est dérivé (`H-13`).
- ⛔ WP-03 (décompilation Ghidra) **bloqué** dans ce sandbox : ni JVM ni accès au CDN des
  releases GitHub (`JOURNAL.md` D-019) — à reprendre hors sandbox.
- ⏳ Reste à confirmer : le périmètre (action A-01) et la stack d'implémentation (D-017).
- ⛔ Hors périmètre par décision : licence/activation, contournement anti-débogage,
  extraction des cookies de navigateurs (voir `docs/JOURNAL.md` D-004).
