# REA dans XDM — installation et mode d'emploi

[REA (« Reverse Engineer Anything »)](https://github.com/morluto/rea) est un serveur MCP +
CLI qui permet à un agent d'inspecter une application **sans son code source** :
binaires natifs, applications JavaScript/Electron, assemblies .NET, APK, sites web,
captures réseau, artefacts Unity/Godot, modèles GGUF, etc. Chaque résultat est un
**bundle Evidence** (constats + preuves + limites déclarées).

- Paquet officiel : [`rea-agents` sur npm](https://www.npmjs.com/package/rea-agents)
- Site : <https://rea.tools/>
- Licence : MIT

## 1. Ce qui est installé ici

| Élément | Emplacement | Détail |
|---|---|---|
| REA CLI (globale) | `/usr/local/bin/rea` | v6.8.0 (npm global, `6.7.0` pour le binaire `rea --version`) |
| REA (dépendance projet, épinglée) | `./node_modules/.bin/rea` | `rea-agents@6.8.0` déclaré dans `package.json` |
| Jeton agent / skills | `/usr/local/lib/node_modules/rea-agents/skills` | instructions de workflow fournies avec le paquet |
| Application témoin | `samples/demo-electron-app/` | petite app Electron écrite pour valider l'outil |
| Sorties d'analyse | `analysis/` | résumé versionné, JSON brut dans `analysis/raw/` (ignoré par Git) |

Réinstallation à l'identique :

```bash
npm install            # installe rea-agents@6.8.0 dans le projet
npm install -g rea-agents   # optionnel : commande `rea` globale
npx rea-agents@latest update   # mise à jour vérifiée
```

## 2. État de l'environnement

```bash
npm run doctor
```

Résultat actuel sur ce sandbox (Debian 12, Node 22.22.3) :

| Vérification | Statut |
|---|---|
| Node.js, hôte, `ps` (procps) | ✅ |
| Analyse statique JavaScript / Electron | ✅ aucune dépendance externe |
| Inventaires d'artefacts, APK (signatures), .NET, PE/ELF notes, GGUF, IPS, BEAM… | ✅ intégré |
| Moteur natif (Hopper / Ghidra / IDA) | ❌ non installé |
| JADX (décompilation APK) | ❌ non fourni |
| Chrome/Playwright (analyse de sites web, captures) | ❌ absent |
| `sqlite` natif (bases de données) | ⚠️ nécessite Node 24 |

Ces trois derniers points ne bloquent **que** les commandes concernées ; ils
s'activent en fournissant un binaire/chemin externe (variables `GHIDRA_INSTALL_DIR`,
`REA_JADX_MCP_JAR`, `HOPPER_LAUNCHER_PATH`…), sans réinstaller REA.

## 3. Utilisation en CLI

```bash
# Vue d'ensemble d'une app (macOS/Linux/Windows)
rea analyze /chemin/vers/app --format json

# Reconstruction statique d'une app JavaScript/Electron (dossier extrait ou .asar)
rea analyze-javascript-application /chemin/vers/app --format json

# Un fichier précis seulement, avec un budget de temps
rea analyze-javascript-application ./app --source-path dist/main.js --analysis-timeout-ms 120000

# Fichiers binaires de bas niveau, sans moteur natif
rea inspect pe-imports ./app.exe
rea inspect elf-notes ./binaire
rea inspect go-binary ./outil-go
rea inspect model-artifact ./modele.gguf

# Contrat de commande et schémas
rea --llms --llms-full
rea <commande> --schema
```

Format de sortie : `--format json|yaml|md|jsonl|toon`. Les JSON sont de vrais bundles
Evidence (`evidence_id`, `subject`, `provider`, `normalized_result`, `confidence`,
`coverage`, `limitations`).

## 4. Utilisation depuis un agent (MCP)

```bash
npx rea-agents@latest setup
```

L'assistant propose d'enregistrer le serveur MCP et les instructions de workflow
(Claude Code, Codex, Cursor, Gemini CLI, Grok Build…), sauvegarde les configs
existantes, puis demande un redémarrage de l'agent. Ensuite on lui parle en langage
naturel :

> « Comprends comment fonctionne la recherche dans cette app Electron, montre-moi les
> preuves, puis implémente une fonctionnalité équivalente pour mon projet. »

Réglages utiles : `REA_MCP_INPUT_SCHEMA_PROFILE=full` (schémas d'entrée détaillés) et
`REA_MCP_OUTPUT_SCHEMA_PROFILE=compact|off` (si le client tronque `tools/list`).

## 5. Premier passage de validation (fait)

L'application témoin `samples/demo-electron-app` a été analysée :

```bash
npm run analyze:demo > analysis/raw/demo-electron-app.json
```

REA a reconstruit, **sans exécuter l'app** : le point d'entrée `main` via
`package.json`, la `BrowserWindow` et ses `webPreferences`, le preload résolu depuis
`path.join(__dirname, …)`, l'API `contextBridge` exposée (`window.vault` → `read`), et le
canal IPC `vault:read` reliant `ipcMain.handle` à `ipcRenderer.invoke`.

Détail et limites : [`analysis/demo-electron-app-summary.md`](../analysis/demo-electron-app-summary.md).

## 6. Application à la cible IDM

Le dépôt contient une cible réelle (`cible/IDMan.exe`, IDM 6.42.22.3) et toute la
chaîne de preuve associée :

```bash
npm run evidence:idm    # 11 bundles Evidence -> analysis/raw/idman/
npm run triage:idm      # agrégats déterministes -> analysis/idman/triage.json
npm run extract:idm     # chaînes, RTTI, dialogues, menus -> analysis/raw/idman/
```

Ce qui fonctionne **sans** moteur natif : PE (en-têtes, sections, imports, ressources,
load config, certificats), entropie, objdump (en-têtes/sections/symboles).
Ce qui exige un moteur : `rea analyze`, `rea decompile`, `rea function`,
`rea inspect-native-api` → Ghidra 12.1.x (`GHIDRA_INSTALL_DIR`), cf. `docs/ROADMAP-IDM.md` WP-03.

## 7. Règles d'usage dans ce dépôt

1. Ne jamais publier de JSON brut volumineux : les sorties complètes vont dans
   `analysis/raw/` (ignoré) ; on ne versionne qu'un résumé de quelques Ko.
2. Toujours recopier `evidence_id`, la couverture et les `limitations` avec une
   conclusion — un constat statique ne prouve pas un comportement à l'exécution.
3. Ne pas examiner de code que nous n'avons pas le droit d'analyser ; l'outil reste
   local, mais la responsabilité d'usage est celle de l'utilisateur.
4. `rea doctor` avant toute campagne, pour savoir quels providers sont réellement
   disponibles.
