# Matrice de conformité (WP-12, v0.1)

> **Statut** : ✅ v1.17 — **Dernière revue** : 2026-10-30
> **Vérification** : `node tools/audit-conformance.mjs --strict` (6 contrôles) — la matrice
> est auditée, pas seulement rédigée : voir `revue-clean-room.md`.
> **Rôle** : relier, pour chaque exigence de spécification, la **preuve** statique qui la
> fonde et le **test** qui la vérifiera. Aucune ligne d'implémentation ne référence une
> exigence absente de ce fichier.
> **Sources** : `docs/specs/A-moteur-de-telechargement.md` (v0.9),
> `docs/specs/B-grabber.md` (v0.11), annexes 12 à 16 ; fiches C et D dans l'annexe 15 ;
> domaine E (interface) : décisions `D-084`/`D-085`, sans fiche de spécification dédiée.
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
| `EX-A-01` fichier unique écrit en place | Observé | annexe 14 §5.2, §7 (`CreateFileW` `0x156d48`) | `T-A-01` | **vert** |
| `EX-A-02` état dans `<cible>.xdm-part.json` | Décision | `D-024` | `T-A-02` | **vert** |
| `EX-A-03` carte = liste de bornes | Observé + Décision | annexe 14 §5.1 ; `D-030` | `T-A-03` | **vert** |
| `EX-A-04` rejet des cartes incohérentes | Dérivé | `D-030` | `T-A-04` | **vert** |
| `EX-A-20` reprise au niveau **fichier** par défaut (carte relue, morceaux clos non redemandés), `--sans-reprise` pour repartir de zéro, carte d'une **autre URL** jamais recollée et raison du refus annoncée (`url`, `taille`, `validateur`) | **Décision** (`D-071`) | `D-071` ; `src/connection-loop.js`, `bin/xdm.js` | `T-A-29`, `T-A-30` | **vert** |
| `EX-A-21` nom final : `--nom`, sinon l'URL, sinon `Content-Disposition` (`filename*` avant `filename`) quand le nom de l'URL n'a pas d'extension ; composante finale assainie | **Décision** (`D-072`) | `D-072` ; `src/promote.js`, `src/http-client.js` | `T-A-30` | **vert** |
| `EX-A-22` `--sortie json` : un seul objet sur `stdout`, progression et messages sur `stderr` | **Décision** (`D-073`) | `D-073` ; `bin/xdm.js` | `T-A-31` | **vert** |
| `EX-A-23` `--proxy` appliqué au transfert HTTP **et** à la sonde ; proxy illisible refusé localement | **Décision** (`D-074`) | `D-074` ; `src/proxy.js`, `bin/xdm.js` | `T-A-32` | **vert** |
| `EX-A-24` **magasin de cookies pour le moteur** (`xdm --cookies F`) : le fichier est relu au départ et réécrit à la fin ; le `Set-Cookie` de la **sonde** sert ensuite à **chaque morceau**, dans le même transport, sans recopie manuelle | **Décision** (`D-076`) | `D-076` ; `src/cookies.js` (`withCookies`), `bin/xdm.js` | `T-A-24` | **vert** |
| `EX-A-25` **bornes des options numériques** : `--connexions` 1..128 et `--morceau` 1..10 485 760 octets sont refusés **localement** (message avec la valeur reçue) au lieu d'être corrigés en silence ; un découpage donnant plus de 500 morceaux est **signalé** au lieu de laisser croire à un transfert normal | **Décision** (`D-079`) | `D-079` ; `bin/xdm.js` (`MORCEAUX_ALERTE`), `src/connection-loop.js` (`MAX_SOCKETS`), `src/chunk-policy.js` | `T-A-33` | **vert** |
| `EX-A-05` progression dérivée | Dérivé | `D-031` | `T-A-05` | **vert** |
| `EX-A-06` morceau 1–10 MiB, paliers 2/10 MiB | Observé + Décision | annexe 14 §5.4 ; `chunks.json` ; `D-029` | `T-A-06` | **vert** |
| `EX-A-07` 1 → N connexions, plafond 8 par défaut | Observé + Décision | annexe 14 §6 ; `0x0fbe17` ; `D-036`, `D-043` | `T-A-07` | **vert** (allocation, file, boucle et **runner** ; la boucle réseau reste à écrire) |
| `EX-A-08` `Range` par morceau, repli 1 connexion sans `206` | Observé | annexe 14 §8 ; `D-038` | `T-A-08` | **vert** (planification ; la boucle reste à écrire) |
| `EX-A-09` rollback = troncature + morceau de reprise | Observé + Décision | annexe 14 §5.3 ; `D-035` | `T-A-09` | **vert** |
| `EX-A-10` divergence → empreinte → repli | Observé + Décision | annexe 14 §5.5 ; `D-025`, `D-039` | `T-A-10` | **vert** |
| `EX-A-11` morceau incomplet jamais finalisé | Observé | annexe 14 §7 (`isCmpleted = 0`) | `T-A-11` | **vert** |
| `EX-A-12` promotion conditionnée à la vérification | Observé + Décision | annexe 14 §7 ; `D-026` | `T-A-12` | **vert** |
| `EX-A-13` réacteur unique, 128 sockets, délai ≤ 12 s | Observé + Décision | annexe 14 §4.4 ; `io-model.json` ; `D-028`, `D-039` | `T-A-13` | **vert** (plafond 128 ; le réacteur unique est celui de Node) |
| `EX-A-14` nom final assaini | Observé + Décision | annexe 14 §3 ; `D-037` | `T-A-14` | **vert** |
| `EX-A-15` URL relative résolue, ≤ 10 redirections, ≤ 10 239 o | Observé | annexe 14 §8.1 (`0x17dc90`) ; `D-038` | `T-A-15` | **vert** |
| `EX-A-16` `Accept-Encoding: identity` | Observé | annexe 14 §8 ; `D-038` | `T-A-16` | **vert** |
| `EX-A-17` aucune télémétrie | Décision | `D-004`, `D-012` | `T-A-17` | **vert** |
| `EX-A-18` inactivité > 30 s ⇒ reconnexion | Observé | annexe 14 §4.5 (`0x1a139f`, `0x18adad`) ; `D-038` | `T-A-25` | **vert** |
| `EX-A-19` reprise sans retour à zéro | Observé + Décision | annexe 14 §4.5, §5.3 ; `D-030` | `T-A-26` | **vert** |

