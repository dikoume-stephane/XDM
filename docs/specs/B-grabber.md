# Fiche B — Grabber (aspiration de site)

> **Domaine** : B (grabber) · **Lot** : `WP-11`/`WP-23` (`A-05`, deuxième fiche) · **Statut** : ✅ `clos`
> (les 38 exigences sont **vertes** : modèle de projet, filtres, parcours, arborescence locale et promotion ;
> **exploration** : choix XDM documentés depuis `D-041`, l'algorithme d'IDM n'étant pas dans
> `IDMan.exe`)
> **Dernière revue** : 2026-10-29 (v0.13 : `absent` publié dans le JSON de vérification
> (`D-078`) ; v0.12 : en-têtes personnalisés (`D-069`), aspiration incrémentale (`D-070`),
> `--sans-reprise` (`D-071`), nom par `Content-Disposition` (`D-072`), `--sortie json`
> (`D-073`), proxy et rapport de vérification (`D-074`) — 38 exigences)
> **Preuves** : annexes 11 (modèle de projet), 12 (grabber), 13 (filtres et artefacts) ;
> `filters.json` ; décisions `D-032`, `D-033`.
> **Cible** : `IDMan.exe` SHA-256 `5f78da5a…2f11c9`.
> **Avertissement de périmètre** : le balayage d'IDM n'est **pas** établi — et il ne l'est
> pas parce que le moteur d'exploration **n'est pas dans `IDMan.exe`** (mesure : 0 référence
> code aux conteneurs `SPL`/`RL`/`LI2`, annexe 12 §6). Depuis `D-041`, ce qui en dépend n'est
> plus marqué **Hypothèse** mais **Décision** : c'est XDM qui définit le parcours, et cette
> fiche décrit ce que XDM fait — plus ce qu'IDM ferait.

---

## 1. But fonctionnel (en une phrase)

À partir d'une URL de départ, parcourir un site, retenir les fichiers qui correspondent
aux filtres de l'utilisateur, les télécharger en conservant l'arborescence d'origine, et
pouvoir reprendre une aspiration interrompue.

## 2. Exigences

