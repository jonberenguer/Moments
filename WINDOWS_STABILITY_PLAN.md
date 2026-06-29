# Windows Stability & Installer — Working Plan

> Branch: **`windows-stability-and-installer`** (off `main` @ `50dc758`)
> Status: **#1 and #3 DONE; #2 pending.** Created so work can be parked while
> addressing an unrelated bug on `main`, then resumed here.

This branch addresses three Windows-package issues raised during UAT. Each
section below has the **traced root cause** (file:line) and **ranked candidate
fixes**.

---

## 1. Windows freeze on close (intermittent) — ✅ DONE

**Implemented:** ack-based close watchdog + kill in-flight FFmpeg on every quit path.
- `electron/main.js`: on intercepted `close`, after sending `app:confirm-close`,
  start a **4s watchdog**; if the renderer doesn't `app:confirm-close-ack` (proof
  it's alive) the watchdog sets `forceClose`, calls `killAllExports()`, and
  `mainWindow.destroy()`. `killAllExports()` cancels each child in `activeExports`
  — called from the watchdog, the `app:forceClose` handler, and a new
  `app.on('before-quit')`. Watchdog cleared on ack / forceClose / window `closed`.
- `electron/preload.js`: new `confirmCloseAck()` → `app:confirm-close-ack`.
- `src/components/Topbar.jsx`: on `onConfirmClose`, call `confirmCloseAck()` then
  open the dialog.

**Verify on Windows:** (a) X/Alt+F4 during a heavy op no longer hangs (worst case
closes after ~4s); (b) closing mid-export leaves no orphaned `ffmpeg.exe`;
(c) normal Exit/Cancel still work.

<details><summary>Original analysis (for reference)</summary>

### How close works today
`electron/main.js:236` + `src/components/Topbar.jsx:195`:
`X`/Alt+F4 → main `e.preventDefault()` → sends `app:confirm-close` to renderer →
renderer shows "Exit moments?" dialog → user clicks Exit → `app:forceClose`
(`main.js:286`) → main sets `forceClose=true` and calls `mainWindow.close()` again.

### Root cause (two structural weaknesses, both fit "intermittent")
1. **Close depends entirely on the renderer answering.** After `preventDefault()`,
   the only exit is the renderer round-trip. If the renderer is busy/wedged
   (video decode, big `setState`, stalled `<video>`) the `app:confirm-close`
   message queues, no dialog appears, and X looks dead. **No watchdog/timeout, no
   fallback.**
2. **In-flight FFmpeg children are never killed on quit.** `activeExports`
   (`main.js:377`) holds `cancel()` handlers but nothing calls them on
   `before-quit`/`window-all-closed`. On Windows, killing the parent does NOT reap
   spawned children → orphaned `ffmpeg.exe` holds pipes/temp → app appears hung.
   **There is no `before-quit` handler at all.**

### Candidate fixes (ranked)
1. **Close watchdog in main:** after sending `app:confirm-close`, start a ~4s
   timer; if no reply, force the close. Kills the "X does nothing" symptom.
2. **Kill active exports on quit:** `app.on('before-quit')` (and in the force-close
   path) iterates `activeExports` and `SIGKILL`s each child.
3. **Skip confirm when nothing to lose** (no clips, no active export) → close
   immediately. Fewer round-trips = fewer wedge chances.
4. Belt-and-suspenders: detached / `taskkill /T` child spawning so children die
   with the parent on Windows.

**Plan:** do **1 + 2** together (cover both freeze modes, low risk). ✅ Done as above.

</details>

---

## 2. Crash importing 20+ videos (~10s clips)

There is **no cache/storage cap** in the code — it's a memory blowup in the
import path.

### Root cause (traced)
- `dialog:openFiles` (`electron/main.js:348`) reads **every selected file** with
  `fs.readFileSync` and returns each as **base64** over IPC. Base64 inflates ~33%
  and all files are in main memory *simultaneously*.
- Renderer `base64ToFile` (`src/components/MediaPanel.jsx:7`): `atob` → another
  full copy → `new File([bytes])`. Each file briefly exists ~3× (main buffer +
  base64 string + decoded array), all at once.
- Each library item gets `URL.createObjectURL` (`useMediaStore.js:92`) that is
  **never revoked** for library media (only music/workflow blobs are revoked),
  and the preview/thumbnails decode multiple `<video>` streams.

Net: a 20-file batch multiplies the transient peak into GB range → renderer OOM /
IPC message-size ceiling → crash. Scales with **import batch size** = the symptom.

