import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  construireMenu, DEFAUTS, demarrerCoquille, estInterne, optionsFenetre, parseArgs,
} from '../src/desktop-shell.js';

/**
 * Doublure du module Electron.
 *
 * Elle reproduit ce que `src/desktop-shell.js` utilise réellement (et rien de plus) : c'est
 * la contrepartie du choix de faire recevoir Electron en argument. Un test qui aurait
 * besoin d'un vrai binaire Electron serait un test qu'on n'exécute pas.
 */
function fauxElectron() {
  const appels = { urls: [], externes: [], chemins: [], boites: [], quits: 0, menus: [], affichee: false };
  const abonnes = new Map();
  const fenetres = [];

  const app = {
    whenReady: async () => {},
    on: (nom, retenu) => abonnes.set(nom, retenu),
    quit: () => {
      appels.quits += 1;
    },
  };

  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.events = {};
      const events = this.events;
      this.webContents = {
        events: {},
        setWindowOpenHandler: (gestionnaire) => {
          this.ouvertHandler = gestionnaire;
        },
        on: (nom, retenu) => {
          this.webContents.events[nom] = retenu;
        },
        openDevTools: () => {
          appels.devtools = true;
        },
      };
      fenetres.push(this);
      void events;
    }

    once(nom, retenu) {
      this.events[nom] = retenu;
    }

    show() {
      appels.affichee = true;
    }

    async loadURL(url) {
      appels.urls.push(url);
    }
  }

  const electron = {
    app,
    BrowserWindow,
    Menu: {
      buildFromTemplate: (modele) => ({ modele }),
      setApplicationMenu: (menu) => {
        appels.menus.push(menu);
      },
    },
    shell: {
      openExternal: async (url) => {
        appels.externes.push(url);
        return true;
      },
      openPath: async (chemin) => {
        appels.chemins.push(chemin);
        return '';
      },
    },
    dialog: {
      showMessageBox: async (fenetre, options) => {
        appels.boites.push(options);
        return { response: 0 };
      },
    },
  };

  return { electron, appels, abonnes, fenetres };
}

