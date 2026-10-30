# Captures dynamiques — dépôt d'attente

Ce dossier reçoit ce qui **ne peut pas** être produit dans l'environnement d'analyse : un
conteneur Linux sans écran, sans VM Windows et sans IDM exécutable. Le mode opératoire est
`docs/GUIDE-WINDOWS.md` §3 à §6 ; ce fichier ne fait que nommer les sous-dossiers attendus.

```
analysis/dynamique/
├── wp30/    # WP-30  : deux arborescences (IDM, XDM) + rapport.txt + reglages-idm.md
├── wp40/    # WP-40  : procmon-idman.csv, hook-wininet.js, *.pcapng
├── wp41/    # WP-41  : une fiche H-06.md … H-16.md par hypothèse
├── wp42/    # WP-42  : mesures.csv (7 scénarios × 3 répétitions)
└── accessibilite.md   # §2 : parcours NVDA, 5 lignes
```

Règles de dépôt, sans exception :

1. **Aucun cookie, aucun jeton, aucun binaire d'IDM.** Une capture qui en contient une est
   refusée telle quelle (`D-004`) ; refaites-la filtrée sur le site témoin local.
2. **Rien n'est accepté sans son fichier d'origine** : un `rapport.txt` sans les deux
   arborescences n'est pas une preuve, c'est une affirmation.
3. **Les fichiers sont nommés d'après la section du guide** qui les produit, pour que la
   relecture retrouve la commande exacte.
