/**
 * Moments App — Electron Main Process
 *
 * GPU priority: NVIDIA/AMD NVENC/AMF (dedicated GPU) → Intel QSV (iGPU) → CPU (libx264)
 * Platform: Linux + Windows only
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const { spawn, execSync } = require('child_process')

// ─── FFmpeg binary path ───────────────────────────────────────────────────────
// In production: bundled inside resources/ffmpeg/
// In dev: the per-platform binary under bin/<win|linux>/ (same one that gets
//         packaged), falling back to PATH only if it isn't there.
function getFFmpegPath() {
  const ext = process.platform === 'win32' ? '.exe' : ''
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg', `ffmpeg${ext}`)
  }
  const subdir   = process.platform === 'win32' ? 'win' : 'linux'
  const localBin = path.join(__dirname, '..', 'bin', subdir, `ffmpeg${ext}`)
  if (fs.existsSync(localBin)) return localBin
  return 'ffmpeg'  // from PATH
}

// The bare 'ffmpeg' (PATH fallback) is assumed present; a resolved file path is
// considered available only if it exists on disk.
function ffmpegAvailable(bin) {
  return bin === 'ffmpeg' || fs.existsSync(bin)
}

// Restore the executable bit on POSIX — extraResources / source checkouts can
// drop it, which would make spawn fail with EACCES on Linux. Best-effort.
function ensureFFmpegExecutable(bin) {
  if (bin !== 'ffmpeg' && process.platform !== 'win32' && fs.existsSync(bin)) {
    try { fs.chmodSync(bin, 0o755) } catch { /* ignore */ }
  }
}

// ─── GPU detection ────────────────────────────────────────────────────────────
let _gpuCapCache = null

