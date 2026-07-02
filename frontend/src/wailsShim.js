// Wails → Electron compatibility shim.
//
// The frontend was written against Electron's window.electronAPI (see the frozen
// electron-app-legacy/electron/preload.js). Under Wails, the Go backend methods
// are injected at window.go.main.App.* and the event runtime at window.runtime.
// This module reconstructs window.electronAPI on top of those globals so the
// existing call sites keep working unchanged.
//
// Uses the injected globals directly (not the generated wailsjs wrappers) to
// avoid coupling the shim to generated import names.

export async function installElectronShim() {
  const go = window.go?.main?.App
  const rt = window.runtime
  if (!go || !rt || window.electronAPI) return false

  // Subscribe helper: Wails EventsOn returns its own unsubscribe fn, matching the
  // Electron cleanup contract (onLog/onConfirmClose return a remover).
  const onEvent = (name) => (cb) => rt.EventsOn(name, (data) => cb(data))

  // platform must be a synchronous value (Topbar reads it during render), so
  // resolve it once here before the shim is installed / React renders.
  const platform = await go.Platform()

  window.electronAPI = {
    // ── GPU ──
    detectGPU: () => go.DetectGPU(),
    resetGPU: () => go.ResetGPU(),

    // ── FFmpeg ──
    checkFFmpeg: () => go.FFmpegCheck(),
    startExport: (payload) => go.StartExport(payload),
    cancelExport: (jobId) => { go.CancelExport(jobId) },

    // ── Export events ──
    onLog: onEvent('ffmpeg:log'),
    onStepStart: onEvent('ffmpeg:stepStart'),
    onStepDone: onEvent('ffmpeg:stepDone'),
    onEncoderInfo: onEvent('ffmpeg:encoderInfo'),

    // ── Native OS file drop (Wails OnFileDrop) → import entries ──
    onFileDrop: onEvent('files:dropped'),

    // ── File system ──
    readFile: (p) => go.ReadFile(p),
    writeFile: (p, b64) => go.WriteFile(p, b64),
    copyFile: (s, d) => go.CopyFile(s, d),
    deleteFile: (p) => go.DeleteFile(p),
    fileExists: (p) => go.FileExists(p),
    mkdtemp: (prefix) => go.Mkdtemp(prefix || 'moments_'),
    rmdir: (p) => go.Rmdir(p),
    resourcesPath: () => go.ResourcesPath(),
    fontPath: (fontFile) => go.FontPath(fontFile),

    // ── Dialog / shell ──
    saveFileDialog: async (opts) => {
      const p = await go.SaveFileDialog(opts?.defaultName || '', opts?.filters || [])
      return p || null // Electron returns null on cancel; Go returns ""
    },
    openFilesDialog: (opts) => go.OpenFilesDialog(opts?.accept || ''),
    openPath: (p) => go.OpenPath(p),
    // No sync File→path in a webview; native drag-drop paths arrive via Wails
    // OnFileDrop in M3. Until then this returns null → caller keeps the blob File.
    pathForFile: () => null,

    // ── Preferences ──
    getPrefs: (key) => go.GetPrefs(key ?? ''),
    setPrefs: (key, value) => go.SetPrefs(key, value),

    // ── Platform info ──
    platform,
    isElectron: true, // unused by the app, kept for parity
    // Wails uses the native OS frame on all platforms (no titleBarOverlay
    // equivalent), so the Topbar should not act as a custom draggable titlebar.
    customTitleBar: false,

    // ── Window controls ──
    forceClose: () => go.ForceClose(),
    confirmCloseAck: () => go.ConfirmCloseAck(),
    onConfirmClose: onEvent('app:confirm-close'),
  }
  return true
}
