# Revisit: Offline / air-gapped Windows NSIS build (Docker on Windows Server)

> **Status:** idea parked — not started. Captured from a brainstorm on 2026-06-30.
> **Driver:** build the per-user **NSIS installer** (`Moments Setup <ver>.exe`)
> **offline / air-gapped**, without relying on the `windows-latest` GitHub Actions
> runner. This doc is the plan to pick up when we decide to actually build it.

## Context / why this exists
- The shipping Windows target is a **per-user NSIS installer** (see CLAUDE.md →
  "Windows target"). It currently builds on the **`windows-latest` CI runner**
  (native Windows) because NSIS uninstaller-stub generation **cannot
  cross-compile from Linux** — electron-builder must *execute* a temp uninstaller
  stub, which fails under the Linux/Wine container (`…__uninstaller.exe -> no
  files found`).
- For local Linux smoke tests there's `npm run build:win:portable` (portable exe,
  no uninstaller) — but that is **not** the real installer.
- Goal here: a **self-contained, offline** way to produce the real NSIS installer
  on an on-prem **headless Windows Server 2025 + Docker** box.

## Key decisions (tentative)
1. **Build in a Windows container, not Linux/Wine.** Native Windows = NSIS +
   uninstaller "just work", no Wine. Headless is fine (all CLI; no display need).
2. **Separate Dockerfile** — e.g. `build/windows.Dockerfile`. A single image is
   single-OS and a Windows container only runs on a Windows host, so this cannot
   extend the existing Linux `node:24-slim` `Dockerfile`. Keep that one for
   AppImage + dev.
3. **Base image:** `mcr.microsoft.com/windows/servercore:ltsc2025` (match the host
   build → **process isolation** = fast; mismatch forces Hyper-V isolation).
   `nanoserver` is too minimal for the Node install + electron-builder helpers.

## Host prerequisites (Windows Server 2025)
- Docker / Mirantis runtime in **Windows-containers mode** (default on Server).
- Base tag **`ltsc2025`** to match the host.
- Ample disk (servercore is multi-GB before Node + electron-builder cache).
- No GUI required.

## What to install **in the image**
electron-builder fetches most of its own toolchain, so the image is lean:

| Install | Why |
|---|---|
| **Node.js 24** (win-x64 zip → expand → add to PATH) | npm + electron-builder |
| **FFmpeg win binary** (`node scripts/download-ffmpeg.js win`, or bind-mount `bin/win`) | bundled into the app |
| *(optional)* **Git** | only if cloning inside the container vs bind-mount |
| *(optional)* **Windows SDK `signtool` + code-signing cert** | only if signing; skip → unsigned |
| *(maybe)* **VC++ redistributable** | some electron-builder helper exes want it on bare servercore |

**NOT needed (electron-builder downloads/bundles):** NSIS / `makensis`,
winCodeSign, the Electron **Windows** binaries, 7-Zip. Also no Python / VS Build
Tools (project has no native node modules).

### ⚠️ Air-gapped wrinkle — pre-bake ALL downloads at image-build time
The whole point is offline, so nothing can hit the network at *run* time. While
the image is built on a connected machine, pre-fetch and bake:
- Node 24 zip.
- **electron-builder cache** (`ELECTRON_BUILDER_CACHE=C:\eb-cache`): NSIS,
  nsis-resources, winCodeSign, **electron-vX-win32-x64.zip**. Easiest way to warm
  it: run one throwaway `npm run build:win` during image build (connected) so the
  cache populates; it then ships inside the image.
- **FFmpeg win binary** baked into `bin/win` (or into the image), since
  `download-ffmpeg.js` pulls from github.com.
- `npm ci` deps (the `node_modules` layer).
Then the actual offline build run uses only what's already in the image.

## Dockerfile layout (stages — to write later)
1. `FROM mcr.microsoft.com/windows/servercore:ltsc2025` + `SHELL powershell`.
2. Install Node 24 (download win-x64 zip → expand `C:\node` → prepend PATH) → `node -v`.
3. `ENV ELECTRON_BUILDER_CACHE=C:\eb-cache`.
4. `WORKDIR C:\app`; `COPY package*.json .`; `RUN npm ci` (cached layer).
5. Bake FFmpeg (`bin/win`) + warm electron-builder cache (throwaway build) while online.
6. `CMD npm run build:win` → `dist-electron\Moments Setup <ver>.exe`.

## Source strategy (decide when building)
- **Bake source + build in image** → fully reproducible/offline; rebuild image per
  change, `docker cp` the artifact out. **Best fit for air-gapped/reproducible.**
- **Toolchain image + bind-mount** (`-v ${PWD}:C:\app`) → fast iteration, installer
  lands on host; but `node_modules` on a mounted Windows volume is slow → keep deps
  + `ELECTRON_BUILDER_CACHE` in **named volumes**. (Less "air-gapped clean".)

## Invocation sketch (bind-mount variant)
```
docker build -t moments-win -f build/windows.Dockerfile .
docker run --rm -v ${PWD}:C:\app -w C:\app `
  -v moments-eb-cache:C:\eb-cache moments-win npm run build:win
# → dist-electron\Moments Setup <ver>.exe
```

## Gotchas
- Image size + first-build time are significant.
- `ltsc2025` tag must match host for process isolation.
- Unsigned installer → SmartScreen warning unless signtool + cert added.
- Bind-mount perf for `node_modules` on Windows containers → use a volume.
- Confirm `npm run build:win` (= `electron-builder --win`, NSIS target) doesn't try
  to **auto-publish** in this context (it auto-publishes on CI + tag + token). For a
  local offline build there's no tag/token, so it should just build — but if a
  token is present, add `--publish never`.

## Alternatives considered (cheaper than a Windows container)
1. **CI (`windows-latest`)** already builds the exact installer for free — ruled
   out here only because the driver is **offline / air-gapped**.
2. **Native build on the Windows Server** (install Node, `npm run build:win`) — far
   simpler than a Windows container (no base-image/isolation/mount headaches). If
   the only goal is "a working offline installer" and reproducible-container
   isolation isn't required, **this is likely the better first step**; reach for the
   container only if you need a clean, repeatable, dependency-pinned environment.

## Open questions to settle when we revisit
- Container (reproducible/isolated) vs native server build (simplest)? Driver is
  offline — both satisfy that; pick based on how much you value isolation.
- Signing in scope (signtool + cert) or unsigned for internal use?
- Bake-source vs bind-mount (air-gapped leans **bake**).
- Where do offline inputs come from on the air-gapped box (pre-baked into the
  image on a connected machine, then transferred)?

## Pointers
- `package.json` → `build.win` / `build.nsis` (target + per-user config),
  `_win_portable` (preserved portable config), `build:win` / `build:win:portable`.
- `.github/workflows/build.yml` → the working native Windows NSIS build (reference).
- `scripts/download-ffmpeg.js` → FFmpeg fetch (direct release-asset URLs).
- `CLAUDE.md` → "Windows target — per-user NSIS installer", "Building Installers".
