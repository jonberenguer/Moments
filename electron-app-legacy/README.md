# electron-app-legacy

Frozen Electron implementation of Moments, retained for **reference** during the
Wails (Go) migration (branch `migrated-to-wails`). **Do not develop here** — the
active app is moving to Wails at the repo root.

## Contents
- `electron/main.js` — Electron main process (GPU detect, FFmpeg spawn, IPC, prefs,
  `media://` protocol, window/close handling). The behavioral spec the Go backend
  must reproduce.
- `electron/preload.js` — the `window.electronAPI` contextBridge surface (the exact
  API the Wails bindings + JS shim must match).
- `Dockerfile.electron` — the old Node 24 + Wine image for Electron/electron-builder
  builds.
- `WINDOWS_STABILITY_PLAN.md` — the v1.5.6 Windows work (close-freeze, per-user NSIS
  installer, path-based `media://` import). Root-cause notes still relevant to the
  port.

## Why kept
The migration reuses the React frontend (`src/`, `public/`) but **rewrites** this
main/preload layer in Go. Keeping it lets us diff behavior and re-validate parity
(esp. the FFmpeg export args and the preview↔export geometry) as we go. See
`../WAILS_MIGRATION_PLAN.md`.

> Note: `package.json` still points `main` + electron-builder `files` at
> `electron-app-legacy/electron/**` so the legacy app remains buildable for
> comparison. This will be removed once the Wails backend reaches parity.
