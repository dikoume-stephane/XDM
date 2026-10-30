# Guide Windows — exécuter sur votre PC ce qui est bloqué ici

> **Pour qui ?** Quelqu'un qui a un PC Windows, une licence IDM en règle, et deux heures
> devant lui. Aucune compétence en rétro-ingénierie n'est nécessaire : chaque étape est une
> suite de commandes et d'observations à noter.
>
> **Pourquoi ?** Quatre lots de la roadmap ne peuvent pas être exécutés dans l'environnement
> d'analyse (un conteneur Linux sans écran, sans VM, sans IDM exécutable). Ils bloquent les
> portes **G4** (comparaison IDM ↔ XDM) et **G5** (hypothèses P0 tranchées). Ce guide les rend
> exécutables chez vous, et dit exactement quoi me renvoyer.
>
> **État au moment d'écrire** : 351 tests verts, 101 exigences (100 vertes, 1 hors périmètre),
> 89 décisions, 34 lots dont 30 clos. Les **quatre** lots restants sont ceux de ce guide.
> Deux chantiers restent par ailleurs **faisables sans vous** et ne sont pas faits : la pause
> coopérative d'un transfert (il faut un `AbortSignal` traversant `src/connection-loop.js`) et
> la police embarquée de l'interface — voir `docs/ROADMAP-IDM.md` §7.3.

---

## 0. Ce que ce guide débloque

| Lot | Question posée | Ce que vous produisez | Où le déposer |
|---|---|---|---|
| **`WP-30`** | XDM aspire-t-il un site **comme** le Site Grabber d'IDM ? | deux arborescences + un rapport de comparaison | `analysis/dynamique/wp30/` |
| **`WP-40`** | Que fait IDM **pendant** une aspiration (fichiers, registre, réseau) ? | journaux Process Monitor, captures Wireshark, trace Frida | `analysis/dynamique/wp40/` |
| **`WP-41`** | Les 8 hypothèses ouvertes (`H-06`→`H-16`) tiennent-elles ? | une fiche par hypothèse : observé / infirmé / non conclu | `analysis/dynamique/wp41/` |
| **`WP-42`** | Quels sont les vrais débits et les vrais seuils d'IDM ? | grille de mesures CSV | `analysis/dynamique/wp42/` |
| **`A-09-bis`** | Quel est le format binaire d'un `.gsd` ? | un projet `.gsd` produit par IDM + un dump hexadécimal | `analysis/idman/echantillons/` |
| **`A-02`** | Que dit le code décompilé des zones non lues ? | réponses aux `Q-*` géographiques | `analysis/idman/` |

Les trois premières lignes suffisent à franchir **G4** et **G5**. Les trois dernières sont du
bonus qui lève des questions restées ouvertes faute d'outil.

### Trois règles qui ne se négocient pas

1. **VM isolée, instantané avant de commencer.** IDM s'installe avec des pilotes et des
   services ; une VM permet de tout jeter à la fin. VirtualBox ou Hyper-V, 4 vCPU, 8 Go,
   60 Go, un instantané nommé `avant-idm`.
2. **Licence IDM en règle, ou période d'essai.** On observe un logiciel qu'on a le droit
   d'exécuter. Aucun contournement de licence, aucun patch.
3. **`D-004` reste la loi.** On **n'extrait aucun cookie de navigateur**, on ne touche à aucun
   DRM, on n'appelle aucun serveur de l'éditeur. `H-11` (usage des cookies) reste
   **non instruite** : on peut *observer qu'IDM lit un fichier de cookies*, jamais *récupérer
   son contenu*. Si une étape vous demande de copier un cookie, elle est hors du guide.

---

## 1. Préparer la machine (30 min)

### 1.1 Système

- Windows 10 22H2 ou Windows 11, à jour, **compte local** (pas de compte Microsoft : moins de
  synchronisation parasite).
- Désactiver le presse-papiers partagé et la synchronisation OneDrive dans la VM.
- Créer l'instantané `avant-idm` **avant** l'installation d'IDM.

