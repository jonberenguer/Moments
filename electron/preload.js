/**
 * Moments — Electron Preload
 * Exposes a minimal, typed API surface to the renderer via contextBridge.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // ── GPU ──────────────────────────────────────────────────────────────────
  detectGPU:   ()         => ipcRenderer.invoke('gpu:detect'),
  resetGPU:    ()         => ipcRenderer.invoke('gpu:reset'),

  // ── FFmpeg availability ────────────────────────────────────────────────────
  checkFFmpeg: ()         => ipcRenderer.invoke('ffmpeg:check'),

  // ── Export ───────────────────────────────────────────────────────────────
  startExport: (payload)  => ipcRenderer.invoke('ffmpeg:export', payload),
  cancelExport:(jobId)    => ipcRenderer.send('ffmpeg:cancel', jobId),

  // ── Export event listeners ────────────────────────────────────────────────
  onLog:          (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('ffmpeg:log', h)
    return () => ipcRenderer.removeListener('ffmpeg:log', h)
  },
  onStepStart:    (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('ffmpeg:stepStart', h)
    return () => ipcRenderer.removeListener('ffmpeg:stepStart', h)
  },
  onStepDone:     (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('ffmpeg:stepDone', h)
    return () => ipcRenderer.removeListener('ffmpeg:stepDone', h)
  },
  onEncoderInfo:  (cb) => {
    const h = (_, d) => cb(d)
    ipcRenderer.on('ffmpeg:encoderInfo', h)
    return () => ipcRenderer.removeListener('ffmpeg:encoderInfo', h)
  },

  // ── File system ───────────────────────────────────────────────────────────
  readFile:        (p)         => ipcRenderer.invoke('fs:readFile', p),
  writeFile:       (p, b64)    => ipcRenderer.invoke('fs:writeFile', p, b64),
  copyFile:        (s, d)      => ipcRenderer.invoke('fs:copyFile', s, d),
  deleteFile:      (p)         => ipcRenderer.invoke('fs:deleteFile', p),
  fileExists:      (p)         => ipcRenderer.invoke('fs:exists', p),
  mkdtemp:         (prefix)    => ipcRenderer.invoke('fs:mkdtemp', prefix),
  rmdir:           (p)         => ipcRenderer.invoke('fs:rmdir', p),
  resourcesPath:   ()          => ipcRenderer.invoke('fs:appResourcesPath'),
  fontPath:        (fontFile)  => ipcRenderer.invoke('fs:fontPath', fontFile),

  // ── Dialog / shell ────────────────────────────────────────────────────────
  saveFileDialog:  (opts)      => ipcRenderer.invoke('dialog:saveFile', opts),
  openFilesDialog: (opts)      => ipcRenderer.invoke('dialog:openFiles', opts),
  openPath:        (p)         => ipcRenderer.invoke('shell:openPath', p),
  // Resolve a drag-dropped / <input> File to its on-disk path (Electron only; the
  // renderer can't read File.path under context isolation). Returns null in a
  // browser or if unavailable → caller falls back to the blob-URL File path.
  pathForFile:     (file)      => { try { return webUtils.getPathForFile(file) || null } catch { return null } },

  // ── Preferences ───────────────────────────────────────────────────────────
  getPrefs:   (key)        => ipcRenderer.invoke('prefs:get', key),
  setPrefs:   (key, value) => ipcRenderer.invoke('prefs:set', key, value),

  // ── Platform info ─────────────────────────────────────────────────────────
  platform: process.platform,
  isElectron: true,

  // ── Window controls ───────────────────────────────────────────────────────
  // Native window management (resize/maximize/restore/snap) is handled by the OS
  // via titleBarStyle:'hidden' + titleBarOverlay. The renderer only needs to
  // confirm-and-close: the main process intercepts the window close and asks the
  // renderer (onConfirmClose); the user's choice resolves via forceClose().
  forceClose:     ()   => ipcRenderer.invoke('app:forceClose'),
  // Ack sent the instant the renderer receives a confirm-close request, so the
  // main process knows the renderer is alive (not wedged) and stands down its
  // force-close watchdog.
  confirmCloseAck: ()  => ipcRenderer.send('app:confirm-close-ack'),
  onConfirmClose: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('app:confirm-close', handler)
    return () => ipcRenderer.removeListener('app:confirm-close', handler)
  },
})
