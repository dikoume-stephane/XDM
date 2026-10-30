# Maquette v2 — application du skill `ui-ux-pro-max`

Ce document trace **comment** la maquette `docs/maquettes/interface-xdm-v2.html` a été produite :
skill utilisé, requêtes exécutées, décisions retenues, contrastes mesurés, vérifications passées,
et écarts assumés. Il répond aux mêmes exigences que le reste du dépôt : rien n'est affirmé sans
preuve exécutable.

## 1. Provenance du skill

| Élément | Valeur |
| --- | --- |
| Dépôt | `github.com/nextlevelbuilder/ui-ux-pro-max-skill` |
| Version | **2.15.0** (`skill.json`) |
| Commit inspecté | `28b3b8dee8c976df4fa3e94aed4e092ad43fcb03` (26 octobre 2026) |
| Licence | MIT |
| Copie locale | `git clone --depth 1 … /tmp/ui-ux-skill` — **hors dépôt, non persistée** |

Le clone n'est pas versionné : 30 Mio de références pour un livrable qui n'a besoin que des
règles citées ci-dessous. Pour rejouer l'analyse :

```bash
git clone --depth 1 https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git /tmp/ui-ux-skill
cd /tmp/ui-ux-skill
python3 .claude/skills/ui-ux-pro-max/scripts/search.py \
  "download manager desktop productivity tool" --design-system -p "XDM" -f markdown
```

## 2. Design system résolu

Sortie de `--design-system` (nouveau projet), conservée telle quelle :

* **Style** : Flat Design — pas d'ombre portée, pas de dégradé, survol par couleur ou opacité,
  transitions 150–200 ms, icônes minimales.
* **Couleurs** : `primary #0D9488`, `secondary #14B8A6`, `accent #EA580C`,
  `background #F0FDFA`, `foreground #134E4A`, `muted #E8F1F4`, `border #99F6E4`,
  `destructive #DC2626`, `ring #0D9488`.
* **Typographie** : Plus Jakarta Sans, graisses 300–700.
* **Anti-patrons à éviter** : onboarding complexe, sensation de lenteur.

Ce que la maquette en a fait :

1. Les couleurs sont devenues des **jetons sémantiques** (`--c-primaire`, `--c-surface`,
   `--c-texte-2`…) et non des hexadécimaux dispersés. Aucun composant n'écrit une couleur en dur.
2. Un **second jeu de jetons** définit le thème sombre ; le basculement ne change qu'un attribut
   `data-theme` sur `<html>`.
3. Le **teal de marque `#0D9488` ne sert jamais de couleur de texte** : mesuré à 3,74:1 sur blanc,
   il échoue au minimum de 4,5:1. Un jeton dédié `--c-primaire-texte` (`#0F766E`, 5,47:1) porte
   le texte et les icônes signifiantes ; le teal de marque reste pour les aplats et les boutons
   principaux (5,61:1 avec un texte noir).

## 3. Requêtes ciblées et ce qu'elles ont apporté

| Requête | Enseignement retenu |
| --- | --- |
| `--design-system "download manager desktop productivity tool"` | style, palette, police, anti-patrons (§2) |
| `--domain ux "data table row status list management"` | état de ligne porté par un libellé, pas une couleur seule |
| `--domain ux "empty state no data"` | message + action, jamais un écran vide ni « 0 résultat » |
| `--domain ux "keyboard focus visible"` | anneau visible sur tout élément interactif |
| `--domain ux "table pagination filter search"` | pagination annoncée (« 1–6 sur 128 »), « aucun résultat » avec suggestions |
| `--domain ux "progress long running task"` | progression chiffrée + estimation de temps restant |
| `--domain ux "no results"` | suggestions plutôt qu'un constat d'échec |
| `--domain icons "download arrow settings navigation list"` | jeu d'icônes nommées (download-simple, list, gear, arrow-left/right) |

`references/quick-reference.md` §1–§3 ont été lus avant livraison, comme le demande le workflow du
skill : accessibilité (CRITIQUE), toucher et interaction (CRITIQUE), performance (HAUTE).

## 4. Règles appliquées, et où