### 1.2 Outils (à installer dans cet ordre)

| Outil | Version conseillée | Pourquoi |
|---|---|---|
| Git for Windows | 2.4x | récupérer le dépôt XDM |
| Node.js LTS | 22.x | faire tourner XDM et ses 351 tests |
| Python | 3.12 | `tools/idman_*.py` (analyse du binaire) |
| 7-Zip | 24.x | extraire les ressources, produire les archives |
| **IDM** | la vôtre | c'est la cible |
| Process Monitor | dernière | `WP-40` : fichiers, registre |
| Wireshark | 4.x | `WP-40`/`WP-42` : réseau |
| Frida (`pip install frida-tools`) | 16.x | `WP-40` : appels WinINet, arguments |
| Ghidra | 12.x | `A-02` (facultatif) |
| `clumsy` | 0.3 | `WP-42` : latence et pertes réseau |

### 1.3 Vérifier que la VM est propre

```powershell
# Dans PowerShell, en administrateur
Get-ComputerInfo | Select-Object WindowsProductName, OsHardwareAbstractionLayer
node --version      # >= 22.12
python --version    # 3.12.x
```

---

## 2. Faire tourner XDM sur Windows (20 min)

C'est la première preuve utile : **XDM est un produit, pas un dépôt**.

```powershell
git clone https://github.com/dikoume-stephane/XDM.git
cd XDM
npm install                      # installe REA (dev) — aucune dépendance d'exécution
npm test                         # attendu : 351 tests, 0 échec
node tools/audit-conformance.mjs --strict   # attendu : « Aucun écart de traçabilité. »
```

Puis l'interface, dans le navigateur :

```powershell
node bin/xdm-ui.js --port 8100 --dossier "$env:USERPROFILE\Téléchargements\XDM"
# ouvrir http://127.0.0.1:8100/
```

**Accessibilité (10 min, et un vrai gain)** — l'interface a été auditée automatiquement
(axe-core : 0 violation), mais jamais avec un lecteur d'écran réel :

1. Lancer NVDA (gratuit), puis `node bin/xdm-ui.js --port 8100`.
2. Parcourir les écrans avec `Tab` et les flèches ; lancer un téléchargement au clavier.
3. Noter : les boutons-icônes sont-ils nommés ? la progression est-elle annoncée ? le focus
   reste-t-il visible ? les changements d'écran sont-ils annoncés ?
4. Déposer `analysis/dynamique/accessibilite.md` (5 lignes suffisent).

Puis l'application de bureau :

```powershell
npm run desktop:install    # télécharge Electron (~120 Mo) dans desktop/node_modules
npm run desktop            # ouvre la fenêtre XDM
```

**Ce qui doit se passer** : une fenêtre s'ouvre, le menu contient *Fichier* (ouvrir le dossier
de téléchargements), *Affichage*, *Aide* ; un téléchargement lancé depuis l'écran
« Téléchargements » apparaît dans l'historique avec son code de sortie.

**Points de vigilance Windows**

- Si `npm test` échoue sur des chemins, vérifiez que vous êtes dans `XDM\` et non dans un
  sous-dossier : les tests créent leurs fichiers dans `%TEMP%`.
- Un antivirus peut bloquer l'écoute sur un port local : autorisez `node.exe` en réseau privé.
- L'interface écoute **127.0.0.1** par défaut. Avec `--hote 0.0.0.0`, un jeton est exigé et
  affiché au démarrage (`D-088`) : c'est voulu.
- **Note à me renvoyer** : si `npm test` ne donne pas exactement 350/350, la sortie complète
  est plus utile que « ça marche pas ».

---

## 3. `WP-30` — comparer le Site Grabber d'IDM et `xdm-grab` (1 h)

### 3.1 Construire un site témoin **local** et figé

On n'aspire pas un vrai site : on veut un corpus dont on connaît chaque octet.

```powershell
$site = "$env:USERPROFILE\site-temoin"
New-Item -ItemType Directory -Force "$site\a", "$site\media", "$site\prive" | Out-Null
Set-Content "$site\index.html" '<html><body><a href="/a/page1.html">1</a> <a href="/media/f.bin">F</a> <a href="/prive/x.html">P</a></body></html>'
Set-Content "$site\a\page1.html" '<html><body><a href="/a/page2.html">2</a> <a href="/media/g.bin">G</a></body></html>'
Set-Content "$site\a\page2.html" '<html><body>fin</body></html>'
Set-Content "$site\prive\x.html" '<html><body>privé</body></html>'
Set-Content "$site\robots.txt" "User-agent: *`nDisallow: /prive/`n"
# deux fichiers de tailles connues
fsutil file createnew "$site\media\f.bin" 65536
fsutil file createnew "$site\media\g.bin" 131072
# servir le site
cd $site ; python -m http.server 8123 --bind 127.0.0.1
```

Le site répond sur `http://127.0.0.1:8123/`. Notez la date/heure : elle sert de référence.