| ID | Exigence | Niveau | Preuve | Test prévu |
|---|---|---|---|---|
| `EX-B-01` | Un projet d'aspiration est **un seul artefact** (fichier), pas un état éclaté dans le registre | **Observé** (IDM : `.gsd`) + **Décision** (XDM : `.xdmspider.json`) | annexe 11 §1 (`%sproject%s.gsd`, `0x68c948`) ; `D-042` | `T-B-01` ✅ : sauvegarde, relecture, reprise sur un autre dossier cible |
| `EX-B-02` | Le projet contient : identifiant, nom, URL racine, filtres, plan de site, entrées retenues, planification optionnelle | **Dérivé** | annexe 11 §4 | `T-B-02` ✅ : 5 invariants vérifiés, écriture atomique, projet incohérent rejeté |
| `EX-B-03` | Un filtre = `{id, motif, actif}` ; l'appartenance à la liste **inclusion** ou **exclusion** est portée par la collection, pas par le filtre | **Observé** + **Décision** | annexe 13 §2 bis ; `D-032` | `T-B-03` ✅ : déplacement à forme constante ; un `scope` résiduel invalide le projet |
| `EX-B-04` | Les identifiants de filtres sont attribués par un compteur persistant qui démarre à **100**, jamais recyclé | **Observé** + **Décision** | annexe 13 §2 ter ; `D-033` | `T-B-04` ✅ : 100 puis 101, et après suppression le compteur continue |
| `EX-B-05` | Un motif est un **masque glob ancré** (`*.png`), éventuellement une liste séparée par des virgules ; l'exclusion l'emporte sur l'inclusion | **Observé** + **Décision** | annexe 13 §4 bis (défaut `*.html,*.htm,…`) | `T-B-05` ✅ : ancrage strict, liste, priorité de l'exclusion, désactivation d'un filtre |
| `EX-B-06` | Une entrée retenue porte au minimum : URL, chemin local, nom de fichier local, taille attendue, état, journal | **Observé** (noms de valeurs) | annexe 12 §2 (`LocalFileName`, `LocalPath`, `LogFileName`, `nExpectedSize`) | `T-B-06` ✅ : six champs présents à la création |
| `EX-B-07` | La profondeur d'exploration est un paramètre du projet ; côté IDM c'est `nLevels` (`+0xb8`, entier 32 bits) ; XDM retient **2 niveaux par défaut** | **Observé** (champ) + **Décision** (défaut) | annexe 12 §6.1 (`0x1381e0`, `+0xb8`) ; `D-041` | `T-B-07` : profondeur 1 = page de départ seulement |
| `EX-B-08` | Une page HTML est lue, ses liens extraits (`href`, `src`), résolus en URL absolues, puis classés (retenu / exclu / hors périmètre) ; **parcours en largeur par niveau** | **Décision** (XDM) | `D-041` ; annexe 12 §6.5 ; `src/crawler.js` | `T-B-08` ✅ : ordre des niveaux, extraction, schémas ignorés |
| `EX-B-09` | Les liens déjà visités ne sont **jamais** revisités (dédoublonnage par URL canonique : schéma+hôte+chemin, sans fragment ni barre finale) | **Décision** (XDM) | `D-041` ; `canonicalUrl` | `T-B-09` ✅ : boucle de liens ⇒ une requête par page |
| `EX-B-10` | Chaque fichier retenu devient une tâche de téléchargement ordinaire (mêmes exigences `EX-A-*`) | **Observé** | annexe 12 §1 (promotion vers la file principale) ; `D-042` | `T-B-10` ✅ : tâche `PENDING` par entrée, cible `rootDir/<chemin local>`, reprise héritée du moteur |
| `EX-B-11` | L'arborescence locale reproduit celle du site, le nom de fichier venant de l'URL ; collisions suffixées, `..` neutralisé | **Observé** (chemin local) + **Décision** (règles) | annexe 12 §2 ; `D-042` | `T-B-11` ✅ : `/a/b/c.zip` → `a/b/c.zip`, `/docs/` → `docs/index.html`, `../../etc/passwd` neutralisé |
| `EX-B-12` | Un fichier `empty.html` (`<HTML><BODY> </BODY></HTML>`) est écrit dans le dossier cible, **jamais écrasé** | **Observé** + **Décision** (non-écrasement) | annexe 13 §4 (`0xd1ed0`) ; `D-042` | `T-B-12` ✅ : contenu exact, fichier utilisateur préservé |
| `EX-B-13` | Aucune requête hors du site de départ sans action explicite de l'utilisateur ; `robots.txt` respecté (la chaîne `robots` existe dans la cible, `0xb2410`, sémantique non établie) | **Décision** (XDM) | `D-041` ; `grabber.json` §symbols ; `src/crawler.js` | `T-B-13` ✅ : lien externe signalé et non suivi, `robots.txt` appliqué |
| `EX-B-14` | Les pages et feuilles de style aspirées peuvent être **réécrites** vers les chemins locaux : attributs d'URL (`href`, `src`, `srcset`, …), `url()` et `@import` ; chemins relatifs ; `<script>`, `<style>`, `<pre>`, commentaires et références inconnues **intacts** | **Décision** (XDM, **sans précédent** dans la cible : aucun parseur HTML) | `Q-B-01` (annexe 12 §6) ; `D-053` ; `src/rewrite.js` | `T-B-26` ✅ : `./` pour soi-même, ancre et requête conservées, `srcset`, CSS, extension non réécrite ; mesure de bout en bout (site local) : 4 fichiers, **5 liens réécrits**, externe et cible 404 intacts. Pré-requis CLI : `--sans-exclusions --inclure '*'` (les pages sont exclues par défaut, `D-032`) |
| `EX-B-15` | Un **rapport** d'aspiration est produit à la demande (texte, JSON, CSV, Markdown) : compteurs, tailles, durées, échecs et tentatives — **aucune valeur inventée** (progression inconnue ⇒ `n/a`, pas 0 %) | **Décision** (XDM ; IDM affiche des statistiques, format non observé) | `D-053` ; `src/report.js` | `T-B-27` ✅ : file vide, reprises, CSV exact, format refusé |
| `EX-B-16` | La planification est un **recalcul à chaque exécution** : fenêtres locales (`lun-ven 01:00-06:00`, `ven-lun`, nuit `22:00-02:00`), quotas d'octets et de tâches ; hors fenêtre, rien n'est téléchargé (code 3) ; les tâches non retenues restent `PENDING` ; une taille inconnue est **reportée**, jamais budgétée à zéro | **Décision** (XDM : ni démon ni cron) | `D-054` ; `src/schedule.js` | `T-B-28` ✅ : `ven-lun`, traversée de minuit, ordre des candidates, quotas, `only` du runner |
| `EX-B-17` | `robots.txt` est lu selon la **RFC 9309** : seules les règles du **groupe applicable** comptent (le groupe nommant notre produit l'emporte sur `*` ; groupes homonymes fusionnés), `*` et `$` sont les seuls métacaractères, la règle au motif le plus long décide, `Allow` gagne à longueur égale et une directive inconnue est ignorée sans erreur | **Décision** (précise `D-041`) | `D-059` ; `src/crawler.js` (`parseRobots`, `robotsRegExp`) | `T-B-29` ✅ : 13 cas (groupes, priorité, `$`, `*.pdf$` vs `.pdf.html`, directives inconnues) |
| `EX-B-18` | L'exploration peut être **parallèle et bornée** : au plus `parallelisme` requêtes simultanées, vagues absorbées **dans l'ordre de la file** ; le résultat (pages, entrées retenues, motifs) est identique à celui de l'exploration en série | **Décision** | `D-061` ; `Q-B-05` ; `src/crawler.js` | `T-B-30` ✅ : pic mesuré ≤ 3 et ≥ 2 avec `parallelisme: 3`, sortie identique au série, `RangeError` sous 1 |
| `EX-B-19` | `Crawl-delay` (extension hors RFC) est traité comme un **conseil borné** : lu pour le groupe applicable, ignoré s'il n'est pas un nombre fini positif, appliqué **entre deux vagues** — jamais avant la première ni après la dernière ; `--delai` explicite l'emporte toujours, `0` l'annule | **Décision** | `D-060` ; `src/crawler.js` (`parseCrawlDelay`) | `T-B-31` ✅ : groupe nommé, valeurs absurdes ignorées, attentes comptées, `--delai` prioritaire |
| `EX-B-20` | `--exclure` **élague** le parcours : la branche n'est pas demandée et rien de ce qu'elle cite n'entre dans la file ; les exclusions **par défaut** (`*.html`, `*.jpg`…) ne font, elles, que trier les téléchargements — sinon `--inclure` fermerait l'exploration | **Décision** | `D-060` ; `D-032` ; `src/crawler.js` (`prune`) | `T-B-32` ✅ (aucune requête vers la branche), `T-C-14` ✅ (bout en bout, motif conservé dans le projet) |
| `EX-B-21` | Les liens **relatifs** se résolvent contre la base déclarée par la page (`<base href>`, première balise, base inexploitable ignorée) ; la balise elle-même ne devient jamais un lien à télécharger | **Décision** | `D-063` ; `src/crawler.js` (`documentBase`) | `T-B-33` ✅ : base absolue, relative, vide, `ftp:`, casse et retour à la ligne, fichier retenu **sous la base** |
| `EX-B-22` | Le parcours **s'arrête** après N pages en échec **consécutif** (`--arret-erreurs`) et le dit (`stopped: 'erreurs'`) ; un échec isolé repart à zéro, une file vidée n'est pas un arrêt sur erreur, le plafond de pages est distingué (`stopped: 'plafond'`) | **Décision** | `D-063` ; `src/crawler.js` (`maxErrors`) | `T-B-34` ✅ : 7 requêtes sans garde-fou, 4 avec `maxErrors: 3`, échec isolé sans effet |
| `EX-B-23` | `--essai` montre le **plan** — pages visitées, fichiers prévus, cibles, motif d'arrêt — **sans rien écrire** : dossier cible non créé, ni `empty.html`, ni projet, ni file, aucun téléchargement, code de sortie 0 ; `--sortie json` reste consommable | **Décision** | `D-064` ; `bin/xdm-grab.js` | `T-C-16` ✅ : `readdir` en `ENOENT` après coup, zéro requête de fichier, JSON exploitable |
| `EX-B-24` | Les **plans de site** (opt-in `--sitemap`) sont lus : directives `Sitemap:` du `robots.txt` d'abord, sinon `/sitemap.xml` ; index suivi un seul niveau, plans et URL plafonnés, URL hors origine écartées ; leurs entrées deviennent des **amorces** soumises aux mêmes contrôles qu'un lien — une amorce fichier est retenue sans être visitée, une amorce interdite par `robots.txt` est refusée et comptée | **Décision** | `D-065` ; `src/sitemap.js` | `T-C-17` ✅ (index, repli, 404 non fatal, plafonds, format inconnu signalé), `T-B-37` ✅ (fichier retenu, page mise en file, doublon et tiers écartés) |
| `EX-B-25` | `--sous-domaines` élargit le parcours au **même site** — même hôte, sous-domaine, ou même parent d'au moins deux labels — et **jamais** à un tiers ; désactivé par défaut, limite « pas de *Public Suffix List* » nommée | **Décision** | `D-065` ; `src/crawler.js` (`sameSiteHost`) | `T-B-36` ✅ (`a.`/`b.` du même parent acceptés, `evil-example.test` et `example.test.autre.test` refusés), `T-C-19` ✅ |
| `EX-B-26` | `--tentatives` couvre **aussi l'exploration** : mêmes statuts transitoires, même `Retry-After`, même plafond que les téléchargements (`D-055`) ; reprises comptées (`retries`) ; sans reprise, le statut est remonté tel quel | **Décision** | `D-065` ; `src/retry.js`, `src/crawler.js` | `T-B-38` ✅ (503 puis 200, une reprise, `Retry-After: 2` respecté), `T-C-19` ✅ |
| `EX-B-27` | **Interruption propre** : première interruption = arrêt coopératif (aucune nouvelle vague ni tâche, les travaux en vol finissent, projet/file/cookies sauvegardés, code **130**) ; seconde = sortie immédiate ; aucune tâche ne reste `ACTIVE` | **Décision** | `D-066` ; `src/grab-runner.js` (`shouldStop`), `bin/xdm-grab.js` | `T-B-39` ✅ (arrêt entre deux vagues), `T-C-20` ✅ (vrai SIGINT : code 130, file sans `ACTIVE`) |
| `EX-B-28` | `--aide`/`-h` et `--version`/`-V` répondent **sans URL** et sortent en code **0**, pour les deux CLI, sans effet de bord | **Décision** | `D-066` ; `bin/xdm-grab.js`, `bin/xdm.js` | `T-C-21` ✅ |
| `EX-B-29` | Un arrêt **brutal** (SIGKILL, coupure de courant) laisse des tâches `ACTIVE`/`VERIFYING` ; `--reprendre` les **relève** par les transitions déjà autorisées (`ACTIVE → PAUSED → PENDING`, `VERIFYING → FAILED → PENDING`), annonce combien, et remet `startedAt` à `null` | **Décision** | `D-067` ; `src/grab-runner.js` (`recoverOrphans`) | `T-B-40` ✅ : deux orphelines relevées puis exécutées, file saine non touchée |
| `EX-B-30` | `--taille-max` refuse un fichier trop gros **après la sonde et avant tout octet écrit** (`TOO_LARGE` avec taille et plafond) ; les tailles se lisent en unités **binaires** (`K` = 1 024) et une unité inconnue est refusée, pas interprétée | **Décision** | `D-067` ; `src/size.js`, `src/connection-loop.js` | `T-B-41` ✅ : refus sans fichier partiel, téléchargement normal sous le plafond, `--taille-max 2K` met la tâche en échec avec la raison |
| `EX-B-31` | Avant la première connexion, l'**espace disque** est vérifié (`statfs`, `bavail × bsize`), avec réserve (défaut 64 Mio, bornée à la moitié du volume) ; le refus annonce les octets à libérer, écrit projet et file, sort en code 1 ; les tailles inconnues sont annoncées séparément | **Décision** | `D-067` ; `src/diskspace.js` | `T-B-42` ✅ : `statfs` factice, refus sans aucune requête de fichier, file en `PENDING`, tâche `DONE` non recomptée |
| `EX-B-33` | `--entete` (répétable, **les deux CLI**) : validation unique (`parseHeaderOption`), nom = jeton RFC 9110, valeur sans `CR`/`LF`/`NUL`, refus **explicite** ; l'en-tête part avec la **sonde et chaque plage** ; les en-têtes du moteur (`Range`, `Accept-Encoding`, `If-Range`) gardent la priorité | **Décision** | `D-069` ; `src/headers.js`, `src/connection-loop.js` | `T-A-28` ✅ (toutes les requêtes de données portent l'en-tête), `T-C-22` ✅ (injection `\r\n` refusée) |
| `EX-B-34` | `--incremental` : `If-Modified-Since` sur la date du fichier local ; `304` ⇒ **aucune écriture**, fichier et date intacts, tâche terminée, taille **non inventée** ; `200` ⇒ réécriture ; avec `--reprendre`, `reopenDone` rouvre les `DONE` dont le fichier existe (`DONE → PENDING`) | **Décision** | `D-070` ; `src/http-client.js`, `src/connection-loop.js`, `src/grab-runner.js` | `T-B-45` ✅, `T-A-28` ✅ (contenu et `mtimeMs` inchangés) |
| `EX-B-35` | `--tentatives-total` : crédit d'essais **cumulés** ; une tâche au plafond reste `FAILED` avec son message, n'est **pas** rejouée par `--reprendre`, et est nommée dans la sortie | **Décision** | `D-070` ; `src/grab-runner.js` (`retryFailedCapped`) | `T-B-46` ✅ (tâche à 3 essais non rejouée, celle à 1 essai rejouée) |
| `EX-B-37` | `--verifier --rapport F` écrit un **rapport de vérification** (JSON, CSV, Markdown, HTML ; `.htm` reconnu) : anomalies seules (`MANQUANT`, `TRONQUÉ`, `PARTIEL`, `ABSENT`, `HORS FILE`), conformité, octets annoncés et sur disque ; les rapports s'écrivent où on le demande, jamais dans le dossier vérifié sans le dire | **Décision** | `D-074` ; `src/report.js`, `bin/xdm-grab.js` | `T-B-49` ✅ (4 formats, conforme et non conforme) |
| `EX-B-36` | `--progression` : paliers de 10 %, une ligne par palier et par fichier, taille inconnue annoncée **une fois** sans pourcentage inventé, `stderr` seulement ; `--verifier --sortie json` rend des compteurs et des **listes de chemins** | **Décision** | `D-070` ; `src/progress.js`, `bin/xdm-grab.js` | `T-B-47` ✅ (≤ 12 lignes pour 41 appels), `T-B-48` ✅ |
| `EX-B-32` | `--verifier` compare **la file au disque** sans réseau : manquants (`DONE` sans fichier), tronqués (taille ≠ annoncée), partiels, absents, fichiers hors file ; les fichiers de l'outil sont exclus ; code 1 sur écart ; rien n'est créé ni corrigé ; le rapport HTML est **autonome** et intégralement échappé | **Décision** | `D-068` ; `src/verify.js`, `src/report.js` | `T-B-43` ✅, `T-B-44` ✅ (injection `<script>` neutralisée) |
| `EX-B-38` | `--verifier --sortie json` publie les **six** listes d'anomalies en **chemins** : `missing`, `truncated`, `partial`, `absent`, `unmanaged`, `errors` — une tâche jamais commencée (`absent`) n'est pas une tâche conforme, et l'omettre du JSON faisait conclure à la conformité | **Décision** | `D-078` ; `bin/xdm-grab.js` (`summarize`) | `T-B-50` ✅ |

