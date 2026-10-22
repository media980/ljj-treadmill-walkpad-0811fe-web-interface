Contenu du dossier à déployer en HTTPS (GitHub Pages, Netlify, etc.) :

  index.html       — l'application
  treadmill-core.js — protocole FitShow (chargé par index.html)
  manifest.json    — manifest PWA
  sw.js            — service worker (nécessaire pour l'installation)
  icon-192.png     — icône 192×192
  icon-512.png     — icône 512×512

Les 6 fichiers doivent être à la RACINE du dossier servi
(pas dans un sous-dossier, sinon les chemins relatifs ne fonctionnent pas).

Pour tester en local :
  python3 -m http.server 8000
  puis ouvrir http://localhost:8000/

Pour GitHub Pages :
  1. Créer un repo, uploader les 6 fichiers à la racine
  2. Settings > Pages > Source : main / root
  3. Attendre 1 min, ouvrir l'URL https://<vous>.github.io/<repo>/

Pour Netlify Drop :
  glisser-déposer le dossier entier sur https://app.netlify.com/drop
