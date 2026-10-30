# XDM

Projet de **réimplémentation du « Site Grabber » d'Internet Download Manager** (aspirateur
de site, « çonage ») dans XDM, mené en **analyse statique outillée** : la cible
`cible/IDMan.exe` (IDM 6.42.22.3) est inspectée sans jamais être exécutée, chaque
constat étant rattaché à une preuve reproductible.

Outil principal : **[REA](https://github.com/morluto/rea)** (*Reverse Engineer Anything*),
CLI + serveur MCP qui produit des bundles *Evidence* (constats, couverture, limites).

## Démarrage

```bash
npm test                           # socle XDM : 361 tests, sans dépendance (node --test)
npm run desktop                    # application de bureau (Electron ; voir npm run desktop:install)
npm run audit                      # traçabilité : chaque exigence verte a un test qui existe
npm run gate                       # porte G3 : site local + coupure réseau, comparaison disque/serveur
npm run gate -- --pages 200 --max 200M   # profil de la porte : 200 pages, jusqu'à 200 Mo
node bin/xdm.js <url> [dossier]    # téléchargement réel : plages, reprise, promotion
node bin/xdm.js <url> [dossier] --sortie json   # un objet sur stdout, la progression sur stderr
node bin/xdm.js <url> [dossier] --proxy http://127.0.0.1:8080 --sans-reprise
node bin/xdm.js <url> [dossier] --nom archive.zip   # sinon le nom vient de l'URL ou du serveur
node bin/xdm-grab.js <url> [dir]   # aspiration de site : parcours, arborescence, file
node bin/xdm-grab.js <url> [dir] --reprendre --sortie json   # reprise + résumé machine
node bin/xdm-grab.js <url> [dir] --exclure '*/prive/*' --paralleles 4 --cookies c.json
node bin/xdm.js ftp://exemple.test/pub/fichier.zip [dossier]  # transport choisi par le schéma
node bin/xdm-grab.js <url> [dir] --essai     # plan complet, aucune écriture ni téléchargement
node bin/xdm-grab.js <url> [dir] --sitemap --sous-domaines   # plans de site + sous-domaines
node bin/xdm-grab.js --aide                  # options complètes (code 0), --version aussi
node bin/xdm-grab.js <url> [dir] --verifier  # auditer une aspiration (file ↔ disque, code 1 si écart)
node bin/xdm-grab.js <url> [dir] --taille-max 200M --espace-min 1G
npm run ui                         # interface locale : http://127.0.0.1:8100/ (xdm-ui)
node bin/xdm-ui.js --port 8100 --dossier ~/Téléchargements --actifs 3   # mêmes options, en clair
node bin/xdm-ui.js --hote 0.0.0.0  # exposition réseau : annoncée au démarrage, jamais par défaut
node bin/xdm-grab.js <url> [dir] --entete 'Authorization: Bearer x' --progression
node bin/xdm-grab.js <url> [dir] --incremental   # If-Modified-Since : un 304 laisse le fichier intact
node bin/xdm-grab.js <url> [dir] --reecrire --rapport r.md   # liens locaux + rapport d'aspiration
node bin/xdm-grab.js <url> [dir] --planifier 'lun-ven 01:00-06:00' --quota-octets 50000000
node bin/xdm-media.js <playlist.m3u8> [dir]   # flux HLS : segments, init, assemblage facultatif
node bin/xdm-media.js <media.mp4> [dir] --dash   # MP4 segmenté : plages lues dans l'index sidx
node bin/xdm-media.js <p.m3u8> [dir] --entete 'Authorization: Bearer x' --cookies c.json
                                    # playlist ET segments derrière le même transport authentifié
node bin/xdm.js <url> [dir] --cookies c.json     # le cookie posé par la sonde sert aux morceaux
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
| Maquette de l'interface de bureau (7 écrans, v2) | [`docs/maquettes/interface-xdm-v2.html`](docs/maquettes/interface-xdm-v2.html) |
| Décisions d'interface et application du skill UI | [`docs/maquettes/SKILL-ui-ux-pro-max.md`](docs/maquettes/SKILL-ui-ux-pro-max.md) |
| **Guide Windows** — exécuter chez soi ce qui est bloqué ici (VM, IDM, captures) | [`docs/GUIDE-WINDOWS.md`](docs/GUIDE-WINDOWS.md) |

## Structure

```text
src/                       socle XDM (ESM, zéro dépendance)
test/                      tests de spécification (node --test)
cible/IDMan.exe            cible d'analyse (fournie sur main)
docs/                      journal, roadmap, index mémoire, specs, doc REA, maquettes
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
  DASH) ; **361 tests**, domaines A, B, D et E clos, domaine C à **14/15** (1 hors périmètre),
  soit **102 exigences vertes sur 103** ; porte G3 franchie (200 pages, 205 Mio, coupure
  réseau absorbée).
- ✅ WP-43/WP-44 : en-têtes personnalisés (`--entete`, validation unique partagée par les
  deux CLI, envoyés à la sonde **et** à chaque plage) et aspiration incrémentale
  (`--incremental`, `304` = fichier intact ; `--tentatives-total`, `--progression`) —
  `D-069`, `D-070`.
