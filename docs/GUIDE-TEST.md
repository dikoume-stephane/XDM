# Guide de test — ce que vous pouvez vérifier vous-même

> **But** : rendre chaque affirmation du projet **vérifiable par vous**, sans me croire sur
> parole. Deux pistes, indépendantes :
>
> * **Piste A — le produit** (≈ 20 min, Node seul) : les tests, l'audit de traçabilité, la
>   porte G3, puis un **banc d'essai local** qui montre les trois CLI en fonctionnement.
> * **Piste B — la cible IDM** (≈ 2 h, VM Windows jetable) : les six phases du protocole
>   d'observation (`analysis/idman/16-protocole-observation-vm.md`) qui débloquent ce que
>   l'analyse statique **ne peut pas** trancher.
>
> Rien ici ne demande de contourner une protection, de copier un binaire ou d'utiliser un
> compte : la piste B observe **votre** IDM licite, sur **votre** site de test, dans une VM
> jetable, et ne conserve aucun cookie (`D-004`).

---

## Piste A — tester XDM (sans IDM)

### A.1 Prérequis

| Élément | Version | Vérification |
|---|---|---|
| Node.js | **≥ 22.23.4** (ou 24.22.1+) | `node -v` |
| git | quelconque | `git --version` |
| Un navigateur, un terminal | — | — |

`npm install` **n'est pas** nécessaire : le socle n'a aucune dépendance d'exécution
(`rea-agents` n'est là que pour l'analyse REA, facultative).

### A.2 Récupérer la branche

```bash
git clone https://github.com/dikoume-stephane/XDM.git
cd XDM
git switch arena/c3b095dd-xdm
git log --oneline -1     # le dernier commit du lot en cours
```

### A.3 Les trois commandes de contrôle

```bash
npm test          # attendu : « # tests 286 », « # pass 286 », « # fail 0 »
npm run audit     # attendu : « Exigences : 92 (vertes : 91) » + « Aucun écart de traçabilité. »
npm run gate      # attendu : « Porte G3 : franchie — … coupure(s) … »
```

Ce qu'elles prouvent, et ce qu'elles ne prouvent pas :

