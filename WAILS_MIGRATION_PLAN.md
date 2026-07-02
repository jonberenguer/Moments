# Wails (Go) Migration — Plan & Milestone Tracker

> **Branch:** `migrated-to-wails` (off `main` @ v1.5.6). Living doc — update the
> status boxes as milestones land. Companion to the frozen Electron app in
> `electron-app-legacy/`.
>
> **Ground rules:** all conversion work (Go, `wails` CLI, npm, builds) runs in
> **Docker**, never on the host. Old Electron artifacts live under
> `electron-app-legacy/`; the repo root is Wails-focused.

## Goal
Replace the Electron shell (bundled Chromium + Node main process) with **Wails v2**
(Go backend + OS-native webview), **reusing the React/Vite frontend**. Wins: far
smaller binary, lower RAM, native subprocess/file streaming (kills the base64
round-trips). The frontend is ~80% reusable; the `electron/main.js` + `preload.js`
layer is a **Go rewrite**.

## Architecture decisions
- **Keep FFmpeg argument-building in JS** (`src/hooks/useFFmpeg.js`). Go is a *thin
  exec layer* that resolves the same tokens (`__ENCODER__` / `__ENC_ARGS__` /
  `__ENC_ARGS_HQ__`), spawns FFmpeg, streams logs + progress, and owns the temp-dir
  lifecycle. Porting the filter-graph logic to Go is explicitly out of scope (highest
  regression risk, ~zero benefit).
- **Compatibility shim:** expose `window.electronAPI` in the frontend backed by Wails
  Go bindings + events, so existing call sites change minimally. (See the surface in
  `electron-app-legacy/electron/preload.js`.)
- **`media://` → Wails AssetServer.** Serve clips off disk via a custom
  `http.Handler` using `http.ServeContent` (native HTTP Range → `<video>` seeking).
- **Drag-drop paths:** Wails `OnFileDrop` gives real absolute paths (replaces
  `webUtils.getPathForFile`).

## ⚠️ Top risks (validate in M0 before committing further)
1. **Webview engine change (HIGHEST):** Electron = Blink everywhere. Wails =
   **WebView2** (Chromium) on Windows but **WebKitGTK** on Linux. The caption
   wrap/baseline (`src/textLayout.js`, canvas `measureText`) and Phase-A transform
   geometry were **calibrated against Blink** — they must be re-validated on
   WebKitGTK or the Linux preview↔export parity can drift.
2. **`media://` Range streaming** must work on *both* WebView2 and WebKitGTK.
3. `-webkit-app-region: drag` (titlebar) is Electron-specific → Wails draggable
   mechanism instead.
4. **Packaging parity** — re-do the v1.5.6 per-user NSIS installer + upgrade-in-place
   under Wails' NSIS; re-bundle FFmpeg + ~77 MB CJK fonts.

## `window.electronAPI` surface to reproduce (from preload.js)
GPU: `detectGPU`, `resetGPU` · FFmpeg: `checkFFmpeg`, `startExport`, `cancelExport`
· events: `onLog`, `onStepStart`, `onStepDone`, `onEncoderInfo` · FS: `readFile`,
`writeFile`, `copyFile`, `deleteFile`, `fileExists`, `mkdtemp`, `rmdir`,
`resourcesPath`, `fontPath` · dialog/shell: `saveFileDialog`, `openFilesDialog`,
`openPath`, `pathForFile` · prefs: `getPrefs`, `setPrefs` · platform: `platform`,
`isElectron` · window: `forceClose`, `confirmCloseAck`, `onConfirmClose`.

## Milestones

- [~] **M0 — De-risk spikes** (Docker; now run *inside* the M1 scaffold, not
      standalone). Toolchain proven: `moments-wails` image builds, `wails doctor`
      green (GTK3 + WebKitGTK 4.0/4.1 + gcc + nsis; npm flag is a doctor
      false-negative).
  - [ ] Spike A: AssetServer handler serves a local video w/ Range → `<video>`
        seeks on WebView2 **and** WebKitGTK. (Wire into main.go M3 handler slot.)
  - [ ] Spike B: Go spawns FFmpeg, streams `time=` progress to the UI via events.
  - [ ] Spike C **(highest risk)**: render a caption in **WebKitGTK** and
        pixel-compare vs the FFmpeg export — re-validate text wrap/baseline parity.
