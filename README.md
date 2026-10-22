# Contrail.io

A one-thumb jet game for the phone browser: grow your contrail, cut off the bots, barrel roll through trails, steal the bounty.

Play: https://contrail-io.netlify.app

## What's here
- `index.html`: the whole game (one file: HTML, CSS and JavaScript)
- `manifest.webmanifest`, `icons/`: make it installable as a phone app
- `sw.js`: offline support. Bump `VERSION` whenever `index.html` changes so phones pick up the update
- `_headers`, `netlify.toml`: Netlify settings (static site, no build step)

## Deploying
Netlify deploys the `main` branch automatically once the site is linked to this repo.
Add `#debug` to the URL to see the on-screen event log.
