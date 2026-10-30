#!/usr/bin/env node
/**
 * Point d'entrée Electron de XDM — lot `WP-53` (`EX-E-04`→`EX-E-06`).
 *
 * Ce fichier ne contient **que la colle** : il importe Electron et le passe à
 * `src/desktop-shell.js`, qui porte toute la logique et se teste sans affichage. Le jour
 * où la logique change, c'est le module qui change ; ce fichier ne doit presque jamais
 * bouger.
 *
 * `npx electron .` ou `npm run desktop` (après `npm install`, qui installe Electron en
 * dépendance **de développement** — voir `D-086`).
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, Menu, shell } from 'electron';

import { demarrerCoquille, USAGE } from '../src/desktop-shell.js';

const argv = process.argv.slice(app.isPackaged ? 1 : 2);

if (argv.includes('--aide') || argv.includes('-h')) {
  console.log(USAGE.trimEnd());
  app.quit();
} else {
  // Une seule instance : deux fenêtres partageraient le même dossier de téléchargements et
  // se disputeraient la file d'attente.
  const verrou = app.requestSingleInstanceLock();
  if (!verrou) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const [fenetre] = BrowserWindow.getAllWindows();
      if (!fenetre) return;
      if (fenetre.isMinimized()) fenetre.restore();
      fenetre.focus();
    });

    // L'icône n'est utilisée que si elle est livrée : une fenêtre sans icône est moins
    // jolie, une fenêtre qui échoue à cause d'un fichier absent est inutilisable.
    const icone = fileURLToPath(new URL('./icone.png', import.meta.url));

    demarrerCoquille({
      electron: { app, BrowserWindow, Menu, shell, dialog },
      argv,
      ...(existsSync(icone) ? { icone } : {}),
      journal: (ligne) => console.log(ligne),
    }).catch((erreur) => {
      console.error(erreur);
      dialog.showErrorBox('XDM n’a pas pu démarrer', String(erreur?.message ?? erreur));
      app.exit(1);
    });
  }
}
