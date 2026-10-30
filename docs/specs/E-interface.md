# Fiche E — Interface (application de bureau, serveur local, jeton)

> **Domaine** : E (interface) · **Lot** : `WP-60` · **Statut** : ✅ `clos` (les 14 exigences sont
> **vertes** : coquille Electron, serveur local, réglages, jeton, paquet, suspension, police
> embarquée) · **Dernière revue** : 2026-10-30
> **Preuves** : décisions `D-084`→`D-091` ; `src/manager.js`, `src/ui-server.js`,
> `src/desktop-shell.js`, `src/acces.js`, `src/reglages.js`, `src/aspiration.js`,
> `src/verification.js` ; maquette validée `docs/maquettes/interface-xdm-v2.html`.
> **Cible** : `IDMan.exe` SHA-256 `5f78da5a…2f11c9` — **mais** cette fiche ne décrit pas
> l'interface d'IDM : elle décrit celle de XDM.
> **Avertissement de périmètre** : aucune capture d'écran, aucune ressource et aucun libellé
> d'IDM n'est reproduit. L'interface de XDM est un **choix de produit** (`D-084`), pas une
> observation. C'est la seule fiche du projet où « conforme » veut dire « conforme à la
> décision », jamais « conforme à la cible ».

---

## 1. But fonctionnel (en une phrase)

Permettre à l'utilisateur de piloter les téléchargements, l'aspiration d'un site et la
vérification d'une copie locale depuis une **fenêtre de bureau**, sans jamais exposer la
machine au réseau par accident ni afficher un chiffre que le moteur ne peut pas justifier.

## 2. Périmètre

### 2.1 Dans le périmètre

| Sujet | Où |
|---|---|
| Fenêtre Electron, menu natif, cycle de vie | `src/desktop-shell.js`, `desktop/main.js` |
| Serveur local (HTTP + SSE), écoute, jeton | `src/ui-server.js`, `src/acces.js`, `bin/xdm-ui.js` |
| État, file, journal, historique, compteurs | `src/manager.js` |
| Écrans et interactions | `src/ui/index.html`, `src/ui/app.js`, `src/ui/style.css` |
| Réglages persistants | `src/reglages.js` |
| Aspiration et vérification pilotées par l'API | `src/aspiration.js`, `src/verification.js` |
| Paquet de distribution | `tools/empaqueter.mjs` |

### 2.2 Hors périmètre (et pourquoi)

| Sujet | Motif |
|---|---|
| Installeur signé, mises à jour automatiques | exige un certificat et une machine de distribution : `docs/GUIDE-WINDOWS.md` §8 |
| Lecture des cookies de navigateurs | `D-004` : jamais extraits, jamais exposés |
| Internationalisation | l'interface est en français ; aucune demande contraire |
| Thèmes autres que clair/sombre/système | trois suffisent, le troisième suit l'OS |

## 3. Exigences

| ID | Exigence (résumé) | Niveau | Preuve / décision | Tests |
|---|---|---|---|---|
| `EX-E-01` | Interface locale pilotée par un gestionnaire, écoute sur la boucle locale par défaut | **Décision** | `D-084` | `T-E-01`, `T-E-02` |
| `EX-E-02` | L'état affiché vient du moteur ; code de sortie `0`/`1` ; SSE, jamais de sondage | **Décision** | `D-084` | `T-E-03`, `T-E-04`, `T-E-15` |
| `EX-E-03` | Réglages validés puis persistés ; `robots` verrouillé ; vérification qui refuse au lieu de rassurer | **Décision** | `D-085`, `D-004` | `T-E-05`, `T-E-06`, `T-E-07`, `T-E-08` |
| `EX-E-04` | Fenêtre sans accès Node, navigation verrouillée, liens externes au navigateur système | **Décision** | `D-086` | `T-E-09` |
| `EX-E-05` | Menu natif adapté à la plateforme | **Décision** | `D-086` | `T-E-10` |
| `EX-E-06` | Serveur local éphémère lié à la vie de la fenêtre, instance unique | **Décision** | `D-086` | `T-E-11` |
| `EX-E-07` | Site Grabber à parité avec la CLI ; gabarit « médias seulement » non appliqué | **Décision** | `D-087` | `T-E-12`, `T-E-13`, `T-E-14`, `T-E-16` |
| `EX-E-08` | Jeton exigé hors boucle locale, comparaison à temps constant, cookie `HttpOnly` | **Décision** | `D-088` | `T-E-17`, `T-E-18`, `T-E-19` |
| `EX-E-09` | Paquet nommé, pesé, sans la cible ni les tests | **Décision** | `D-089` | `T-E-20` |
| `EX-E-10` | Suspendre n'est pas échouer ; reprise au bon octet ; progression vivante | **Décision** | `D-090` | `T-E-21`, `T-E-22` |
| `EX-E-11` | Aucune ressource distante ; journal et historique bornés ; charge mesurée | **Décision** | `D-091` | `T-E-23` |