async function detectGPUCapabilities() {
  if (_gpuCapCache) return _gpuCapCache

  const result = {
    nvenc:  false,  // NVIDIA (dedicated GPU)
    amf:    false,  // AMD   (dedicated GPU)
    qsv:    false,  // Intel (iGPU / integrated)
    v4l2m2m: false, // Linux V4L2 M2M (fallback HW)
    cpu:    true,   // always available
    // Alternative export formats (codec availability in this FFmpeg build)
    vp9:    false,  // libvpx-vp9 → WebM video
    opus:   false,  // libopus    → WebM audio (preferred)
    vorbis: false,  // libvorbis  → WebM audio (fallback)
    gif:    false,  // gif encoder
  }

  const ffmpeg = getFFmpegPath()
  ensureFFmpegExecutable(ffmpeg)

  try {
    // Ask FFmpeg which HW encoders are compiled in
    const raw = execSync(`"${ffmpeg}" -hide_banner -encoders 2>&1`, { timeout: 8000 }).toString()
    if (raw.includes('h264_nvenc'))    result.nvenc    = true
    if (raw.includes('h264_amf'))      result.amf      = true
    if (raw.includes('h264_qsv'))      result.qsv      = true
    if (raw.includes('h264_v4l2m2m')) result.v4l2m2m  = true
    if (raw.includes('libvpx-vp9'))    result.vp9      = true
    if (raw.includes('libopus'))       result.opus     = true
    if (raw.includes('libvorbis'))     result.vorbis   = true
    if (/(^|\s)gif(\s)/m.test(raw))    result.gif      = true
  } catch {
    // FFmpeg not found or failed — CPU only
  }

  // Quick smoke-tests: try a 1-frame encode to confirm the HW path actually works.
  // Over RDP on Windows, NVIDIA drivers expose the GPU but the default WDDM display
  // adapter used by the session may not initialise the CUDA context correctly.
  // We use a longer timeout (10 s) and for NVENC we first try with -hwaccel cuda
  // so FFmpeg explicitly initialises the CUDA device — this is required on RDP/
  // headless sessions where the driver doesn't auto-activate. If that fails we
  // fall back to the plain encoder-only smoke test.
  const tmpOut = path.join(os.tmpdir(), `moments_gpucheck_${Date.now()}.mp4`)

  async function smokeTest(encoder, extraArgs = []) {
    return new Promise(resolve => {
      const args = [
        // 256×256 — NVENC (Ampere/Ada) rejects very small frames ("Frame
        // Dimension less than the minimum supported value"), so a 64×64 probe
        // falsely fails on otherwise-working GPUs. Real exports are ≥854×480.
        '-f', 'lavfi', '-i', 'color=black:size=256x256:rate=1',
        '-frames:v', '1',
        '-c:v', encoder, ...extraArgs,
        '-y', tmpOut,
      ]
      // Capture stderr so a failed probe surfaces *why* (missing encode lib,
      // driver too old, no NVENC block) instead of silently becoming "no GPU".
      const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let errBuf = ''
      p.stderr?.on('data', d => { errBuf += d.toString() })
      const t = setTimeout(() => { p.kill(); resolve(false) }, 10000)
      p.on('close', code => {
        clearTimeout(t)
        try { fs.unlinkSync(tmpOut) } catch {}
        if (code !== 0) console.warn(`[GPU] smoke test failed for ${encoder} (code ${code}):\n${errBuf.trim().split('\n').slice(-4).join('\n')}`)
        resolve(code === 0)
      })
    })
  }

  if (result.nvenc) {
    // On Windows/RDP, explicitly request the CUDA hwaccel device so the driver
    // activates even without a physical display attached to the session.
    const withCuda = process.platform === 'win32'
      ? await smokeTest('h264_nvenc', ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-preset', 'p1'])
      : false
    result.nvenc = withCuda || await smokeTest('h264_nvenc', ['-preset', 'p1'])
    // Record whether we need the cuda hwaccel args at encode time
    result.nvencNeedsCuda = withCuda
  }
  if (result.amf)      result.amf      = await smokeTest('h264_amf',   ['-quality', 'speed'])
  if (result.qsv)      result.qsv      = await smokeTest('h264_qsv',   ['-preset', 'veryfast'])
  if (result.v4l2m2m) result.v4l2m2m  = await smokeTest('h264_v4l2m2m')

  _gpuCapCache = result
  console.log('[GPU]', result)
  return result
}

// Reset cache so re-detection can be triggered from renderer
function resetGPUCache() { _gpuCapCache = null }

// ─── Pick best encoder given caps + preference override ──────────────────────
function resolveEncoder(caps, override = 'auto') {
  if (override && override !== 'auto') {
    // Validate override is actually available
    const map = { nvenc: 'h264_nvenc', amf: 'h264_amf', qsv: 'h264_qsv', v4l2m2m: 'h264_v4l2m2m', cpu: 'libx264' }
    if (map[override]) return { encoder: map[override], label: override.toUpperCase(), hw: override !== 'cpu' }
  }
  if (caps.nvenc)    return { encoder: 'h264_nvenc',    label: 'NVENC (GPU)',      hw: true  }
  if (caps.amf)      return { encoder: 'h264_amf',      label: 'AMF (GPU)',        hw: true  }
  if (caps.qsv)      return { encoder: 'h264_qsv',      label: 'QSV (iGPU)',       hw: true  }
  if (caps.v4l2m2m)  return { encoder: 'h264_v4l2m2m',  label: 'V4L2M2M (HW)',    hw: true  }
  return                    { encoder: 'libx264',        label: 'CPU (libx264)',    hw: false }
}

// Encoder-specific quality args. Three tiers map to a constant-quality target
// (CRF/CQ) + a speed↔efficiency preset; H.264 high profile + yuv420p keeps the
// output playable everywhere. A custom target bitrate (Mbps), when given,
// overrides constant-quality with capped VBR (ABR + maxrate/bufsize) so the user
// can hit a specific size/bitrate. All far better quality-per-byte than the old
// speed-first presets. `tier` ∈ {high, balanced, small}; `bitrateMbps` null/0 = off.
function encoderQualityArgs(encoder, tier = 'balanced', bitrateMbps = null) {
  const CQ        = { high: 18, balanced: 21, small: 26 }[tier] ?? 21
  const x264Pre   = { high: 'slow', balanced: 'medium', small: 'veryfast' }[tier] || 'medium'
  const nvPre     = { high: 'p6',   balanced: 'p4',     small: 'p2' }[tier]       || 'p4'
  const qsvPre    = { high: 'slower', balanced: 'medium', small: 'veryfast' }[tier] || 'medium'
  const profile   = ['-profile:v', 'high']
  const br        = (bitrateMbps && bitrateMbps > 0) ? Math.round(bitrateMbps * 1000) : null  // → kbps
  const maxr      = br ? Math.round(br * 1.45) : null
  switch (encoder) {
    case 'h264_nvenc':
      return br
        ? ['-preset', nvPre, '-rc', 'vbr', '-b:v', `${br}k`, '-maxrate', `${maxr}k`, '-bufsize', `${br * 2}k`, ...profile]
        : ['-preset', nvPre, '-rc', 'vbr', '-cq', String(CQ), '-b:v', '0', ...profile]
    case 'h264_amf':
      // constant-QP support varies by AMF build (not smoke-tested here); keep it
      // on VBR. Quality preset is the safe lever; bitrate uses a peak cap.
      return br
        ? ['-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', `${br}k`, '-maxrate', `${maxr}k`, ...profile]
        : ['-quality', tier === 'small' ? 'speed' : 'balanced', '-rc', 'vbr_latency', ...profile]
    case 'h264_qsv':
      return br
        ? ['-preset', qsvPre, '-b:v', `${br}k`, '-maxrate', `${maxr}k`, ...profile]
        : ['-preset', qsvPre, '-global_quality', String(CQ), ...profile]
    case 'h264_v4l2m2m':   // V4L2 has no CRF — bitrate only
      return ['-b:v', br ? `${br}k` : ({ high: '8M', balanced: '6M', small: '3M' }[tier] || '6M')]
    default:               // libx264
      return br
        ? ['-preset', x264Pre, '-b:v', `${br}k`, '-maxrate', `${maxr}k`, '-bufsize', `${br * 2}k`, '-threads', '0', ...profile]
        : ['-preset', x264Pre, '-crf', String(CQ), '-threads', '0', ...profile]
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow
let forceClose = false   // set true once the user confirms exit
let closeWatchdog = null // timer that force-closes if the renderer never answers

// Kill any in-flight FFmpeg child processes. On Windows, child processes are NOT
// reaped when the parent exits, so an export still running at quit/close time
// leaves an orphaned ffmpeg.exe holding pipes + the temp dir — and the app then
// appears to hang on close. Call this on every quit / force-close path. (Defined
// here; `activeExports` is initialised lower down but only read at call time.)
function killAllExports() {
  for (const job of activeExports.values()) {
    try { job.cancel() } catch { /* already gone */ }
  }
}

function clearCloseWatchdog() {
  if (closeWatchdog) { clearTimeout(closeWatchdog); closeWatchdog = null }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  1100,
    minHeight: 700,
    backgroundColor: '#0f0f0f',
    // Keep the native window frame (so resize / maximize / restore / Aero-snap
    // all work) but hide the title bar so we can draw our own. On Windows the
    // overlay paints native min/max/close buttons over the top-right corner.
    titleBarStyle: process.platform === 'linux' ? 'default' : 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: '#15151a', symbolColor: '#e8c96a', height: 48 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox: false,
      // No COOP/COEP needed — we're native, not WASM
      webSecurity: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // Surface a failed renderer load instead of a silent white screen.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL) => {
    if (errorCode === -3) return  // ERR_ABORTED — benign (e.g. cancelled navigation)
    console.error(`Renderer failed to load (${errorCode}): ${errorDesc} ${validatedURL}`)
    dialog.showErrorBox('Moments — failed to load',
      `The app interface could not be loaded.\n\n${errorDesc} (${errorCode})\n${validatedURL || ''}`)
  })

  mainWindow.on('closed', () => { mainWindow = null; clearCloseWatchdog() })

  // Intercept the native close (X button / Alt+F4) to ask the renderer for an
  // exit confirmation. forceClose (set by app:forceClose) lets it through.
  mainWindow.on('close', (e) => {
    if (forceClose || !mainWindow) return
    e.preventDefault()
    mainWindow.webContents.send('app:confirm-close')

    // Watchdog for a wedged renderer. If the renderer is hung (busy decoding
    // video, a stalled <video>, a long setState) it never shows the dialog and
    // never replies, so the X button would do nothing forever — the reported
    // intermittent "freeze on close". A live renderer acks immediately
    // (app:confirm-close-ack → clearCloseWatchdog); if no ack lands within the
    // grace period we assume it's wedged and force the window down. destroy()
    // (not close()) skips renderer unload handlers, which a hung renderer can't
    // run anyway.
    clearCloseWatchdog()
    closeWatchdog = setTimeout(() => {
      closeWatchdog = null
      forceClose = true
      killAllExports()
      if (mainWindow) mainWindow.destroy()
    }, 4000)
  })

  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools()
  })
}

