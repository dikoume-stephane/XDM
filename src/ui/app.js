/**
 * Interface XDM — logique de l'écran.
 *
 * Trois principes, hérités des tests du reste du dépôt :
 *  1. **Aucune donnée inventée.** Tout ce qui s'affiche vient de `/api/*`. Un écran vide
 *     dit qu'il est vide, il ne montre pas de ligne de démonstration.
 *  2. **Aucun `innerHTML` avec une donnée distante.** Les noms de fichiers viennent du
 *     serveur, donc d'une URL : ils sont insérés en `textContent`, jamais interprétés.
 *  3. **Le flux, pas le sondage.** Les mises à jour arrivent par `EventSource` ;
 *     `/api/etat` ne sert qu'au premier rendu et aux actions ponctuelles.
 */

const $ = (selecteur) => document.querySelector(selecteur);

/** Crée un élément, avec attributs et enfants textuels. */
function el(tag, attributs = {}, enfants = []) {
  const noeud = document.createElement(tag);
  for (const [cle, valeur] of Object.entries(attributs)) {
    if (valeur === null || valeur === undefined || valeur === false) continue;
    if (cle === 'classe') noeud.className = valeur;
    else if (cle === 'texte') noeud.textContent = valeur;
    else noeud.setAttribute(cle, valeur === true ? '' : String(valeur));
  }
  for (const enfant of [].concat(enfants)) {
    if (enfant === null || enfant === undefined || enfant === false) continue;
    noeud.append(enfant instanceof Node ? enfant : document.createTextNode(String(enfant)));
  }
  return noeud;
}

/** Icône du sprite, décorative par défaut. */
function icone(nom, classe = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', classe);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${nom}`);
  svg.append(use);
  return svg;
}

const UNITES = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];

/** Taille lisible ; `—` quand elle est inconnue (`EX-B-15`). */
function octets(valeur) {
  if (!Number.isFinite(valeur) || valeur < 0) return '—';
  let reste = valeur;
  let unite = 0;
  while (reste >= 1024 && unite < UNITES.length - 1) {
    reste /= 1024;
    unite += 1;
  }
  const nombre = unite === 0 ? String(Math.round(reste)) : reste.toFixed(reste >= 10 ? 0 : 1).replace('.', ',');
  return `${nombre} ${UNITES[unite]}`;
}

function duree(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const secondes = Math.round(ms / 1000);
  if (secondes < 60) return `${secondes} s`;
  const minutes = Math.floor(secondes / 60);
  return `${minutes} min ${String(secondes % 60).padStart(2, '0')} s`;
}

const heure = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('fr-FR', { hour12: false });
};

const dateHeure = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
};

/** Pastille d'état : icône + mot, jamais la couleur seule. */
function pastille(etat) {
  const modeles = {
    attente: ['horloge', 'attente', 'En attente'],
    en_cours: ['download', 'actif', 'En cours'],
    termine: ['check', 'termine', 'Terminé'],
    echec: ['alerte', 'echec', 'Échec'],
  };
  const [icone_du_etat, classe, libelle] = modeles[etat] ?? ['info', 'attente', etat];
  const span = el('span', { classe: `etat ${classe}` }, [icone(icone_du_etat), libelle]);
  return span;
}

// ------------------------------------------------------------------ état local

const etat = {
  version: null,
  dossier: './telechargements',
  connexions: 4,
  maxActifs: 2,
  taches: [],
  journal: [],
  historique: [],
  flux: null,
};

function annoncer(message) {
  const zone = $('#annonce');
  if (zone) zone.textContent = message;
}

function afficherErreur(message) {
  const bandeau = $('#erreur');
  if (!bandeau) return;
  bandeau.hidden = !message;
  bandeau.textContent = message ?? '';
}

// ------------------------------------------------------------------ appels API

async function api(chemin, options = {}) {
  const reponse = await fetch(chemin, {
    headers: options.corps ? { 'content-type': 'application/json' } : undefined,
    ...options,
    body: options.corps ? JSON.stringify(options.corps) : undefined,
  });
  const charge = await reponse.json().catch(() => ({}));
  if (!reponse.ok) {
    const erreur = charge && charge.erreur ? charge.erreur : { message: `HTTP ${reponse.status}` };
    throw new Error(erreur.message ?? `HTTP ${reponse.status}`);
  }
  return charge;
}

