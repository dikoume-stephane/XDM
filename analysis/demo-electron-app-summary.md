# Démo REA — analyse statique de `samples/demo-electron-app`

Premier passage de validation de l'outillage REA (`rea-agents` 6.8.0) sur l'application
Electron témoin du dépôt. Sortie brute complète : `analysis/raw/demo-electron-app.json`
(321 Ko, non versionnée, régénérable).

| Champ | Valeur |
|---|---|
| `evidence_id` | `ev_29f847b856e91e3409df0221ef581d34a51923921dad6ffc0868712d7e5968a5` |
| Sujet | `demo-electron-app` (`directory`) |
| SHA-256 du sujet | `2e445604e0466e2d8ee95a2a5fcfdcf29d67b6ffe7d45cafb2a3e2e70e8d5f1b` |
| Provider | `rea-javascript-application` v1 |
| Confiance | `derived` |
| Couverture | `complete` — tronquée : False, omissions : 0 |
| Noeuds / liens | 26 / 36 |

## Ce que REA a reconstruit sans exécuter l'application

| Élément | Détail |
|---|---|
| Point d'entrée `main` | `src/main.js` (résolu via `package.json.main`) |
| Fenêtre | `BrowserWindow` l.5-13, `webPreferences` lues statiquement (contextIsolation, etc.) |
| Préchargement | `src/preload.js` (résolu depuis l'expression `path.join(__dirname, ...)`) |
| Pont de contexte | `window.vault` exposé via `contextBridge`, membres : `read` |
| Canal IPC | `vault:read` — `ipcMain.handle` (main) relié à `ipcRenderer.invoke` (preload) |
| Renderer | `src/index.html` et son script `renderer.js` |

## Limites déclarées par REA

- CommonJS and ESM binding relationships were recovered from inert syntax and resolved only within the inventoried artifact container.
- Electron API identity follows proven lexical module aliases and structurally verified module-namespace interop. Other reassignments, dynamic selections, and visibly overwritten namespace members are unresolved; missing findings do not establish absence. Arbitrary call side effects and runtime registration are not evaluated.
- Electron relationships are derived from inert syntax; runtime registration, reachability, defaults, and enforcement remain unproven.
- JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.
- Static imports, entrypoints, workers, endpoints, and storage relationships do not prove runtime execution.

> Les relations sont des candidats statiques : elles n'attestent pas d'un appel réel à
> l'exécution, et une absence de constat ne prouve pas une absence de comportement.