- ✅ WP-53 : **application de bureau** — coquille Electron en périphérie
  (`src/desktop-shell.js`, `desktop/`) : fenêtre sans accès Node (`contextIsolation`,
  `sandbox`, `nodeIntegration: false`), menu natif Fichier/Affichage/Aide, serveur local
  sur port éphémère lié à la vie de la fenêtre, instance unique, liens externes renvoyés
  au navigateur du système. Electron reste hors du socle (`desktop/package.json`,
  `D-086`) : les 361 tests tournent sans lui. Ouverture réelle de la fenêtre à vérifier
  sur une machine à écran (`docs/GUIDE-WINDOWS.md`).
- ✅ WP-59 : **police embarquée et charge bornée** — Plus Jakarta Sans en WOFF2 servi par le
  serveur local (24 Kio, SIL OFL 1.1), aucune ressource distante dans la page, journal borné
  à 500 entrées, file de 300 tâches servie en ~10 ms (`D-091`, `EX-E-11`).
- ✅ WP-58 : **suspendre n'est pas échouer** — `AbortSignal` traversant le moteur (`probe`,
  plages, lecture), suspendre/reprendre dans le gestionnaire et l'API
  (`POST /api/taches/:id/suspendre|reprendre`), fichier partiel conservé et reprise au bon
  octet ; une progression à une seule connexion est désormais annoncée pendant le transfert
  (`D-090`, `EX-E-10`).
- ✅ WP-56 : **paquet de bureau préparé** — `node tools/empaqueter.mjs` produit une
  arborescence de distribution (52 fichiers, 590 Kio) avec un manifeste SHA-256 par fichier ;
  `cible/`, `test/`, `analysis/`, `tools/` et les dossiers de téléchargement n'y entrent
  jamais (`D-089`, `EX-E-09`). L'installeur signé reste à faire sur une machine de
  distribution : `docs/GUIDE-WINDOWS.md` §8 bis.
- ✅ WP-57 : **guide Windows** — `docs/GUIDE-WINDOWS.md` : les quatre lots bloqués
  (`WP-30`, `WP-40`, `WP-41`, `WP-42`) deviennent exécutables chez un tiers, avec le site
  témoin à construire, les filtres Process Monitor, le hook Frida, la grille de mesures et
  le format de restitution.
- ✅ WP-55 : **l'interface exposée porte un jeton** — hors boucle locale, `xdm-ui` tire un
  jeton de 192 bits, l'affiche une fois et l'exige pour l'API comme pour la page ;
  comparaison à temps constant, échange `?jeton=` contre un cookie `HttpOnly` pour que
  `EventSource` continue de fonctionner, aucun jeton journalisé (`D-088`, `EX-E-08`).
- ✅ WP-54 : **parité du Site Grabber avec la CLI** — motifs `inclure`/`exclure` (motif vide
  refusé), sous-domaines, explorations simultanées bornées, réécriture des liens des pages
  téléchargées. Le gabarit « médias seulement » du projet IDM n'est plus appliqué : sans
  cela, filtrer une aspiration aurait supprimé toutes les pages (`D-087`).
- ✅ WP-52 : **Site Grabber, Vérification et réglages persistants** — l'aspiration s'exécute
  dans son propre dossier (`src/aspiration.js`), reste vérifiable (`src/verification.js`),
  et les réglages (dossier, connexions, actifs, thème) sont validés puis relus au démarrage
  (`src/reglages.js`) ; `robots.txt` n'est désactivable ni par fichier ni par API. Les sept
  écrans de la maquette sont désormais câblés. Fiche `EX-E-01`→`EX-E-03`, `D-085`.
- ✅ WP-51 : **interface locale** — `xdm-ui` sert une page qui pilote le moteur par trois
  couches (`src/manager.js` état/file/journal/historique, `src/ui-server.js` HTTP + SSE,
  `bin/xdm-ui.js` CLI). Écoute sur la boucle locale par défaut, aucune injection HTML
  (les données distantes passent par `textContent`), aucune pause mensongère : seules les
  tâches **en attente** sont retirables, la limite est écrite dans l'écran. Écrans
  câblés : Téléchargements, File d'attente, Journal, Historique, Réglages — Site Grabber
  et Vérification restent hors navigation tant qu'ils ne sont pas branchés. `D-084`,
  **[maquette validée](docs/maquettes/interface-xdm-v2.html)**.
- ✅ WP-50 : les CLI disent leurs bornes, leurs codes et leur aide — refus de
  `--connexions` hors 1–128 et de `--morceau` hors 1–10 Mio (avec avertissement au-delà de
  500 morceaux), code de sortie 1 dès qu'une tâche échoue, `--verifier` qui distingue
  `FAILED` de `PENDING`, `--aide`/`--version` sur les trois CLI, compte de cookies juste —
  `D-079`→`D-083`. **Guide de test** : [`docs/GUIDE-TEST.md`](docs/GUIDE-TEST.md).
- ✅ WP-49 : l'authentification ne s'arrête plus au milieu d'un flux — `xdm-media` accepte
  `--entete`, `--cookies` et `--proxy` sur un **seul** transport (playlist, init et chaque
  segment), `xdm` sait persister un magasin de cookies, les trois CLI refusent un argument
  positionnel de trop, et `--verifier --sortie json` publie `absent` — `D-075`→`D-078`.
- ✅ WP-45 → WP-48 : l'outil ne ment plus sur ses options — reprise de fichier par défaut et
  `--sans-reprise`, carte d'une autre URL refusée, nom par `Content-Disposition`, `--sortie
  json`, `--proxy` **réellement** appliqué au HTTP, et rapport écrit par `--verifier
  --rapport` — `D-071`→`D-074`.
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
