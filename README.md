# XDM

Espace de travail pour l'analyse et la reconstruction de fonctionnalités applicatives,
outillé avec **[REA](https://github.com/morluto/rea)** (*Reverse Engineer Anything*) :
un serveur MCP + CLI qui inspecte une application — binaire natif, app JavaScript/Electron,
assembly .NET, APK, site web — sans disposer de son code source, et qui rend chaque
conclusion sous forme de *bundle Evidence* (constats, preuves, limites).

## Démarrage rapide

```bash
npm install                 # rea-agents épinglé (6.8.0) + commande locale ./node_modules/.bin/rea
npm run doctor              # état de l'environnement et des providers
npm run analyze:demo        # première analyse : samples/demo-electron-app
```

Commande globalement disponible si besoin : `npm install -g rea-agents`, puis `rea --help`.

## Contenu du dépôt

| Chemin | Rôle |
|---|---|
| `docs/REA.md` | Installation, état des providers, mode d'emploi CLI et MCP, règles d'usage |
| `samples/demo-electron-app/` | Application Electron minimale servant de cible de validation |
| `analysis/demo-electron-app-summary.md` | Résumé de la première analyse REA (preuves + limites) |
| `analysis/raw/` | Sorties Evidence brutes, régénérables, **non versionnées** |
| `package.json` / `package-lock.json` | Outillage épinglé (`rea-agents@6.8.0`) |

## État actuel

- ✅ REA 6.8.0 installé (global + dépendance projet) et vérifié sur une app Electron :
  point d'entrée, `BrowserWindow`, preload, `contextBridge`, canal IPC `vault:read`.
- ✅ Analyse statique JavaScript/Electron, inventaires d'artefacts, formats PE/ELF,
  Go, GGUF, APK (signatures), .NET statique : opérationnels sans dépendance externe.
- ❌ Non installé dans cet environnement : moteur natif (Hopper/Ghidra/IDA), JADX,
  navigateur Playwright, SQLite natif — voir `docs/REA.md` §2 pour l'activation.

## Mise à jour

```bash
npx rea-agents@latest update && npx rea-agents@latest setup
```