### Candidate fixes (ranked)
1. **Stop round-tripping bytes through base64.** Dialog returns real **file
   paths**; renderer uses them directly (`file://` or custom protocol) for
   `<video src>`, and export copies from path instead of re-writing File bytes.
   Biggest win, most invasive (export currently writes File bytes to temp; would
   copy from path instead).
2. **Import lazily / in batches:** read+decode a file only when added to the
   timeline or previewed; process the dialog list sequentially, not all-at-once.
   Smaller change, big peak reduction.
3. **Revoke object URLs on remove**, and cap concurrent decoding `<video>`
   elements (virtualize the thumbnail grid).
4. Generate thumbnails in main (FFmpeg single-frame) instead of full `<video>`
   decode in renderer.

**Plan:** start with **2 + 3** (cheap mitigation, likely stops crashes); treat
**1** (path-based) as a larger follow-up if needed.

---

## 3. Portable → per-user installer — ✅ DONE

**Implemented:** Windows target switched from `portable` to a **per-user NSIS**
installer.
- `package.json` `build.win.target` → `nsis`; `build.nsis` set to `perMachine:
  false`, `allowElevation: false`, `oneClick: false`, `allowToChangeInstallation
  Directory: true`, `createDesktop/StartMenuShortcut: true`, `deleteAppDataOn
  Uninstall: false`. Old portable config preserved as `_win_portable` (for local
  Linux smoke builds, since NSIS can't cross-compile from Linux).
- `.github/workflows/build.yml`: Windows step renamed; still builds on
  `windows-latest` (native → NSIS works) and the `dist-electron/*.exe` artifact +
  release globs match the NSIS `Setup .exe`.
- Docs updated (CLAUDE.md "Windows target", "Building Installers", bug history).

Result: installs to `%LOCALAPPDATA%\Programs` with no admin; a newer build
upgrades the existing install in place (appId GUID) so only the updated app
remains, prefs preserved; no per-launch `%TEMP%` unpack → faster startup.

**Verify:** download the CI Windows artifact, install (no UAC prompt), run; then
install a newer version → it replaces the old one (not side-by-side) and settings
survive. Optional follow-on: electron-updater auto-update.

<details><summary>Original analysis (for reference)</summary>

### Why portable feels slow
electron-builder's `portable` target is a self-extracting exe — **every launch**
unpacks the whole app (Electron + resources, incl. ~77MB fonts + FFmpeg) to
`%TEMP%` before running. That extraction is the slow startup. An installed app
runs from a fixed dir with no per-launch unpack → much faster cold start.

### Requirements → NSIS mapping
- **User-only (no admin):** NSIS `perMachine: false` → installs to
  `%LOCALAPPDATA%\Programs\moments-app`, no elevation.
- **Upgrade in place ("only the updated app exists"):** NSIS keyed on the stable
  `appId` (`com.moments.app`) detects the prior version and upgrades in place
  (not side-by-side) by default. Keep `deleteAppDataOnUninstall: false` so prefs
  survive upgrades.
- **One-click vs assisted:** existing `nsis` block has `oneClick:false` +
  allow-change-dir. For clean per-user upgrade, consider `oneClick:true` +
  `perMachine:false`. (Owner's call.)

### The one real constraint
NSIS uninstaller-stub generation **fails when cross-compiling from Linux** (why
`portable` was chosen — see CLAUDE.md "Windows target"). **But GitHub Actions
`windows-latest` builds natively → NSIS works there.** Plan: switch the Windows
target to NSIS for CI/release builds; local Linux can keep `portable` for quick
smoke tests (electron-builder can emit both targets).

The `_win_nsis` block already preserved in `package.json` (line ~105) is the
starting point.

### Optional follow-on
electron-updater + GitHub Releases for true auto-update (background download,
update-on-restart) — separate, larger piece. The upgrade-overwrite behavior asked
for comes free with plain NSIS.

</details>

---

## Suggested sequencing
1. **#1** — watchdog + kill-on-quit (small, high value, self-contained).
2. **#3** — Windows target → per-user NSIS in build config + CI (config-only).
3. **#2** — cheap import mitigation first (lazy/batched + URL revoke), path-based
   refactor as follow-up if crashes persist.

## Constraints / notes
- Builds/lint run **only in Docker** (`node:24-slim`, has network; host node/network
  denied). See memory `builds-via-docker-only`.
- `package.json` version is **1.5.5** (owner's uncommitted edit — leave alone).
- Holding the `main` push per owner UAT — don't push without go-ahead.
