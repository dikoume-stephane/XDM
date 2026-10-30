# Distribution — dépôt d'attente

Ce dossier reçoit les pièces de `docs/GUIDE-WINDOWS.md` §8 bis : ce qui transforme le paquet
`dist/xdm-<version>` en logiciel distribuable.

```
analysis/distribution/
├── manifeste.json   # copie de dist/xdm-0.1.0/manifeste.json
├── signature.txt    # sortie de Get-AuthenticodeSignature
├── empreinte.txt    # SHA-256 de l'installeur et de l'archive portable
├── icone.png        # capture d'écran : barre des tâches + menu Démarrer
└── notes.md         # chemin choisi, type de certificat, écarts
```

**Ce qui ne doit jamais arriver ici** : le certificat `.pfx`, son mot de passe, une clé privée.
Le dépôt est public ; un secret poussé une fois est un secret perdu. `D-089` décrit ce que le
paquet contient, et la signature ne change pas son contenu — elle change seulement qui répond
de son intégrité.