### 3.2 Aspirer avec IDM

1. IDM → **Site Grabber** (ou *Grabber* / *Aspirer un site* selon la version).
2. Projet : `wp30-idm`, dossier : `%USERPROFILE%\wp30\idm`.
3. Réglages à relever **et à noter** : niveau de profondeur, filtres, nombre de connexions,
   délai, respect de `robots.txt` s'il est proposé.
4. Lancer. Attendre la fin.
5. **Copier tout le dossier produit** (fichiers + projet `.gsd` + `queue` éventuelle).

> Notez aussi ce qu'IDM **n'a pas** pris (le dossier `prive/` ? les `.html` ? les `.bin` ?) :
> c'est cette différence-là qui intéresse `WP-30`.

### 3.3 Aspirer avec XDM, mêmes intentions

```powershell
cd $env:USERPROFILE\XDM
node bin/xdm-grab.js http://127.0.0.1:8123/ "$env:USERPROFILE\wp30\xdm" `
  --profondeur 2 --pages 100 --paralleles 1
```

Options utiles pour reproduire les réglages d'IDM :

| Réglage IDM | Option XDM |
|---|---|
| profondeur *n* | `--profondeur n` |
| filtre d'inclusion | `--inclure "*.bin"` |
| filtre d'exclusion | `--exclure "*.zip"` |
| ne pas suivre `robots.txt` | **impossible** (`D-004`) — à noter comme écart assumé |
| nombre de connexions | `--connexions n` |
| délai entre requêtes | `--delai s` |

### 3.4 Comparer avec l'outil fourni

```powershell
node tools/comparer-aspirations.mjs "$env:USERPROFILE\wp30\idm" "$env:USERPROFILE\wp30\xdm"
```

Sortie attendue : un tableau `chemin / verdict / octets IDM / octets XDM`, puis un résumé.
Code de sortie `0` si tout est identique, `1` s'il y a une divergence, `2` en cas d'usage
incorrect.

**À me renvoyer** : `analysis/dynamique/wp30/rapport.txt` (copie de la sortie), les deux
arborescences (sans les binaires volumineux), et vos notes de réglages IDM.

---

## 4. `WP-40` — captures dynamiques (1 h 30)

Trois captures, trois questions différentes. **Une par une**, avec un instantané entre chaque.

### 4.1 Process Monitor — ce qu'IDM touche

1. Lancer Process Monitor, **Filter → Filter…** :
   - `Process Name` → `is` → `IDMan.exe`
   - puis `Operation` → `is` → `CreateFile`, `WriteFile`, `RegCreateKey`, `RegSetValue`
2. Vider (`Ctrl+X`), lancer l'aspiration IDM du §3.2.
3. Arrêter la capture, **File → Save** en `.CSV` (attention : format CSV, pas PML).
4. Déposer `wp40/procmon-idman.csv`.

**Ce qu'on cherche** : les chemins exacts (`%APPDATA%\IDM\…`, `Grabber\Projects\…`), les clés
`SCHANNEL\Protocols` (`H-12`), les appels à `IDMGrHlp.exe` (`H-15`).

### 4.2 Frida — quels arguments, quels appels réseau

```powershell
cd $env:USERPROFILE\XDM\analysis\dynamique\wp40
frida -f "C:\Program Files (x86)\Internet Download Manager\IDMan.exe" -l hook-wininet.js --no-pause
```

`hook-wininet.js` (à créer, 20 lignes) :

```javascript
// Observe, n'injecte rien : on journalise les appels WinINet d'IDM.
['HttpOpenRequestA', 'HttpSendRequestA', 'InternetOpenUrlA'].forEach((nom) => {
  const adresse = Module.findExportByName('wininet.dll', nom);
  if (!adresse) return;
  Interceptor.attach(adresse, {
    onEnter(args) {
      try {
        if (nom === 'InternetOpenUrlA') console.log(nom, args[1].readAnsiString());
        else console.log(nom, args[1].readAnsiString());
      } catch (e) { /* pointeur illisible : on ignore */ }
    },
  });
});
```

**Ne journalisez jamais** le contenu des en-têtes `Cookie` : notez seulement *qu'une requête
porte un en-tête d'authentification* (`D-004`).

### 4.3 Wireshark — le trafic réel

1. Interface « Loopback » (ou la carte virtuelle si le site témoin est sur l'hôte).
2. Filtre d'affichage : `tcp.port == 8123`.
3. Capturer une aspiration IDM complète, exporter en `.pcapng`.

**Ce qu'on cherche** : HTTP/1.1 seul ? (`H-07`), ordre et nombre de connexions (`WP-42`),
présence de `Range: bytes=…`, temporisation entre requêtes.

---

## 5. `WP-41` — trancher les hypothèses ouvertes (1 h)

Une fiche par hypothèse, format imposé : **observé / infirmé / non conclu**, avec la preuve
(fichier + ligne + horodatage). Ne concluez pas « probablement » : « non conclu » est une
réponse utile, une supposition ne l'est pas.

| Hypothèse | Ce qu'il faut observer | Où |
|---|---|---|
| **`H-06`** — pas de déchiffrement DRM, heuristiques de détection vidéo | aspirer une page vidéo protégée : IDM propose-t-il un téléchargement ? échoue-t-il ? | capture réseau `WP-40` |
| **`H-07`** — pas de HTTP/2 ni HTTP/3 | Wireshark : `http2` apparaît-il ? un `QUIC` (UDP 443) ? | `wp40/*.pcapng` |
| **`H-09`** — ressources `IMAGE`/`PNG` = captures d'aide | extraire les 6 blobs de `.rsrc` (7-Zip ou `tools/idman_extract.py`) et les ouvrir | `analysis/idman/ressources/` |
| **`H-10`** — `com.tonec.idm` = native messaging JSON | avec Chrome, cliquer un lien vidéo : un processus `idmnmcl` apparaît-il ? capturer stdin/stdout | ProcMon + `wp40/` |
| **`H-11`** — cookies = reprise authentifiée | **sans lire le contenu** : IDM ouvre-t-il un fichier `Cookies` pendant une reprise ? | ProcMon |
| **`H-12`** — `SCHANNEL\Protocols` sert à activer TLS 1.2/1.3 | ProcMon : quelles valeurs sont écrites, et quand ? | `procmon-idman.csv` |
| **`H-13`** — `application/x-fcs` = Flash Media Server (obsolète) | le serveur témoin renvoie ce type : IDM le traite-t-il comme un flux ? | Wireshark |
| **`H-14`** — `idmmkb`/`idmmbc`/`idmfsa` = clavier / navigateur / FS access | lancer IDM, observer les DLL chargées (Process Explorer) et les raccourcis actifs | note libre |
| **`H-15`** — `IDMGrHlp.exe` = worker du grabber (affaiblie) | ProcMon : ses arguments `CreateProcess` pendant une aspiration | `procmon-idman.csv` |
| **`H-16`** — `Duration`/`nAggrV`/`TPswitch` = métadonnées multimédia | après un téléchargement vidéo, ces valeurs apparaissent-elles dans le projet ? | `analysis/idman/echantillons/` |

Modèle de fiche à remplir (une par hypothèse, `wp41/H-xx.md`) :

```markdown
# H-07 — pas de HTTP/2 ni HTTP/3

- **Protocole** : capture Wireshark d'une aspiration complète du site témoin.
- **Observation** : …
- **Verdict** : observé | infirmé | non conclu
- **Preuve** : wp40/wp40-aspiration.pcapng, trames 12–340
- **Ce que ça change** : …
```

---

## 6. `WP-42` — mesurer les performances (1 h)

Sept scénarios, chacun trois fois, avec IDM **et** XDM. Remplissez `wp42/mesures.csv` :

```csv
scenario,outil,fichier_octets,connexions,duree_s,debit_kio_s,requetes,octets_total,notes
local-100m-1c,xdm,104857600,1,,,,,
local-100m-8c,xdm,104857600,8,,,,,
local-100m-8c,idm,104857600,8,,,,,
latence-100ms,xdm,104857600,8,,,,,"clumsy: delay 100ms"
perte-1pct,xdm,104857600,8,,,,,"clumsy: drop 1%"
serveur-429,xdm,104857600,4,,,,,"serveur qui répond 429 une fois sur deux"
reprise-coupure,xdm,104857600,8,,,,,"coupure réseau à 50%"
```

Côté XDM, la mesure se fait en une commande :

```powershell
Measure-Command {
  node bin/xdm.js http://127.0.0.1:8123/media/f.bin "$env:USERPROFILE\wp42\f.bin" --connexions 8
} | Select-Object TotalSeconds
```

**Ce qu'on en fait** : `EX-A-13` (seuil de morceau), les temporisations de reprise et les
plafonds de `src/chunk-policy.js`. Aujourd'hui ces valeurs sont **spécifiées comme produit**
(choisies et testées), pas mesurées sur IDM. Vos chiffres permettent de les confronter.

---

## 7. `A-09-bis` — un vrai projet `.gsd` (20 min)

1. Dans IDM, créer un projet de grabber nommé `echantillon-gsd` sur le site témoin.
2. Aspirer trois fichiers, puis **fermer IDM proprement** (sinon le fichier n'est pas complet).
3. Récupérer le projet :

```powershell
Get-ChildItem "$env:APPDATA\IDM\Grabber\Projects" -Recurse | Select-Object FullName, Length
Copy-Item "$env:APPDATA\IDM\Grabber\Projects\*" "$env:USERPROFILE\XDM\analysis\idman\echantillons\" -Recurse
```

4. Dumper les 512 premiers octets en hexadécimal :

```powershell
Format-Hex -Path .\echantillons\*.gsd -Count 512 | Out-File echantillons\gsd-dump.txt
```

**Ce que ça débloque** : la question `Q-B-06` (format exact) et, par ricochet, la fidélité de
`src/project.js`.

---

## 8. `A-02` — Ghidra (facultatif, 2 h)

Utile seulement si vous voulez lever les questions qui restent dans les zones non lues.

```powershell
# 1. installer Ghidra 12.x et définir la variable
setx GHIDRA_INSTALL_DIR "C:\ghidra_12.2_PUBLIC"
# 2. vérifier
python tools\idman_triage.py            # doit trouver cible\IDMan.exe
```

Les scripts `tools/idman_*.py` s'exécutent ensuite comme dans `docs/REA.md` (analyse de
`cible/IDMan.exe`, jamais d'exécution du binaire).

> **Attention** : Ghidra produit des fichiers volumineux (`.gpr`, `.rep`). Ne les commitez pas ;
> déposez seulement les extraits cités dans les annexes.

---

## 9. Ce que vous me renvoyez, et comment je l'intègre

```
analysis/dynamique/
├── wp30/
│   ├── rapport.txt            # sortie de comparer-aspirations.mjs
│   ├── idm/                   # arborescence produite par IDM (sans gros binaires)
│   ├── xdm/                   # arborescence produite par xdm-grab
│   └── reglages-idm.md        # profondeur, filtres, connexions, options cochées
├── wp40/
│   ├── procmon-idman.csv
│   ├── hook-wininet.js
│   └── *.pcapng
├── wp41/
│   └── H-06.md … H-16.md      # une fiche par hypothèse
└── wp42/
    └── mesures.csv
analysis/idman/echantillons/
├── *.gsd
└── gsd-dump.txt
```

**Ce que j'en fais** : mise à jour des annexes concernées, `H-*` passent de « ouverte » à
« observée / infirmée », `WP-30`/`WP-40`→`WP-42` passent à clos, **G4** et **G5** sont
franchies, et la revendication de fidélité cesse d'être limitée au statique.

**Avant d'envoyer**, deux vérifications côté XDM restent valables :

```powershell
npm test
node tools/audit-conformance.mjs --strict
```

---

## 10. Liste de contrôle

- [ ] VM Windows créée, instantané `avant-idm` pris
- [ ] IDM installé (licence ou essai), aucune modification de licence
- [ ] `npm test` → 351/351 · `audit-conformance --strict` → aucun écart
- [ ] Fenêtre XDM ouverte (`npm run desktop`) — **première confirmation visuelle** de `WP-53`
- [ ] Parcours NVDA fait, notes déposées (`analysis/dynamique/accessibilite.md`)
- [ ] Site témoin servi sur `127.0.0.1:8123`, réglages du serveur notés
- [ ] Aspiration IDM faite, dossier copié, réglages notés
- [ ] Aspiration XDM faite, `comparer-aspirations.mjs` exécuté (code 0 ou 1, pas 2)
- [ ] ProcMon filtré sur `IDMan.exe`, CSV exporté
- [ ] Wireshark : `tcp.port == 8123`, `.pcapng` exporté
- [ ] Frida : hook WinINet chargé, sortie copiée (aucun cookie journalisé)
- [ ] 10 fiches `H-*.md` remplies, verdict explicite
- [ ] `mesures.csv` rempli (7 scénarios × 3)
- [ ] `.gsd` récupéré + dump hexadécimal
- [ ] Tout déposé sous `analysis/dynamique/`, rien de confidentiel, aucun binaire d'IDM

---

## 11. Sécurité, légalité, et ce que ce guide ne fera pas

- **On observe, on ne modifie pas.** Aucune étape ne patche IDM, ne contourne sa licence, ni
  ne redistribue ses fichiers. Le binaire `cible/IDMan.exe` reste hors du dépôt public et hors
  du paquet (`tools/empaqueter.mjs` l'exclut explicitement).
- **Aucune donnée personnelle ne sort de la VM.** Captures réseau limitées au site témoin
  local ; pas de trafic vers un site réel pendant une capture.
- **`D-004` : cookies, DRM, serveurs de l'éditeur.** `H-11` reste « sensible, non instruite ».
  Si une observation ne peut pas être faite sans lire un cookie, elle ne se fait pas — et on
  note « non conclu » avec la raison. C'est déjà la règle appliquée aux annexes.
- **Ce que je refuserai d'intégrer** : une capture contenant des cookies ou des jetons
  d'authentification, un binaire d'IDM, ou une « preuve » sans fichier d'origine.

---

## 12. Si vous n'avez qu'une heure

Faites, dans cet ordre :

1. `npm test` + `npm run desktop` (§2) — 20 min : vous confirmez que l'application de bureau
   démarre, ce que cet environnement n'a pas pu vérifier.
2. `WP-30` (§3) — 30 min : la comparaison IDM ↔ XDM est la seule porte **G4**, et elle ne
   demande aucun outil de capture.
3. `A-09-bis` (§7) — 10 min : un `.gsd` et son dump débloquent `Q-B-06`.

Le reste peut attendre un week-end de pluie.

---

*Ce guide accompagne `docs/GUIDE-TEST.md` (piste B, tests du produit par un tiers) et
`docs/ROADMAP-IDM.md` §7.2 (ce qui reste, et pourquoi c'est bloqué).*