async function chargerTout() {
  try {
    const instantane = await api('/api/etat');
    etat.version = instantane.version;
    etat.dossier = instantane.dossier;
    etat.connexions = instantane.connexions;
    etat.maxActifs = instantane.maxActifs;
    etat.taches = instantane.taches ?? [];
    etat.historique = instantane.historique ?? [];
    const journal = await api('/api/journal');
    etat.journal = (journal.entrees ?? []).slice().reverse();
    const historique = await api('/api/historique');
    etat.historique = historique.entrees ?? etat.historique;
    rendreTout();
    afficherErreur(null);
  } catch (erreur) {
    afficherErreur(`Impossible de joindre le serveur : ${erreur.message}`);
    const temoin = $('#temoin');
    if (temoin) {
      temoin.textContent = 'serveur injoignable';
      temoin.className = 'temoin';
    }
  }
}

// ------------------------------------------------------------------ rendu

function rendreTout() {
  rendreCompteurs();
  rendreTaches();
  rendreFile();
  rendreJournal();
  rendreHistorique();
  rendreReglages();
}

function rendreCompteurs() {
  const enAttente = etat.taches.filter((t) => t.etat === 'attente').length;
  const enCours = etat.taches.filter((t) => t.etat === 'en_cours').length;
  const debit = etat.taches.reduce((total, t) => total + (t.etat === 'en_cours' ? (t.vitesse ?? 0) : 0), 0);

  $('#compte-encours').textContent = String(enCours);
  $('#compte-encours').setAttribute('aria-label', `${enCours} en cours`);
  $('#compte-attente').textContent = String(enAttente);
  $('#compte-attente').setAttribute('aria-label', `${enAttente} en attente`);
  $('#compte-historique').textContent = String(etat.historique.length);
  $('#compte-historique').setAttribute('aria-label', `${etat.historique.length} terminé(s)`);

  $('#resume-tel').textContent =
    etat.taches.length === 0
      ? "Aucun transfert pour l'instant."
      : `${enCours} en cours, ${enAttente} en attente, ${octets(debit)}/s cumulés.`;
  $('#resume-file').textContent =
    enAttente === 0 ? 'Aucune tâche en attente.' : `${enAttente} tâche(s) en attente, exécutées dans l'ordre.`;
  $('#resume-hist').textContent =
    etat.historique.length === 0
      ? 'Aucun transfert terminé pour l\'instant.'
      : `${etat.historique.length} transfert(s) terminé(s) ou en échec dans cette session.`;

  $('#etat-debit').textContent = `${octets(debit)}/s`;
  $('#etat-compteurs').textContent = `${enCours} en cours · ${enAttente} en attente`;
  $('#nav-pied').replaceChildren(
    el('span', {}, [el('b', { texte: String(enCours) }), ' en cours · ', el('b', { texte: String(enAttente) }), ' en attente']),
    el('br'),
    el('span', { style: 'font-family:var(--mono)' , texte: etat.dossier }),
  );
  $('#dossier-affiche').textContent = etat.dossier;
}

function ligneTache(tache) {
  const nom = el('div', { classe: 'cellule-nom' }, [
    el('span', { classe: 'type', 'aria-hidden': 'true', texte: (tache.nom.split('.').pop() || 'DOC').slice(0, 3).toUpperCase() }),
    el('span', { classe: 'txt' }, [
      el('b', { texte: tache.nom }),
      el('span', { texte: tache.url }),
    ]),
  ]);

  const progression = el('div', { classe: 'cellule-progression' });
  if (tache.etat === 'en_cours' && Number.isFinite(tache.taille) && tache.taille > 0) {
    const pourcent = Math.min(100, Math.floor((tache.fait / tache.taille) * 100));
    progression.append(
      el('div', {
        classe: `jauge${pourcent >= 100 ? ' succes' : ''}`,
        role: 'progressbar',
        'aria-valuenow': String(pourcent),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': `Progression de ${tache.nom}`,
      }, [el('span', { style: `width:${pourcent}%` })]),
      el('span', { classe: 'pct', texte: `${pourcent} %` }),
    );
  } else if (tache.etat === 'en_cours') {
    progression.append(el('span', { classe: 'pct', texte: `${octets(tache.fait)} reçus` }));
  } else {
    progression.append(el('span', { classe: 'pct', texte: '—' }));
  }

  const actions = tache.etat === 'attente'
    ? el('button', {
        classe: 'btn-ico',
        type: 'button',
        'aria-label': `Retirer ${tache.nom} de la file`,
        'data-retirer': tache.id,
      }, [icone('croix', 'ico ico-sm')])
    : el('button', {
        classe: 'btn-ico',
        type: 'button',
        'aria-label': `Détail de ${tache.nom}`,
        'data-detail': tache.id,
      }, [icone('points', 'ico ico-sm')]);

  return el('tr', {}, [
    el('td', {}, [nom]),
    el('td', {}, [pastille(tache.etat)]),
    el('td', {}, [progression]),
    el('td', { classe: 'droite num', texte: octets(tache.taille) }),
    el('td', { classe: 'droite num', texte: tache.etat === 'en_cours' ? `${octets(tache.vitesse)}/s` : '—' }),
    el('td', {}, [actions]),
  ]);
}

