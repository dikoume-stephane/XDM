# Porte G3 — parcours complet sur site local

> **Statut** : ✅ **franchie** — **Dernière revue** : 2026-10-28 (v1.0, `D-057`)
> **Définition (roadmap, §3)** : « parcours complet sur un site local (≥ 200 pages, fichiers
> de 1 Ko à 200 Mo, coupures réseau simulées) **sans perte ni doublon** ».
> **Banc** : `tools/gate-g3.mjs` · **Tests** : `test/gate-g3.test.js` (`T-G3`)
> **Reproduction** : `npm run gate -- --pages 200 --max 200M`

---

## 1. Pourquoi une porte, et pas un test de plus

Les 217 tests du dépôt vérifient des comportements **un par un** : un morceau, une reprise,
un cookie, une redirection. Aucun ne répond à la question qui décide de la sortie de la phase
P3 : *sur un site entier, avec un incident au milieu, retrouve-t-on exactement les fichiers du
serveur, une seule fois chacun ?*

La porte G3 est ce test-là, et elle a une propriété que les autres n'ont pas : **elle compare
octet par octet ce qui est sur le disque avec ce que le serveur a servi**. Tout le reste du
banc observe ce que le programme *croit* avoir fait (états, compteurs, rapport) ; une erreur
cohérente avec elle-même passerait inaperçue. Une empreinte SHA-256, non.

---

## 2. Ce que le banc construit

| Élément | Valeur | Pourquoi |
|---|---|---|
| Pages | 200 (profil de porte) / 24 (profil de test) | index + pages liées, profondeur 2 |
| Fichiers | autant que de pages, `1 Ko` → `200 Mo` | longue traîne de petits fichiers + **une** grosse ressource |
| Volume | 205,0 Mio au profil de porte | une progression géométrique sur 200 fichiers produirait 3 Go : inutile et infaisable en test |
| Contenu | déterministe, SHA-256 enchaîné depuis une graine | deux exécutions ⇒ mêmes octets, donc mêmes empreintes |
| Incident | la **première** requête de plage sur le plus gros fichier est coupée après 16 Kio | une vraie coupure de socket, pas un code HTTP d'erreur |
| Filtres | `--sans-exclusions --inclure '*'` | les pages sont exclues par défaut (`D-032`) ; sans cela, pas de miroir |

Le serveur de test **compte ses coupures** : si l'incident n'a pas eu lieu, le banc le dit
(`coupure réellement infligée`) au lieu de féliciter une exécution qui n'a rien prouvé.

---

## 3. Résultats mesurés

### Profil de porte — `node tools/gate-g3.mjs --pages 200 --max 200M`

```
aspiration de 200 page(s) et 200 fichier(s) (1.0 Kio → 200.0 Mio), coupure sur /f/200/fichier-200.bin
première passe : 401 terminé(s), 0 échec(s)
✅ coupure absorbée sans perte — la boucle a rouvert la plage au dernier octet écrit
✅ toutes les tâches terminées — 401/401 en DONE
✅ aucun doublon dans la file — 401 tâche(s), 401 URL distincte(s)
✅ fichiers identiques au serveur — 200 empreintes vérifiées
✅ aucun résidu de travail — aucun fichier temporaire
✅ rapport cohérent avec le disque — 401 tâche(s), 205.0 Mio annoncés (attendu 205.0 Mio)
✅ coupure réellement infligée — 1 coupure(s), 1105 requête(s)

Porte G3 : franchie — 200 fichier(s), 205.0 Mio, 1105 requête(s), 1 coupure(s), 1 passe(s)
```

Durée mesurée : **13,9 s** (murale, boucle locale, 4 connexions, profondeur 2). Profil de test
(24 pages, 2,1 Mio) : **0,6 s**, franchie également — c'est ce profil que rejoue `T-G3`.

### Ce que chaque contrôle exclut

| Contrôle | Ce qu'il exclut | Ce qu'il n'exclut pas |
|---|---|---|
| `toutes les tâches terminées` | une tâche silencieusement abandonnée | une tâche `DONE` sur un fichier faux |
| `aucun doublon dans la file` | deux téléchargements du même fichier | un doublon sur disque hors file |
| `fichiers identiques au serveur` | perte, troncature, corruption, mélange de contenus | un fichier servi faux par le serveur de test |
| `aucun résidu de travail` | `.xdm-part.json` / `.xdmwork` oubliés après promotion | —
| `rapport cohérent avec le disque` | un rapport qui compte des intentions | une erreur de calcul symétrique des deux côtés |
| `coupure réellement infligée` | un banc qui « réussit » sans incident | —

---

## 4. Deux défauts trouvés par la porte

**1. Une coupure de socket condamnait la tâche.** `pumpSegment` signalait déjà l'octet
atteint (`SEGMENT_FAILED` avec `resumeAt`), mais la boucle ne rattrapait que `IDLE_TIMEOUT` :
une coupure franche remontait jusqu'à la file, qui marquait la tâche `FAILED`. Mesure avant
correction : `48 terminé(s), 1 échec(s)` puis une passe de reprise pour arriver à `49/49`.
Correction (`D-057`) : `SEGMENT_FAILED` est traité **comme** `IDLE_TIMEOUT` — la plage est
rouverte au dernier octet écrit, dans la limite des tentatives du morceau. Mesure après :
`49/49` en **une** passe, sans reprise. La reprise de tâche reste couverte par `T-A-26` et
`T-B-21`, elle n'est simplement plus le chemin normal d'une coupure.

**2. Le banc lui-même s'est trompé, et a refusé de le cacher.** Le calcul des octets attendus
filtrait les pages sur l'extension `.html` — donc oubliait l'**index** (`/`, 217 octets).
Écart de 217 o sur 7,4 Mio : invisible à l'œil, refusé par la porte. C'est exactement le
comportement recherché : un banc qui arrondit ne mesure plus rien.

---

## 5. Limites déclarées

| Limite | Pourquoi | Ce qui la lèverait |
|---|---|---|
| Aucune latence, aucun DNS, aucune perte de paquets | serveur en boucle locale | un `tc netem` ou un proxy dégradant, hors sandbox |
| Un seul incident, sur un seul fichier | un scénario doit rester reproductible | un mode `--coupures N` (non implémenté) |
| Pas de gros fichier > 200 Mo | taille du profil de la porte, pas une limite du code | `--max 2G` (le découpage est déjà testé unitairement) |
| Pas de pages dynamiques ni de `POST` | l'aspirateur n'émet que des `GET` (dit dans la roadmap) | hors périmètre |
| Pas de comparaison avec IDM | exige la VM Windows (`A-09`, `WP-30`) | phase P5 |

---

## 6. Journal des révisions

| Date | Changement |
|---|---|
| 2026-10-28 | v1.0 : création (`D-057`) — banc `tools/gate-g3.mjs`, 5 tests `T-G3`, profils test et porte mesurés, deux défauts réels corrigés (coupure de socket ⇒ reprise interne ; calcul d'octets du banc) |
