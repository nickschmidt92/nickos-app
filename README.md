# nickos-app — front-end deploy target

Static front-end for NickOS, served by GitHub Pages at
<https://nickschmidt92.github.io/nickos-app/>.

**This repository is a deploy target, not the source of truth.**

- It contains only the six static files the browser needs. No Cloud Functions, no
  `firestore.rules`, no CI secrets, no backups, and **no NickOS records**.
- It was created 2026-08-11 with a single fresh commit, deliberately carrying **no git
  history**, so that the application can be served publicly while the main repository
  (`nickschmidt92/nickos`, private) keeps its history off the open internet.
- Files here are byte-identical to `nickschmidt92/nickos@ac7370b`. Verified by SHA-256 at
  publish time.

## Why it exists

GitHub Pages requires a public repository on the Free plan. The main NickOS repository had
to become private because its history contained a snapshot of personal records. Splitting
the deploy target from the source repository ends that exposure without taking the app
offline.

## What is safe to put here

Only files that are already public by necessity — the ones a browser downloads anyway. The
Firebase web API key in `firebase-config.js` is not a secret; access is controlled by
`firestore.rules` and by the Authorized Domains list in the Firebase console, both of which
live in the private repository.

**Never commit:** exported data, snapshots, backups, service-account keys, or anything from
`~/Developer/config/secrets/`.

## Updating

Copy the changed static files from the private repo at the commit you want to ship, commit,
push. Bump `CACHE_VERSION` in `service-worker.js` or browsers will keep serving the old
shell.

NickOS V2 will replace this deployment. See `nickos-v2` (private).
