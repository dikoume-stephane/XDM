# Fiche A — Moteur de téléchargement

> **Domaine** : A (moteur) · **Lot** : `WP-05` (`A-05`, première fiche) · **Statut** : `brouillon` avancé
> (19 exigences sur 19 au **vert**, socles `WP-20`/`WP-21` livrés, domaine **clos**)
> **Dernière revue** : 2026-10-27
> **Preuves** : annexe 14 v0.5 (moteur), annexe 13 v0.2 (filtres, hors périmètre ici),
> `chunks.json`, `io-model.json`, `states.json` ; décisions `D-024`→`D-031`, `D-034`→`D-039`.
> **Cible** : `IDMan.exe` SHA-256 `5f78da5a…2f11c9` — les offsets cités ne valent que
> pour cette version.
> **Règle** : une exigence sans preuve est **Hypothèse** ; une exigence **Observé** cite un
> offset ou un `EV-*`. Aucune ligne d'implémentation ne précède la validation de cette
> fiche (porte G1).

---

## 1. But fonctionnel (en une phrase)

Télécharger un fichier HTTP(S) en plusieurs morceaux simultanés, pouvoir l'**interrompre
et le reprendre** sans perdre le travail déjà fait, et livrer un fichier final dont
l'intégrité est vérifiable.

## 2. Exigences

