Files to deploy over HTTPS (GitHub Pages, Netlify, etc.):

  index.html        - the app
  treadmill-core.js - FitShow protocol (loaded by index.html)
  manifest.json     - PWA manifest
  sw.js             - service worker (required for installation)
  icon-192.png      - 192x192 icon
  icon-512.png      - 512x512 icon

All 6 files must be at the ROOT of the served folder
(not in a subfolder, otherwise the relative paths break).

To test locally:
  python3 -m http.server 8000
  then open http://localhost:8000/

GitHub Pages:
  1. Create a repo, upload the 6 files to the root
  2. Settings > Pages > Source: main / root
  3. Wait 1 min, open https://<you>.github.io/<repo>/

Netlify Drop:
  drag and drop the whole folder onto https://app.netlify.com/drop