| Commande | Prouve | Ne prouve **pas** |
|---|---|---|
| `npm test` | 286 cas passent sur votre machine, pas seulement sur la mienne | que le comportement est *fidèle à IDM* (c'est la piste B) |
| `npm run audit` | chaque exigence verte cite une preuve **et** un test qui existe ; les totaux annoncés dans les docs sont ceux comptés | que la preuve est bien interprétée — c'est une revue humaine (`docs/specs/revue-clean-room.md`) |
| `npm run gate` | 200 pages / 205 Mio aspirés, coupure réseau absorbée, disque identique au serveur | la performance comparée à IDM (`WP-30`, bloqué) |

> Si `npm test` échoue : copiez-moi la ligne `not ok …` complète et `node -v`. C'est
> exactement le signal que je ne peux pas produire moi-même, puisque je teste sur une seule
> machine.

### A.4 Le banc d'essai local

Un serveur de test sans dépendance : un site de trois pages, un fichier reproductible de
5 Mio, un fichier protégé par en-tête, un fichier à session par cookie, un flux HLS, un
`robots.txt` qui interdit une branche, et **un journal de chaque requête reçue** — c'est lui
qui permet de vérifier côté serveur ce que le client prétend faire.

```bash
node tools/banc-essai.mjs                 # http://127.0.0.1:8080/
node tools/banc-essai.mjs --port 9000 --taille 20M
node tools/banc-essai.mjs --souffle 0     # pas de silence artificiel (étapes A.5.2 et A.5.6)
node tools/banc-essai.mjs --hote 0.0.0.0  # joignable depuis une VM (piste B)
```

Laissez-le tourner : chaque requête s'affiche chez **lui**, pas chez le client.

```
[req] GET /session.bin 206 range=bytes=0-0 ims=non jeton=non cookie=non octets=0-0
[req] GET /session.bin 206 range=bytes=0-1048575 ims=non jeton=non cookie=oui octets=0-1048575
```

| Route | Ce qu'elle sert à montrer |
|---|---|
| `/` , `/a.html`, `/b.html`, `/c.html` | parcours à trois niveaux (aspiration) |
| `/fichier.bin` | 5 Mio reproductibles, plages (`206`), `ETag`, `Last-Modified` |
| `/session.bin` | **la première requête est anonyme et pose un cookie** ; les suivantes l'exigent |
| `/protege.bin` | en-tête `x-jeton: secret` exigé sur **toutes** les requêtes |
| `/flux/index.m3u8` | HLS : playlist + init + 2 segments derrière le même en-tête |
| `/prive/interdit.html` | branche interdite par `robots.txt` (doit **ne pas** être aspirée) |
| `/lent.bin` | 200 Kio puis silence (`--souffle`, défaut 35 s : au-delà du seuil d'inactivité) |

### A.5 Les six vérifications qui comptent

#### A.5.1 Téléchargement, plages et JSON

```bash
node bin/xdm.js http://127.0.0.1:8080/fichier.bin /tmp/essai --morceau 2097152
#   20 %  1048576/5242880
#  100 %  5242880/5242880
# écrit /tmp/essai/fichier.bin (5242880 octets, 3 requêtes)

node bin/xdm.js http://127.0.0.1:8080/doc.pdf /tmp/essai --sortie json 2>/dev/null
# {"url":"http://127.0.0.1:8080/doc.pdf","target":"/tmp/essai/doc.pdf","size":32,"requests":1}
```

À vérifier **chez le serveur** : le morceau de 2 Mio donne des plages de 2 Mio, pas des
plages de 4 Kio. Et `--sortie json` sort **une** ligne, la progression allant sur `stderr`
(c'est ce qui rend `JSON.parse(stdout)` possible).

#### A.5.2 Reprise après coupure

```bash
node tools/banc-essai.mjs --port 8081 --souffle 8     # silence de 8 s (sous le seuil de 30 s)
node bin/xdm.js http://127.0.0.1:8081/lent.bin /tmp/reprise --morceau 1048576
# … Ctrl-C pendant le silence (ou : timeout 3 node bin/xdm.js …)
ls /tmp/reprise           # lent.bin.xdm-part  lent.bin.xdm-part.json  ← la carte
node bin/xdm.js http://127.0.0.1:8081/lent.bin /tmp/reprise --morceau 1048576
#  100 %  1048576/1048576
# écrit /tmp/reprise/lent.bin (1048576 octets, 1 requêtes)     ← une seule requête : la suite
```

Ce qu'il faut regarder dans le journal du serveur : la deuxième exécution demande une plage
qui **commence après 0**. Si elle redemande depuis zéro, la reprise ne marche pas — dites-le.

#### A.5.3 Authentification par en-tête

```bash
node bin/xdm.js http://127.0.0.1:8080/protege.bin /tmp/essai
# xdm : statut 401 pour http://127.0.0.1:8080/protege.bin
node bin/xdm.js http://127.0.0.1:8080/protege.bin /tmp/essai --entete 'x-jeton: secret' --morceau 2097152
# écrit /tmp/essai/protege.bin (5242880 octets, 3 requêtes)
```

Côté serveur, **chaque** ligne doit porter `jeton=oui` — sonde comprise. Un `jeton=non`
au milieu d'un téléchargement, c'est le défaut que la CLI prétend ne plus avoir.

#### A.5.4 Cookies de session

```bash
node bin/xdm.js http://127.0.0.1:8080/session.bin /tmp/essai --cookies /tmp/essai/c.json
# cookies  : /tmp/essai/c.json (1 cookie(s))
# écrit /tmp/essai/session.bin (5242880 octets, 3 requêtes)
cat /tmp/essai/c.json      # {"version":1,"savedAt":…,"cookies":[{"name":"session",…}]}
```

Sans `--cookies`, la même commande doit échouer en `401` : le cookie est **nécessaire**, pas
décoratif. Côté serveur : `cookie=non` sur la première requête, `cookie=oui` sur les suivantes.

#### A.5.5 Flux HLS

```bash
node bin/xdm-media.js http://127.0.0.1:8080/flux/index.m3u8 /tmp/essai/flux --entete 'x-jeton: secret'
# initialisation : /tmp/essai/flux/init.mp4
# segment 1 : http://127.0.0.1:8080/flux/seg-1.ts
# segment 2 : http://127.0.0.1:8080/flux/seg-2.ts
# terminé : 2 segment(s), 196608 octets dans /tmp/essai/flux
```

Sans `--entete`, la playlist est refusée (`401`) avant tout segment. Avec, le journal du
serveur doit montrer `jeton=oui` sur la playlist **et** sur `init.mp4` et les deux segments.

#### A.5.6 Aspiration et vérification

```bash
node bin/xdm-grab.js http://127.0.0.1:8080/ /tmp/site --profondeur 2 --exclure 'lent.bin'
node bin/xdm-grab.js http://127.0.0.1:8080/ /tmp/site --verifier
# vérification de /tmp/site : 5 tâche(s), 2 conforme(s)
#   ÉCHEC     session.bin (tâche FAILED : rien écrit sur le disque)
#   ÉCHEC     protege.bin (tâche FAILED : rien écrit sur le disque)
#   ÉCHEC     flux/index.m3u8 (tâche FAILED : rien écrit sur le disque)
# vérification : ÉCART DÉTECTÉ (code 1)
```

Trois choses à contrôler :

Le compte est normal : trois fichiers du banc exigent une authentification que cette commande
ne fournit pas — c'est voulu, et c'est ce qui donne des tâches `FAILED` à vérifier.

1. `/prive/interdit.html` **n'apparaît pas** dans le journal du serveur (le `robots.txt` du
   banc l'interdit) — c'est `Q-B-02`, tranchée côté XDM par `D-059` et **pas** encore côté IDM.
2. un fichier en échec donne un **code de sortie 1**, jamais 0 (`--verifier` comme exécution
   normale) ;
3. une tâche seulement « pas encore tentée » n'est **pas** un écart ; une tâche `FAILED` oui.

> Note : `xdm-grab` ne connaît pas `--souffle` (c'est une option du banc). Pour éviter
> d'attendre `/lent.bin`, excluez-le : `--exclure 'lent.bin'`, ou lancez le banc avec
> `--souffle 0`.

### A.6 Les erreurs doivent être des erreurs

```bash
node bin/xdm.js http://127.0.0.1:8080/doc.pdf /tmp/essai --morceau 20971520
# xdm : --morceau attend une taille de 1 à 10485760 octets (10 Mio ; reçu : 20971520)
node bin/xdm.js http://127.0.0.1:8080/doc.pdf /tmp/essai --connexions 0
# xdm : --connexions attend un entier de 1 à 128 (reçu : 0)
node bin/xdm.js http://127.0.0.1:8080/doc.pdf /tmp/essai extra1
# xdm : trop d'arguments : extra1
for cli in bin/xdm.js bin/xdm-grab.js bin/xdm-media.js; do node $cli --version; done
# xdm 0.1.0 (Node …) / xdm-grab 0.1.0 / xdm-media 0.1.0   — et code 0 pour les trois
```

Règle du projet, vérifiable ici : **refus explicite** plutôt que correction silencieuse. Si
une valeur absurde est acceptée sans un mot, c'est un défaut, pas une souplesse.

---

### A.7 L'interface locale (5 min)

```bash
npm run ui                        # puis ouvrir http://127.0.0.1:8100/
node tools/banc-essai.mjs --port 8099 --taille 5M &   # un fichier de 5 Mio à télécharger
```

1. Coller `http://127.0.0.1:8099/fichier.bin` dans le champ, **Ajouter à la file**.
2. Cliquer **Démarrer la file** : la progression avance, puis la ligne passe dans
   **Historique** avec le **code 0** et le fichier apparaît dans `./telechargements`.
3. Refaire la même chose avec la **même** URL : le second fichier s'appelle
   `fichier-2.bin` — aucun écrasement silencieux.
4. Coller une URL `file:///etc/passwd` : l'ajout est **refusé** avec un message, aucune
   requête réseau n'est émise.
5. Arrêter `xdm-ui` (Ctrl-C) pendant un transfert, puis relancer : la tâche reprend au
   dernier octet confirmé (fichier `.part`), pas de zéro.

Ce qu'il faut voir et qui n'est **pas** là, volontairement : aucun bouton « pause » sur un
transfert en cours (le moteur n'a pas d'interruption coopérative, `D-084`), et aucun écran
**Site Grabber** ni **Vérification** (non câblés, `WP-52`) — un bouton mort serait pire
qu'une absence.

---

## Piste B — la cible IDM, en VM (débloque la phase P5)

### B.1 Cadre

| Point | Règle |
|---|---|
| Licence | **votre** IDM, acheté et licite ; aucune distribution, aucun binaire dans le dépôt |
| Machine | VM Windows 10/11 **jetable**, réseau privé (pas de NAT vers Internet), snapshot « propre » |
| Site de test | le banc d'essai de ce dépôt, sur l'hôte, en réseau privé |
| Ce qu'on ne fait pas | pas de contournement de protection, pas de télémétrie de l'éditeur, **aucun cookie conservé** (`D-004`) |
| Preuves | hors dépôt (`analysis/raw/` est dans `.gitignore`) ; seuls les constats entrent dans les annexes |

### B.2 Préparation (10 min)

```powershell
# 1. Vérifier que le binaire est bien la cible : sinon les offsets cités ne valent plus.
Get-FileHash "C:\Program Files (x86)\Internet Download Manager\IDMan.exe" -Algorithm SHA256
# attendu : 5f78da5a63604a3fefba6577ef6b2af976ec4d2fc4d0f219a72099a0da2f11c9

# 2. Outils d'observation (déjà présents ou gratuits) :
#    reg.exe (export), procmon (Sysinternals), pktmon (intégré), PowerShell (Format-Hex)
```

Sur l'hôte, lancez le banc :

```bash
node tools/banc-essai.mjs --hote 0.0.0.0 --port 8080 --souffle 35
# banc d'essai : http://127.0.0.1:8080/
# depuis une VM : http://192.168.x.x:8080/   ← notez cette adresse
```

Ouvrez le pare-feu de l'hôte pour le port 8080 **en réseau privé uniquement**. Depuis la VM,
`http://<adresse-hôte>:8080/` doit afficher la page du banc.

### B.3 Les six phases

Chaque phase dit : ce qu'on fait, ce qui est renvoyé, ce que ça tranche. Le détail complet est
dans `analysis/idman/16-protocole-observation-vm.md`.

| # | Ce que vous faites | Ce que vous m'envoyez | Ce que ça tranche |
|---|---|---|---|
| **P1** | Installer IDM, le fermer, exporter le registre, ouvrir puis fermer la boîte « Site Grabber », réexporter | `p1.reg` (avant) et `p1-apres.reg`, la ligne `Get-FileHash` | `Q-B-03` (défaut de `nLevels`), `H-04` (`MaxConnectionsNumber`), existence de `IncludeFilters`/`ExcludeFilters` |
| **P2** | Aspirer `http://<hôte>:8080/` à profondeur 3, puis m'envoyer le journal du banc | le journal `[req] GET …` complet, horodaté | `H-05` : l'ordre d'exploration est-il BFS (`a`, `b`, puis `c`) ou DFS (`a`, `c`, puis `b`) ? |
| **P3** | Aspirer la même racine en laissant `robots.txt` en place | le journal : `/prive/interdit.html` est-il demandé ? | `Q-B-02` (politique `robots.txt` d'IDM), l'agent envoyé |
| **P4** | Créer un projet d'aspiration minimal (une page, deux fichiers), le sauvegarder, puis changer un réglage et re-sauvegarder | le `.gsd` (ou `*.xdmspider`), les **64 premiers octets** en hexadécimal, et le diff entre les deux versions | `Q-B-06` (format réel du projet), `H-08` |
| **P5** | Naviguer vers `/fichier.bin` avec l'extension navigateur active, onglet réseau de `chrome://extensions` (ou relais `idmnmcl.dll`) | la **trame** (le champ cookie est noté présent, sa valeur masquée) | `H-10` (native messaging) |
| **P6** | Télécharger `/lent.bin` (35 s de silence après 200 Kio), `MaxConnections` forcé à 8 | le journal du banc + le nombre de reprises et l'offset de la première reprise | `A-13` : seuil réel, `mAttempts`, reprise au dernier octet confirmé |

Commandes utiles côté Windows :

```powershell
reg export "HKCU\Software\DownloadManager" C:\xdm\p1.reg /y
reg export "HKCU\Software\DownloadManager\GrabberSts" C:\xdm\p1-sts.reg /y
Format-Hex -Path C:\Users\vous\AppData\Roaming\IDM\*.gsd -Count 128
pktmon start -c --pkt-size 0 -f C:\xdm\p6.etl      # puis « pktmon stop »
```

### B.4 Renvoi

Nommez les fichiers `vm-P<n>-<AAAA-MM-JJ>-<objet>.<ext>`, comme le protocole. **Ne joignez
pas** : le binaire, une clé de licence, un cookie, un mot de passe, une capture d'écran de
votre compte. Le constat suffit ; je le reporte avec sa date et son chemin.

Si une phase est impossible (IDM refuse de démarrer, l'extension ne journalise pas), dites
laquelle et ce que vous avez vu : « impossible » est un résultat, pas un échec.

---

## Fiche de retour (à remplir)

Copiez ce bloc, remplissez, collez-le dans la conversation :

```text
Environnement : OS … / Node … (sortie de `node -v`)
Commit testé  : sortie de `git log --oneline -1`

npm test        : …. pass / …. fail            (si échec : la ligne `not ok` complète)
npm run audit   : … exigences, … vertes, écarts : oui/non
npm run gate    : franchie / échec (message)

Banc d'essai   : OK / KO — étape concernée (A.5.1 … A.5.6)
  - le journal du serveur montre-t-il `jeton=oui` partout où il faut ? oui/non
  - la reprise repart-elle au bon offset ? oui/non (offset observé : …)
  - un échec donne-t-il bien un code 1 ? oui/non

Piste B (si faite) : phases réalisées (P1…P6), fichiers joints, ce qui a bloqué
Remarques libres  :
```

---

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `npm test` échoue sur `node --test` inconnu | Node trop ancien | installer Node ≥ 22.23.4 (`nvm install 22`) |
| `EADDRINUSE` en lançant le banc | port occupé | `--port 0` (port choisi par le système) ou un autre port |
| La VM ne joint pas le banc | pare-feu, ou `127.0.0.1` au lieu de l'adresse de l'hôte | `--hote 0.0.0.0`, autoriser Node dans le pare-feu privé, utiliser l'adresse affichée |
| `--morceau 20M` refusé | `xdm` attend des **octets** | `--morceau 20971520` (mais le maximum est 10 Mio) |
| Une étape de la piste B semble impossible | — | dites-le : le protocole prévoit explicitement « impossible à observer » |

---

## Ce que votre test change, concrètement

| Résultat | Conséquence |
|---|---|
| `npm test` vert chez vous | je sais que la suite n'est pas liée à ma machine |
| un test rouge | je corrige **et** j'ajoute le cas, comme pour les 5 défauts du lot en cours |
| P1/P2/P3 réussies | `Q-B-02`, `Q-B-03`, `H-04`, `H-05` passent de « non tranchée » à « observée », avec date et preuve |
| P4 réussie | `WP-11` (`.gsd`) sort du blocage : le format réel remplace l'hypothèse |
| P6 réussie | la fidélité du moteur (seuil de 30 s, reprises) n'est plus seulement testée **contre XDM**, mais **contre IDM** |