| ID | Exigence | Niveau | Preuve | Test prévu |
|---|---|---|---|---|
| `EX-A-01` | Un téléchargement s'ouvre sur **un seul fichier de travail** préalloué, écrit à l'offset par chaque connexion | **Observé** (aligné sur IDM) | annexe 14 §5.2, §7 ; `CreateFileW` `0x156d48` | `T-A-01` : deux écritures concurrentes à des offsets disjoints produisent le fichier attendu |
| `EX-A-02` | L'état de reprise est persisté dans `<cible>.xdm-part.json`, jamais dans le registre | **Décision** | `D-024` | `T-A-02` : reprise après `kill -9` |
| `EX-A-03` | La carte de morceaux est une **liste de bornes** `{id, startOffset, nextId, completed}`, sans champ de fin explicite | **Observé** + **Décision** | annexe 14 §5.1 ; `D-030`, `D-035` | `T-A-03` : la fin d'un morceau = `startOffset` du suivant |
| `EX-A-04` | Une carte non monotone, cyclique, ou dont un `nextId` est orphelin est **rejetée** au chargement | **Dérivé** | `D-030` | `T-A-04` : trois cartes corrompues → rejet explicite |
| `EX-A-05` | La progression affichée est **recalculée** depuis la carte, jamais persistée | **Dérivé** | `D-031` | `T-A-05` : progression identique avant/après reprise |
| `EX-A-06` | Taille de morceau = `clamp(1 MiB, 10 MiB, f(taille))`, avec les paliers 2 MiB (≤ 512 Mio) et 10 MiB (au-delà) | **Observé** + **Décision** | annexe 14 §5.4 ; `chunks.json` ; `D-029` | `T-A-06` : encadrement sur 1 Kio, 1 Gio, 100 Gio |
| `EX-A-07` | Le nombre de téléchargements actifs est plafonné par la configuration (défaut **8**) et la file suit l'ordre d'arrivée ; une place ne s'ouvre qu'après libération | **Observé** + **Décision** | annexe 14 §6 ; `0x0fbe17` ; `D-036` | `T-A-07` ✅ : 12 tâches → 8 actives, la 9ᵉ au premier `DONE` |
| `EX-A-08` | Chaque connexion émet `Range: bytes=<début>-<fin>` ; l'absence de `Accept-Ranges` ou une réponse `200` (au lieu de `206`) ⇒ **une seule connexion** | **Observé** | annexe 14 §8 ; `D-038` | `T-A-08` ✅ : serveur sans plage → 1 connexion, plages → 8 au plus |
| `EX-A-09` | Le rollback tronque le fichier de travail au dernier offset confirmé (`ftruncate`) et **rouvre la zone perdue en morceau de reprise** | **Observé** (troncature) + **Décision** (réouverture) | annexe 14 §5.3 (`SetFilePointer` `0x15fee5`, `SetEndOfFile` `0x15ff52`, compteur `0x15ff9b`) ; `D-035` | `T-A-09` ✅ : coupure en cours de morceau → reprise à l'offset confirmé (1 216), zone perdue redemandée, fichier final exact |
| `EX-A-10` | Deux contenus divergents entre connexions ⇒ détection (empreinte SHA-256 par fenêtre de recouvrement) puis **repli à une connexion** | **Observé** (phénomène) + **Décision** (mécanisme) | annexe 14 §5.5 ; `D-025`, `D-039` | `T-A-10` ✅ : flux divergents injectés → repli, fichier issu d'une seule vue |
| `EX-A-11` | Un morceau incomplet n'est **jamais** marqué terminé ni copié dans le fichier final | **Observé** | annexe 14 §7 (`isCmpleted = 0`) | `T-A-11` ✅ |
| `EX-A-12` | Le fichier final n'est promu qu'après vérification de la carte et de la taille attendue ; la promotion est un `rename` atomique et supprime la carte | **Observé** + **Décision** | annexe 14 §7 ; `D-026`, `D-036` | `T-A-12` ✅ : carte incomplète ou taille incohérente ⇒ rien n'est livré ni supprimé |
| `EX-A-13` | Un seul réacteur d'E/S par session, plafond de **128 sockets**, délai `select` ≤ **12 000 ms** | **Observé** + **Décision** | annexe 14 §4.4 ; `io-model.json` ; `D-028`, `D-039` | `T-A-13` ✅ : 500 connexions demandées sur 200 morceaux → **128** travailleurs au plus |
| `EX-A-18` | Inactivité d'une connexion **> 30 s** ⇒ la connexion est redémarrée (nouvelle `Range` au dernier offset confirmé), pas le téléchargement | **Observé** | annexe 14 §4.5 (`cmp eax, 0x1e` en `0x1a139f`, `0x18adad`) ; `D-038` | `T-A-25` ✅ : flux muet ⇒ `IDLE_TIMEOUT` avec `resumeAt` = dernier octet confirmé |
| `EX-A-19` | Une tentative de reprise ne repart **jamais** de zéro tant que la carte est valide | **Observé** + **Décision** | annexe 14 §4.5, §5.3 ; `D-030` | `T-A-26` : 3 redémarrages successifs, progression strictement croissante |
| `EX-A-14` | Le nom final est déduit de l'URL, et seule la **dernière composante** assainie est conservée (≤ 200 octets, noms réservés neutralisés) | **Observé** (déduction du nom) + **Décision** | annexe 14 §3 (`GetDefaultlocalName`) ; `D-037` | `T-A-14` ✅ : `../../etc/passwd` → `passwd`, `CON.txt` → `_CON.txt` |
| `EX-A-15` | Toute redirection (`Location:`) est résolue en URL absolue (RFC 3986), avec limite de 10 redirections et URL ≤ 10 239 octets | **Observé** | annexe 14 §8.1 (`InternetCombineUrlA`, `cmp ecx, 0x27ff`) ; `D-038` | `T-A-15` ✅ : chaîne de 11 redirections → abandon explicite, URL longue rejetée avant réseau |
| `EX-A-16` | Compression désactivée pour les transferts par morceaux (`Accept-Encoding: identity`) | **Observé** | annexe 14 §8 ; `D-038` | `T-A-16` ✅ : l'en-tête part sur la sonde **et** sur chaque segment |
| `EX-A-17` | Aucune télémétrie, aucun appel réseau hors du téléchargement demandé | **Décision** | `D-004`, `D-012`, `D-038` | `T-A-17` ✅ : une seule connexion ouverte, jamais deux en parallèle |

## 3. Modèle de données

### 3.1 Fichier annexe `<cible>.xdm-part.json`

```json
{
  "version": 1,
  "url": "https://exemple.test/fichier.bin",
  "target": "fichier.bin",
  "totalSize": 10485760,
  "chunkSize": 2097152,
  "created": "2026-10-27T10:00:00Z",
  "chunks": [
    { "id": 1, "start": 0,       "next": 2, "completed": true  },
    { "id": 2, "start": 2097152, "next": 3, "completed": false }
  ]
}
```

| Champ | Type | Rôle | Preuve |
|---|---|---|---|
| `version` | entier | format du fichier, permet une migration | **Décision** |
| `url`, `target` | chaîne | identification du téléchargement | annexe 14 §3, §5.1 |
| `totalSize` | int64 | taille attendue ; `-1` si inconnue | annexe 14 §5.1 (`FileSize`) |
| `chunkSize` | int64 | taille cible choisie (`EX-A-06`) | annexe 14 §5.4 |
| `chunks[].id` | entier > 0 | identité stable, unique | annexe 14 §5.1 (`ID`) |
| `chunks[].start` | int64 | borne basse **inclusive** | annexe 14 §5.1 (`startPos`) |
| `chunks[].next` | entier > 0 | `id` du morceau suivant ; `0` = dernier | annexe 14 §5.1 (`nextID`) |
| `chunks[].completed` | booléen | morceau clos et vérifié | annexe 14 §5 (`isCompl`) |

