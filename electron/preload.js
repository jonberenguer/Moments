/**
 * Moments — Electron Preload
 * Exposes a minimal, typed API surface to the renderer via contextBridge.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // ── GPU ──────────────────────────────────────────────────────────────────
  detectGPU:   ()         => ipcRenderer.invoke('gpu:detect'),
  resetGPU:    ()         => ipcRenderer.invoke('gpu:reset'),

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

  // ── Preferences ───────────────────────────────────────────────────────────
  getPrefs:   (key)        => ipcRenderer.invoke('prefs:get', key),
  setPrefs:   (key, value) => ipcRenderer.invoke('prefs:set', key, value),

  // ── Platform info ─────────────────────────────────────────────────────────
  platform: process.platform,
  isElectron: true,

  // ── Window controls ───────────────────────────────────────────────────────
  closeApp:    () =>    ipcRenderer.invoke('app:close'),
  startResize: (dir) => ipcRenderer.send('window:startResize', dir),
  stopResize:  ()    => ipcRenderer.send('window:stopResize'),
})