// Single-instance lock: a second launch focuses the existing window instead of
// spinning up a rival process that fights over prefs.json / temp export dirs.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('activate', () => { if (!mainWindow) createWindow() })
  // Catch every quit path (window-all-closed, menu quit, OS shutdown) — make sure
  // no FFmpeg child outlives the app and hangs the close.
  app.on('before-quit', () => { clearCloseWatchdog(); killAllExports() })
}

// ─── IPC: FFmpeg availability ─────────────────────────────────────────────────
// The renderer queries this on launch to reflect a missing binary in the UI
// (disabled Export + warning) instead of a blocking native dialog.
ipcMain.handle('ffmpeg:check', () => {
  const bin = getFFmpegPath()
  ensureFFmpegExecutable(bin)
  return { available: ffmpegAvailable(bin), path: bin }
})

// ─── IPC: GPU detection ───────────────────────────────────────────────────────
ipcMain.handle('gpu:detect', async () => {
  return await detectGPUCapabilities()
})

ipcMain.handle('gpu:reset', () => {
  resetGPUCache()
  return true
})

// ─── IPC: App close ───────────────────────────────────────────────────────────
// Native resize/maximize/restore/snap are handled by the OS now; the renderer
// only confirms exit. The window 'close' handler asks the renderer, which calls
// this once the user confirms.
ipcMain.handle('app:forceClose', () => {
  clearCloseWatchdog()
  forceClose = true
  killAllExports()              // don't leave an export running after the user exits
  if (mainWindow) mainWindow.close()
})