| Règle du skill | Application dans la maquette |
| --- | --- |
| `no-emoji-icons` | sprite SVG inline de 28 symboles en tête de fichier ; **zéro caractère emoji** dans le fichier (vérifié par script) |
| `icon-context` | icônes décoratives `aria-hidden="true"` ; boutons icône seule avec `aria-label` nommant l'élément (« Relancer rapport-annuel-2025 ») |
| `color-contrast` | 25 couples texte/fond mesurés, tous ≥ 4,5:1 (§5) |
| `focus-states` / `focus-appearance` | anneau `2px` + `outline-offset: 2px`, 3,59:1 sur le fond |
| `skip-links` | « Aller au contenu principal » en premier élément focusable |
| `heading-hierarchy` | un `h1` (titre de la maquette), `h2` par écran, `h3`/`h4` dans les cartes |
| `form-labels` | chaque champ a un `<label for>` ; aucun texte d'exemple tenant lieu de libellé |
| `error-feedback` | erreur de proxy : bordure, icône, message relié par `aria-describedby` + `aria-invalid` |
| `color-not-only` | états « En cours / En pause / Terminé / Échec » : icône + mot + teinte |
| `web-target-size` | boutons 36 px, liens de navigation 40 px, boutons icône 36 px — au-delà des 24 px exigés |
| `touch-target-size` | 44 px réservés aux commandes principales sur écran tactile (voir écart n° 2) |
| `cursor-pointer` | tout élément cliquable qui n'est pas un `<button>` (`cursor: pointer`) |
| `reduced-motion` | `prefers-reduced-motion` neutralise transitions et animations |
| `loading-buttons` | bouton principal désactivé pendant une opération (état `disabled` stylé) |
| `empty states` | File d'attente (« Rien de terminé dans la file ») et Historique (« Aucun résultat pour… ») avec message, cause et deux actions |
| `auto-rotation-controls` | défilement automatique du journal désactivable (`aria-pressed`) |
| `contextual-live-badge-updates` | `role="status" aria-live="polite"` pour les nouveaux événements, sans voler le focus |
| `dragging-alternative` | réordonnancement de la file par boutons « Monter / Descendre » nommés |
| `escape-routes` | assistant Site Grabber en trois étapes avec `aria-current="step"` |
| `image-dimension` / `font-loading` | aucune image distante ; pile système avec `font-display` implicite (voir écart n° 1) |
| `tableaux` | chaque tableau dans un conteneur `overflow-x: auto`, en-têtes `scope="col"`, `aria-sort` |
| `responsive` | points de rupture 860 / 900 / 980 / 1000 / 1240 px ; contenu lisible dès 375 px |

## 5. Contrastes mesurés (thème clair et sombre)

Calculés avec la formule WCAG 2 (luminance relative), pas à l'œil.

| Couple | Ratio | Verdict |
| --- | --- | --- |
| Texte principal `#134E4A` sur surface `#FFFFFF` | 9,48:1 | AAA |
| Texte secondaire `#475569` sur surface | 7,58:1 | AAA |
| Texte tertiaire `#5D6B7A` sur surface | 5,46:1 | AA |
| `--c-primaire-texte #0F766E` sur surface | 5,47:1 | AA |
| `--c-primaire-texte` sur fond `#F0FDFA` | 5,25:1 | AA |
| Noir sur bouton primaire `#0D9488` | 5,61:1 | AA |
| Bordure de contrôle `#0F766E` sur fond | 5,25:1 | AA |
| Anneau de focus `#0D9488` sur fond | 3,59:1 | AA (élément non textuel, seuil 3:1) |
| Succès `#146C34` sur `#E7F6EC` | 5,83:1 | AA |
| Attention `#B45309` sur `#FDF2E2` | 4,54:1 | AA |
| Danger `#C81E1E` sur `#FDECEC` | 5,02:1 | AA |
| Sombre : texte `#E6FFFA` sur surface `#0A2E2B` | 13,94:1 | AAA |
| Sombre : `#2DD4BF` sur surface | 7,84:1 | AAA |
| Sombre : danger `#F87171` sur `#3D1717` | 5,69:1 | AA |

Trois valeurs ont été corrigées à cause de ces mesures : `--c-succes` est passé de `#15803D`
(4,49:1, juste sous le seuil) à `#146C34`, `--c-danger` de `#DC2626` (4,23:1 sur son fond doux)
à `#C81E1E`, et le teal de texte a été séparé du teal de marque.

## 5 bis. De la maquette à l'application