## 3. Modèle de données

### 3.1 Fichier de projet `.xdmspider.json`

```json
{
  "version": 1,
  "id": 3,
  "name": "exemple",
  "rootUrl": "https://exemple.test/docs/",
  "depth": 2,
  "nextFilterId": 102,
  "filters": {
    "include": [
      { "id": 100, "motif": "*.pdf", "actif": true }
    ],
    "exclude": [
      { "id": 101, "motif": "*.html,*.htm,*.js,*.css,*.gif,*.jpg,*.jpeg,*.jpe,*.bmp,*.png,*.tif", "actif": true }
    ]
  },
  "sitemap": [
    { "url": "https://exemple.test/docs/", "profondeur": 0, "etat": "parsee", "type": "text/html" }
  ],
  "entries": [
    {
      "url": "https://exemple.test/docs/manuel.pdf",
      "localPath": "docs/",
      "localFileName": "manuel.pdf",
      "expectedSize": 1048576,
      "etat": "en-attente",
      "log": ""
    }
  ],
  "planification": null
}
```

| Structure | Champs | Preuve |
|---|---|---|
| Projet | `id`, `name`, `rootUrl`, `depth`, `nextFilterId`, `filters`, `sitemap`, `entries`, `planification` | annexe 11 §1, §4 ; `nLevels`, `nextFilterID` |
| Filtre | `id` (> 0), `motif`, `actif` | annexe 13 §2 bis (16 octets observés) |
| Nœud de plan | `url`, `profondeur`, `etat`, `type` | annexe 12 §4 (plan de site : contenu inconnu) |
| Entrée | `url`, `localPath`, `localFileName`, `expectedSize`, `etat`, `log` | annexe 12 §2 (`LocalPath`, `LocalFileName`, `nExpectedSize`, `LogFileName`) |