**Règle de lecture** : ces 14 exigences sont toutes **Décision**. Aucune n'est *Observé*,
parce qu'aucune ne vient du binaire de la cible. La matrice `conformance.md` applique la même
règle : une exigence « Hypothèse » ne peut pas être verte.

## 4. Modèle de données

### 4.1 Tâche de téléchargement

| Champ | Type | Invariant |
|---|---|---|
| `id` | `T-<n>` | unique, jamais recyclé pendant la session |
| `url` | URL absolue | `http:`/`https:` seulement (`SCHEMA_REFUSE` sinon) |
| `nom`, `cible` | chaîne | le nom local ne collisionne pas dans le dossier (`nomLibre`) |
| `etat` | `attente` \| `en_cours` \| `suspendu` \| `termine` \| `echec` | voir §5 |
| `taille`, `fait` | entiers ou `null` | `fait ≤ taille` quand `taille` est connue |
| `vitesse` | entier (o/s) | remis à `0` hors `en_cours`, jamais négatif |
| `debut`, `fin` | horodatages | `fin === null` tant que la tâche n'est pas close |
| `codeSortie` | `0` \| `1` \| `null` | `0` succès, `1` échec, `null` avant la fin **et pour un suspendu** |
| `erreur` | `{message, code}` \| `null` | jamais rempli pour une suspension |

### 4.2 Aspiration

`{id, url, etat, phase, pages, retenus, taches, termines, echecs, dossier, codeSortie,
inclure[], exclure[], sousDomaines, paralleles, reecrire, reecrits}`.

Invariant : une aspiration écrit dans **son propre dossier** (`<dossier>/aspirations/<hôte>-<horodatage>`),
sinon deux aspirations écraseraient la même `queue.json` (`D-085`).

### 4.3 Réglages

`{version, dossier, connexions, maxActifs, theme, profondeur, maxPages, robots}` — `robots`
est **toujours** `true` : le champ se lit, ne s'écrit pas (`ROBOTS_VERROUILLE`, `D-004`).

### 4.4 Événement SSE

`{type, ...}` avec `type ∈ {etat, ajout, demarrage, progression, termine, echec, retrait,
suspendu, attente, journal, aspiration, reglages}`. Un événement `progression` est émis **au
plus toutes les 200 ms par tâche** : un affichage plus fin ne serait pas lisible et coûterait
des octets.

## 5. Machine à états d'une tâche

```text
attente --(demarrer / place disponible)--> en_cours
en_cours --(succès du moteur)--> termine          [codeSortie 0, historique]
en_cours --(erreur du moteur)--> echec            [codeSortie 1, historique]
en_cours --(suspendre)--> suspendu                [fichier .part conservé, pas d'historique]
en_cours --(retirer)--> refusé                    [TACHE_ACTIVE, 409]
attente  --(suspendre)--> suspendu
suspendu --(reprendre)--> attente                 [relance immédiate si une place existe]
suspendu --(retirer)--> (supprimée)               [les octets partiels restent sur disque]
termine|echec --(suspendre)--> refusé             [ETAT_INVALIDE, 400]
```

| État | Apparaît dans | Retirable | Suspendable | Reprenable |
|---|---|---|---|---|
| `attente` | Téléchargements, File d'attente | oui | oui | non |
| `en_cours` | Téléchargements | non | **oui** | non |
| `suspendu` | Téléchargements | oui | non | oui |
| `termine` / `echec` | Historique | non | non | non |

## 6. Interfaces externes

### 6.1 Routes HTTP (boucle locale, jeton si configuré)

| Méthode | Route | Rôle | Codes |
|---|---|---|---|
| `GET` | `/` et fichiers statiques | interface (`index.html`, `app.js`, `style.css`, `/polices/*.woff2`) | `200`, `403` hors racine, `401` si jeton |
| `GET` | `/api/etat` | instantané complet (compteurs, tâches, aspirations, historique) | `200` |
| `POST` | `/api/taches` | ajouter une URL à la file | `201`, `400` |
| `DELETE` | `/api/taches/:id` | retirer une tâche `attente` ou `suspendue` | `200`, `404`, `409` |
| `POST` | `/api/taches/:id/suspendre` | suspendre | `200`, `400`, `404` |
| `POST` | `/api/taches/:id/reprendre` | reprendre | `200`, `400`, `404` |
| `POST` | `/api/demarrer` | lancer la file | `202` |
| `GET`/`PATCH` | `/api/reglages` | lire / valider puis écrire les réglages | `200`, `400` |
| `GET`/`POST` | `/api/aspirations` | lister / lancer une aspiration | `200`, `202`, `400` |
| `POST` | `/api/verifications` | vérifier un dossier | `200`, `400`, `404`, `409` |
| `GET` | `/api/journal`, `/api/historique` | journaux bornés | `200` |
| `GET` | `/api/evenements` | flux SSE (instantané initial + événements) | `200` |