function rendreTaches() {
  const corps = $('#liste-taches');
  corps.replaceChildren(...etat.taches.map(ligneTache));
  $('#vide-taches').hidden = etat.taches.length > 0;
}

function rendreFile() {
  const attente = etat.taches.filter((t) => t.etat === 'attente');
  const corps = $('#file-corps');
  corps.replaceChildren(
    ...attente.map((tache, index) =>
      el('tr', {}, [
        el('td', { classe: 'droite num', texte: String(index + 1) }),
        el('td', {}, [
          el('div', { classe: 'cellule-nom' }, [
            el('span', { classe: 'type', 'aria-hidden': 'true', texte: (tache.nom.split('.').pop() || 'DOC').slice(0, 3).toUpperCase() }),
            el('span', { classe: 'txt' }, [el('b', { texte: tache.nom }), el('span', { texte: tache.url })]),
          ]),
        ]),
        el('td', { classe: 'droite num', texte: octets(tache.taille) }),
        el('td', {}, [
          el('button', {
            classe: 'btn-ico',
            type: 'button',
            'aria-label': `Retirer ${tache.nom} de la file`,
            'data-retirer': tache.id,
          }, [icone('croix', 'ico ico-sm')]),
        ]),
      ]),
    ),
  );
  $('#vide-file').hidden = attente.length > 0;
}

function rendreJournal() {
  const flux = $('#journal-flux');
  flux.replaceChildren(
    ...etat.journal.slice(0, 200).map((entree) =>
      el('div', { classe: 'evenement' }, [
        el('span', { classe: 'heure', texte: heure(entree.date) }),
        el('span', { classe: 'source', texte: entree.source ?? 'xdm' }),
        el('span', { classe: 'message', texte: entree.message }),
        el('span', { classe: `niveau ${entree.niveau === 'succes' ? 'succes' : entree.niveau === 'erreur' ? 'erreur' : entree.niveau === 'attention' ? 'attention' : 'info'}` }, [
          icone(entree.niveau === 'succes' ? 'check' : entree.niveau === 'info' ? 'info' : 'alerte', 'ico ico-sm'),
          entree.niveau,
        ]),
      ]),
    ),
  );
  $('#vide-journal').hidden = etat.journal.length > 0;
}

function rendreHistorique() {
  const corps = $('#hist-corps');
  corps.replaceChildren(
    ...etat.historique.map((entree) =>
      el('tr', {}, [
        el('td', { classe: 'num', texte: dateHeure(entree.fin ?? entree.debut) }),
        el('td', {}, [
          el('div', { classe: 'cellule-nom' }, [
            el('span', { classe: 'type', 'aria-hidden': 'true', texte: (entree.nom.split('.').pop() || 'DOC').slice(0, 3).toUpperCase() }),
            el('span', { classe: 'txt' }, [el('b', { texte: entree.nom }), el('span', { texte: entree.url })]),
          ]),
        ]),
        el('td', { classe: 'droite num', texte: octets(entree.taille) }),
        el('td', { classe: 'droite num', texte: duree(entree.duree) }),
        el('td', {}, [pastille(entree.etat)]),
        el('td', { classe: 'droite num', texte: entree.codeSortie === null ? '—' : String(entree.codeSortie) }),
      ]),
    ),
  );
  $('#vide-historique').hidden = etat.historique.length > 0;
}