**Invariants** :

1. `nextFilterId > max(filters[*].id)` ;
2. `id` de filtre unique et non nul ;
3. toute `entries[].url` est unique après normalisation ;
4. `sitemap[].profondeur <= depth` ;
5. `localFileName` ne contient ni `..` ni séparateur de chemin (assainissement).

**Inconnu** : le format binaire du `.gsd` (en-tête, version, sérialisation) — annexe 11 §5.
XDM ne cherche pas à le lire.

## 4. Machine à états

### 4.1 Projet

```text
IDLE --(start)--> CRAWLING --(plan complet)--> SELECTING --(entrées validées)--> DOWNLOADING
  ^                   |                                                        |
  |                   +--(annulation)--> IDLE                                  |
  +----------------------(fin / annulation)------------------------------------+
DOWNLOADING --(toutes entrées terminées ou en échec)--> DONE --(suppression)--> (supprimé)
```

| État | Effet persistant |
|---|---|
| `CRAWLING` | ajout des nœuds au plan de site, au fil de l'eau |
| `SELECTING` | marquage `retenu` / `exclu` de chaque nœud |
| `DOWNLOADING` | une tâche par entrée retenue, état dans la fiche A |
| `DONE` | projet conservé jusqu'à suppression explicite |

### 4.2 Page (nœud du plan)

