# 16 — Protocole d'observation en machine virtuelle (`A-09`)

> **Statut** : ✅ v1 (protocole prêt à exécuter, **aucune observation faite**) · **Dernière revue** : 2026-10-28
> **Cible** : `IDMan.exe` SHA-256 `5f78da5a63604a3fefba6577ef6b2af976ec4d2fc4d0f219a72099a0da2f11c9`
> **But** : lever les questions qu'aucune analyse statique ne peut trancher — par
> construction, pas par manque d'outil. Chaque phase dit *ce qu'elle achète* et *comment on
> saura que c'est fait*.

---

## 0. Pourquoi ce document existe

L'analyse statique (`pefile` + `capstone`, annexe 06 §« Bilan d'outillage ») a tranché tout ce
qui est **dans** le binaire : structures, constantes, séquences d'appels, chaînes. Elle ne
peut pas trancher ce qui n'y est pas :

| Question | Nature | Pourquoi le statique échoue |
|---|---|---|
| `Q-B-03` — défaut de `nLevels` | valeur écrite à l'installation | le chargeur (`0x1381e0`) ne l'initialise pas ; la valeur vit dans le registre après installation |
| `H-04` — sémantique des « download limits » | comportement | le code lit des compteurs, le sens dépend de l'usage |
| `H-05` — ordre d'exploration | algorithme | non localisable dans `IDMan.exe` (`D-041`, annexe 12 §6) |
| `Q-B-02` — politique `robots.txt` | comportement | une chaîne `robots` existe (`0xb2410`), sa sémantique ne se lit pas |
| `Q-B-04` — rôle de `empty.html` | comportement observable | écrit par `0xd1ed0`, jamais relu par ce module |
| `Q-B-06` — format réel du `.gsd` | données produites | le fichier est créé à l'exécution, pas dans le binaire |
| `H-10` — trame de *native messaging* | IPC | `idmnmcl.dll` absent de `cible/` |
| `A-13` — défaut de `mAttempts` (`0x281ce0`) | valeur d'exécution | lue depuis les réglages, jamais écrite en dur |
| `A-13` — sens de `[conn+0x13c] == 2` (300 s) | comportement | le champ est comparé, son origine est ailleurs |

**Règle du jeu** : ce protocole **n'exécute pas** `IDMan.exe` pour en extraire des secrets,
ne contourne aucune protection, n'appelle aucun serveur de l'éditeur. Il observe un logiciel
installé, sur un site de test local, dans une VM jetable. `D-004` reste la limite dure :
rien sur les cookies, rien sur les DRM.

---

## 1. Environnement

| Élément | Exigence |
|---|---|
| Hyperviseur | VirtualBox / Hyper-V / QEMU, **réseau en mode « réseau privé »** (pas de NAT vers Internet) |
| Système | Windows 10/11 neuf, pas d'IDM préinstallé, snapshot « propre » avant installation |
| Réseau | serveur HTTP de test sur `127.0.0.1:8080` dans la VM (ou machine hôte en réseau privé) |
| Capture | `wireshark`/`pktmon` sur l'interface de bouclage ; `procmon` filtré sur `IDMan.exe` ; `reg export` avant/après |
| Traçage réseau applicatif | le serveur de test **journalise chaque requête** (méthode, chemin, en-têtes) : c'est la source la plus fiable, et elle est déjà dans `.gitignore` (`analysis/raw/`) |
| Preuve | hash du binaire installé = `5f78da5a…2f11c9`, sinon les offsets cités ne valent plus |

**Nommage des preuves** : `analysis/raw/idman/vm-P<n>-<AAAA-MM-JJ>-<objet>.<ext>`
(pcap, csv, reg, hexdump). Ces fichiers ne sont **pas versionnés** ; seuls leurs constats
entrent dans les annexes, avec la date et le chemin.

---

## 2. Phases

### P1 — Valeurs par défaut d'une installation neuve
**Ce qu'on fait** : installer IDM, le fermer, exporter
`HKCU\Software\DownloadManager` et `HKCU\Software\DownloadManager\GrabberSts` (récursif).
Recommencer après avoir ouvert puis fermé la boîte « Site Grabber ».
**Artefacts** : `vm-P1-*.reg`, diff avant/après.
**Ce que ça tranche** : `Q-B-03` (défaut de `nLevels`, attendu petit entier ≥ 1),
`H-04` (valeurs de `MaxConnectionsNumber`), existence des clés `IncludeFilters` /
`ExcludeFilters` et du compteur `nextFilterID` (annexe 13 §2 ter).
**Critère d'acceptation** : un tableau `valeur → défaut observé` où chaque ligne cite la clé
et le fichier `.reg` ; `Q-B-03` reçoit une réponse chiffrée, ou la mention explicite
« absente à l'installation ».