Règles transverses : méthode inattendue ⇒ `405` ; route inconnue ⇒ `404` ; corps de requête
> 64 Kio ⇒ `413` ; toute erreur métier porte un `code` stable.

### 6.2 Fenêtre Electron

| Élément | Comportement |
|---|---|
| `webPreferences` | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` |
| Liens / navigation | hors origine locale ⇒ navigateur système, fenêtre refusée ; `webview` interdite |
| Menu | Fichier (dossier, navigateur, quitter), Affichage (recharger, devtools, zoom, plein écran), Aide (à propos) ; macOS : menu applicatif en tête |
| Cycle de vie | serveur sur `127.0.0.1` port éphémère, fermé avec la fenêtre, instance unique |

### 6.3 Interfaces externes au sens réseau

Aucune. L'interface ne contacte **que** le serveur qu'elle-même a démarré : pas de CDN, pas de
fonte distante, pas de télémétrie (`EX-E-11`).

## 7. Cas d'erreur et dégradations

| Cas | Comportement attendu | Code / test |
|---|---|---|
| URL non `http(s)` | refus avant tout accès réseau | `SCHEMA_REFUSE`, `T-E-…` |
| Dossier de destination absent | créé avant le premier `.part` | `T-E-15` |
| Fichier de réglages cassé | refus explicite, sauf si tout est précisé en ligne de commande | `T-E-05` |
| Dossier à vérifier absent / sans `queue.json` | refus, jamais un rapport vide « conforme » | `DOSSIER_ABSENT`, `FILE_ABSENTE`, `T-E-07` |
| Motif de filtre vide | refusé, pas ignoré | `MOTIF_INVALIDE`, `T-E-12` |
| Port déjà pris | erreur au démarrage, pas de bascule silencieuse | `EADDRINUSE`, `T-E-02` |
| Jeton absent ou faux | page de connexion, API `401` + `WWW-Authenticate` | `T-E-18` |
| Suspension en cours de transfert | état `suspendu`, `.part` conservé, reprise exacte | `T-E-21`, `T-E-22` |
| Webview / navigation externe | refusée | `T-E-09` |
| Page réécrite plus courte | `queue.json` réaligné sur la taille écrite | `T-E-16` |

## 8. Écarts assumés

| Écart | Motif | Décision |
|---|---|---|
| Aucune interface d'IDM n'est reproduite | le projet ne copie ni ressources ni libellés | `D-006`, `D-041` |
| `robots.txt` non désactivable depuis l'interface | contrainte de produit | `D-004`, `D-085` |
| Jeton obligatoire hors boucle locale seulement | sur la boucle locale, la contrainte n'apporte rien | `D-088` |
| Écoute `0.0.0.0` possible mais annoncée | nécessaire aux aperçus distants | `D-084`, `D-088` |
| Pas d'installeur signé | certificat et machine de distribution absents | `D-089` |
| Ouverture réelle de la fenêtre non vérifiée ici | aucun affichage dans la sandbox | `D-086`, GUIDE-WINDOWS §2 |

## 9. Couverture des tests

`test/ui-server.test.js`, `test/ui-api.test.js`, `test/ui-cli.test.js`, `test/manager.test.js`,
`test/reglages.test.js`, `test/verification.test.js`, `test/aspiration.test.js`,
`test/desktop.test.js` (`T-E-09`→`T-E-11`), `test/acces.test.js`, `test/suspension.test.js`,
`test/charge.test.js`, `test/empaquetage.test.js` — identifiants `T-E-01`→`T-E-23`.

## 10. Ce que cette fiche ne prétend pas

- **Que l'interface d'IDM soit connue.** Aucune capture, aucun libellé, aucune ressource de
  l'éditeur n'a été lue pour écrire cette fiche.
- **Que la fenêtre s'ouvre.** Les tests injectent une doublure d'Electron ; l'ouverture réelle
  sera confirmée par `docs/GUIDE-WINDOWS.md` §2, sur une machine à écran.
- **Que l'accessibilité soit parfaite.** L'audit automatique (axe-core) donne 0 violation et
  3 vérifications incomplètes sur les écrans masqués, mais aucun lecteur d'écran réel n'a
  parcouru l'interface : c'est l'étape NVDA du guide Windows.
