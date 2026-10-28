# Fiche B — Grabber (aspiration de site)

> **Domaine** : B (grabber) · **Lot** : `WP-11` (`A-05`, deuxième fiche) · **Statut** : `brouillon`
> (modèle de projet et filtres **implémentés et testés** : `EX-B-02`→`EX-B-05` vertes ;
> **exploration** : choix XDM documentés depuis `D-041`, l'algorithme d'IDM n'étant pas dans
> `IDMan.exe`)
> **Dernière revue** : 2026-10-27
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
| `EX-B-01` | Un projet d'aspiration est **un seul artefact** (fichier), pas un état éclaté dans le registre | **Observé** (IDM : `.gsd`) + **Décision** (XDM : JSON) | annexe 11 §1 (`%sproject%s.gsd`, `0x68c948`) | `T-B-01` : projet copié sur une autre machine = reprise possible |
| `EX-B-02` | Le projet contient : identifiant, nom, URL racine, filtres, plan de site, entrées retenues, planification optionnelle | **Dérivé** | annexe 11 §4 | `T-B-02` ✅ : 5 invariants vérifiés, écriture atomique, projet incohérent rejeté |
| `EX-B-03` | Un filtre = `{id, motif, actif}` ; l'appartenance à la liste **inclusion** ou **exclusion** est portée par la collection, pas par le filtre | **Observé** + **Décision** | annexe 13 §2 bis ; `D-032` | `T-B-03` ✅ : déplacement à forme constante ; un `scope` résiduel invalide le projet |
| `EX-B-04` | Les identifiants de filtres sont attribués par un compteur persistant qui démarre à **100**, jamais recyclé | **Observé** + **Décision** | annexe 13 §2 ter ; `D-033` | `T-B-04` ✅ : 100 puis 101, et après suppression le compteur continue |
| `EX-B-05` | Un motif est un **masque glob ancré** (`*.png`), éventuellement une liste séparée par des virgules ; l'exclusion l'emporte sur l'inclusion | **Observé** + **Décision** | annexe 13 §4 bis (défaut `*.html,*.htm,…`) | `T-B-05` ✅ : ancrage strict, liste, priorité de l'exclusion, désactivation d'un filtre |
| `EX-B-06` | Une entrée retenue porte au minimum : URL, chemin local, nom de fichier local, taille attendue, état, journal | **Observé** (noms de valeurs) | annexe 12 §2 (`LocalFileName`, `LocalPath`, `LogFileName`, `nExpectedSize`) | `T-B-06` |
| `EX-B-07` | La profondeur d'exploration est un paramètre du projet ; côté IDM c'est `nLevels` (`+0xb8`, entier 32 bits) ; XDM retient **2 niveaux par défaut** | **Observé** (champ) + **Décision** (défaut) | annexe 12 §6.1 (`0x1381e0`, `+0xb8`) ; `D-041` | `T-B-07` : profondeur 1 = page de départ seulement |
| `EX-B-08` | Une page HTML est lue, ses liens extraits (`href`, `src`), résolus en URL absolues, puis classés (retenu / exclu / hors périmètre) ; **parcours en largeur par niveau** | **Décision** (XDM) | `D-041` ; annexe 12 §6.5 | `T-B-08` : jeu de 20 liens, verdicts attendus |
| `EX-B-09` | Les liens déjà visités ne sont **jamais** revisités (dédoublonnage par URL normalisée : schéma+hôte+chemin, sans fragment ni barre finale) | **Décision** (XDM) | `D-041` | `T-B-09` : page bouclant sur elle-même → 1 seule requête |
| `EX-B-10` | Chaque fichier retenu devient une tâche de téléchargement ordinaire (mêmes exigences `EX-A-*`) | **Observé** | annexe 12 §1 (promotion vers la file principale) | `T-B-10` : une entrée reprise à 50 % continue au bon offset |
| `EX-B-11` | L'arborescence locale reproduit celle du site, le nom de fichier venant de l'URL | **Observé** (chemin local) / **Dérivé** (déduction) | annexe 12 §2 | `T-B-11` : `/a/b/c.zip` → `a/b/c.zip` |
| `EX-B-12` | Un fichier `empty.html` (`<HTML><BODY> </BODY></HTML>`) est écrit dans le dossier cible | **Observé** | annexe 13 §4 (`0xd1ed0`) | `T-B-12` : fichier présent, contenu exact, jamais écrasé s'il existe |
| `EX-B-13` | Aucune requête hors du site de départ sans action explicite de l'utilisateur ; `robots.txt` respecté (la chaîne `robots` existe dans la cible, `0xb2410`, sémantique non établie) | **Décision** (XDM) | `D-041` ; `grabber.json` §symbols | `T-B-13` : lien externe présent mais non suivi |

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

## 9. Journal des révisions

| Date | Auteur | Changement |
|---|---|---|
| 2026-10-28 | mesures `WP-11` | v0.3 : `D-041` — le moteur d'exploration n'est pas dans `IDMan.exe` (0 référence code aux conteneurs, annexe 12 §6) ; l'exploration devient un **choix XDM** documenté (`EX-B-07`→`EX-B-09`, `EX-B-13`) ; plus aucune exigence en `Hypothèse` |
| 2026-10-27 | socle `WP-20` | v0.2 : modèle de projet et filtres implémentés (`src/project.js`), `EX-B-02`→`EX-B-05` **vertes** ; reste bloqué par `Q-B-01` (exploration) |
| 2026-10-27 | analyse statique | création (brouillon) : 13 exigences, modèle de projet, machine à états, 7 cas d'erreur, 5 écarts, 6 questions ouvertes. **6 exigences sur 13 sont des hypothèses** : la fiche ne peut pas passer en revue avant `Q-B-01` |
