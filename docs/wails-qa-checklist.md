# Wails Migration — Runtime QA Checklist (M7)

Everything through M6 compiles and `wails build` is green in-container, but the
build environment is headless — the items below need a **real display** (Linux +
Windows) and, for the installer, a **Windows CI run**. Check each on the built app.

Run dev: `wails dev` (in the toolchain container needs an X server; simplest is to
run on a real Linux desktop with Go+Wails+WebKitGTK, or use the built binary
`build/bin/Moments`).

## ⚠️ Linux runtime dependencies (WebKitGTK)
Unlike Electron (bundled Chromium + codecs), a Wails Linux app uses the system
WebKitGTK + GStreamer. Required on the target machine:
- **WebKitGTK 4.1 + GTK3:** `libwebkit2gtk-4.1-0 libgtk-3-0t64` (Debian 13 names;
  the binary is built with `-tags webkit2_41`).
- **GStreamer H.264/AAC codecs** — WITHOUT these, MP4 (`<video>`) renders **blank**
  (thumbnails/preview/canvas), even though the file is served fine:
  `gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav`
  (`gstreamer1.0-libav` = the `avdec_h264` decoder). Still images (JPG/PNG) need no
  codec. **Windows/WebView2 is unaffected** (H.264 built in).
- Follow-up: for a friction-free Linux release, either document these deps or ship
  an AppImage that bundles the GStreamer codec plugins.

## Spike C — preview↔export parity (HIGHEST RISK)
The caption wrap/baseline + Phase-A transform geometry were calibrated on **Blink**
(Electron). Wails uses **WebKitGTK on Linux** — re-validate:
- [ ] Add a caption (Latin) → preview position/size matches the exported MP4 frame.
- [ ] Multi-line wrapped caption → line breaks + alignment match preview vs export.
- [ ] CJK caption (Noto TC/JP/etc.) renders in preview and export; unsupported
      glyphs show □ in both (WYSIWYG). Latin font on CJK text → □ + Inspector warning.
- [ ] Clip transform (scale/rotate/move) → preview matches export geometry.
- [ ] Re-run the offscreen-render calibration harness against WebKitGTK if any drift.

## Spike A — media serving + seeking
- [ ] Imported video renders in preview (`/media?p=…` via the AssetServer handler).
- [ ] Scrubbing/seeking the `<video>` works (HTTP Range → 206). Test a large file.
- [ ] Image clips render.
- [ ] Filenames with spaces / non-ASCII / (Windows) drive-letter paths work.

## Import / drag-drop
- [ ] `+` button → native open dialog; multi-select adds to library; `lastMediaDir`
      remembered next open.
- [ ] Drag OS files onto the window → imported (Wails OnFileDrop). Non-media ignored.
- [ ] No double-import; internal library→timeline drag + clip reorder still work.
- [ ] Large import (50+ clips) — no OOM (path-based, no bytes in renderer).

## Export (each encoder available on the machine)
- [ ] Export → valid MP4; progress bar + ETA advance (time= streaming).
- [ ] Encoder auto-detect + manual override (NVENC/AMF/QSV/V4L2/CPU) each produce
      output; encoderInfo shows the right label.
- [ ] Quality tiers (high/balanced/small) + custom bitrate.
- [ ] Transitions are NOT pixelated (HQ intermediates + single final pass).
- [ ] WebM + GIF output.
- [ ] Text overlays, end fade, background music mix, clip transform all in output.
- [ ] Cancel mid-export kills FFmpeg promptly; no orphaned process.
- [ ] Result preview plays; Save dialog writes to the chosen path; temp dir cleaned.
- [ ] GPU smoke-tests: a compiled-but-nonfunctional HW encoder is correctly skipped.

## Workflows
- [ ] Save workflow → reopen → clips auto-relink from disk (path); moved-file falls
      back to filename re-link; custom fonts persist.

## Window / lifecycle
- [ ] Native frame: resize / maximize / restore / snap.
- [ ] Close (X) → confirm dialog; confirm exits; cancel stays.
- [ ] Close while exporting → no hang (watchdog + killAllExports).
- [ ] Second launch focuses the existing window (single-instance).

## Packaging (CI + installed app)
- [ ] Run `.github/workflows/wails-build.yml` (tag or PR) → Linux tarball + Windows
      `Moments-amd64-installer.exe` artifacts.
- [ ] Windows installer: per-user (no UAC), installs to
      `%LOCALAPPDATA%\Programs\Moments`, desktop/start-menu shortcuts.
- [ ] Installed app finds `ffmpeg.exe` + fonts under `<install>\ffmpeg\` (export +
      preview fonts work).
- [ ] Re-install a newer build → upgrades in place; `prefs.json` in
      `%APPDATA%\moments-app` preserved.
- [ ] Linux tarball: extract, `./Moments` runs; export + fonts work.

## Cleanup follow-ups (post-parity)
- [ ] De-dupe fonts (still embedded in the web bundle AND shipped external → ~85 MB
      binary): serve preview @font-face from `/fonts/…` on disk, drop from the embed.
- [ ] Optional: Linux AppImage instead of a tarball.
- [ ] Result preview via `/media?p=<tmpOutput>` instead of base64 readFile.
- [ ] Prune remaining browser-only fallback code if the browser target is dropped.