```text
DISCOVERED --(GET)--> FETCHED --(parse)--> PARSED --(filtre)--> RETENU | EXCLU
     |                   |                   |
     +----(erreur)-------+-------------------+--> ERREUR (réessayable)
```

## 5. Interfaces externes

| Interface | Sens | Format | Remarques |
|---|---|---|---|
| HTTP(S) | sortant | `GET` de pages + fichiers | une seule connexion pendant `CRAWLING` (**Dérivé** : pas de preuve d'un crawl parallèle) |
| Fichier projet | lecture/écriture | JSON UTF-8 atomique | remplace le `.gsd` (`EX-B-01`) |
| Dossier cible | écriture | arborescence + `empty.html` | `EX-B-11`, `EX-B-12` |
| Moteur de téléchargement | interne | tâches de la fiche A | `EX-B-10` |

## 6. Cas d'erreur et dégradations

| Cas | Comportement attendu | Preuve | Test |
|---|---|---|---|
| page en 404/500 | nœud `ERREUR`, exploration du reste poursuivie | **Décision** (`D-041`) | `T-B-20` |
| boucle de liens | dédoublonnage par URL normalisée | **Décision** (`D-041`) | `T-B-09` |
| site très profond | arrêt à `depth` ; message explicite | **Observé** (paramètre) | `T-B-21` |
| disque plein pendant l'aspiration | arrêt propre, projet conservé | annexe 12 (messages disque) | `T-B-22` |
| lien vers un autre domaine | ignoré par défaut | **Décision** (`D-041`) | `T-B-13` |
| encodage de page non UTF-8 | décodage selon `Content-Type`, repli latin-1 | **Décision** (`D-041`) | `T-B-23` |
| reprise après arrêt | aucun nœud déjà `PARSED` n'est refetché | **Décision** (cohérent avec `EX-B-01`) | `T-B-24` |
| page réécrite en local (`--reecrire`) | liens relatifs corrects, `<script>` intact, cible absente inchangée | **Décision** (`D-053`) | `T-B-26` |
| fichier absent au moment de la réécriture | page laissée telle quelle, comptée comme non réécrite | **Décision** (`D-053`) | `T-B-26` |
| exécution hors fenêtre | 0 téléchargement, code de sortie 3, ouverture suivante annoncée | **Décision** (`D-054`) | `T-B-28` |
| quota d'octets dépassé par la tâche suivante | tâche reportée, quota respecté | **Décision** (`D-054`) | `T-B-28` |

## 7. Écarts assumés avec IDM

| Écart | Motif | Décision |
|---|---|---|
| projet en JSON, pas en `.gsd` binaire | format inconnu, non documenté, aucun besoin d'interopérabilité | `EX-B-01`, annexe 11 |
| filtres dans le projet, pas dans le registre | portabilité | `D-033` |
| filtre sans « portée » par règle | la portée est la liste (preuve binaire) | `D-032` |
| pas d'intégration navigateur (capture des clics) | hors périmètre P0 (D-007) | annexe 02 |
| pas de repli sur les moteurs propriétaires | idem | `D-007` |

## 8. Questions ouvertes

| ID | Question | Bloque | Qui/quoi peut trancher |
|---|---|---|---|
| `Q-B-01` | Algorithme d'exploration (BFS, DFS, files de priorité) | **close — non instruite dans ce module** : 0 référence code aux conteneurs `SPL`/`RL`/`LI2`, 1 seule à `CIDMSpider` (annexe 12 §6.2) | sans objet ici ; à réévaluer si `IDMGrHlp.exe` devient disponible (`D-041`) |
| `Q-B-02` | Politique `robots.txt` (respect, cache, `User-Agent`) | conformité | **partiellement observée** : chaîne `robots` (`0x28b978`) + 1 référence code (`0xb2410`), sémantique non établie ; XDM **respecte** `robots.txt` (`D-041`) |
| `Q-B-03` | Valeur par défaut de `nLevels` | ergonomie | **ouverte sans effet** : le chargeur (`0x1381e0`) n'initialise pas `+0xb8`, le défaut n'est pas localisé ; XDM fixe **2** (`D-041`) |
| `Q-B-04` | Rôle exact de `empty.html` (remplacement de lien mort ou marqueur) | comportement observable | VM (`A-09`), `D-023` |
| `Q-B-05` | Parallélisme du crawl (1 connexion ou N) | performance | `states.json` : plusieurs états de « réception » simultanés ? |
| `Q-B-06` | Format du `.gsd` | aucun (écart assumé) | VM, dump hexadécimal |
| `Q-B-07` | Sémantique exacte de la planification d'IDM (« Start download at », limites horaires) | aucun : `EX-B-16` est une **décision XDM** | VM (`A-09`), dialogues 268-271 |

## 9. Journal des révisions

| Date | Auteur | Changement |
|---|---|---|
| 2026-10-29 | lot `WP-49` | v0.13 : `D-077`/`D-078` — refus d'un positionnel de trop dans les trois CLI, `absent` dans le JSON de vérification ; **38/38**, 281 tests |
| 2026-10-28 | lots `WP-24`/`WP-25` | v0.6 : `src/rewrite.js` (`D-053`), `src/report.js`, `src/schedule.js` (`D-054`) — `EX-B-14`→`EX-B-16` vertes, **16/16** ; réécriture **sans précédent** dans la cible, planification **sans démon** ; 220 tests |
| 2026-10-28 | assemblage `WP-11` | v0.5 : `src/grabber.js` (`D-042`) — arborescence locale, collisions, `empty.html` non écrasé, promotion en tâches ordinaires ; `EX-B-01`/`06`/`10`/`11`/`12` vertes ⇒ **13/13**, **97 tests** |
| 2026-10-28 | parcours `WP-11` | v0.4 : `src/crawler.js` — BFS par niveau, URL canonique, `robots.txt`, filtres ; `EX-B-07`→`EX-B-09` et `EX-B-13` **vertes** (`T-B-07`→`T-B-09`, `T-B-13`) ; **90 tests** |
| 2026-10-28 | mesures `WP-11` | v0.3 : `D-041` — le moteur d'exploration n'est pas dans `IDMan.exe` (0 référence code aux conteneurs, annexe 12 §6) ; l'exploration devient un **choix XDM** documenté (`EX-B-07`→`EX-B-09`, `EX-B-13`) ; plus aucune exigence en `Hypothèse` |
| 2026-10-27 | socle `WP-20` | v0.2 : modèle de projet et filtres implémentés (`src/project.js`), `EX-B-02`→`EX-B-05` **vertes** ; reste bloqué par `Q-B-01` (exploration) |
| 2026-10-27 | analyse statique | création (brouillon) : 13 exigences, modèle de projet, machine à états, 7 cas d'erreur, 5 écarts, 6 questions ouvertes. **6 exigences sur 13 sont des hypothèses** : la fiche ne peut pas passer en revue avant `Q-B-01` |
