// Frontend native-API shim.
//
// Reconstructs `window.nativeAPI` — the stable device API the React code calls —
// on top of the Wails-injected globals `window.go.main.App.*` and
// `window.runtime`.
//
// IMPORTANT: this installs window.nativeAPI as a **top-level side effect** and
// MUST be imported before any module that captures `window.nativeAPI` at module
// scope — useFFmpeg.js and MediaPanel.jsx do `const api = window.nativeAPI` at
// import time. So main.jsx imports this first. (The earlier async install ran
// after those modules had already captured `undefined`, which crashed detectGPU /
// export.) Backend methods + events are resolved lazily (at call time), so a
// slightly-late runtime injection still works.

const goApp = () => window.go?.main?.App
const rtime = () => window.runtime

function call(method, ...args) {
  const app = goApp()
  if (!app || typeof app[method] !== 'function') {
    return Promise.reject(new Error(`Wails backend method unavailable: ${method}`))
  }
  return app[method](...args)
}

const onEvent = (name) => (cb) => {
  const r = rtime()
  if (!r?.EventsOn) return () => {}
  return r.EventsOn(name, (data) => cb(data))
}

// Only install under Wails (window.runtime / window.go are injected before the app
// bundle runs). In a plain browser (vite dev without Wails) leave nativeAPI
// undefined so the app uses its browser fallback code paths.
if (!window.nativeAPI && (window.runtime || window.go)) {
  const ua = navigator.userAgent || ''
  const api = {
    // ── GPU ──
    detectGPU: () => call('DetectGPU'),
    resetGPU: () => call('ResetGPU'),

    // ── FFmpeg ──
    checkFFmpeg: () => call('FFmpegCheck'),
    startExport: (payload) => call('StartExport', payload),
    cancelExport: (jobId) => { call('CancelExport', jobId) },

    // ── Export events ──
    onLog: onEvent('ffmpeg:log'),
    onStepStart: onEvent('ffmpeg:stepStart'),
    onStepDone: onEvent('ffmpeg:stepDone'),
    onEncoderInfo: onEvent('ffmpeg:encoderInfo'),

    // ── Native OS file drop ──
    onFileDrop: onEvent('files:dropped'),

    // ── File system ──
    readFile: (p) => call('ReadFile', p),
    writeFile: (p, b64) => call('WriteFile', p, b64),
    copyFile: (s, d) => call('CopyFile', s, d),
    deleteFile: (p) => call('DeleteFile', p),
    fileExists: (p) => call('FileExists', p),
    mkdtemp: (prefix) => call('Mkdtemp', prefix || 'moments_'),
    rmdir: (p) => call('Rmdir', p),
    resourcesPath: () => call('ResourcesPath'),
    fontPath: (fontFile) => call('FontPath', fontFile),

    // ── Dialog / shell ──
    saveFileDialog: async (opts) =>
      (await call('SaveFileDialog', opts?.defaultName || '', opts?.filters || [])) || null,
    openFilesDialog: (opts) => call('OpenFilesDialog', opts?.accept || ''),
    openPath: (p) => call('OpenPath', p),
    pathForFile: () => null, // webviews can't map File→path; OS drops use OnFileDrop

    // ── Preferences ──
    getPrefs: (key) => call('GetPrefs', key ?? ''),
    setPrefs: (key, value) => call('SetPrefs', key, value),

    // ── Platform info (sync guess from UA; refined by backend below) ──
    platform: /Windows/i.test(ua) ? 'win32' : /Mac OS|Macintosh/i.test(ua) ? 'darwin' : 'linux',
    customTitleBar: false, // Wails uses the native OS frame on all platforms

    // ── Window controls ──
    forceClose: () => call('ForceClose'),
    confirmCloseAck: () => call('ConfirmCloseAck'),
    onConfirmClose: onEvent('app:confirm-close'),
  }
  window.nativeAPI = api

  // Refine platform with the authoritative backend value once reachable.
  call('Platform').then((p) => { if (p) api.platform = p }).catch(() => {})

  // Loopback media server base (http://127.0.0.1:port). Media element src is
  // <base>/media/<b64url(path)> — required so GStreamer can fetch <video> on
  // WebKitGTK. Resolves within ms of startup, long before any import builds a URL.
  call('MediaBase').then((b) => { if (b) window.__MOMENTS_MEDIA_BASE = b }).catch(() => {})
}