/** Exécute `callback` avec un dossier temporaire, nettoyé ensuite. */
async function avecDossier(callback) {
  const racine = await mkdtemp(join(tmpdir(), 'xdm-desktop-'));
  try {
    return await callback(racine);
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
}

test('T-E-09 : la fenêtre n’ouvre pas Node et ne navigue pas hors de l’interface', async () => {
  const { electron, appels, fenetres } = fauxElectron();
  await avecDossier(async (dossier) => {
    const coquille = await demarrerCoquille({ electron, dossier, argv: ['--port', '0'], plateforme: 'win32' });
    try {
      assert.equal(fenetres.length, 1, 'une seule fenêtre');
      const { webPreferences } = coquille.fenetre.options;
      assert.equal(webPreferences.contextIsolation, true);
      assert.equal(webPreferences.nodeIntegration, false);
      assert.equal(webPreferences.sandbox, true);
      assert.equal(webPreferences.webSecurity, true);
      assert.equal(appels.urls[0], coquille.url, 'la fenêtre charge l’interface locale');

      // Lien externe cliqué dans une page : navigateur système, jamais la fenêtre XDM.
      assert.deepEqual(
        coquille.fenetre.ouvertHandler({ url: 'https://exemple.test/page' }),
        { action: 'deny' },
      );
      assert.deepEqual(appels.externes, ['https://exemple.test/page']);

      // Cible interne : refusée aussi (pas de fenêtre secondaire), sans appel externe.
      coquille.fenetre.ouvertHandler({ url: `${coquille.url}index.html` });
      assert.equal(appels.externes.length, 1, 'une URL interne n’ouvre rien à l’extérieur');

      // Navigation dans la fenêtre : refusée hors origine locale.
      let bloque = false;
      coquille.fenetre.webContents.events['will-navigate'](
        { preventDefault: () => { bloque = true; } },
        'https://exemple.test/ailleurs',
      );
      assert.equal(bloque, true);
      assert.equal(appels.externes.length, 2, 'la tentative de navigation part au navigateur');

      // Webview : interdite, point.
      let webviewBloquee = false;
      coquille.fenetre.webContents.events['will-attach-webview']({ preventDefault: () => { webviewBloquee = true; } });
      assert.equal(webviewBloquee, true);
    } finally {
      await coquille.arreter();
    }
  });
});

test('T-E-10 : le menu natif expose les actions attendues, adapté à la plateforme', async () => {
  const appelsActions = [];
  const actions = Object.fromEntries(
    ['ouvrirDossier', 'ouvrirNavigateur', 'apropos'].map((nom) => [nom, () => appelsActions.push(nom)]),
  );

  const windows = construireMenu({ plateforme: 'win32', actions });
  assert.deepEqual(windows.map((entree) => entree.label), ['Fichier', 'Affichage', 'Aide']);
  const fichier = windows[0].submenu;
  assert.deepEqual(fichier[0].click(), 1, '« Ouvrir le dossier » appelle l’action');
  assert.equal(fichier[0].label, 'Ouvrir le dossier de téléchargements');
  assert.equal(fichier[1].accelerator, 'CmdOrCtrl+Shift+O');
  assert.equal(fichier.at(-1).role, 'quit', 'sous Windows, quitter est dans le menu Fichier');
  const affichage = windows[1].submenu.map((entree) => entree.role).filter(Boolean);
  assert.ok(affichage.includes('reload'));
  assert.ok(affichage.includes('toggleDevTools'));
  assert.equal(windows[2].submenu[0].click(), 2, '« À propos » est branché');
  assert.deepEqual(appelsActions, ['ouvrirDossier', 'apropos']);

  const mac = construireMenu({ plateforme: 'darwin', actions });
  assert.equal(mac[0].role, 'appMenu', 'macOS commence par le menu applicatif');
  assert.equal(mac[1].submenu.at(-1).role, 'close', 'sous macOS, fermer la fenêtre ne quitte pas');
});

test('T-E-11 : serveur local éphémère, arrêt propre, et pas de reprise automatique hors macOS', async () => {
  const { electron, appels, abonnes } = fauxElectron();
  await avecDossier(async (dossier) => {
    const coquille = await demarrerCoquille({ electron, dossier, plateforme: 'win32' });

    const url = new URL(coquille.url);
    assert.equal(url.hostname, '127.0.0.1', 'l’interface n’écoute que la boucle locale');
    assert.ok(Number(url.port) > 0, 'un port a bien été attribué');

    const reponse = await fetch(coquille.url);
    assert.equal(reponse.status, 200);
    assert.match(await reponse.text(), /<html/i);

    // Fermer la fenêtre quitte l'application sous Windows…
    abonnes.get('window-all-closed')();
    assert.equal(appels.quits, 1);
    // …et le serveur s'éteint avec elle.
    await coquille.arreter();
    await assert.rejects(fetch(coquille.url), 'le serveur est fermé');
  });

  const { electron: macElectron, appels: macAppels, abonnes: macAbonnes } = fauxElectron();
  await avecDossier(async (dossier) => {
    const coquille = await demarrerCoquille({ electron: macElectron, dossier, plateforme: 'darwin' });
    macAbonnes.get('window-all-closed')();
    assert.equal(macAppels.quits, 0, 'sous macOS, l’application survit à la fenêtre');
    await coquille.arreter();
  });
});

test('WP-53 : les arguments et les garde-fous de la coquille', async () => {
  assert.deepEqual(parseArgs([]), { ...DEFAUTS, aide: false });
  assert.equal(parseArgs(['--port', '8123']).port, 8123);
  assert.equal(parseArgs(['--dossier', '/tmp/x']).dossier, '/tmp/x');
  assert.equal(parseArgs(['--devtools']).devtools, true);
  assert.throws(() => parseArgs(['--port', 'abc']), TypeError);
  assert.throws(() => parseArgs(['--port', '70000']), RangeError);
  assert.throws(() => parseArgs(['--dossier']), TypeError);
  assert.throws(() => parseArgs(['--inconnu']), TypeError);

  const options = optionsFenetre({ plateforme: 'win32' });
  assert.equal(options.show, false, 'la fenêtre attend ready-to-show');
  assert.equal(options.minWidth, 960);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(optionsFenetre({ preload: '/tmp/p.cjs' }).webPreferences.preload, '/tmp/p.cjs');

  assert.equal(estInterne('http://127.0.0.1:1234/api/etat', 'http://127.0.0.1:1234/'), true);
  assert.equal(estInterne('http://localhost:1234/', 'http://127.0.0.1:1234/'), true);
  assert.equal(estInterne('http://127.0.0.1:1235/', 'http://127.0.0.1:1234/'), false);
  assert.equal(estInterne('https://exemple.test/', 'http://127.0.0.1:1234/'), false);
  assert.equal(estInterne('pas une url', 'http://127.0.0.1:1234/'), false);

  await assert.rejects(demarrerCoquille({}), TypeError, 'sans Electron, on refuse de démarrer');
});