La feuille de style de la maquette a été reprise **telle quelle** dans
`src/ui/style.css` : l'interface livrée par `xdm-ui` a donc exactement l'apparence validée.
Le balisage, lui, a été réécrit : les lignes de démonstration ont laissé la place à un rendu
piloté par `/api/*`, les données distantes passant par `textContent` (aucun `innerHTML`).
Quatre écrans sont câblés (Téléchargements, File d'attente, Journal, Historique) plus les
Réglages ; Site Grabber et Vérification ne sont pas dans la navigation tant que l'API ne
les expose pas (`D-084`).

## 6. Vérifications exécutées

Audit automatisé, `axe-core` + `jsdom`, jeu de règles WCAG 2.0/2.1/2.2 A et AA + bonnes pratiques :

```bash
npm i --no-save axe-core jsdom      # dépendances optionnelles, hors package.json
node tools/audit-a11y.mjs docs/maquettes/interface-xdm-v2.html
node tools/audit-a11y.mjs docs/maquettes/interface-xdm-v2.html --tous-les-ecrans
```

Résultats obtenus :

| Portée | Violations | Règles satisfaites |
| --- | --- | --- |
| Écran affiché par défaut | **0** | 46 |
| Les 7 écrans rendus visibles | **0** | 47 |

La règle `color-contrast` est désactivée dans l'audit : `jsdom` ne calcule pas la mise en page.
Le contraste est donc vérifié sur les jetons (§5), ce qui couvre tous les couples réellement
utilisés. Les deux points marqués « à vérifier à la main » (`landmark-one-main`,
`page-has-heading-one`) le sont parce que `jsdom` n'expose pas la sémantique de document complet :
le `<main>` et le `h1` existent bien dans le fichier.

Contrôles structurels complémentaires : 0 identifiant dupliqué, 0 `aria-labelledby`/`for`
orphelin, 0 `<use href>` sans symbole, balises équilibrées (`div` 172/172, `td` 148/148,
`button` 112/112, `svg` 112/112).

## 7. Écarts assumés

1. **Plus Jakarta Sans n'est pas embarquée.** La maquette est ouverte dans une iframe sans réseau :
   ni Google Fonts ni CDN. La pile de repli (`ui-sans-serif`, `system-ui`, Segoe UI, Roboto) donne
   des métriques proches mais pas identiques. *Correction prévue* : sous-ensemble WOFF2 embarqué en
   data URI (< 30 Ko) au moment du socle Electron, quand le budget de poids sera connu.
2. **Cibles à 36–40 px, pas 44 px.** Le skill demande 44 px (Apple) / 48 dp (Material) pour le
   tactile ; WCAG 2.2 AA n'exige que 24 px pour le pointage. Une application de bureau dense ne
   supporte pas 44 px sur chaque bouton de barre d'outils : la maquette reste à 36 px au pointeur
   et réserve 44 px aux actions principales sur écran tactile. Arbitrage documenté, réversible.
3. **Aucun test avec lecteur d'écran réel.** Les vérifications sont automatisées (axe + structure)
   et revues à la main. Ni NVDA ni VoiceOver ne sont disponibles dans la sandbox : la conformité
   annoncée est celle du balisage, pas celle de l'expérience annoncée.
4. **Pas de thème sombre système automatique.** Le basculement est manuel (bouton) ; le réglage
   `Système` existe dans l'écran Réglages mais n'est pas câblé, faute de `prefers-color-scheme`
   simulable dans l'aperçu statique.
5. **Le composant « menu » a perdu son rôle `menubar`.** Un `menubar` sans navigation par flèches
   est un motif ARIA incomplet : la barre de menus est devenue un `<nav>` avec des boutons (0
   violation au lieu de 2). Le vrai menu applicatif viendra avec Electron.
6. **Deux écrans sont des ajouts de produit, pas des sorties du skill.** « File d'attente » et
   « Historique » ont été demandés explicitement ; le skill ne les prescrit pas. Leur structure
   suit en revanche ses règles (tableau défilant, états vides, actions nommées).
7. **Le contenu est fictif, et le dit.** Aucune valeur affichée n'est produite par le code :
   la maquette ne prétend pas mesurer un système qui tourne. Les seules vérités de référence
   restent les CLI (`bin/xdm.js`, `bin/xdm-grab.js`, `bin/xdm-media.js`) et leurs 286 tests.