**Invariants** (vérifiés au chargement) :

1. `chunks` non vide ; `start` strictement croissants selon le chaînage ;
2. dernier maillon : `next == 0` ; tous les `next` référencent un `id` existant ;
3. `chunk[i].start < totalSize` ; `totalSize <= 0` ⇒ carte refusée (taille inconnue =
   pas de découpage) ;
4. un seul morceau peut porter `completed == false` **par connexion active** ;
5. aucune écriture hors de `[0, totalSize)` ;
6. un rollback n'avance jamais le `start` d'un morceau sans insérer de morceau de reprise
   (sinon le prédécesseur clos annoncerait des octets absents — `D-035`).

### 3.2 Fichiers sur disque

| Fichier | Rôle | Cycle de vie |
|---|---|---|
| `<cible>.xdm-part` | données, préalloué à `totalSize` | supprimé après promotion |
| `<cible>.xdm-part.json` | carte | supprimé après promotion |
| `<cible>` | livrable | créé par `rename` atomique depuis `<cible>.xdm-part` |

**Inconnu** : le format binaire d'un enregistrement `ChList` d'IDM (annexe 14 §11) — sans
intérêt pour XDM, qui n'importe pas d'état IDM (`D-024`).

## 4. Machine à états

### 4.1 Par téléchargement

```text
PENDING --(start)--> ACTIVE --(tous morceaux completed)--> VERIFYING --(taille OK)--> DONE
   ^                    |                                        |
   |                    +--(erreur fatale)--> FAILED <-----------+
   +----- (reprise manuelle) ------------------------------------ +
ACTIVE --(pause)--> PAUSED --(start)--> ACTIVE        [carte intacte]
```

| État | Entrées permises | Sorties | Effets persistants |
|---|---|---|---|
| `PENDING` | `start`, suppression | `ACTIVE` | création de la carte |
| `ACTIVE` | pause, annulation, reprise partielle | `PAUSED`, `FAILED`, `VERIFYING` | mise à jour de la carte **et** des données |
| `PAUSED` | `start` | `ACTIVE` | aucun (carte déjà à jour) |
| `VERIFYING` | — | `DONE`, `FAILED` | promotion du fichier, suppression de la carte |
| `DONE` | suppression | — | aucun |
| `FAILED` | reprise, suppression | `ACTIVE` | carte conservée, raison inscrite |

### 4.2 Par connexion (5 états, contre 39 chez IDM — `D-027`)

```text
CONNECT --(socket prêt)--> HEADERS --(206 attendu)--> DATA --(morceau plein)--> DONE
   |                          |                        |
   +-------(échec)------------+------------------------+--> ERROR --(retry)--> CONNECT
```

| État | Garde d'entrée | Effet |
|---|---|---|
| `CONNECT` | une place libre et un morceau libre | ouverture socket, proxy éventuel |
| `HEADERS` | socket connecté | `Range` émis, en-têtes lus, statut vérifié |
| `DATA` | statut `206` (ou `200` si une seule connexion) | écritures `pwrite` à l'offset courant |
| `DONE` | octets reçus = taille du morceau | morceau marqué `completed` |
| `ERROR` | toute erreur | rollback (`EX-A-09`), 3 tentatives, backoff 1-2-4 s |

## 5. Interfaces externes

| Interface | Sens | Format | Remarques |
|---|---|---|---|
| HTTP(S) | sortant | `GET` + `Range: bytes=a-b` | `Accept-Encoding: identity` (`EX-A-16`), redirections ≤ 10 (`EX-A-15`) |
| Proxy HTTP | sortant | `CONNECT host:port` pour TLS | observé chez IDM (`HttpsProxyConnect`) ; authentification `Basic`/`Digest` |
| Système de fichiers | écriture | `pwrite`, `ftruncate`, `rename` | pas de `O_APPEND` : écriture positionnée obligatoire |
| Fichier annexe | lecture/écriture | JSON UTF-8 | écriture temporaire + `rename` (atomique) |
| Journal | écriture | texte | aucune donnée personnelle, URL tronquée |

## 6. Cas d'erreur et dégradations