- [x] **M1 — Scaffold:** DONE. Frontend moved to `frontend/`; Go project at root
      (`main.go`/`app.go`/`go.mod`/`wails.json`/`build/`); clean
      `frontend/package.json`. **`wails build` is green in-container** → 85 MB Linux
      binary `build/bin/Moments`, bindings generated, real React app compiles under
      Vite with no electron-import snags. (85 MB because ~77 MB fonts are embedded
      via `frontend/public` → move to external resources in M4/M6.)
- [x] **M2 — Go backend bindings:** DONE (compiles + binds; runtime QA needs a
      display). `prefs.go` (userConfigDir prefs.json), `fs.go` (read/write/copy/
      delete/exists/mkdtemp/rmdir/resources/fontPath), `dialogs.go` (open/save/
      openPath), `ffmpeg.go` (FFmpegCheck + DetectGPU encoder-parse + ResetGPU;
      StartExport/CancelExport stubbed for M4), `app.go` (Platform + onBeforeClose/
      ForceClose/ConfirmCloseAck), `resources.go`. `frontend/src/wailsShim.js`
      reconstructs `window.electronAPI` on the injected `window.go`/`window.runtime`
      globals; installed in `main.jsx` before render. All 22 methods bound; `wails
      build` green. Deferred: DetectGPU HW smoke-tests + full export → M4;
      `pathForFile`/drag-drop → M3.
- [x] **M3 — media serving + drag-drop:** DONE (`wails build` green; **Spike A**
      seek + drop-import need runtime QA on a display). `media.go` = AssetServer
      fallback handler serving `/media?p=<abs>` via `http.ServeContent` (native
      Range → video seeking). `mediaUrlFor` in `useMediaStore.js` now emits
      `/media?p=…` (was `media://m/…`). OS drag-drop: `OnFileDrop` (main.go
      `DragAndDrop.EnableFileDrop`) → filter to media → emit `files:dropped` → shim
      `onFileDrop` → `App.jsx` adds to library. Confirmed no double-import: no
      frontend handler reads `dataTransfer.files` (all DnD is internal ID-based), so
      OS-file drop is new capability, internal library→timeline DnD unaffected.
- [x] **M4 — Export pipeline wiring:** DONE (`wails build` green; runtime QA — an
      actual export → valid MP4 — needs a display + the ffmpeg binary). `encoders.go`
      (resolveEncoder + encoderQualityArgs + encoderIntermediateArgs, faithful ports),
      `export.go` (`StartExport`: token resolution incl. `-hwaccel cuda` before first
      `-i`, per-step spawn, `ffmpeg:log`/`stepStart`/`stepDone`/`encoderInfo` events,
      `\r`/`\n` split so `time=` progress streams, fallback-on-fail, cancellation via
      `activeExports` + `CancelExport`; temp-dir stays renderer-owned — never deleted
      here). `ffmpeg.go` `DetectGPU` now runs the HW smoke-tests + sets
      `NvencNeedsCuda`. `killAllExports()` defined (wired to close in M5). JS
      arg-building (`useFFmpeg.js`) untouched; single-final-pass swap stays
      renderer-side. **Refinement (later):** result preview uses `readFile` (base64
      of the whole output over the bridge) — could switch to `/media?p=<tmpOutput>`.
- [x] **M5 — Window/chrome:** DONE (`wails build` green; runtime QA needs a
      display). Native OS frame on all platforms (no Wails `titleBarOverlay`
      equivalent) + MinWidth/MinHeight; Topbar custom-titlebar path gated off via
      shim `customTitleBar:false`. Close-confirm + v1.5.6 freeze fix mirrored:
      `onBeforeClose` emits `app:confirm-close` + arms a 4s watchdog; `ConfirmCloseAck`
      clears it; `ForceClose`/`OnShutdown` call `killAllExports()` + quit.
      `SingleInstanceLock` (UniqueId `com.moments.app`) focuses the existing window.
- [ ] **M6 — Packaging parity:** Windows per-user NSIS + upgrade-in-place; Linux
      (AppImage/deb); bundle FFmpeg + fonts; CI (`.github/workflows`).