// Renderer ack that it received the confirm-close request and is showing the
// dialog — proof it's alive, so the wedged-renderer watchdog stands down and the
// user's Exit/Cancel choice drives the rest.
ipcMain.on('app:confirm-close-ack', () => { clearCloseWatchdog() })

// ─── Persistent preferences ───────────────────────────────────────────────────
// Stored as a flat JSON file in the OS user-data directory so settings survive
// app restarts without any external dependency.
const PREFS_PATH = path.join(app.getPath('userData'), 'prefs.json')

function readPrefs() {
  try {
    if (fs.existsSync(PREFS_PATH)) return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'))
  } catch {}
  return {}
}

function writePrefs(prefs) {
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf8') } catch {}
}

ipcMain.handle('prefs:get', (_, key) => {
  const prefs = readPrefs()
  return key ? prefs[key] ?? null : prefs
})

ipcMain.handle('prefs:set', (_, key, value) => {
  const prefs = readPrefs()
  prefs[key] = value
  writePrefs(prefs)
  return true
})

// ─── IPC: Open files dialog (with remembered last folder) ────────────────────
ipcMain.handle('dialog:openFiles', async (_, { accept } = {}) => {
  const prefs      = readPrefs()
  const defaultPath = prefs.lastMediaDir || app.getPath('home')

  // Build extension filters from the accept hint (e.g. 'image/*,video/*')
  const filters = [
    { name: 'Media', extensions: ['jpg','jpeg','png','gif','webp','heic','avif','mp4','mov','webm','avi','mkv','m4v'] },
    { name: 'Images', extensions: ['jpg','jpeg','png','gif','webp','heic','avif'] },
    { name: 'Videos', extensions: ['mp4','mov','webm','avi','mkv','m4v'] },
    { name: 'All Files', extensions: ['*'] },
  ]

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:       'Add Media',
    defaultPath,
    filters,
    properties: ['openFile', 'multiSelections'],
  })

  if (canceled || !filePaths.length) return []

  // Persist the directory of the first selected file for next time
  const pickedDir = path.dirname(filePaths[0])
  writePrefs({ ...readPrefs(), lastMediaDir: pickedDir })

  // Read each file and return { name, base64, mime } so the renderer can
  // reconstruct File/Blob objects without needing direct fs access.
  const results = []
  for (const fp of filePaths) {
    try {
      const buf  = fs.readFileSync(fp)
      const ext  = path.extname(fp).slice(1).toLowerCase()
      const mime = ['mp4','mov','webm','avi','mkv','m4v'].includes(ext)
        ? `video/${ext === 'mov' ? 'quicktime' : ext}`
        : `image/${ext === 'jpg' ? 'jpeg' : ext}`
      results.push({ name: path.basename(fp), base64: buf.toString('base64'), mime })
    } catch { /* skip unreadable files */ }
  }
  return results
})