function rendreReglages() {
  $('#reg-dossier').textContent = etat.dossier;
  $('#reg-connexions').textContent = String(etat.connexions);
  $('#reg-actifs').textContent = String(etat.maxActifs);
  $('#reg-version').textContent = etat.version ?? '—';
  $('#version').textContent = etat.version ? `v${etat.version}` : 'interface';
}

// ------------------------------------------------------------------ navigation

function afficherEcran(nom) {
  for (const section of document.querySelectorAll('.ecran')) {
    const actif = section.id === `ecran-${nom}`;
    section.classList.toggle('actif', actif);
    if (actif) section.removeAttribute('hidden');
    else section.setAttribute('hidden', '');
  }
  for (const lien of document.querySelectorAll('.nav-lien[data-ecran]')) {
    if (lien.dataset.ecran === nom) lien.setAttribute('aria-current', 'page');
    else lien.removeAttribute('aria-current');
  }
  const titre = document.querySelector(`#ecran-${nom} h2`);
  $('#titre-fenetre').textContent = titre ? titre.textContent : 'XDM';
  document.title = `XDM — ${titre ? titre.textContent : 'interface'}`;
  $('#contenu-principal').focus({ preventScroll: true });
}

// ------------------------------------------------------------------ thème

const CLE_THEME = 'xdm.theme';