- [ ] **M7 — QA parity pass** against the Electron feature list (CLAUDE.md).

## Status log
- **2026-07-02 (1)** — Branch created. Restructure: Electron artifacts →
  `electron-app-legacy/`; `package.json` `main`/`files` re-pointed. Feasibility +
  milestones agreed. (commit `a06ace2`)
- **2026-07-02 (2)** — Toolchain image `moments-wails` built (Go 1.23 + WebKitGTK
  4.0/4.1 + Node 24 + Wails v2.12 + nsis); `wails doctor` green.
- **2026-07-02 (3)** — **M1 done.** Frontend → `frontend/`; Go scaffold at root;
  clean `frontend/package.json` (electron dep/config dropped, Electron manifest kept
  as `electron-app-legacy/package.json.electron-reference`). `wails build` green
  in-container → `build/bin/Moments` (85 MB). Build via:
  `docker run --rm -u 1000:1000 -e HOME=/tmp -e GOMODCACHE=/gomod -e GOCACHE=/gocache
  -v <scratch>/gomod:/gomod -v <scratch>/gocache:/gocache -v "$PWD":/app -w /app
  moments-wails wails build`.
- **2026-07-02 (4)** — **M2 done.** Go backend (`prefs`/`fs`/`dialogs`/`ffmpeg`/
  `app`/`resources`.go) + `frontend/src/wailsShim.js` reconstructing
  `window.electronAPI` over `window.go`/`window.runtime`; wired in `main.jsx` before
  render. All 22 methods bound, `wails build` green. (commit `7f2a4ec`)
- **2026-07-02 (5)** — **M3 done.** `media.go` AssetServer handler (`/media?p=<abs>`,
  `http.ServeContent` Range); `mediaUrlFor`→`/media?p=…`; `OnFileDrop`→`files:dropped`
  →shim `onFileDrop`→`App.jsx` library import (`DragAndDrop.EnableFileDrop`). No
  double-import (no `dataTransfer.files` handler exists). `wails build` green. Runtime
  QA pending a display (Spike A seek, drop-import). **Next: M4** — export pipeline
  wiring: JS builds the arg arrays (`useFFmpeg.js`, unchanged), Go `StartExport`
  resolves the encoder tokens (`__ENCODER__`/`__ENC_ARGS__`/`__ENC_ARGS_HQ__`),
  spawns FFmpeg, streams `ffmpeg:log`/`stepStart`/`stepDone`/`encoderInfo` events,
  owns temp-dir lifecycle; port the DetectGPU HW smoke-tests. Reference:
  `electron-app-legacy/electron/main.js` lines ~107-350 (detect+smoke) & 477-607
  (export loop).
- **2026-07-02 (6)** — **M4 done.** `encoders.go` + `export.go` + expanded
  `ffmpeg.go` (smoke-tests). Full export loop ported (tokens, streaming, fallback,
  cancel); `useFFmpeg.js` unchanged. `wails build` green. (commit `bcb9bf9`)
- **2026-07-02 (7)** — **M5 done.** Native frame (all platforms) + MinW/H; Topbar
  custom-titlebar gated off (shim `customTitleBar:false`); close watchdog + kill
  exports on ForceClose/OnShutdown/watchdog-timeout; SingleInstanceLock. `wails
  build` green. **Next: M6** — packaging parity: Win per-user NSIS + upgrade-in-place
  (Wails NSIS `nsisType:"perUser"` / custom template), Linux target, **externalize
  the ~77 MB fonts + ffmpeg from the embedded bundle** (finalize `resourcesBase`/
  `fontsDir`/`ffmpegPath` for packaged layout), CI. Then M7 QA.

## Open questions
- Wails **v2** (stable) vs **v3** (alpha)? Default to v2 unless a v3 feature is
  needed.
- Frontend location: keep `src/` at root, or move under Wails' conventional
  `frontend/`? (Decide at M1 scaffold.)
- Linux packaging target (AppImage vs deb vs both) under Wails.
- Windows: keep the exact per-user NSIS behavior — confirm Wails NSIS supports
  `perMachine:false` + upgrade-in-place via the same app GUID.