// ─── IPC: Save file dialog ────────────────────────────────────────────────────
ipcMain.handle('dialog:saveFile', async (_, { defaultName, filters }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'moment.mp4',
    filters: filters || [{ name: 'MP4 Video', extensions: ['mp4'] }],
  })
  return canceled ? null : filePath
})

// ─── IPC: Shell open ──────────────────────────────────────────────────────────
ipcMain.handle('shell:openPath', async (_, filePath) => {
  return shell.openPath(filePath)
})

// ─── IPC: Export (native FFmpeg) ─────────────────────────────────────────────
// Manages a map of active export processes so we can cancel them
const activeExports = new Map()

ipcMain.handle('ffmpeg:export', async (event, payload) => {
  const { jobId, steps, encoderOverride, exportQuality, exportBitrate, tempDir: reqTempDir } = payload

  const tempDir = reqTempDir || path.join(os.tmpdir(), `moments_export_${jobId}`)
  fs.mkdirSync(tempDir, { recursive: true })

  const ffmpeg = getFFmpegPath()
  ensureFFmpegExecutable(ffmpeg)
  if (!ffmpegAvailable(ffmpeg)) {
    return { ok: false, error: `FFmpeg binary not found at "${ffmpeg}". Run "node scripts/download-ffmpeg.js" to install it.` }
  }
  const caps   = await detectGPUCapabilities()
  const enc    = resolveEncoder(caps, encoderOverride)
  const encArgs = encoderQualityArgs(enc.encoder, exportQuality, exportBitrate)

  // On Windows RDP sessions, NVENC may require -hwaccel cuda before inputs.
  // This was detected during the smoke-test and stored as caps.nvencNeedsCuda.
  const hwaccelInputArgs = (enc.encoder === 'h264_nvenc' && caps.nvencNeedsCuda)
    ? ['-hwaccel', 'cuda']
    : []

  // Inform renderer which encoder is being used
  event.sender.send('ffmpeg:encoderInfo', { jobId, encoder: enc.label, hw: enc.hw })

  let cancelled = false
  let currentProc = null

  // Register cancellation handler
  const cancelHandler = (_, cjobId) => {
    if (cjobId === jobId) {
      cancelled = true
      if (currentProc) try { currentProc.kill('SIGKILL') } catch {}
    }
  }
  ipcMain.on('ffmpeg:cancel', cancelHandler)

  const cleanup = () => {
    ipcMain.removeListener('ffmpeg:cancel', cancelHandler)
    activeExports.delete(jobId)
    // NOTE: tempDir is NOT deleted here — the renderer reads the output file
    // after startExport resolves, then calls api.rmdir() to clean up.
    // Deleting here would race with the renderer readFile call.
  }

  function runFFmpeg(label, args) {
    return new Promise((resolve, reject) => {
      if (cancelled) return reject(new Error('Cancelled'))

      const logLines = []
      const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'info', ...args])
      currentProc = proc

      proc.stderr.on('data', chunk => {
        const text = chunk.toString()
        text.split('\n').forEach(line => {
          if (line.trim()) {
            logLines.push(line)
            event.sender.send('ffmpeg:log', { jobId, line, label })
          }
        })
      })

      proc.on('close', code => {
        currentProc = null
        if (cancelled) return reject(new Error('Cancelled'))
        if (code === 0) resolve(logLines)
        else reject(new Error(`FFmpeg step [${label}] exited with code ${code}\n${logLines.slice(-10).join('\n')}`))
      })

      proc.on('error', err => {
        currentProc = null
        const hint = err.code === 'ENOENT'
          ? ` — FFmpeg binary not found at "${ffmpeg}". Run "node scripts/download-ffmpeg.js" to install it.`
          : err.code === 'EACCES'
            ? ` — FFmpeg binary at "${ffmpeg}" is not executable.`
            : ''
        reject(new Error(`FFmpeg failed to start [${label}]: ${err.message}${hint}`))
      })
    })
  }

  try {
    activeExports.set(jobId, { cancel: () => { cancelled = true; if (currentProc) currentProc.kill('SIGKILL') } })

    // Execute each step sent from renderer
    // Steps are pre-built FFmpeg argument arrays with placeholder resolution handled renderer-side
    const results = []

    function resolveArgs(args) {
      const out = []
      let hwaccelInserted = false
      for (const a of args) {
        // Prepend hwaccel input args immediately before the first -i flag
        if (!hwaccelInserted && hwaccelInputArgs.length > 0 && a === '-i') {
          out.push(...hwaccelInputArgs)
          hwaccelInserted = true
        }
        if (a === '__ENCODER__')        out.push(enc.encoder)
        else if (a === '__ENC_ARGS__')  out.push(...encArgs)
        else                            out.push(a)
      }
      return out
    }

    for (const step of steps) {
      if (cancelled) throw new Error('Cancelled')

      event.sender.send('ffmpeg:stepStart', { jobId, label: step.label })
      try {
        await runFFmpeg(step.label, resolveArgs(step.args))
      } catch (err) {
        if (step.fallbackOnFail) {
          event.sender.send('ffmpeg:log', { jobId, line: step.fallbackOnFail.message || '  ↳ no audio stream — substituting silence', label: step.label })
          await runFFmpeg(step.fallbackOnFail.label, resolveArgs(step.fallbackOnFail.args))
        } else {
          throw err
        }
      }
      event.sender.send('ffmpeg:stepDone', { jobId, label: step.label })
      results.push(step.label)
    }

    return { ok: true, encoder: enc.label, hw: enc.hw, steps: results }
  } catch (err) {
    return { ok: false, error: err.message, cancelled }
  } finally {
    cleanup()
  }
})