function appliquerTheme(choix) {
  const sombre = choix === 'sombre' || (choix === 'systeme' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (sombre) document.documentElement.setAttribute('data-theme', 'sombre');
  else document.documentElement.removeAttribute('data-theme');
  const bascule = $('#bascule-theme');
  if (bascule) {
    bascule.setAttribute('aria-pressed', sombre ? 'true' : 'false');
    bascule.querySelector('span').textContent = sombre ? 'Thème clair' : 'Thème sombre';
    bascule.querySelector('use').setAttribute('href', sombre ? '#i-soleil' : '#i-lune');
  }
  for (const bouton of document.querySelectorAll('[data-theme]')) {
    bouton.setAttribute('aria-pressed', bouton.dataset.theme === choix ? 'true' : 'false');
  }
  try {
    localStorage.setItem(CLE_THEME, choix);
  } catch {
    /* navigation privée : le choix ne survit pas, l'affichage reste correct */
  }
}

function themeCourant() {
  try {
    return localStorage.getItem(CLE_THEME) ?? 'systeme';
  } catch {
    return 'systeme';
  }
}

// ------------------------------------------------------------------ flux temps réel

function brancherFlux() {
  if (etat.flux) etat.flux.close();
  const source = new EventSource('/api/evenements');
  etat.flux = source;

  source.addEventListener('etat', (message) => {
    const instantane = JSON.parse(message.data);
    etat.version = instantane.version ?? etat.version;
    etat.dossier = instantane.dossier ?? etat.dossier;
    etat.connexions = instantane.connexions ?? etat.connexions;
    etat.maxActifs = instantane.maxActifs ?? etat.maxActifs;
    etat.taches = instantane.taches ?? etat.taches;
    rendreTout();
    const temoin = $('#temoin');
    temoin.replaceChildren(icone('check', 'ico'), ' serveur connecté');
    temoin.className = 'temoin';
    $('#etat-connexion').textContent = 'direct';
  });

  const surTache = (type) => (message) => {
    const evenement = JSON.parse(message.data);
    const tache = evenement.tache;
    const index = etat.taches.findIndex((t) => t.id === tache.id);
    if (type === 'ajout') {
      if (index < 0) etat.taches.push(tache);
      annoncer(`${tache.nom} ajouté à la file.`);
    } else if (type === 'retrait') {
      if (index >= 0) etat.taches.splice(index, 1);
      annoncer(`${tache.nom} retiré de la file.`);
    } else if (type === 'demarrage' || type === 'progression') {
      if (index >= 0) etat.taches[index] = tache;
      else etat.taches.push(tache);
    } else if (type === 'termine' || type === 'echec') {
      if (index >= 0) etat.taches.splice(index, 1);
      annoncer(`${tache.nom} ${type === 'termine' ? 'terminé' : 'en échec'}.`);
      api('/api/historique')
        .then((charge) => {
          etat.historique = charge.entrees ?? etat.historique;
          rendreHistorique();
          rendreCompteurs();
        })
        .catch(() => {});
    }
    rendreTout();
    $('#etat-derniere').textContent = `dernier événement ${heure(evenement.date)}`;
  };

  for (const type of ['ajout', 'demarrage', 'progression', 'termine', 'echec', 'retrait']) {
    source.addEventListener(type, surTache(type));
  }

  source.addEventListener('journal', (message) => {
    const evenement = JSON.parse(message.data);
    etat.journal.unshift(evenement.entree);
    if (etat.journal.length > 200) etat.journal.length = 200;
    rendreJournal();
  });

  source.addEventListener('error', () => {
    const temoin = $('#temoin');
    if (temoin) {
      temoin.replaceChildren(icone('alerte', 'ico'), ' reconnexion…');
      temoin.className = 'temoin';
    }
  });
}

// ------------------------------------------------------------------ actions

async function ajouterUrl(url) {
  afficherErreur(null);
  try {
    await api('/api/taches', { method: 'POST', corps: { url } });
    annoncer('URL ajoutée à la file.');
    $('#url').value = '';
  } catch (erreur) {
    afficherErreur(erreur.message);
  }
}

async function demarrerFile() {
  afficherErreur(null);
  try {
    await api('/api/demarrer', { method: 'POST' });
    annoncer('File démarrée.');
  } catch (erreur) {
    afficherErreur(erreur.message);
  }
}

async function retirerTache(id) {
  try {
    await api(`/api/taches/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (erreur) {
    afficherErreur(erreur.message);
  }
}

function exporterCsv() {
  const entetes = ['date', 'nom', 'url', 'etat', 'taille', 'duree_ms', 'code_sortie'];
  const lignes = [entetes.join(',')];
  for (const e of etat.historique) {
    const valeurs = [e.fin ?? '', e.nom, e.url, e.etat, e.taille ?? '', e.duree ?? '', e.codeSortie ?? ''];
    lignes.push(valeurs.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','));
  }
  const blob = new Blob([lignes.join('\n')], { type: 'text/csv;charset=utf-8' });
  const lien = el('a', { href: URL.createObjectURL(blob), download: 'historique-xdm.csv' });
  document.body.append(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(lien.href), 1000);
}

// ------------------------------------------------------------------ câblage

function cabler() {
  for (const lien of document.querySelectorAll('.nav-lien[data-ecran]')) {
    lien.addEventListener('click', () => afficherEcran(lien.dataset.ecran));
  }
  for (const bouton of document.querySelectorAll('[data-aller]')) {
    bouton.addEventListener('click', () => afficherEcran(bouton.dataset.aller));
  }

  $('#form-url').addEventListener('submit', (evenement) => {
    evenement.preventDefault();
    const valeur = $('#url').value.trim();
    if (valeur === '') {
      afficherErreur('URL requise.');
      $('#url').focus();
      return;
    }
    ajouterUrl(valeur);
  });

  $('#btn-demarrer').addEventListener('click', demarrerFile);
  $('#btn-demarrer-file').addEventListener('click', demarrerFile);
  $('#btn-focus-url').addEventListener('click', () => {
    afficherEcran('telechargements');
    $('#url').focus();
  });

  document.addEventListener('click', (evenement) => {
    const cible = evenement.target.closest('[data-retirer]');
    if (cible) retirerTache(cible.dataset.retirer);
  });

  $('#btn-copier-journal').addEventListener('click', async () => {
    const texte = etat.journal
      .slice()
      .reverse()
      .map((e) => `${e.date} ${e.niveau} ${e.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(texte);
      annoncer('Journal copié.');
    } catch {
      afficherErreur('Copie impossible dans ce contexte.');
    }
  });

  $('#btn-csv').addEventListener('click', exporterCsv);

  $('#bascule-theme').addEventListener('click', () => {
    appliquerTheme(document.documentElement.getAttribute('data-theme') === 'sombre' ? 'clair' : 'sombre');
  });
  for (const bouton of document.querySelectorAll('[data-theme]')) {
    bouton.addEventListener('click', () => appliquerTheme(bouton.dataset.theme));
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeCourant() === 'systeme') appliquerTheme('systeme');
  });
}

appliquerTheme(themeCourant());
cabler();
chargerTout().then(brancherFlux);