### P2 — Ordre d'exploration
**Ce qu'on fait** : servir un site de test à trois niveaux (`/`, `/n1-a`, `/n1-b`, `/n2-a`,
`/n2-b`, `/n3`), lancer une aspiration à profondeur 3, relever **l'ordre exact** des requêtes
côté serveur.
**Ce que ça tranche** : `H-05` (BFS par niveau ? DFS ?) — et permettrait de **rouvrir**
`D-041` avec une preuve au lieu d'une décision. Un ordre `n1-a, n1-b, n2-a, n2-b` = BFS ;
`n1-a, n2-a, n3, n1-b` = DFS.
**Critère d'acceptation** : le journal du serveur, ordonné, avec l'horodatage ; conclusion en
une phrase, falsifiable par un second essai identique.

### P3 — Politique `robots.txt`
**Ce qu'on fait** : servir `robots.txt` avec `Disallow: /prive`, un lien vers `/prive/x.html`,
et un `User-agent` renvoyé en 403. Observer si `/prive/x.html` est demandé.
**Ce que ça tranche** : `Q-B-02` (respect ou non), et la question du `User-Agent` envoyé.
**Critère d'acceptation** : « demandé » / « non demandé », avec l'entrée de journal
correspondante. Si `Q-B-02` contredit `D-042`/`crawler.js`, la décision est révisée, pas le
protocole.

### P4 — Format réel du `.gsd`
**Ce qu'on fait** : créer un projet d'aspiration minimal (une page, deux fichiers), le
sauvegarder, localiser le `.gsd` (`%APPDATA%` ou dossier des projets), en faire un
`hexdump`, puis modifier un réglage et re-sauvegarder pour observiser le delta.
**Ce que ça tranche** : `Q-B-06` (format), `H-08` (le projet est bien un fichier).
**Critère d'acceptation** : les 64 premiers octets, la position des chaînes visibles
(l'URL de départ, le nom du projet), et une hypothèse de structure **testable** — pas
« c'est binaire ».

### P5 — Trame de *native messaging*
**Ce qu'on fait** : remplacer `idmnmcl.dll` par un relais qui journalise `stdin`/`stdout`
(ou utiliser l'onglet réseau de `chrome://extensions`). Naviguer vers un fichier
téléchargeable sur le site de test.
**Ce que ça tranche** : `H-10` (format `{action, url, referer, cookies}`, longueur préfixée
sur 4 octets, JSON).
**Critère d'acceptation** : une trame complète, dont on peut dire si elle est du *native
messaging* Chrome standard ou un dialecte. **Aucun cookie n'est extrait ni conservé**
(`D-004`) : le champ est noté présent, sa valeur est masquée.

### P6 — Inactivité, reprises et plafond de connexions
**Ce qu'on fait** : serveur qui envoie 200 octets puis se tait 35 s ; fichier de 4 Mio,
`MaxConnections` forcé à 8 ; compter les connexions simultanées et les reprises.
**Ce que ça tranche** : `A-13` (`mAttempts`, seuil réel de 30 s, redémarrage à l'offset
confirmé), `EX-A-18`/`EX-A-19` côté comportement — nos tests les couvrent déjà côté XDM,
cette phase vérifie que la cible fait pareil.
**Critère d'acceptation** : nombre de reprises par connexion, délai mesuré, et l'offset de la
première requête de reprise (doit être > 0).

---

## 3. Après la campagne

1. Chaque constat entre dans **l'annexe thématique** correspondante (06, 11, 12, 13, 14), avec
   la date et le chemin de la preuve — jamais « de mémoire ».
2. Toute hypothèse tranchée passe en `confirmée`/`réfutée` dans `06-hypotheses.md`.
3. Toute décision contredite est **remplacée** dans `JOURNAL.md` (on n'édite pas une décision
   passée), et `src/` suit avec ses tests : `D-041` (parcours) et `D-042` (arborescence) sont
   les deux premières à réévaluer.
4. La roadmap coche `A-09` et ouvre `WP-07` (fiches C–F).

## 4. Ce que ce protocole ne fera pas

- extraire ou déchiffrer des cookies, mots de passe, licences (`D-004`) ;
- contourner une protection technique, un DRM ou une limitation de licence ;
- contacter les serveurs de l'éditeur, ni télécharger quoi que ce soit depuis Internet ;
- publier des extraits substantiels du logiciel : seuls des offsets, des noms de valeurs et
  des constats de comportement sont consignés.