// ─── IPC: File system helpers ─────────────────────────────────────────────────
ipcMain.handle('fs:readFile', async (_, filePath) => {
  const buf = fs.readFileSync(filePath)
  // Return as base64 so it crosses the context bridge cleanly
  return buf.toString('base64')
})

ipcMain.handle('fs:writeFile', async (_, filePath, base64Data) => {
  const buf = Buffer.from(base64Data, 'base64')
  fs.writeFileSync(filePath, buf)
  return true
})

ipcMain.handle('fs:copyFile', async (_, src, dest) => {
  fs.copyFileSync(src, dest)
  return true
})

ipcMain.handle('fs:deleteFile', async (_, filePath) => {
  try { fs.unlinkSync(filePath) } catch {}
  return true
})

ipcMain.handle('fs:exists', async (_, filePath) => {
  return fs.existsSync(filePath)
})

ipcMain.handle('fs:mkdtemp', async (_, prefix) => {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'moments_'))
})

ipcMain.handle('fs:rmdir', async (_, dirPath) => {
  try { fs.rmSync(dirPath, { recursive: true, force: true }) } catch {}
  return true
})

ipcMain.handle('fs:appResourcesPath', async () => {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
})

ipcMain.handle('fs:fontPath', async (_, fontFile) => {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', 'fonts')
    : path.join(__dirname, '..', 'public', 'ffmpeg', 'fonts')
  return path.join(base, fontFile)
})

// ─── IPC: File path from File object name (Electron can access real FS paths) ─
ipcMain.handle('fs:resolveUploadPath', async (_, { name, tmpPath }) => {
  // Renderer writes file bytes to tmpPath; we just validate it exists
  return fs.existsSync(tmpPath) ? tmpPath : null
})
