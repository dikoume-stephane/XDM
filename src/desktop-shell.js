/**
 * Coquille de bureau Electron — lot `WP-53` (`EX-E-04`, `EX-E-05`, `EX-E-06`, `D-086`).
 *
 * La décision de forme est prise depuis `D-084` : XDM est une **application de bureau**
 * (Electron), pas un site web. `src/ui-server.js` savait déjà servir l'interface et
 * piloter le gestionnaire ; ce module est la **seule** couche qui change quand la fenêtre
 * devient une fenêtre de système : démarrage du serveur local, création de la fenêtre,
 * menu natif, ouverture du dossier de téléchargements, arrêt propre.
 *
 * Trois règles de conception, chacune vérifiable sans lancer Electron :
 *
 *  1. **Aucun accès Node dans la page.** `contextIsolation: true`, `nodeIntegration: false`,
 *     `sandbox: true`. L'interface reste une page web : elle n'a aucune raison de voir
 *     `require`, `process` ou le disque de l'utilisateur.
 *  2. **La fenêtre ne navigue pas.** Un lien externe cliqué dans un fichier HTML affiché
 *     ne doit pas transformer la fenêtre applicative en navigateur : il part au navigateur
 *     du système ; toute navigation hors de l'origine locale est refusée.
 *  3. **Le serveur suit la vie de l'application.** Il écoute sur la boucle locale, sur un
 *     port **éphémère** (0) : deux instances ne se disputent pas 8100, et le port n'est
 *     jamais choisi par autre chose que le système.
 *
 * Le module ne s'importe pas d'Electron : il **reçoit** le module en argument
 * (`demarrerCoquille({ electron })`), ce qui permet de le tester avec des doublures, sans
 * binaire Electron ni affichage. `desktop/main.js` n'est alors qu'une ligne de colle.
 *
 * @module desktop-shell
 */

import { mkdir } from 'node:fs/promises';

import { startUiServer } from './ui-server.js';
import { VERSION } from './version.js';

/** Nom affiché de l'application (fenêtre, menu, « À propos »). */
export const NOM_PRODUIT = 'XDM';

/** Dimensions de la fenêtre, et plancher en dessous duquel la mise en page se casse. */
export const DIMENSIONS = Object.freeze({ largeur: 1180, hauteur: 820, largeurMini: 960, hauteurMini: 640 });

/** Valeurs par défaut de la coquille, exportées pour que les tests n'en inventent pas. */
export const DEFAUTS = Object.freeze({ port: 0, devtools: false });

/**
 * Erreur de coquille, porteuse d'un code stable.
 */
export class CoquilleError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'CoquilleError';
    this.code = code;
  }
}

/**
 * Analyse les arguments de la coquille.
 *
 * Volontairement pauvre : une application de bureau se configure par son écran de
 * réglages, pas par une ligne de commande. Seuls `--dossier`, `--port` et `--reglages`
 * restent utiles au développement et aux tests.
 *
 * @param {string[]} argv
 * @returns {{port: number, dossier?: string, reglages?: string, devtools: boolean, aide: boolean}}
 */
export function parseArgs(argv = []) {
  const options = { ...DEFAUTS, aide: false };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--aide' || argument === '-h') {
      options.aide = true;
      continue;
    }
    if (argument === '--devtools') {
      options.devtools = true;
      continue;
    }
    if (argument === '--port') {
      const valeur = argv[i + 1];
      if (valeur === undefined || !/^\d+$/.test(valeur)) throw new TypeError('--port attend un entier');
      const nombre = Number(valeur);
      if (nombre > 65535) throw new RangeError('--port doit être <= 65535');
      options.port = nombre;
      i += 1;
      continue;
    }
    if (argument === '--dossier' || argument === '--reglages') {
      const valeur = argv[i + 1];
      if (valeur === undefined || valeur.startsWith('-')) throw new TypeError(`${argument} attend un chemin`);
      options[argument.slice(2)] = valeur;
      i += 1;
      continue;
    }
    throw new TypeError(`argument inconnu : ${argument}`);
  }
  return options;
}