**Couverture** : 25 exigences, **25 vertes** (`npm test`, 286 cas) — domaine A **clos**.
La boucle de connexions (`src/connection-loop.js`) exécute les exigences de bout en bout
contre des serveurs locaux, y compris la coupure, la reprise depuis la carte persistée et la
promotion (`T-A-25`, `T-A-19`, `T-A-12`). Aucune exigence
`Hypothèse` dans ce domaine.

## 3. Domaine B — grabber

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-B-01` projet = un artefact | Observé + Décision | annexe 11 §1 (`%sproject%s.gsd`) ; `D-042` | `T-B-01` | **vert** |
| `EX-B-02` contenu du projet | Dérivé | annexe 11 §4 | `T-B-02` | **vert** |
| `EX-B-03` filtre sans portée propre | Observé + Décision | annexe 13 §2 bis ; `D-032` | `T-B-03` | **vert** |
| `EX-B-04` identifiants à partir de 100 | Observé + Décision | annexe 13 §2 ter ; `D-033` | `T-B-04` | **vert** |
| `EX-B-05` motif = masque glob | Observé | annexe 13 §4 bis | `T-B-05` | **vert** |
| `EX-B-06` champs d'une entrée | Observé | annexe 12 §2 | `T-B-06` | **vert** |
| `EX-B-07` profondeur paramétrable (`nLevels`) | Observé + Décision | annexe 13 §4 bis ; `D-041` | `T-B-07` | **vert** (profondeur 1, 2 et arrêt aux niveaux) |
| `EX-B-08` exploration HTML → liens → classement | **Décision** (`D-041`, `H-05` levée) | `Q-B-01` ; `src/crawler.js` | `T-B-08` | **vert** |
| `EX-B-09` dédoublonnage des URL | **Décision** (`D-041`) | `Q-B-01` ; `canonicalUrl` | `T-B-09` | **vert** |
| `EX-B-10` entrée = tâche de téléchargement | Observé | annexe 12 §1 ; `D-042`, `D-043` | `T-B-10` | **vert** |
| `EX-B-11` arborescence locale | Observé + Décision | annexe 12 §2 ; `D-042` | `T-B-11` | **vert** |
| `EX-B-12` `empty.html` | Observé + Décision | annexe 13 §4 (`0xd1ed0`) ; `D-042` | `T-B-12` | **vert** |
| `EX-B-13` pas de sortie de domaine | **Décision** (`D-041`) | annexe 12 §6 ; `src/crawler.js` | `T-B-13` | **vert** |
| `EX-B-14` réécriture des liens vers les chemins locaux | **Décision** (`D-053`, sans précédent) | `D-053` ; `Q-B-01` | `T-B-26` | **vert** |
| `EX-B-15` rapport texte/JSON/CSV/Markdown, sans valeur inventée, incluant le **diagnostic d'exploration** (motifs de rejet comptés) quand un parcours a eu lieu | **Décision** (`D-053`, `D-064`) | `D-053`, `D-064` ; `src/report.js` | `T-B-27`, `T-B-35` | **vert** |
| `EX-B-16` planification recalculée : fenêtres, quotas, ni démon ni cron | **Décision** (`D-054`) | `D-054` ; `src/schedule.js` | `T-B-28` | **vert** |
| `EX-B-17` `robots.txt` lu selon la RFC 9309 : règles du **seul groupe applicable** (le groupe nommant notre produit l'emporte sur `*`, groupes homonymes fusionnés), `*` et `$` du motif, règle la plus longue, `Allow` gagne à longueur égale, directives inconnues ignorées sans erreur | **Décision** (`D-059`, précise `D-041`) | `D-059` ; `src/crawler.js` (`parseRobots`, `robotsRegExp`) | `T-B-29` | **vert** (13 cas) |
| `EX-B-18` exploration **parallèle bornée** : au plus `parallelisme` requêtes simultanées, parcours par vagues absorbées dans l'ordre de la file, résultat identique à l'exploration en série | **Décision** (`D-061`) | `D-061` ; `Q-B-05` ; `src/crawler.js` (`crawl`) | `T-B-30` | **vert** (pic ≤ 3 et ≥ 2, même sortie qu'en série) |
| `EX-B-19` `Crawl-delay` : lu pour le groupe applicable, borné à un nombre fini de secondes, appliqué **entre deux vagues** ; un délai explicite (`--delai`, y compris `0`) l'emporte toujours | **Décision** (`D-060`) | `D-060` ; `src/crawler.js` (`parseCrawlDelay`) | `T-B-31` | **vert** |
| `EX-B-29` les tâches laissées `ACTIVE`/`VERIFYING` par un arrêt **brutal** sont relevées au `--reprendre` (`ACTIVE → PAUSED → PENDING`, `VERIFYING → FAILED → PENDING`, transitions déjà autorisées) ; le nombre est annoncé | **Décision** (`D-067`) | `D-067` ; `src/grab-runner.js` (`recoverOrphans`) | `T-B-40` | **vert** |
| `EX-B-30` plafond de taille par fichier (`--taille-max`), refusé **après la sonde, avant tout octet écrit** (`TOO_LARGE` avec taille et plafond) ; tailles lues en unités **binaires**, unité inconnue refusée | **Décision** (`D-067`) | `D-067` ; `src/size.js`, `src/connection-loop.js` | `T-B-41` | **vert** |
| `EX-B-31` espace disque vérifié **avant la première connexion** : disponible via `statfs` (`bavail`, pas `bfree`), réserve par défaut, octets à libérer annoncés, taille inconnue comptée à part ; refus = projet et file écrits, code 1 | **Décision** (`D-067`) | `D-067` ; `src/diskspace.js` | `T-B-42` | **vert** |
| `EX-B-32` `--verifier` : audit **file ↔ disque** sans réseau (manquants, tronqués, partiels, absents, fichiers hors file, fichiers de l'outil exclus) ; code 1 sur écart ; ne crée ni ne corrige rien ; rapport HTML **autonome** et échappé (`--rapport x.html`) | **Décision** (`D-068`) | `D-068` ; `src/verify.js`, `src/report.js` (`toHtml`) | `T-B-43`, `T-B-44` | **vert** |
| `EX-B-33` **en-têtes personnalisés** (`--entete`, répétable, les deux CLI) : mêmes règles de validation à la main de l'appelant qu'au moteur — nom = jeton RFC 9110, valeur sans `CR`/`LF`/`NUL`, refus **explicite** ; un en-tête part avec la **sonde et chaque plage**, jamais avec l'un sans l'autre | **Décision** (`D-069`) | `D-069` ; `src/headers.js` (`parseHeaderOption`), `src/connection-loop.js` | `T-A-28` | **vert** |
| `EX-B-34` **aspiration incrémentale** (`--incremental`) : `If-Modified-Since` sur la date du fichier local ; un `304` laisse le fichier **intact** (aucune écriture, même date) et compte comme **terminé** ; un `200` réécrit ; avec `--reprendre`, les tâches `DONE` sont **rouvertes** pour être reposées au serveur | **Décision** (`D-070`) | `D-070` ; `src/connection-loop.js`, `src/http-client.js` (`probe`), `src/grab-runner.js` (`reopenDone`) | `T-B-45` | **vert** |
| `EX-B-35` **crédit d'essais cumulés** (`--tentatives-total`) : au-delà du plafond, une tâche en échec n'est **pas** rejouée par `--reprendre`, reste `FAILED` avec son message, et le nombre est annoncé | **Décision** (`D-070`) | `D-070` ; `src/grab-runner.js` (`retryFailedCapped`) | `T-B-46` | **vert** |
| `EX-B-36` **progression lisible** (`--progression`) : paliers de 10 %, une ligne par palier et par fichier, taille inconnue annoncée **une fois** sans pourcentage inventé ; `--verifier --sortie json` rend des compteurs et des **listes de chemins**, pas des objets de tâche | **Décision** (`D-070`) | `D-070` ; `src/progress.js`, `bin/xdm-grab.js` (`summarize`) | `T-B-47`, `T-B-48` | **vert** |
| `EX-B-37` `--verifier --rapport` écrit un **rapport de vérification** dans les quatre formats (extension ⇒ format, `.htm` compris) : anomalies seules (`MANQUANT`, `TRONQUÉ`, `PARTIEL`, `ABSENT`, `HORS FILE`), conformité, octets annoncés et sur disque | **Décision** (`D-074`) | `D-074` ; `src/report.js` (`buildVerifyReport`), `bin/xdm-grab.js` (`reportFormatFor`) | `T-B-49` | **vert** |
| `EX-B-24` **plans de site** (opt-in) : directives `Sitemap:` du `robots.txt` d'abord, sinon `/sitemap.xml` ; index suivi **un seul niveau**, plans et URL **plafonnés** ; seules les URL de la même origine sont retenues ; les URL trouvées sont des **amorces** soumises aux mêmes contrôles (`robots.txt`, filtres, site, plafond) — une amorce fichier est retenue sans être « visitée » | **Décision** (`D-065`) | `D-065` ; `src/sitemap.js` | `T-C-17`, `T-B-37` | **vert** |
| `EX-B-25` `--sous-domaines` élargit le parcours au **même site** (même hôte, sous-domaine, même parent d'au moins deux labels), jamais à un domaine tiers ; opt-in, et la limite « pas de *Public Suffix List* » est nommée | **Décision** (`D-065`) | `D-065` ; `src/crawler.js` (`sameSiteHost`) | `T-B-36`, `T-C-19` | **vert** |
| `EX-B-26` `--tentatives` couvre **aussi l'exploration** : mêmes statuts transitoires et même `Retry-After` que les téléchargements (`D-055`), reprises comptées, aucune seconde politique | **Décision** (`D-065`) | `D-065` ; `src/retry.js`, `src/crawler.js` | `T-B-38`, `T-C-19` | **vert** |
| `EX-B-27` **interruption propre** (Ctrl-C) : arrêt coopératif — les tâches en vol finissent, les autres restent `PENDING`, projet/file/cookies sauvegardés, code **130**, seconde interruption = sortie immédiate ; aucune tâche laissée `ACTIVE` | **Décision** (`D-066`) | `D-066` ; `src/grab-runner.js` (`shouldStop`), `bin/xdm-grab.js` | `T-B-39`, `T-C-20` | **vert** |
| `EX-B-28` `--aide`/`--version` répondent **sans URL** et sortent en code **0** — sur les **trois** CLI (`xdm`, `xdm-grab`, `xdm-media`), sans effet de bord ; `xdm-media` répondait 2 à `--aide` et « option inconnue » à `--version` | **Décision** (`D-066`, étendue par `D-082`) | `D-066`, `D-082` ; `src/version.js`, `bin/xdm-media.js` | `T-C-21` | **vert** |
| `EX-B-21` les liens relatifs se résolvent contre la **base déclarée** (`<base href>`, première balise, base inexploitable ignorée) ; la balise ne devient jamais un lien à télécharger | **Décision** (`D-063`) | `D-063` ; `src/crawler.js` (`documentBase`) | `T-B-33` | **vert** |
| `EX-B-22` le parcours **s'arrête** après N pages en échec **consécutif** (`--arret-erreurs`), et le dit (`stopped: 'erreurs'`) ; un échec isolé ne déclenche rien, une file vidée n'est pas un arrêt sur erreur | **Décision** (`D-063`) | `D-063` ; `src/crawler.js` (`maxErrors`) | `T-B-34` | **vert** |
| `EX-B-23` `--essai` montre le **plan** (pages, fichiers, cibles, arrêt) sans rien écrire ni télécharger : dossier cible non créé, ni `empty.html`, ni projet, ni file, code de sortie 0 ; `--sortie json` reste consommable | **Décision** (`D-064`) | `D-064` ; `bin/xdm-grab.js` | `T-C-16` | **vert** |
| `EX-B-38` le JSON de vérification (`--verifier --sortie json`) publie les **six** listes d'anomalies, `absent` comprise : une tâche jamais commencée n'est pas une tâche conforme, et l'oublier dans le JSON la faisait disparaître des scripts | **Décision** (`D-078`) | `D-078` ; `bin/xdm-grab.js` (`summarize`) | `T-B-50` | **vert** |
| `EX-B-39` **code de sortie** d'une aspiration : `0` seulement si aucune tâche n'a échoué ; une tâche `FAILED` sort en **1** et le nombre est annoncé (auparavant : code 0 avec 3 fichiers sur 5 manquants) | **Décision** (`D-080`) | `D-080` ; `bin/xdm-grab.js` | `T-B-51` | **vert** (vrai binaire, deux sites) |
| `EX-B-40` `--verifier` distingue « **tentée et ratée** » (`FAILED`, écart, conformité fausse, code 1) de « **pas encore tentée** » (`PENDING`, normal) ; les tâches `FAILED` sont nommées une par une | **Décision** (`D-081`) | `D-081` ; `src/verify.js` (`failed`), `bin/xdm-grab.js` | `T-B-52` | **vert** |
| `EX-B-41` le **compte de cookies** annoncé après écriture est celui du fichier, pour `xdm` **et** `xdm-media` : le message lisait `saved.count`, champ inexistant, et affichait « undefined cookie(s) » | **Décision** (`D-083`) | `D-083` ; `bin/xdm.js`, `bin/xdm-media.js` | `T-A-34`, `T-D-12` | **vert** |
| `EX-B-20` `--exclure` **élague** la branche : un lien élagué n'est ni retenu ni demandé, donc rien de ce qu'il cite n'entre dans la file ; l'exclusion par défaut, elle, continue de ne trier que les téléchargements | **Décision** (`D-060`) | `D-060` ; `D-032` ; `src/crawler.js` (`prune`) | `T-B-32`, `T-C-14` | **vert** |

**Couverture** : 41 exigences, **41 vertes** (`npm test`, 286 cas) — domaine B **clos**.
`Q-B-01` est close comme non instruite dans ce module (annexe 12 §6) : l'exploration et
l'arborescence sont des **choix XDM** implémentés et testés (`src/crawler.js`,
`src/grabber.js`, `D-041`/`D-042`).

**Exécution de bout en bout (`D-043`)** — ces exigences ne dépendent plus d'un plan :

| Ce qui est exécuté | Code | Tests |
|---|---|---|
| parcours → arborescence → file | `src/crawler.js`, `src/grabber.js` | `T-B-20` (`test/grab-cli.test.js`) |
| file → téléchargement → promotion | `src/grab-runner.js` | `T-B-01`, `T-B-10` (`test/grab-runner.test.js`) |
| états `PENDING → ACTIVE → VERIFYING → DONE`, échec isolé | `src/grab-runner.js`, `src/task-queue.js` | `T-A-07`, `T-A-22` |
| concurrence bornée (8 par défaut) | `src/grab-runner.js` | `T-A-07` |
| seules les pages sont explorées | `src/crawler.js` (`isPageUrl`) | `T-B-08` |
| reprise bornée des statuts transitoires | `src/retry.js`, `src/grab-runner.js` (`maxAttempts`) | `T-C-11` |
| réécriture locale des pages et feuilles de style | `src/rewrite.js`, `bin/xdm-grab.js` (`--reecrire`, `--inclure`, `--sans-exclusions`) | `T-B-26` |
| rapport d'aspiration (texte/JSON/CSV/Markdown) | `src/report.js`, `bin/xdm-grab.js` (`--rapport`) | `T-B-27` |
| fenêtre de planification, quotas, hors fenêtre ⇒ code 3 | `src/schedule.js`, `src/task-queue.js` (`accept`), `src/grab-runner.js` (`only`) | `T-B-28` |
| essai sans effet de bord (`--essai`) | `bin/xdm-grab.js` | `T-C-16` |
| en-têtes personnalisés pages + fichiers (`--entete`) | `bin/xdm-grab.js` (`parseHeader`) | `T-C-15` |
| diagnostic d'exploration dans le rapport | `src/report.js` (`summarizeCrawl`) | `T-B-35` |
| plans de site → amorces du parcours | `src/sitemap.js`, `bin/xdm-grab.js` (`--sitemap`) | `T-C-17`, `T-B-37` |
| interruption propre (Ctrl-C) | `src/grab-runner.js` (`shouldStop`), `bin/xdm-grab.js` | `T-B-39`, `T-C-20` |
| reprise après arrêt brutal | `src/grab-runner.js` (`recoverOrphans`) | `T-B-40` |
| plafond de taille, espace disque | `src/size.js`, `src/diskspace.js` | `T-B-41`, `T-B-42` |
| vérification d'une aspiration existante | `src/verify.js`, `bin/xdm-grab.js` (`--verifier`) | `T-B-43` |
| cookies de session partagés exploration ↔ téléchargements, persistés sur demande | `src/cookies.js`, `bin/xdm-grab.js` (`--cookies`) | `T-C-12` |
| élagage d'une branche par `--exclure` | `src/crawler.js` (`prune`), `bin/xdm-grab.js` | `T-B-32`, `T-C-14` |

## 3 bis. Domaine C — transports (`WP-07`)

> Source : [`analysis/idman/15-spec-protocoles.md`](../../analysis/idman/15-spec-protocoles.md) §2.

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-C-01` HTTP/1.1 uniquement | Observé | annexe 15 §2.1 | `T-C-01` | **vert** (aucun `node:http2`) |
| `EX-C-02` en-têtes de requête | Observé | annexe 15 §2.1 | `T-C-02` | **vert** (`User-Agent`, `Accept`, `Referer`, `Cookie`) |
| `EX-C-03` `If-Range` + `Content-Range` | Observé | `0x6b8018`, `0x6b1e24` | `T-C-03` | **vert** (validateur de la carte, redémarrage si périmé) |
| `EX-C-04` cookies de session | Observé + Dérivé | `0x6b2958` | `T-C-04` | **vert** (RFC 6265, hôte ≠ domaine) |
| `EX-C-05` `gzip, deflate` hors morceaux | Observé | `0x6b26bc` | `T-C-05` | **vert** (décompression gzip/deflate/br) |
| `EX-C-06` séquence FTP `CWD`→`TYPE I`→`SIZE`→`REST`→`RETR` | Observé | annexe 15 §2.3 | `T-C-06` | **vert** (`src/ftp.js`) |
| `EX-C-07` refus de `PASV` = échec explicite | Observé | annexe 15 §2.3 | `T-C-07` | **vert** (`PASV_UNSUPPORTED`) |
| `EX-C-15` **refus d'un argument positionnel de trop** dans les trois CLI (code 1, message `trop d'arguments : …`) : `xdm a b c` téléchargeait `a` et passait `c` sous silence | **Décision** (`D-077`) | `D-077` ; `bin/xdm.js`, `bin/xdm-grab.js`, `bin/xdm-media.js` | `T-A-25` | **vert** |
| `EX-C-08` RTMP/RTMPT/MMS hors grabber | Observé + `H-18` | annexe 15 §2.4 | — | ⛔ **hors périmètre** (`H-18` : enregistrement de flux) |
| `EX-C-09` proxys HTTP/HTTPS/FTP/SOCKS + PAC | Observé | annexe 15 §2.5 | `T-C-09` | **vert** (`src/proxy.js`, `src/pac.js` ; FTP par tunnel) |
| `EX-C-10` authentification proxy Basic/Digest | Observé | annexe 15 §2.5 | `T-C-10` | **vert** (Basic + Digest `qop=auth`) |
| `EX-C-11` statuts transitoires : diagnostic explicite (`HTTP_STATUS`, `retryable`, `Retry-After`), pas de reprise silencieuse | **Décision** (`D-055`) | `D-055` ; `src/retry.js` | `T-C-11` | **vert** (reprise par la file, `--tentatives`, `Retry-After` respecté) |
| `EX-C-12` persistance **optionnelle** du magasin de cookies : `--cookies F` relit le fichier, applique les cookies aux pages *et* aux téléchargements, réécrit le magasin en fin d'exécution ; seuls les cookies **datés** sont conservés, fichier en `0600`, écrit par fichier temporaire puis `rename` ; un fichier corrompu lève au lieu d'être deviné | **Décision** (`D-062`, étend `D-047`) | `D-062` ; `src/cookies.js` | `T-C-12` | **vert** (session exclue, `100600`, reprise sans repasser par la page) |
| `EX-C-14` en-têtes personnalisés (`--entete « Nom: valeur »`, répétable) envoyés aux **pages** comme aux **fichiers** ; nom validé comme jeton HTTP, retour à la ligne **refusé** (injection d'en-tête) ; un en-tête du moteur (`Range`, `If-Range`) reste prioritaire | **Décision** (`D-063`) | `D-063` ; `EX-C-02` ; `bin/xdm-grab.js` (`parseHeader`) | `T-C-15` | **vert** |
| `EX-C-13` la CLI de téléchargement choisit le transport d'après le **schéma** de l'URL (`http`/`https` → moteur HTTP, `ftp` → `src/ftp.js`) et refuse tout autre schéma **avant** tout accès réseau | **Décision** (`D-062`, met en service `EX-C-06`) | `D-062` ; `EX-C-06` ; `bin/xdm.js` | `T-C-13` | **vert** (séquence FTP observée, `REST` de reprise, schéma inconnu refusé) |

**Couverture : 14 vertes / 15, 1 hors périmètre** (`D-047`→`D-052`, `D-055`, `D-062`, `D-063`) :
- **vertes** : `EX-C-01` (HTTP/1.1 seul), `EX-C-02` (en-têtes), `EX-C-03` (`If-Range` de la
  carte), `EX-C-04` (`src/cookies.js`), `EX-C-05` (`src/headers.js` + `decodeBody`),
  `EX-C-06`/`EX-C-07` (`src/ftp.js`) ;
- **vertes (fin)** : `EX-C-09` (HTTP/HTTPS `CONNECT`, SOCKS5, FTP par tunnel, PAC à
  sous-ensemble explicite), `EX-C-10` (Basic **et** Digest, `D-052`), `EX-C-12` (cookies
  persistants `0600`), `EX-C-13` (transport choisi par le schéma) et `EX-C-14` (en-têtes
  personnalisés, injection refusée) ;
- **hors périmètre** : `EX-C-08` (RTMP/MMS servent l'enregistrement de flux, `H-18`).

## 3 ter. Domaine D — médias (`WP-07`)

> Source : [`analysis/idman/15-spec-protocoles.md`](../../analysis/idman/15-spec-protocoles.md) §3.

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-D-01` playlist HLS reconnue | Observé | `0x6b2790`, MIME `0x6b2f48` | `T-D-01` | **vert** (`src/hls.js`) |
| `EX-D-02` variantes `STREAM-INF` | Observé + Dérivé | `0x6b275c` | `T-D-02` | **vert** (débit le plus haut, `D-046`) |
| `EX-D-03` segments `EXTINF` | Dérivé | annexe 15 §3.1 | `T-D-03` | **vert** (plan + téléchargement) |
| `EX-D-04` `EXT-X-MAP` avant les segments | Observé + Dérivé | `0x6b27c8`, `-tmp_dashinit` | `T-D-04` | **vert** (`init.mp4` en premier) |
| `EX-D-05` `EXT-X-BYTERANGE` | Observé | `0x6b27f8` | `T-D-05` | **vert** (plages explicites et implicites) |
| `EX-D-06` `EXT-X-KEY` sans déchiffrement | Observé + `D-004` | `0x6b2828` | `T-D-06` | **vert** (`encrypted: true`, octets intacts) |
| `EX-D-07` direct (`MEDIA-SEQUENCE`) | Observé + Dérivé | `0x6b284c` | `T-D-07` | **vert** (analyse ; suivi continu non implémenté) |
| `EX-D-08` DASH par `sidx`, pas de `MPD` | Observé + `H-19` | `CMp4DashReader`, `CSidxParser` (`0x2b5aa8`) | `T-D-08` | **vert** (`src/dash.js` : plages de l'index, init, refus sans index) |
| `EX-D-09` `DISCONTINUITY` | Dérivé | `0x6b2798` | `T-D-09` | **vert** (frontière signalée) |
| `EX-D-11` **authentification unifiée des médias** (`xdm-media --entete`, `--cookies`, `--proxy`) : un **seul** transport pour la playlist, l'init et **chaque** segment, y compris ceux sans `BYTERANGE` ; une playlist non-2xx lève son **statut** au lieu de « #EXTM3U attendu » | **Décision** (`D-075`) | `D-075` ; `src/headers.js` (`withHeaders`), `src/media.js`, `bin/xdm-media.js` | `T-D-11` | **vert** (4 cas) |
| `EX-D-10` aucun DRM | Décision | `D-004` ; annexe 15 §3 | `T-D-10` | **vert** (décision écrite et testée) |

**Couverture : 11 / 11** — `src/hls.js`, `src/media.js` et `bin/xdm-media.js` (`D-046`)
pour HLS, `src/sidx.js` et `src/dash.js` pour DASH (`D-048`). Domaine D **clos**.

## 3 quater. Domaine E — interface (`WP-51`/`WP-52`)

| Exigence | Niveau | Preuve (annexe / offset) | Test | État |
|---|---|---|---|---|
| `EX-E-01` **interface locale pilotée par un gestionnaire** : `xdm-ui` sert une page qui parle à `src/manager.js`, qui parle au moteur — l'interface ne touche ni au disque ni aux sockets ; l'écoute est sur la boucle locale par défaut, `--hote 0.0.0.0` est un choix explicite annoncé au démarrage | **Décision** (`D-084`) | `D-084` ; `src/manager.js`, `src/ui-server.js`, `bin/xdm-ui.js` | `T-E-01`, `T-E-02` | **vert** |
| `EX-E-02` **l'état affiché vient du moteur** : un ajout part en file, la file appelle `connection-loop`, le résultat porte le code de sortie de la CLI (`0` succès, `1` échec) et rejoint l'historique ; la progression arrive par **SSE** et non par sondage ; aucune donnée distante n'est insérée en HTML | **Décision** (`D-084`) | `D-084` ; `src/manager.js`, `src/ui/app.js` | `T-E-03`, `T-E-04` | **vert** |
| `EX-E-03` **réglages persistants et vérification** : les réglages (dossier, connexions, actifs, thème) sont validés puis écrits dans un JSON relu au démarrage ; `robots` ne se désactive ni par fichier ni par API (`D-004`) ; la vérification refuse un dossier absent ou sans `queue.json` et rend le code `0`/`1` de la CLI ; une aspiration s'exécute dans son propre dossier et reste vérifiable | **Décision** (`D-085`) | `D-085` ; `src/reglages.js`, `src/verification.js`, `src/aspiration.js` | `T-E-05`→`T-E-08` | **vert** |

## 4. Ce que cette matrice révèle

1. **Le domaine A est spécifiable et testable immédiatement** : 23 exigences, aucune
   hypothèse, chaque test peut s'écrire sans réseau réel (serveur local + fichiers).
2. **Le domaine B ne l'est pas** : 3 exigences sur 13 reposent sur l'algorithme
   d'exploration, qui n'est pas établi (`Q-B-01`, `A-09`).
3. **Trois exigences du domaine B sont des ajouts XDM assumés** : réécriture des liens
   (`EX-B-14`), rapport (`EX-B-15`), planification (`EX-B-16`). Elles ne figurent pas dans
   la cible — `Q-B-01` a établi qu'`IDMan.exe` n'embarque aucun parseur HTML — et la fiche B
   les marque **Décision**, jamais **Observé**.
4. **Le socle est complet et couvert** : 50 cas verts sur six modules (`chunk-map`,
   `chunk-policy`, `part-file`, `work-file`, `project`, `task-queue`, `promote`) écrits
   *avant* toute couche réseau. Un test a d'ailleurs invalidé une conséquence implicite de
   `D-030` (`D-035`) : c'est exactement ce que la porte G1 cherche à produire.

## 5. Ordre de mise en œuvre proposé

| Rang | Test | Pourquoi d'abord |
|---|---|---|
| 1 | `T-A-03`, `T-A-04` | ✅ fait — la carte est le contrat de données ; tout le reste en dépend |
| 2 | `T-A-01`, `T-A-09` | ✅ fait — écriture en place + troncature : cœur du modèle |
| 3 | `T-A-06`, `T-A-07` | ✅ fait — valeurs par défaut et plafonds (observés) ; `T-A-13` reste à faire |
| 4 | ~~`T-A-08`, `T-A-15`, `T-A-16`~~ | contrat HTTP minimal — **fait** (`D-038`) |
| 5 | ~~`T-A-10`, `T-A-25`, `T-A-26`~~ | robustesse — **fait** (`D-039`) |
| 6 | `T-B-*` (sauf bloqués) | ✅ fait — `D-041` a débloqué le domaine B ; **13/13** |
| 7 | `T-B-20` | ✅ fait — `D-043` : l'aspiration s'exécute de bout en bout |
| 8 | `T-C-01`→`T-C-03` | à faire — reprise conditionnelle et en-têtes : à portée de `http-client.js` |
| 9 | `T-D-*` | ✅ fait — `D-046`/`D-048` : HLS et DASH de bout en bout |
| 10 | `T-C-04`, `T-C-03`, `T-C-01` | ✅ fait — `D-047` : cookies, reprise conditionnelle, HTTP/1.1 unique |
| 11 | `T-C-02`, `T-C-05`→`T-C-07`, `T-C-09`, `T-C-10` | ✅ fait — `D-049`→`D-051` : en-têtes, compression, FTP, proxys |
| 12 | `T-C-09`, `T-C-10` | ✅ fait — `D-052` : Digest, FTP par tunnel, PAC |
| 13 | `T-C-08` | ⛔ hors périmètre (`H-18`) |
| 14 | `T-B-26`→`T-B-28` | ✅ fait — `D-053`/`D-054` : réécriture, rapport, planification (ajouts XDM) |
| 15 | `T-C-11` | ✅ fait — `D-055` : `429`/`503`/`416` diagnostiqués, aucune reprise silencieuse |

## 6. Journal des révisions

| Date | Changement |
|---|---|
| 2026-10-30 | v1.17 : `D-084`/`D-085` — **domaine E** (interface) : interface locale pilotée par un gestionnaire (`EX-E-01`), état issu du moteur et progression par SSE (`EX-E-02`), réglages persistants + vérification + aspiration dans leur propre dossier (`EX-E-03`) ; A **25/25**, B **41/41**, C **14/15**, D **11/11**, E **3/3**, 334 tests, total **94 vertes / 95** |
| 2026-10-29 | v1.16 : `D-079`→`D-083` — bornes numériques refusées (`EX-A-25`), code de sortie d'une aspiration (`EX-B-39`), conformité de vérification (`EX-B-40`), compte de cookies annoncé (`EX-B-41`), `--aide`/`--version` sur les trois CLI (`EX-B-28` étendue) ; A **25/25**, B **41/41**, C **14/15**, D **11/11**, 286 tests, total **91 vertes / 92** |
| 2026-10-29 | v1.15 : `D-075`→`D-078` — authentification unifiée des médias (`EX-D-11`), magasin de cookies du moteur (`EX-A-24`), refus d'un positionnel de trop (`EX-C-15`), `absent` dans le JSON de vérification (`EX-B-38`) ; A **24/24**, B **38/38**, C **14/15**, D **11/11**, 281 tests, total **87 vertes / 88** |
| 2026-10-29 | v1.14 : `D-071`→`D-074` — reprise par défaut et `--sans-reprise` (`EX-A-20`), nom par `Content-Disposition` (`EX-A-21`), `--sortie json` (`EX-A-22`), `--proxy` appliqué (`EX-A-23`), rapport de vérification (`EX-B-37`) ; A **23/23**, B **37/37**, 274 tests, total **83 vertes / 84** |
| 2026-10-29 | v1.13 : `D-069`/`D-070` — en-têtes personnalisés (`EX-B-33`), aspiration incrémentale (`EX-B-34`), plafond d'essais cumulés (`EX-B-35`), progression et audit JSON (`EX-B-36`) ; domaine B **36/36**, 265 tests, total **78 vertes / 79** |
| 2026-10-29 | v1.12 : `D-067`/`D-068` — reprise des tâches orphelines (`EX-B-29`), plafond de taille (`EX-B-30`), espace disque (`EX-B-31`), vérification et rapport HTML (`EX-B-32`) ; domaine B **32/32**, 257 tests, total **74 vertes / 75** |
| 2026-10-29 | v1.11 : `D-065`/`D-066` — plans de site et amorces (`EX-B-24`), `--sous-domaines` (`EX-B-25`), reprise pendant l'exploration (`EX-B-26`), interruption propre (`EX-B-27`), aide et version (`EX-B-28`) ; domaine B **28/28**, C **13/14** ; 250 tests, total **70 vertes / 71** |
| 2026-10-29 | v1.10 : `D-063`/`D-064` — `<base href>` (`EX-B-21`), arrêt sur échecs consécutifs (`EX-B-22`), essai sans effet de bord (`EX-B-23`), en-têtes personnalisés (`EX-C-14`), diagnostic d'exploration dans le rapport (`EX-B-15` étendue) ; domaine B **23/23**, C **13/14** ; 240 tests, total **65 vertes / 66** |
| 2026-10-29 | v1.9 : `D-059`→`D-062` — `robots.txt` RFC 9309 (`EX-B-17`), exploration parallèle bornée (`EX-B-18`), `Crawl-delay` et élagage `--exclure` (`EX-B-19`, `EX-B-20`), cookies persistants (`EX-C-12`), transport choisi par le schéma (`EX-C-13`) ; domaine B **20/20**, domaine C **12/13** (1 hors périmètre) ; 233 tests, total **61 vertes / 62** |
| 2026-10-28 | v1.8 : `D-056` — la matrice est **auditée** (`tools/audit-conformance.mjs`) : 5 écarts réels corrigés (domaine B clos avec 4 lignes « bloqué », `T-B-07` inexistant, `EX-C-08` citant `T-C-08`, 3 preuves qui étaient des chemins de code, 2 modules sans référence) ; `EX-B-15`/`16`, `EX-C-11`, `EX-D-10` citent désormais leur décision ; 220 tests, total **55 vertes / 56** |
| 2026-10-28 | v1.7 : `D-055` — `429`/`503` sortent en `HTTP_STATUS` (statut, `retryable`, `Retry-After`) au lieu d'une « taille inconnue » ; `EX-C-11` verte ; 207 tests, total **55 vertes / 56** |
| 2026-10-28 | v1.6 : `D-053` (réécriture, **sans précédent** dans la cible) et `D-054` (planification sans démon) — `EX-B-14`→`EX-B-16` vertes, domaine B **16/16** ; 196 tests, total **54 vertes / 55** |
| 2026-10-28 | v1.5 : `D-052` — Digest, FTP par tunnel, PAC ; domaine C **9/10** (1 hors périmètre) ; 172 tests, total **51 vertes / 52** |
| 2026-10-28 | v1.4 : `D-049`→`D-051` — en-têtes et compression, FTP passif, proxys `CONNECT`/SOCKS5 ; domaine C **6 vertes / 10**, 159 tests, total **49 vertes / 52** |
| 2026-10-28 | v1.3 : `D-047` (cookies, `If-Range`) et `D-048` (DASH par `sidx`) — domaine D **clos 10/10**, domaine C 3/10 ; 140 tests, total **45 vertes / 52** |
| 2026-10-28 | v1.2 : fiche D implémentée (`D-046`) — HLS segmenté de bout en bout, `sidx` lu ; **9/10** du domaine D, 128 tests, total **39 vertes / 52** |
| 2026-10-28 | v1.1 : domaines C (transports) et D (médias) ajoutés (`WP-07`, annexe 15) — 20 exigences spécifiées, 0 implémentée ; 108 tests sur A+B |
| 2026-10-28 | v1.0 : exécution (`src/grab-runner.js`, `bin/xdm-grab.js`, `D-043`) — file → téléchargement → promotion, 106 tests ; matrice figée |
| 2026-10-28 | v0.9 : assemblage (`src/grabber.js`, `D-042`) — arborescence, collisions, `empty.html`, promotion ; **domaine B clos (13/13)**, **97 tests** |
| 2026-10-28 | v0.8 : parcours implémenté (`src/crawler.js`) — `EX-B-07`→`EX-B-09`, `EX-B-13` vertes ; 8/13 du domaine B, 90 tests |
| 2026-10-28 | v0.7 : `D-041` — le moteur d'exploration n'est pas dans `IDMan.exe` (mesure `grabber.json`) ; domaine B **débloqué** par décision de périmètre, plus aucune exigence en `Hypothèse` |
| 2026-10-27 | v0.6 : assemblage (`D-040`) — carte persistée, fusion des morceaux de reprise (`A-21`), promotion, CLI ; **79 tests verts** |
| 2026-10-27 | v0.5 : boucle de connexions (`D-039`) — domaine A **clos**, 19/19 ; repli sur divergence et plafond de 128 sockets vérifiés ; 73 tests verts |
| 2026-10-27 | v0.4 : couche HTTP écrite (`D-038`) — `EX-A-08`, `EX-A-15`→`EX-A-18` vertes, 17/19 du domaine A ; 61 tests verts au total |
| 2026-10-27 | v0.3 : `WP-20` clos — 50 tests verts, 13 exigences du domaine A et 4 du domaine B au vert ; `D-036` (file) et `D-037` (nom) consignées |
| 2026-10-27 | v0.2 : socle `WP-20` livré — 9 tests verts sur le domaine A (24 cas), `D-034` (stack) et `D-035` (rollback) consignées |
| 2026-10-27 | création v0.1 : 32 exigences recensées (19 domaine A, 13 domaine B), 3 bloquées, 0 test écrit |