| Cas | Comportement attendu | Preuve | Test |
|---|---|---|---|
| réseau coupé | `ERROR` sur la connexion ; les autres continuent ; reprise avec `Range` = offset courant | annexe 14 §5.3 | `T-A-20` |
| `429` / `503` | backoff 1-2-4 s, 3 tentatives, puis échec de la connexion (pas du téléchargement) | **Hypothèse** (valeurs) | `T-A-21` |
| `416` (plage insatisfiable) | morceau recalculé depuis la taille réelle ; si la taille a changé ⇒ cartes invalidée, reprise de zéro après confirmation | annexe 14 §8 | `T-A-22` |
| disque plein | arrêt propre, aucun fichier partiel promu | annexe 14 §7 (`Not enough disk space…`) | `T-A-23` |
| contenu divergent entre connexions | repli à 1 connexion + journal (`EX-A-10`) | annexe 14 §5.5 | `T-A-10` |
| redirection en boucle | abandon à la 10ᵉ, message explicite | annexe 14 §8.1 | `T-A-15` |
| carte corrompue | rejet, reprise de zéro **après confirmation** | `D-030` | `T-A-04` |
| coupure pendant la promotion | `rename` atomique : soit l'ancien, soit le nouveau, jamais un mélange | **Décision** | `T-A-24` |

## 7. Écarts assumés avec IDM

| Écart | Motif | Décision |
|---|---|---|
| pas de RTMP/MMS/RTMPT | protocoles propriétaires/obsolètes, hors périmètre P0 | annexe 02, `D-007` |
| pas de registre | portabilité (Linux/macOS) | `D-024`, `D-033` |
| empreinte SHA-256 au lieu de la comparaison octet à octet | même garantie, coût mémoire constant, testable | `D-025` |
| pas d'assemblage `JoinFile` | fichier unique écrit en place | `D-026` |
| 5 états de connexion au lieu de 39 | les états 17..27 d'IDM sont MMS/RTMP | `D-027` |
| pas de reprise d'un état IDM existant | aucun besoin exprimé, format binaire inconnu | `D-024` |

## 8. Questions ouvertes

| ID | Question | Bloque | Qui/quoi peut trancher |
|---|---|---|---|
| `Q-A-01` | ~~Le plancher de 1 MiB est-il aussi la taille minimale de morceau ?~~ **Résolue** : oui, aucune constante de morceau plus petite n'existe dans le bloc `ChunksList` (annexe 14 §5.4) | — | — |
| `Q-A-02` | **Valeur par défaut** du réglage `mAttempts` (nombre de reprises d'une connexion) | non | lecture de l'initialisation des réglages autour de `0x399a5` ; à défaut, XDM retient 3 |
| `Q-A-03` | Comportement exact quand `Content-Length` est absent et que le serveur ignore `Range` | non | banc d'essai `T-A-08` |
| `Q-A-04` | Politique de reprise sur `ETag`/`Last-Modified` changés entre deux sessions | non | `If-Range` observé chez IDM (annexe 14 §8) |

## 9. Journal des révisions

| Date | Auteur | Changement |
|---|---|---|
| 2026-10-27 | boucle de connexions `WP-22` | v0.6 : `src/connection-loop.js` + `src/divergence.js` (`D-039`) — distribution des morceaux, reprise à l'offset confirmé, repli sur divergence, plafond 128 sockets ; **domaine A clos (19/19)**, **73 tests** |
| 2026-10-27 | client HTTP `WP-21` | v0.5 : `D-038` — sonde `bytes=0-0`, `identity`, 10 redirections bornées, inactivité 30 s avec offset de reprise ; `EX-A-08`, `EX-A-15`→`EX-A-18` vertes ; **61 tests** |
| 2026-10-27 | socle `WP-20` | v0.4 : file de tâches (`D-036`) et assainissement du nom (`D-037`) écrits et testés ; `EX-A-07`, `EX-A-11`, `EX-A-12`, `EX-A-14` passent **vert** — **50 tests** au total |
| 2026-10-27 | socle `WP-20` | v0.3 : `EX-A-09` précisée (réouverture de la zone perdue, `D-035`), invariant 6 ajouté ; **24 tests de spécification verts** (`npm test`) sur les exigences `EX-A-01`→`EX-A-07`, `EX-A-09`, `EX-A-19` |
| 2026-10-27 | analyse statique | v0.2 : `A-13` complétée — `EX-A-18` (inactivité 30 s ⇒ reconnexion), `EX-A-19` (reprise sans perte), `Q-A-02` restreinte à la valeur de `mAttempts` |
| 2026-10-27 | analyse statique | création (brouillon) : 17 exigences, modèle de données, machine à états, 8 cas d'erreur, 6 écarts, 4 questions ouvertes — dérivée des annexes 13 et 14, sans nouvelle rétro-ingénierie |
