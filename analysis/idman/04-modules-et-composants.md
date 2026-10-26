# 04 — Modules et composants de la suite IDM

> **Statut** : ✅ v1 · **Dernière revue** : 2026-10-26
> **Sources** : `EV-triage-modules` (39 noms de modules trouvés en chaînes),
> `EV-local-strings`, `EV-inspect-pe-imports`, `EV-triage-registry`.
> **Niveau** : les noms de fichiers sont **Observés** ; les rôles sont **Dérivés** du nom,
> des chaînes d'erreur et du contexte — aucun module externe n'a été analysé (ils ne sont
> pas dans le dépôt).

## 1. Pourquoi cette annexe compte

`IDMan.exe` n'est pas autonome : c'est un **orchestrateur** qui pilote des DLL et des
processus annexes. Comprendre le grabber oblige à savoir *qui* télécharge et *qui* parle
aux navigateurs. La colonne « preuve » indique ce qui est établi.

## 2. Inventaire

| Module | Rôle dérivé | Preuve | Priorité d'étude |
|---|---|---|---|
| `IDMan.exe` | application principale : UI, file, grabber, moteur | **la cible elle-même** | ✅ fait |
| `IDMNetMon.dll` / `IDMNetMon64.dll` / `IDMNetMonAA.dll` | **surveillance réseau** : capture des liens/vidéos (probablement via Winsock LSP — voir `sporder.dll` et `…Protocol_Catalog9\Catalog_Entries`) | chaînes (UTF-16) + clés registre LSP | **haute** (cœur de la capture de liens) |
| `idmnmcl.dll` | **client de messagerie native** : implémente `com.tonec.idm` côté IDM | chaîne `idmnmcl.dll` + clés `NativeMessagingHosts\com.tonec.idm` | **haute** |
| `idmmzcc*.xpi` (`mozilla_cc3@internetdownloadmanager.com.xpi`) | extension Mozilla (Firefox/Waterfox/PaleMoon) | chaînes (`%sextensions\mozilla_cc3@…xpi`) | moyenne |
| `idmcchandler2.dll` / `idmcchandler2_64.dll` | « cache handler » Chrome : lecture/écriture du cache navigateur (récupération de flux déjà lus) | nom + coexistence 32/64 | **haute** (extraction de vidéos) |
| `idmbrbtn.dll` / `idmbrbtn64.dll` / `idmbrbtnAA.dll` | bouton « télécharger avec IDM » greffé dans les navigateurs | nom + classe `CIDMButton` | moyenne |
| `IDMShellExt.dll` / `…64` / `…AA` | extension shell (menu contextuel Explorateur, icônes) | nom + `ShellIconOverlayIdentifiers` | basse |
| `IDMIECC.dll` / `IDMIECC64.dll` | intégration IE (couche « IECC ») | nom | basse (IE mort) |
| `IDMGetAll.dll` / `IDMGetAll64.dll` | « tout télécharger » depuis le navigateur | nom + dialogue 228 « Download All Links with IDM » | moyenne |
| `IDMVMPrs.dll` / `…64` / `…AA` | **analyseur de médias vidéo** (« VM Parser ») — détection des flux dans une page | nom + `H-06` | **haute** |
| `idmvs.dll`, `idmvconv.dll` | « video sniffer » / conversion | nom seul → `H-06` | à confirmer |
| `idmftype.dll`, `IDMFType64.dll` | classification des types de fichiers | nom + dialogue 294 « File types » | moyenne |
| `idmindex.dll` | indexation (recherche dans les téléchargements) | nom + `CMainDlgSearchBar` | basse |
| `idmmkb.dll`, `idmmbc.dll` | ? (clavier/hotkeys ? / « MBC » ?) | nom seul → `H-14` | basse |
| `idmfsa.dll` | ? (« FSA » = File System Access ?) | nom seul → `H-14` | basse |
| `idmupdt.exe`, `idmupdt2.exe` | mise à jour (« QuickUpdate ») | chaînes `QuickUpdate for IDM…`, dialogue 182 | basse (hors périmètre) |
| `IDMIntegrator64.exe`, `sIDMIntegrator64.exe` | intégration 64 bits (installation des ponts navigateurs) | chaînes | moyenne |
| `IDMGrHlp.exe`, `sIDMGrHlp.exe` | processus « grabber helper » (exploration hors UI ?) ou helper d'installation | nom ; **à élucider** → `H-15` | **haute** si c'est le worker de çonage |
| `IDMMsgHost.exe` | hôte de messages (native messaging côté stockage ?) | nom | moyenne |
| `idmBroker.exe` | courtier (élévation / IPC privilégié) | nom + `CContinueElevatedFSADlg` | moyenne |
| `IDMan1.dll`, `IDMan2.dll`, `IDM.dll` | bibliothèques internes / ressources ? | noms seulement | basse |
| `sporder.dll` | utilitaire Winsock **Service Provider Order** (réordonnancement des LSP) | chaîne + clés `WinSock2\Parameters` | **haute** (mécanisme d'interception) |

## 3. Architecture déduite (Dérivé, à valider)

```
Navigateur ──(extension/XPI ou BHO)──┐
                                     ├─► com.tonec.idm (messagerie native) ─► idmnmcl.dll
IDMNetMon.dll (LSP Winsock) ─────────┘                                        │
   capture des URL/streams                                                    ▼
                                                        IDMan.exe : file + grabber + moteur
IDMVMPrs.dll / idmvs.dll (analyse média) ─────────────────┘                   │
idmcchandler2.dll (cache vidéo navigateur) ───────────────────────────────────┘
                                                          │
                              IDMGrHlp.exe / idmBroker.exe (travail annexe, élévation)
                                                          │
                                               WS2_32 (sockets) + SChannel (TLS)
```

**Conséquences pour le clonage**

1. Nous n'avons **pas** besoin de reproduire l'architecture multi-processus d'IDM : un
   seul processus XDM + une extension navigateur suffit fonctionnellement.
2. L'interception **par LSP Winsock** est un mécanisme fragile et historiquement
   exploité comme vecteur d'abus : **ne pas la reproduire**. L'alternative moderne est
   l'API `chrome.downloads`/`webRequest` de l'extension + hôte de messagerie native.
3. Le module qui « voit » les vidéos (`IDMVMPrs`) est le vrai différenciateur : sa
   logique (heuristiques de détection) est hors de notre périmètre P0 mais mérite une
   hypothèse dédiée (`H-06`).

## 4. Ce que cette annexe ne prouve pas

- Aucun module externe n'est disponible : leurs rôles sont **dérivés des noms**.
- La présence d'une chaîne ne prouve pas que le module est chargé à l'exécution.
- `IDMGrHlp.exe` peut être un helper d'*installation* plutôt que d'exploration : c'est
  précisément ce que `H-15` doit trancher (via les arguments de ligne de commande et
  `CreateProcessA` observés en dynamique).