/**
 * Options de `BrowserWindow`, en un seul endroit pour qu'aucune fenêtre secondaire ne
 * puisse être créée avec des réglages plus permissifs.
 *
 * @param {{preload?: string, icone?: string, plateforme?: string}} [options]
 * @returns {Record<string, unknown>}
 */
export function optionsFenetre({ preload, icone, plateforme = process.platform } = {}) {
  return {
    width: DIMENSIONS.largeur,
    height: DIMENSIONS.hauteur,
    minWidth: DIMENSIONS.largeurMini,
    minHeight: DIMENSIONS.hauteurMini,
    title: NOM_PRODUIT,
    // On affiche après `ready-to-show` : sans cela, l'utilisateur voit une fenêtre blanche
    // clignoter le temps que la page se charge.
    show: false,
    backgroundColor: '#F0FDFA',
    autoHideMenuBar: false,
    ...(icone ? { icon: icone } : {}),
    webPreferences: {
      ...(preload ? { preload } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  };
}

/**
 * Indique si une URL appartient à l'interface servie localement.
 *
 * Comparaison sur l'**origine** : le même port sur `localhost` et `127.0.0.1` est accepté,
 * tout le reste ne l'est pas.
 *
 * @param {string} cible
 * @param {string} base
 * @returns {boolean}
 */
export function estInterne(cible, base) {
  try {
    const a = new URL(cible);
    const b = new URL(base);
    const hotes = new Set([b.hostname, '127.0.0.1', 'localhost', '[::1]']);
    return a.protocol === b.protocol && a.port === b.port && hotes.has(a.hostname);
  } catch {
    return false;
  }
}

/**
 * Construit le modèle de menu natif (structure de données `Menu.buildFromTemplate`).
 *
 * Les actions sont **injectées** : le modèle ne connaît ni Electron ni le gestionnaire, ce
 * qui rend le menu vérifiable par un test qui n'a pas d'affichage.
 *
 * @param {{plateforme?: string, actions?: Record<string, () => unknown>}} [options]
 * @returns {object[]}
 */
export function construireMenu({ plateforme = process.platform, actions = {} } = {}) {
  const clic = (nom) => () => actions[nom]?.();
  const modele = [
    {
      label: 'Fichier',
      submenu: [
        {
          id: 'ouvrir-dossier',
          label: 'Ouvrir le dossier de téléchargements',
          accelerator: 'CmdOrCtrl+O',
          click: clic('ouvrirDossier'),
        },
        {
          id: 'ouvrir-navigateur',
          label: 'Ouvrir l’interface dans le navigateur',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: clic('ouvrirNavigateur'),
        },
        { type: 'separator' },
        plateforme === 'darwin'
          ? { role: 'close', label: 'Fermer la fenêtre' }
          : { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Recharger l’interface', accelerator: 'CmdOrCtrl+R' },
        { role: 'toggleDevTools', label: 'Outils de développement', accelerator: 'CmdOrCtrl+Shift+I' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Taille réelle' },
        { role: 'zoomIn', label: 'Agrandir' },
        { role: 'zoomOut', label: 'Réduire' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
      ],
    },
    {
      label: 'Aide',
      submenu: [{ id: 'apropos', label: `À propos de ${NOM_PRODUIT}`, click: clic('apropos') }],
    },
  ];
  // Sur macOS, le premier menu est occupé par l'application (quitter, services, masquer).
  if (plateforme === 'darwin') modele.unshift({ role: 'appMenu' });
  return modele;
}

/**
 * Démarre la coquille complète : serveur local, fenêtre, menu, arrêt propre.
 *
 * @param {{
 *   electron: {app: any, BrowserWindow: any, Menu: any, shell: any, dialog: any},
 *   demarrerServeur?: typeof startUiServer,
 *   dossier?: string,
 *   reglages?: unknown,
 *   argv?: string[],
 *   preload?: string,
 *   icone?: string,
 *   plateforme?: string,
 *   journal?: (ligne: string) => void,
 * }} options
 */
export async function demarrerCoquille({
  electron,
  demarrerServeur = startUiServer,
  dossier,
  reglages = null,
  argv = [],
  preload,
  icone,
  plateforme = process.platform,
  journal = () => {},
} = {}) {
  if (!electron?.app || !electron?.BrowserWindow) {
    throw new TypeError('demarrerCoquille attend le module Electron (app, BrowserWindow, Menu, shell, dialog)');
  }
  const options = parseArgs(argv);
  const { app, BrowserWindow, Menu, shell, dialog } = electron;

  await app.whenReady();

  // Port 0 : le système choisit un port libre. Une deuxième instance ne casse pas la
  // première, et l'interface n'est joignable que depuis la machine.
  const ui = await demarrerServeur({
    port: options.port,
    hote: '127.0.0.1',
    ...(dossier ? { dossier } : {}),
    ...(reglages ? { reglages } : {}),
  });
  const url = ui.url;
  journal(`interface servie sur ${url}`);

  const fenetre = new BrowserWindow(optionsFenetre({ preload, icone, plateforme }));
  const { webContents } = fenetre;

  /** Ouvre une cible dans le navigateur du système, jamais dans XDM. */
  const externe = (cible) => {
    try {
      const protocole = new URL(cible).protocol;
      // `file:`, `javascript:` et consorts n'ont rien à faire dans un navigateur externe.
      if (protocole === 'http:' || protocole === 'https:' || protocole === 'mailto:') {
        shell.openExternal(cible).catch(() => {});
      }
    } catch {
      /* URL illisible : rien à ouvrir. */
    }
  };

  webContents.setWindowOpenHandler(({ url: cible }) => {
    if (!estInterne(cible, url)) externe(cible);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (evenement, cible) => {
    if (!estInterne(cible, url)) {
      evenement.preventDefault();
      externe(cible);
    }
  });
  webContents.on('will-attach-webview', (evenement) => evenement.preventDefault());

  const dossierCourant = () => ui.manager.etat().dossier;

  const actions = {
    ouvrirDossier: async () => {
      const cible = dossierCourant();
      // Le dossier peut ne pas exister au premier lancement : le créer évite un dialogue
      // d'erreur pour un cas qui n'est pas une erreur.
      await mkdir(cible, { recursive: true }).catch(() => {});
      const erreur = await shell.openPath(cible);
      if (erreur) journal(`dossier non ouvert : ${erreur}`);
    },
    ouvrirNavigateur: () => shell.openExternal(url).catch(() => {}),
    apropos: () =>
      dialog.showMessageBox(fenetre, {
        type: 'info',
        title: `À propos de ${NOM_PRODUIT}`,
        message: `${NOM_PRODUIT} ${VERSION}`,
        detail:
          'Aspirateur de site et gestionnaire de téléchargements.\n'
          + 'Réimplémentation propre : aucune ressource ni aucun code d’IDM n’est utilisé.\n'
          + `Interface locale : ${url}`,
        buttons: ['Fermer'],
      }),
  };

  Menu.setApplicationMenu(Menu.buildFromTemplate(construireMenu({ plateforme, actions })));

  fenetre.once('ready-to-show', () => fenetre.show());
  if (options.devtools) webContents.openDevTools?.({ mode: 'detach' });
  await fenetre.loadURL(url);

  /** Arrêt propre : le serveur ne survit pas à la fenêtre. */
  const arreter = async () => {
    await ui.fermer?.();
  };

  app.on('window-all-closed', () => {
    if (plateforme !== 'darwin') app.quit();
  });
  app.on('will-quit', () => {
    void arreter();
  });

  return { fenetre, serveur: ui.serveur, manager: ui.manager, url, menu: construireMenu({ plateforme, actions }), actions, arreter, options };
}

/**
 * Texte d'aide de la coquille (utilisé par `desktop/main.js --aide`).
 */
export const USAGE = `usage : xdm-desktop [--dossier DIR] [--reglages FICHIER] [--port N] [--devtools]
  --dossier    dossier de destination des fichiers (défaut : réglages, sinon ./telechargements)
  --reglages   fichier de réglages JSON (défaut ~/.config/xdm/reglages.json)
  --port       port du serveur local (défaut 0 : port libre choisi par le système)
  --devtools   ouvrir les outils de développement au démarrage
  --aide, -h   afficher cette aide et sortir
`;
