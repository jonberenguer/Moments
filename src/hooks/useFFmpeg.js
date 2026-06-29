/**
 * useFFmpeg — Electron Native FFmpeg Hook
 *
 * Replaces the WASM-based @ffmpeg/ffmpeg with native FFmpeg via Electron IPC.
 * GPU priority: NVENC (dedicated) → AMF (dedicated) → QSV (iGPU) → CPU
 *
 * The export pipeline is 100% faithful to the original WASM pipeline
 * (same stages, same filter graphs, same normalisation invariants) with
 * these key differences:
 *   - Files are written to the OS temp dir (not WASM virtual FS)
 *   - FFmpeg runs as a native child process (not WASM inside a Worker)
 *   - GPU-accelerated encoders replace libx264 where available
 *   - No -threads 1 restriction (GPU handles parallelism; CPU uses all cores)
 *   - Font files are referenced by real OS paths (no WASM FS write needed)
 *   - "Load" step is instant (no 31MB WASM binary download)
 */

import { useState, useRef, useCallback } from 'react'
import { wrapText } from '../textLayout'
import { fontFallbackText } from '../fontCoverage'

const api = window.electronAPI   // injected by preload.js

// ─── Constants (same as WASM version) ────────────────────────────────────────
const QUALITY_DIMS = {
  '480p':  { '16:9': [854,  480],  '9:16': [480,  854]  },
  '720p':  { '16:9': [1280, 720],  '9:16': [720, 1280]  },
  '1080p': { '16:9': [1920, 1080], '9:16': [1080, 1920] },
}

const XFADE_MAP = {
  crossfade: 'fade', slide_left: 'slideleft',
  slide_up:  'slideup', zoom_in: 'zoomin', dip_black: 'fadeblack',
}

const SEG_FPS       = 30
const SEG_TIMEBASE  = 90000
const SEG_PIX_FMT   = 'yuv420p'
const SEG_AUD_RATE  = 44100
const SEG_AUD_KBPS  = '128k'

export const PRESET_FONTS = [
  // Video-style display & sans faces (OFL / Google Fonts)
  { key: 'BebasNeue-Regular',       label: 'Bebas Neue',       file: 'BebasNeue-Regular.ttf',      cssFamily: 'MomBebas' },
  { key: 'Anton-Regular',           label: 'Anton',            file: 'Anton-Regular.ttf',          cssFamily: 'MomAnton' },
  { key: 'Oswald-Regular',          label: 'Oswald',           file: 'Oswald-Regular.ttf',         cssFamily: 'MomOswald' },
  { key: 'Montserrat-Regular',      label: 'Montserrat',       file: 'Montserrat-Regular.ttf',     cssFamily: 'MomMontserrat' },
  { key: 'Montserrat-Bold',         label: 'Montserrat Bold',  file: 'Montserrat-Bold.ttf',        cssFamily: 'MomMontserratBold' },
  { key: 'Roboto-Regular',          label: 'Roboto',           file: 'Roboto-Regular.ttf',         cssFamily: 'MomRoboto' },
  { key: 'Roboto-Bold',             label: 'Roboto Bold',      file: 'Roboto-Bold.ttf',            cssFamily: 'MomRobotoBold' },
  // Original bundled faces
  { key: 'Poppins-Regular',         label: 'Poppins',      file: 'Poppins-Regular.ttf',        cssFamily: 'MomPoppins' },
  { key: 'Poppins-Bold',            label: 'Poppins Bold', file: 'Poppins-Bold.ttf',           cssFamily: 'MomPoppinsBold' },
  { key: 'LiberationSans-Regular',  label: 'Sans',         file: 'LiberationSans-Regular.ttf', cssFamily: 'MomSans' },
  { key: 'LiberationSans-Bold',     label: 'Sans Bold',    file: 'LiberationSans-Bold.ttf',    cssFamily: 'MomSansBold' },
  { key: 'LiberationSerif-Regular', label: 'Serif',        file: 'LiberationSerif-Regular.ttf',cssFamily: 'MomSerif' },
  { key: 'LiberationMono-Regular',  label: 'Mono',         file: 'LiberationMono-Regular.ttf', cssFamily: 'MomMono' },
  // ── CJK-capable faces (cjk:true) ──────────────────────────────────────────
  // These cover Latin + Han/Kana/Hangul, so a CJK caption set to one of them is
  // NOT force-routed to the fallback below — the user's choice is honoured.
  // (Latin-only faces above have no CJK glyphs and drawtext does no per-glyph
  // fallback, so CJK captions in those are routed to NotoSansCJKkr.)
  { key: 'TaipeiSansTC-Regular',  label: '台北黑體 Taipei Sans',              file: 'TaipeiSansTCBeta-Regular.ttf', cssFamily: 'MomTaipeiSans', cjk: true },
  { key: 'GenSekiGothicTW-Regular', label: '源石黑體 GenSekiGothic',          file: 'GenSekiGothicTW-Regular.otf',  cssFamily: 'MomGenSeki',    cjk: true },
  { key: 'NotoSansJP-Regular',    label: 'Noto Sans Japanese',              file: 'NotoSansJP-Regular.otf',       cssFamily: 'MomNotoJP',     cjk: true },
  { key: 'NotoSansTC-Regular',    label: 'Noto Sans Traditional Chinese',   file: 'NotoSansTC-Regular.otf',       cssFamily: 'MomNotoTC',     cjk: true },
  { key: 'NotoSansSC-Regular',    label: 'Noto Sans Simplified Chinese',    file: 'NotoSansSC-Regular.otf',       cssFamily: 'MomNotoSC',     cjk: true },
  { key: 'NotoSansKR-Regular',    label: 'Noto Sans Korean',                file: 'NotoSansKR-Regular.otf',       cssFamily: 'MomNotoKR',     cjk: true },
  // Universal CJK fallback (covers Latin + Hangul + Han + kana) — OFL. Used
  // automatically for any CJK caption whose selected font has no CJK glyphs.
  { key: 'NotoSansCJKkr-Regular',   label: 'CJK (Korean/Chinese/JP)', file: 'NotoSansCJKkr-Regular.otf', cssFamily: 'MomNotoCJK', cjk: true },
]

// ─── Preview font loader (same as WASM version) ───────────────────────────────
const _loadedFonts = new Set()
export function loadPreviewFont(fontKey) {
  if (_loadedFonts.has(fontKey)) return
  const preset = PRESET_FONTS.find(f => f.key === fontKey)
  if (!preset) return
  // Base-relative URL: an absolute '/ffmpeg/…' path 404s in the packaged app,
  // which loads from file://…/dist/index.html (vite base is './'). Using
  // BASE_URL resolves correctly in both `npm run dev` and the built app.
  const base = import.meta.env.BASE_URL || './'
  const lf   = preset.file.toLowerCase()
  const fmt  = lf.endsWith('.otf') ? 'opentype' : lf.endsWith('.ttc') ? 'collection' : 'truetype'
  const style = document.createElement('style')
  style.textContent = `@font-face{font-family:'${preset.cssFamily}';src:url('${base}ffmpeg/fonts/${preset.file}') format('${fmt}');font-display:swap;}`
  document.head.appendChild(style)
  document.fonts.load(`12px '${preset.cssFamily}'`)
  _loadedFonts.add(fontKey)
}

// ─── Filter builders (identical to WASM version) ─────────────────────────────
function buildEqFilter(brightness, contrast, saturation) {
  const b = brightness || 0
  const c = contrast   || 0
  const s = saturation || 0
  if (b === 0 && c === 0 && s === 0) return null
  return `eq=brightness=${(b/50).toFixed(3)}:contrast=${(1+c/50).toFixed(3)}:saturation=${(1+s/50).toFixed(3)}`
}

function buildImageEffectVf(effect, W, H, duration) {
  if (!effect || effect === 'none') return null
  const fps    = SEG_FPS
  const frames = Math.max(2, Math.ceil(duration * fps))
  switch (effect) {
    case 'ken_burns': {
      const z = `1+(0.18*on/${frames})`
      const x = `(iw/2-(iw/zoom/2))-(iw*0.03*on/${frames})`
      const y = `(ih/2-(ih/zoom/2))-(ih*0.02*on/${frames})`
      return `scale=${W*2|0}:${H*2|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps}`
    }
    case 'fade_in': {
      const z    = `1.04-(0.04*on/${frames})`
      const x    = `iw/2-(iw/zoom/2)`
      const y    = `ih/2-(ih/zoom/2)`
      const fade = Math.min(1.2, duration * 0.4).toFixed(2)
      return `scale=${W*2|0}:${H*2|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps},fade=t=in:st=0:d=${fade}`
    }
    default: return null
  }
}

// True when a clip has a non-identity Phase A transform.
function clipHasTransform(c) {
  return (c?.scale ?? 1) !== 1 || (c?.rotation ?? 0) !== 0 || (c?.offsetX ?? 0) !== 0 || (c?.offsetY ?? 0) !== 0
}

// Phase A clip transform composite (export), mirroring the preview CSS transform
// translate(offX%,offY%) scale(S) rotate(θ): fit the media to the canvas (no pad —
// transparent letterbox), scale, rotate around centre with transparent corners,
// then overlay onto `bgLabel` at the offset (overlay clips to the canvas, matching
// the preview's overflow:hidden). Returns the filter_complex fragment producing
// [vout] from `srcLabel` (raw media input, e.g. '[0:v]') over `[bgLabel]` (W×H bg).
// `extra` = any per-clip chain (eq / speed) applied to the fitted media first.
function buildTransformOverlay(srcLabel, bgLabel, W, H, c, extra) {
  const S    = c.scale ?? 1
  const rot  = (c.rotation ?? 0) * Math.PI / 180   // CSS rotate() is clockwise; FFmpeg rotate matches
  const offX = (c.offsetX ?? 0) / 100
  const offY = (c.offsetY ?? 0) / 100
  const fit  = `scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1`
  const parts = []
  let cur = '_tf0'
  parts.push(`${srcLabel}${fit}${extra ? ',' + extra : ''},format=rgba[${cur}]`)
  if (S !== 1) { parts.push(`[${cur}]scale=iw*${S}:ih*${S}[_tfs]`); cur = '_tfs' }
  if (rot !== 0) {
    // Grow the output to the rotated bounding box (cos/sin precomputed) so corners
    // aren't clipped before the overlay; fillcolor=none keeps them transparent.
    const co = Math.abs(Math.cos(rot)).toFixed(6), si = Math.abs(Math.sin(rot)).toFixed(6)
    parts.push(`[${cur}]rotate=${rot.toFixed(6)}:fillcolor=none:ow=iw*${co}+ih*${si}:oh=iw*${si}+ih*${co}[_tfr]`); cur = '_tfr'
  }
  const ox = `(main_w-overlay_w)/2+(${offX.toFixed(6)})*main_w`
  const oy = `(main_h-overlay_h)/2+(${offY.toFixed(6)})*main_h`
  parts.push(`[${bgLabel}][${cur}]overlay=${ox}:${oy}:shortest=1,format=yuv420p[vout]`)
  return parts.join(';')
}

// Build one drawtext PER LINE of a caption, pinning each line at its baseline
// (y_align=baseline) at the exact y the preview's CSS line box renders it.
// Verified pixel-identical to the preview (offscreen-render calibration) for
// single AND multi-line. The preview centers a line-box block (line-height 1.3 ×
// N lines) on the anchor; we reproduce it from the font's metrics. fontAsc/fontDesc
// come from canvas measureText (passed from Stage 3, the same metrics the browser's
// line box uses); lineWidths are each wrapped line's width (for left/right align).
// Per-line drawtext avoids depending on FreeType's internal line pitch (which
// differs from the browser's — the cause of the earlier drift/clipping).
function buildCaptionDrawtexts(seg, W, H, fontPath, lineFiles, lineWidths, fontAsc, fontDesc) {
  const fontSize = Math.round((seg.fontSize || 60) * (W / 1280))
  const color    = (seg.color || '#ffffff').replace('#', '')
  const N        = lineFiles.length
  const lineHeightPx = 1.3 * fontSize           // matches Preview CSS line-height:1.3
  const margin   = Math.round(14 * (H / 720))   // matches preview pos_bottom/top (14px, scaled)
  const blockH   = N * lineHeightPx

  // Block anchor per position — mirrors Preview.jsx: custom centres the block on
  // (posX%,posY%); presets centre horizontally and pin top/centre/bottom.
  const pos = seg.position || 'bottom'
  let blockTop, blockCx
  if (pos === 'custom')      { blockCx = W * ((seg.posX ?? 50) / 100); blockTop = H * ((seg.posY ?? 85) / 100) - blockH / 2 }
  else if (pos === 'top')    { blockCx = W / 2; blockTop = margin }
  else if (pos === 'center') { blockCx = W / 2; blockTop = (H - blockH) / 2 }
  else                       { blockCx = W / 2; blockTop = H - margin - blockH }   // bottom

  // First line's baseline from the block top = CSS half-leading + font ascent.
  const halfLeading   = (lineHeightPx - (fontAsc + fontDesc)) / 2
  const firstBaseline = blockTop + halfLeading + fontAsc
  const blockW        = Math.max(1, ...lineWidths)

  const tStart    = (seg.startTime || 0).toFixed(4)
  // endTime is not stored on segments — derive it from startTime + duration.
  const tEndRaw   = seg.endTime != null
    ? seg.endTime
    : seg.duration != null
      ? (seg.startTime || 0) + seg.duration
      : 1e9
  const tEnd      = tEndRaw.toFixed(4)

  // Map seg.animation to an FFmpeg alpha expression.
  // 'fade'       — fade in over first 0.4s, fade out over last 0.4s of the segment window.
  // 'slide'      — FFmpeg drawtext has no native slide; use the same fade as a graceful fallback.
  // 'typewriter' — no per-character control in drawtext; fade fallback.
  // (none/other) — fully opaque for the entire enabled window.
  const anim = seg.animation || 'none'
  const fadeDur = 0.4
  let alphaExpr
  if (anim === 'fade' || anim === 'slide' || anim === 'typewriter') {
    alphaExpr =
      `if(lt(t,${tStart}+${fadeDur.toFixed(2)}),` +
        `(t-${tStart})/${fadeDur.toFixed(2)},` +
        `if(gt(t,${tEnd}-${fadeDur.toFixed(2)}),` +
          `(${tEnd}-t)/${fadeDur.toFixed(2)},` +
          `1))`
  } else {
    alphaExpr = '1'
  }
  // Constant per-caption opacity (0–100 → 0–1) multiplied into the alpha so it
  // composes with the fade animation. Mirrors the preview's CSS opacity.
  const opacity = Math.max(0, Math.min(1, (seg.opacity ?? 100) / 100))
  if (opacity < 1) alphaExpr = `(${alphaExpr})*${opacity.toFixed(3)}`
  // Optional drop shadow (hard offset; no blur in drawtext). Offset scales with
  // font size so it looks consistent across resolutions.
  const shadowPart = seg.shadow === false
    ? ''
    : `:shadowcolor=black@0.75:shadowx=${Math.max(1, Math.round(fontSize * 0.06))}:shadowy=${Math.max(1, Math.round(fontSize * 0.06))}`
  // Optional outline (border) around the glyphs — crisper than the shadow.
  const borderPart = seg.outline
    ? `:borderw=${Math.max(1, Math.round(fontSize * 0.04))}:bordercolor=black`
    : ''
  // Escape a real OS path for FFmpeg's drawtext filter syntax.
  // Rules (applied in order):
  //   1. Normalise backslashes to forward slashes (FFmpeg accepts both on Windows)
  //   2. Escape Windows drive-letter colon: C:/... → C\:/...
  //      The colon is FFmpeg's filter option separator; it must be escaped even
  //      inside single-quoted values — quotes do NOT protect colons here.
  //   3. Escape any single quotes in the path itself
  const escPath = (pth) => pth
    .replace(/\\/g, '/')          // backslash → forward slash
    .replace(/^([A-Za-z]):/, '$1\\:')  // C: → C\:  (drive letter only)
    .replace(/'/g, "\\'")         // escape single quotes
  // The caption text is supplied via `textfile=` (a real file written to the temp
  // dir), NOT inlined as `text='…'`. This sidesteps the whole class of two-level
  // filtergraph escaping bugs for the text content itself — apostrophes, colons,
  // commas, brackets, % — which previously broke the *entire* -vf chain (one bad
  // caption dropped ALL overlays via the s3 fallback). Only the file path needs
  // escaping now, handled by escPath() exactly like the font path.
  // Alignment → per-line x: centre each line on the anchor, or pin to the block's
  // left/right edge (blockW = widest line). expansion=none keeps bytes literal.
  const talign = (seg.textAlign === 'left' || seg.textAlign === 'right') ? seg.textAlign : 'center'
  // One drawtext per line, each pinned at its baseline (y_align=baseline) at the y
  // the preview renders it — see the calibration note on the function header.
  return lineFiles.map((lf, i) => {
    const baseline = Math.round(firstBaseline + i * lineHeightPx)
    let x
    if (talign === 'left')        x = `${Math.round(blockCx - blockW / 2)}`
    else if (talign === 'right')  x = `${Math.round(blockCx + blockW / 2)}-text_w`
    else                          x = `${Math.round(blockCx)}-text_w/2`
    return (
      `drawtext=fontfile='${escPath(fontPath)}':textfile='${escPath(lf)}':expansion=none:` +
      `fontsize=${fontSize}:fontcolor=${color}${shadowPart}${borderPart}:` +
      `y_align=baseline:x=${x}:y=${baseline}:` +
      `alpha='${alphaExpr}':enable='between(t,${tStart},${tEnd})'`
    )
  })
}

function buildAtempoChain(speed) {
  if (speed === 1) return []
  const chain = []
  let s = speed
  while (s > 2.0) { chain.push('atempo=2.0'); s /= 2.0 }
  while (s < 0.5) { chain.push('atempo=0.5'); s /= 0.5 }
  chain.push(`atempo=${s.toFixed(6)}`)
  return chain
}

// ─── Helpers: write File/Blob or Uint8Array to real OS path ──────────────────
function fileToBase64(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result.split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(fileOrBlob)
  })
}

async function writeFileToPath(fileOrBlob, destPath) {
  const b64 = await fileToBase64(fileOrBlob)
  await api.writeFile(destPath, b64)
}

async function writeUint8ToPath(uint8, destPath) {
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < uint8.length; i += chunk)
    binary += String.fromCharCode(...uint8.subarray(i, i + chunk))
  await api.writeFile(destPath, btoa(binary))
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useFFmpeg() {
  const runningRef  = useRef(false)
  const loadingRef  = useRef(false)
  const jobIdRef    = useRef(null)

  const [loaded,   setLoaded]   = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [progress, setProgress] = useState(0)
  const [etaSeconds, setEtaSeconds] = useState(null)
  const [logs,     setLogs]     = useState([])
  const [encoder,  setEncoder]  = useState(null)
  const [gpuCaps,  setGpuCaps]  = useState(null)
  const [encoderOverride, setEncoderOverride] = useState('auto')

  const allLogsRef = useRef([])

  const pushLog = useCallback(msg => {
    allLogsRef.current = [...allLogsRef.current.slice(-500), msg]
    setLogs(p => [...p.slice(-300), msg])
  }, [])

  const clearLogs = useCallback(() => { allLogsRef.current = []; setLogs([]) }, [])

  // ── Load: detect GPU (replaces WASM 31 MB download) ──────────────────────
  const load = useCallback(async () => {
    if (loadedRef.current || loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    pushLog('Detecting GPU capabilities…')
    try {
      const caps = await api.detectGPU()
      setGpuCaps(caps)
      const enc = caps.nvenc    ? 'NVENC (GPU)'
                : caps.amf      ? 'AMF (GPU)'
                : caps.qsv      ? 'QSV (iGPU)'
                : caps.v4l2m2m  ? 'V4L2M2M (HW)'
                :                 'CPU (libx264)'
      setEncoder(enc)
      pushLog(`Encoder ready: ${enc} ✓`)
      setLoaded(true)
    } catch (err) {
      pushLog(`GPU detection failed: ${err?.message || err} — falling back to CPU`)
      setLoaded(true)
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [pushLog])

  const loadedRef = useRef(false)

  const cancelExport = useCallback(() => {
    if (jobIdRef.current) api.cancelExport(jobIdRef.current)
  }, [])

  const resetGPU = useCallback(async () => {
    loadedRef.current = false
    setLoaded(false)
    await api.resetGPU()
    await load()
  }, [load])

  // ── Main export pipeline ──────────────────────────────────────────────────
  const exportMoment = useCallback(async ({
    clips,
    textSegments       = [],
    musicFile,
    musicVolume        = 70,
    musicTrimStart     = 0,
    musicTrimEnd       = null,
    aspectRatio        = '16:9',
    quality            = '720p',
    globalTransition   = 'crossfade',
    transitionDuration = 0.6,
    endFadeVideo       = false,
    endFadeVideoDuration = 1.5,
    endFadeAudio       = false,
    endFadeAudioDuration = 1.5,
    outputName         = 'moment.mp4',
    exportQuality      = 'balanced',
    exportBitrate      = null,
    exportFormat       = 'mp4',          // 'mp4' | 'webm' | 'gif'
    webmAudioCodec     = 'libopus',      // resolved from FFmpeg caps (libopus|libvorbis|null)
    onProgress,
    encoderOverride: encOvr = 'auto',
  }) => {
    if (runningRef.current) throw new Error('Export already in progress')
    runningRef.current = true
    setProgress(0)
    setEtaSeconds(null)

    const jobId = `export_${Date.now()}`
    jobIdRef.current = jobId
    const [W, H] = QUALITY_DIMS[quality]?.[aspectRatio] ?? [1280, 720]

    // Separator for paths (platform-aware, but we always use forward slashes in FFmpeg args)
    const tmpDir = await api.mkdtemp('moments_export_')
    const SEP    = api.platform === 'win32' ? '\\' : '/'
    const p      = (name) => `${tmpDir}${SEP}${name}`
    // FFmpeg always gets forward-slash paths even on Windows
    const fp     = (name) => p(name).replace(/\\/g, '/')

    const steps   = []
    const segments = []
    const clipDurByIndex = {}   // i → clip output seconds, for progress weighting
    const td       = Math.max(0.1, transitionDuration)
    // Per-clip transition duration (after this clip); falls back to the global
    // `td`. Returns 0 when the boundary is a hard cut ('none'). Mirrors the
    // store's exportDuration / timeline math so preview length == export length.
    const tdFor = (clip) => {
      const t = clip?.transition || globalTransition
      return t === 'none' ? 0 : Math.max(0.1, clip?.transitionDuration ?? td)
    }

    // ── Real progress + ETA ─────────────────────────────────────────────────
    // Each step carries a `weight` = the seconds of media it processes (clip
    // output length for Stage-1 encodes, the full timeline for Stage 2/3/4).
    // FFmpeg prints `time=HH:MM:SS.ms` on stderr (streamed here via onLog), so we
    // map the current step's time= onto its weight and sum across completed
    // steps for an accurate overall bar — far better than the old "advance as
    // steps are *queued*" counter. weightByLabel/totalWeight are filled in once
    // the step list is built (below), before main starts executing it.
    const weightByLabel   = {}
    let   totalWeight     = 0
    let   completedWeight = 0
    let   curWeight       = 0
    const exportStartMs   = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/
    const reportProgress = (within) => {
      const processed = totalWeight > 0 ? Math.min(totalWeight, completedWeight + within) : 0
      const pct = totalWeight > 0 ? Math.min(99, Math.round((processed / totalWeight) * 100)) : 0
      setProgress(pct); onProgress?.(pct)
      const elapsed = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - exportStartMs) / 1000
      if (processed > 0.25 && elapsed > 1.5) {
        const rate = processed / elapsed                 // weight-seconds per real second
        setEtaSeconds(rate > 0 ? Math.max(0, (totalWeight - processed) / rate) : null)
      }
    }

    // Subscribe to IPC events for real-time logging + progress
    const unsubLog = api.onLog(({ line }) => {
      pushLog(`  ${line}`)
      const m = TIME_RE.exec(line)
      if (m) reportProgress(Math.min(curWeight, (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])))
    })
    const unsubStep = api.onStepStart(({ label }) => {
      pushLog(`▶ ${label}`)
      curWeight = weightByLabel[label] || 0
    })
    const unsubDone = api.onStepDone(({ label }) => {
      pushLog(`  ✓ ${label}`)
      completedWeight = Math.min(totalWeight, completedWeight + (weightByLabel[label] || 0))
      curWeight = 0
      reportProgress(0)
    })
    const unsubEncoder = api.onEncoderInfo(({ encoder: enc, hw }) => {
      setEncoder(enc)
      pushLog(`Using encoder: ${enc}${hw ? ' 🚀' : ''}`)
    })

    const cleanup = () => {
      unsubLog(); unsubStep(); unsubDone(); unsubEncoder()
      jobIdRef.current  = null
      runningRef.current = false
      loadedRef.current  = true  // keep loaded=true, ready for next export
      api.rmdir(tmpDir).catch(() => {})
    }

    try {
      pushLog(`── Export ${W}×${H} · ${quality} · ${aspectRatio} ──`)

      // ── Resolve font paths from bundled resources ─────────────────────
      const fontPathCache = {}
      for (const preset of PRESET_FONTS) {
        fontPathCache[preset.key] = await api.fontPath(preset.file)
      }

      const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','heic','avif'])

      // ── Validate and write source files to temp dir ───────────────────
      pushLog('Preparing clip list…')
      const validClips = []
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i]
        if (!c.file) { pushLog(`  ⚠ Skipping "${c.name}" — no file`); continue }
        const ext = c.file.name.split('.').pop().toLowerCase()
        // Use validClips.length as the index so that src_N.ext, aud_N.aac, and
        // seg_N.mp4 all share the same N — even when earlier clips were skipped.
        // Using the original loop index `i` would misalign audio and video steps
        // when any clip is skipped (e.g. after a workflow load before files are re-added).
        const vi    = validClips.length
        const fname = `src_${vi}.${ext}`
        validClips.push({ ...c, _fname: fname, _ext: ext, _isImg: IMAGE_EXTS.has(ext) })
      }
      if (validClips.length === 0) throw new Error('No clips with files to export')

      pushLog('Writing source files…')
      for (const c of validClips) {
        await writeFileToPath(c.file, p(c._fname))
        pushLog(`  wrote ${c._fname}  (${(c.file.size/1024).toFixed(0)} KB)`)
      }
      if (musicFile) {
        await writeFileToPath(musicFile, p('music_src'))
        pushLog('  music_src written')
      }

      pushLog(`${validClips.length} clip(s) ready`)

      // ══════════════════════════════════════════════════════════════════
      // STAGE 1 — Encode each clip → normalised seg_N.mp4
      // ══════════════════════════════════════════════════════════════════
      pushLog('── Stage 1: Encoding clips ──')

      // Longest transition in use — every segment is padded to at least this
      // (+0.5s) so per-clip xfades always have room to overlap on both sides.
      const maxTd = validClips.reduce((m, c) => Math.max(m, tdFor(c)), td)

      for (let i = 0; i < validClips.length; i++) {
        const c = validClips[i]
        const eqFilter = buildEqFilter(c.brightness, c.contrast, c.saturation)

        let actualDur
        if (c._isImg) {
          actualDur = Math.max(maxTd + 0.5, c.duration || 4)
        } else {
          const spd = c.speed > 0 ? c.speed : 1
          const ts  = c.trimStart || 0
          const te  = (c.trimEnd && c.trimEnd > ts) ? c.trimEnd : (c.fileDuration || c.duration || 4)
          actualDur = Math.max(maxTd + 0.5, (te - ts) / spd)
        }
        const durStr  = actualDur.toFixed(4)
        const segFile = `seg_${i}.mp4`
        clipDurByIndex[i] = actualDur   // progress weighting (Stage-1 steps tagged [i])

        pushLog(`\n  ┌─ [${i+1}/${validClips.length}] "${c.name}" — ${c._isImg ? 'IMAGE' : 'VIDEO'} — ${actualDur.toFixed(2)}s`)

        if (c._isImg) {
          // Compute effect vf once — used by both the blur and non-blur paths.
          // Ken Burns and a clip transform are mutually exclusive — a transform wins.
          const effectVf = clipHasTransform(c) ? null : buildImageEffectVf(c.imageEffect, W, H, actualDur)

          if (c.blurBackground) {
            // ── BLUR BACKGROUND ──────────────────────────────────────────
            // bg: scale source to FILL canvas → crop centre → boxblur → [_bg]
            // fg: scale source to FIT canvas (letterboxed, NO padding) → [_feven]
            //     overlay centres fg over blur; blurred bg shows through bars.
            // NOTE: do NOT pad fg to W×H — that collapses the overlay offset to 0.
            //
            // When imageEffect is also set we need two separate FFmpeg passes:
            //   pass A  blur filter_complex  → img_base_i.mp4  (W×H, 30fps CFR)
            //   pass B  -vf effectVf         → seg_i.mp4
            // Combining filter_complex + a zoompan -vf in one command isn't
            // possible; splitting into two passes also lets zoompan see a proper
            // 30fps video input so its `on` frame counter advances correctly.
            const blurOut = effectVf ? `img_base_${i}.mp4` : segFile

            const bgChain = `[_bg0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=20:luma_power=2[_bg]`
            let blurFc
            if (clipHasTransform(c)) {
              // blur bg + transformed fg (scale/rotate/move over the blur, offset).
              // Transform excludes Ken Burns, so this is single-pass → segFile.
              blurFc = [`[0:v]split=2[_bg0][_fg0]`, bgChain, buildTransformOverlay('[_fg0]', '_bg', W, H, c, eqFilter)].join(';')
            } else {
              const fgNodes = [
                `[_fg0]scale=${W}:${H}:force_original_aspect_ratio=decrease[_ffit]`,
                `[_ffit]scale=trunc(iw/2)*2:trunc(ih/2)*2[_feven]`,
              ]
              const fgOut   = eqFilter ? `[_feven]${eqFilter}[_fpadded]` : null
              const finalFg = eqFilter ? '[_fpadded]' : '[_feven]'
              blurFc = [
                `[0:v]split=2[_bg0][_fg0]`,
                bgChain,
                ...fgNodes,
                ...(fgOut ? [fgOut] : []),
                `[_bg]${finalFg}overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[vout]`,
              ].join(';')
            }

            steps.push({
              label: `img-blur[${i}]`,
              args: [
                '-loop', '1', '-i', fp(c._fname),
                '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
                '-filter_complex', blurFc,
                '-map', '[vout]', '-map', '1:a',
                '-t', durStr,
                '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
                '-r', String(SEG_FPS), '-fps_mode', 'cfr',
                '-video_track_timescale', String(SEG_TIMEBASE),
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-t', durStr, '-y', fp(blurOut),
              ],
            })

            if (effectVf) {
              // ── EFFECT pass (reads blur output, writes seg) ──────────
              // Input is an already-encoded 30fps CFR video — no -r needed.
              // eq was already applied in the blur pass so only effectVf here.
              steps.push({
                label: `img-effect[${i}]`,
                args: [
                  '-i', fp(blurOut),
                  '-vf', effectVf,
                  '-map', '0:v:0', '-map', '0:a:0',
                  '-t', durStr,
                  '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
                  '-r', String(SEG_FPS), '-fps_mode', 'cfr',
                  '-video_track_timescale', String(SEG_TIMEBASE),
                  '-c:a', 'copy',
                  '-t', durStr, '-y', fp(segFile),
                ],
              })
            }

            segments.push({ file: segFile, actualDur, clip: c })
            continue
          }

          if (clipHasTransform(c)) {
            // ── Transform: scale/rotate/move over a black canvas ─────────
            // Ken Burns (effectVf) is mutually exclusive with a transform → skipped.
            const fc = `color=c=black:s=${W}x${H}:r=${SEG_FPS}[_tfbg];`
              + buildTransformOverlay('[0:v]', '_tfbg', W, H, c, eqFilter)
            steps.push({
              label: `img-tf[${i}]`,
              args: [
                '-loop', '1', '-r', String(SEG_FPS), '-i', fp(c._fname),
                '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
                '-filter_complex', fc,
                '-map', '[vout]', '-map', '1:a:0',
                '-t', durStr,
                '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
                '-r', String(SEG_FPS), '-fps_mode', 'cfr',
                '-video_track_timescale', String(SEG_TIMEBASE),
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-t', durStr, '-y', fp(segFile),
              ],
            })
            segments.push({ file: segFile, actualDur, clip: c })
          } else {
          // ── Non-blur: fit → pad → optional effect/EQ ─────────────────
          // Use -vf (simple filtergraph) with -r as input option so the image
          // loop generates frames at the correct rate before reaching zoompan.
          // Embedding effectVf inside filter_complex caused zoompan's `on`
          // counter to not advance, producing a static (no animation) output.
          const placeVf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=${W}:${H}:-1:-1:color=black,setsar=1`
          const vfChain = [placeVf, effectVf, eqFilter].filter(Boolean).join(',')

          steps.push({
            label: `img-place[${i}]`,
            args: [
              '-loop', '1', '-r', String(SEG_FPS), '-i', fp(c._fname),
              '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
              '-vf', vfChain,
              '-map', '0:v:0', '-map', '1:a:0',
              '-t', durStr,
              '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
              '-r', String(SEG_FPS), '-fps_mode', 'cfr',
              '-video_track_timescale', String(SEG_TIMEBASE),
              '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
              '-t', durStr, '-y', fp(segFile),
            ],
          })
          segments.push({ file: segFile, actualDur, clip: c })
          }

        } else {
          // ── VIDEO: audio extraction + placement encode ────────────────
          const spd     = c.speed > 0 ? c.speed : 1
          const ts      = c.trimStart || 0
          const te      = (c.trimEnd && c.trimEnd > ts) ? c.trimEnd : (c.fileDuration || c.duration || 4)
          const srcDur  = te - ts
          const audOut  = `aud_${i}.aac`
          const speedVf = spd !== 1 ? `setpts=${(1/spd).toFixed(6)}*PTS` : null

          const silenceStep = {
            label: `vid-sil[${i}]`,
            args: [
              '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
              '-t', durStr, '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
              '-y', fp(audOut),
            ],
          }
          if (c.includeAudio !== false) {
            const atempoArgs = buildAtempoChain(spd)
            steps.push({
              label: `vid-aud[${i}]`,
              args: [
                '-ss', String(ts), '-i', fp(c._fname), '-t', String(srcDur),
                '-map', '0:a:0',
                ...(atempoArgs.length ? ['-filter:a', atempoArgs.join(',')] : []),
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-t', durStr, '-y', fp(audOut),
              ],
              fallbackOnFail: silenceStep,
            })
          } else {
            steps.push(silenceStep)
          }

          if (c.blurBackground) {
            // ── BLUR BACKGROUND (VIDEO): single-pass filter_complex ──────
            // fg: fit → even-align (stays at letterbox size, NO pad) → optional speed/eq
            // overlay centres fg over full-canvas blur; bars show blur behind them.
            // NOTE: do NOT pad the fg to W×H — see image blur path comment.
            const bgChain = `[_bg0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=20:luma_power=2[_bg]`
            let blurFc
            if (clipHasTransform(c)) {
              // blur bg + transformed fg (speed/eq applied first, then scale/rotate/move).
              const extra = [speedVf, eqFilter].filter(Boolean).join(',')
              blurFc = [`[0:v]split=2[_bg0][_fg0]`, bgChain, buildTransformOverlay('[_fg0]', '_bg', W, H, c, extra)].join(';')
            } else {
              const fgNodes = [
                `[_fg0]scale=${W}:${H}:force_original_aspect_ratio=decrease[_ffit]`,
                `[_ffit]scale=trunc(iw/2)*2:trunc(ih/2)*2[_feven]`,
              ]
              const vidFgChain = ['[_feven]']
              if (speedVf)  vidFgChain.push(speedVf)
              if (eqFilter) vidFgChain.push(eqFilter)
              const hasExtra = speedVf || eqFilter
              if (hasExtra) {
                fgNodes.push(vidFgChain.join(',') + '[_fgfinal]')
              }
              const finalFg = hasExtra ? '[_fgfinal]' : '[_feven]'
              blurFc = [
                `[0:v]split=2[_bg0][_fg0]`,
                bgChain,
                ...fgNodes,
                `[_bg]${finalFg}overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[vout]`,
              ].join(';')
            }

            steps.push({
              label: `vid-place[${i}]`,
              args: [
                '-ss', String(ts), '-i', fp(c._fname), '-t', String(srcDur),
                '-i', fp(audOut),
                '-filter_complex', blurFc,
                '-map', '[vout]', '-map', '1:a',
                '-t', durStr,
                '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
                '-r', String(SEG_FPS), '-fps_mode', 'cfr',
                '-video_track_timescale', String(SEG_TIMEBASE),
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-t', durStr, '-y', fp(segFile),
              ],
            })
            segments.push({ file: segFile, actualDur, clip: c })
          } else if (clipHasTransform(c)) {
            // ── Transform video: scale/rotate/move over a black canvas ────
            const extra = [speedVf, eqFilter].filter(Boolean).join(',')
            const fc = `color=c=black:s=${W}x${H}:r=${SEG_FPS}[_tfbg];`
              + buildTransformOverlay('[0:v]', '_tfbg', W, H, c, extra)
            steps.push({
              label: `vid-tf[${i}]`,
              args: [
                '-ss', String(ts), '-i', fp(c._fname), '-t', String(srcDur),
                '-i', fp(audOut),
                '-filter_complex', fc,
                '-map', '[vout]', '-map', '1:a',
                '-t', durStr,
                '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
                '-r', String(SEG_FPS), '-fps_mode', 'cfr',
                '-video_track_timescale', String(SEG_TIMEBASE),
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-y', fp(segFile),
              ],
            })
            segments.push({ file: segFile, actualDur, clip: c })
          } else {
            // ── Non-blur video: fit → pad → speed/eq ─────────────────────
            const fitVf   = `scale=${W}:${H}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=${W}:${H}:-1:-1:color=black,setsar=1`
            const vfParts = [fitVf, speedVf, eqFilter].filter(Boolean)
            steps.push({
              label: `vid-place[${i}]`,
              args: [
                '-ss', String(ts), '-i', fp(c._fname), '-t', String(srcDur),
                '-i', fp(audOut),
                '-vf', vfParts.join(','),
                '-map', '0:v:0', '-map', '1:a',
                '-t', durStr,
                '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
                '-r', String(SEG_FPS), '-fps_mode', 'cfr',
                '-video_track_timescale', String(SEG_TIMEBASE),
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-y', fp(segFile),
              ],
            })
            segments.push({ file: segFile, actualDur, clip: c })
          }
        }

        pushLog(`  ✓ Clip ${i+1}/${validClips.length} queued`)
      }

      // ══════════════════════════════════════════════════════════════════
      // STAGE 2 — Transitions + music → prefinal.mp4
      // ══════════════════════════════════════════════════════════════════
      const hasMusicFile = !!musicFile
      const multiClip    = segments.length > 1
      const preFinal     = 'prefinal.mp4'
      const musicTrimFilter = (musicTrimStart > 0 || musicTrimEnd != null)
        ? `atrim=start=${musicTrimStart}${musicTrimEnd != null ? `:end=${musicTrimEnd}` : ''},asetpts=PTS-STARTPTS,`
        : ''
      const allCuts = multiClip && !hasMusicFile && segments.every(s => (s.clip.transition || globalTransition) === 'none')

      if (allCuts) {
        // Concat demuxer path: write playlist as text, then pass path to main process
        const playlist = segments.map(s => `file '${fp(s.file)}'`).join('\n')
        const playlistPath = p('concat_list.txt')
        await api.writeFile(playlistPath, btoa(unescape(encodeURIComponent(playlist))))
        steps.push({ label: 's2-concat', args: ['-f', 'concat', '-safe', '0', '-i', fp('concat_list.txt'), '-c', 'copy', '-y', fp(preFinal)] })

      } else if (!multiClip && !hasMusicFile) {
        steps.push({ label: 's2-copy', args: ['-i', fp(segments[0].file), '-c', 'copy', '-y', fp(preFinal)] })

      } else if (!multiClip && hasMusicFile) {
        const mv = Math.max(0, Math.min(1, (musicVolume ?? 70) / 100)).toFixed(3)
        steps.push({
          label: 's2-music',
          args: ['-i', fp(segments[0].file), '-i', fp('music_src'), '-filter_complex',
            `[0:a]volume=1.0[ca];[1:a]${musicTrimFilter}volume=${mv}[ma];[ca][ma]amix=inputs=2:duration=first[aout]`,
            '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-shortest', '-y', fp(preFinal)],
        })

      } else {
        const segInputs = segments.flatMap(s => ['-i', fp(s.file)])
        const vParts = [], aParts = []
        let vLabel = '[0:v]', aLabel = '[0:a]', timeOff = 0

        for (let i = 0; i < segments.length - 1; i++) {
          const last = i === segments.length - 2
          const vOut = last ? '[vfinal]' : `[xv${i}]`
          const aOut = last ? '[afinal]' : `[xa${i}]`
          const ct   = segments[i].clip.transition || globalTransition

          if (ct === 'none') {
            if (last) {
              vParts.push(`${vLabel}[${i+1}:v]concat=n=2:v=1:a=0${vOut}`)
              aParts.push(`${aLabel}[${i+1}:a]concat=n=2:v=0:a=1${aOut}`)
            } else {
              const vTmp = `[cv${i}]`, aTmp = `[ca${i}]`
              vParts.push(`${vLabel}[${i+1}:v]concat=n=2:v=1:a=0${vTmp}`)
              vParts.push(`${vTmp}settb=1/${SEG_TIMEBASE},setpts=PTS${vOut}`)
              aParts.push(`${aLabel}[${i+1}:a]concat=n=2:v=0:a=1${aTmp}`)
              aParts.push(`${aTmp}asetpts=PTS${aOut}`)
            }
            timeOff += segments[i].actualDur
          } else {
            const xfName = XFADE_MAP[ct] || 'fade'
            const tdi    = tdFor(segments[i].clip)   // per-clip duration, falls back to global
            timeOff += segments[i].actualDur - tdi
            vParts.push(`${vLabel}[${i+1}:v]xfade=transition=${xfName}:duration=${tdi}:offset=${timeOff.toFixed(4)}${vOut}`)
            aParts.push(`${aLabel}[${i+1}:a]acrossfade=d=${tdi.toFixed(4)}${aOut}`)
          }
          vLabel = vOut; aLabel = aOut
        }

        if (hasMusicFile) {
          const mv = Math.max(0, Math.min(1, (musicVolume ?? 70) / 100)).toFixed(3)
          const N  = segments.length
          steps.push({
            label: 's2-xfade+music',
            args: [...segInputs, '-i', fp('music_src'), '-filter_complex',
              [...vParts, ...aParts, `[afinal]volume=1.0[cv];[${N}:a]${musicTrimFilter}volume=${mv}[mv];[cv][mv]amix=inputs=2:duration=first[mixout]`].join(';'),
              '-map', '[vfinal]', '-map', '[mixout]',
              '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
              '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-shortest', '-y', fp(preFinal)],
          })
        } else {
          steps.push({
            label: 's2-xfade',
            args: [...segInputs, '-filter_complex', [...vParts, ...aParts].join(';'),
              '-map', '[vfinal]', '-map', '[afinal]',
              '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
              '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-y', fp(preFinal)],
          })
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // STAGE 3 — Text overlays → output.mp4
      // Native FFmpeg: font paths are real OS paths, no FS write needed
      // ══════════════════════════════════════════════════════════════════
      const activeSegs = textSegments.filter(s => s.text?.trim())
      if (activeSegs.length > 0) {
        // Write each DISTINCT custom font to its own temp file, keyed by the
        // content-stable family — so captions using different uploaded fonts each
        // get the right face (the old single font_custom.ttf overwrote and the
        // last one won). Reused fonts (same family) are written once.
        for (const seg of activeSegs) {
          if (seg.fontFile === 'custom' && seg.customFontData) {
            const fam = seg.customFontFamily || 'MomCustomFont'
            const cacheKey = `custom:${fam}`
            if (!fontPathCache[cacheKey]) {
              const fname = `font_${fam}.ttf`
              await writeUint8ToPath(seg.customFontData.slice(), p(fname))
              fontPathCache[cacheKey] = fp(fname)
            }
          }
        }

        // Resolve the render font per caption (with CJK routing) up front, so the
        // SAME family drives both the wrap measurement and the drawtext render.
        // CJK fallback: preset Latin faces (and most custom fonts) have no
        // Korean/Chinese/Japanese glyphs, and drawtext does no per-glyph fallback,
        // so such captions would export blank — route them to the bundled CJK font.
        const presetByKey = Object.fromEntries(PRESET_FONTS.map(f => [f.key, f]))
        const resolved = activeSegs.map(seg => {
          // Honor the SELECTED font — no silent cross-font substitution. Any
          // codepoint the font can't render is sanitized to □ (tofu), exactly as
          // the preview does (shared fontFallbackText), so drawtext (which has no
          // per-glyph fallback) produces the same result the user saw.
          const key = seg.fontFile || 'Poppins-Regular'
          const family = key === 'custom'
            ? (seg.customFontFamily || 'MomCustomFont')
            : (presetByKey[key]?.cssFamily || 'sans-serif')
          const dispText = fontFallbackText(seg.text || '', seg, presetByKey[key]?.cjk)
          return { seg, key, family, dispText }
        })
        // Make sure each measuring font is registered/loaded in the renderer before
        // wrapText measures — otherwise measureText uses a fallback face and the
        // export would wrap differently from the preview.
        for (const r of resolved) if (r.key !== 'custom') loadPreviewFont(r.key)
        try { await document.fonts.ready } catch { /* best-effort */ }

        // Per caption: wrap into lines (shared algorithm = same breaks as the
        // preview), measure the font metrics + line widths the preview's CSS line
        // box uses, write each line to its own UTF-8 file, and build one
        // baseline-pinned drawtext per line. textfile= (not inline text=) keeps
        // special chars from breaking the -vf chain.
        const measCtx = document.createElement('canvas').getContext('2d')
        const allDrawtexts = []
        for (let ci = 0; ci < resolved.length; ci++) {
          const { seg, key, family, dispText } = resolved[ci]
          const lines = wrapText(dispText, family, seg.fontSize || 60, seg.boxWidth ?? 80)
          const fontSizeExport = Math.round((seg.fontSize || 60) * (W / 1280))
          measCtx.font = `${fontSizeExport}px ${family}`
          const fm = measCtx.measureText('Mg')
          // fontBoundingBox = the line-box metrics the browser uses; fall back to
          // rough ratios if the face isn't loaded (export without a prior preview).
          const fontAsc  = fm.fontBoundingBoxAscent  || fontSizeExport * 0.80
          const fontDesc = fm.fontBoundingBoxDescent || fontSizeExport * 0.20
          const lineWidths = lines.map(l => measCtx.measureText(l).width)
          const lineFiles = []
          for (let i = 0; i < lines.length; i++) {
            const tname = `text_${ci}_${i}.txt`
            await api.writeFile(p(tname), btoa(unescape(encodeURIComponent(lines[i]))))
            lineFiles.push(fp(tname))
          }
          const customKey = `custom:${seg.customFontFamily || 'MomCustomFont'}`
          const fontPath = (key === 'custom' && fontPathCache[customKey])
            ? fontPathCache[customKey]
            : (fontPathCache[key] || fontPathCache['Poppins-Regular'])
          allDrawtexts.push(...buildCaptionDrawtexts(seg, W, H, fontPath, lineFiles, lineWidths, fontAsc, fontDesc))
        }
        const vfChain = allDrawtexts.join(',')

        steps.push({
          label: 's3-text',
          args: [
            '-i', fp(preFinal),
            '-vf', vfChain,
            '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__',
            '-c:a', 'copy', '-y', fp('output.mp4'),
          ],
          // If the bundled FFmpeg lacks the `drawtext` filter (e.g. johnvansickle
          // static builds, which omit it despite enabling libfreetype), the text
          // pass fails. Rather than abort the whole export, fall back to copying
          // the video through without overlays and surface a clear message.
          fallbackOnFail: {
            label: 's3-text-fallback',
            args: ['-i', fp(preFinal), '-c', 'copy', '-y', fp('output.mp4')],
            message: '  ↳ text overlays skipped — this FFmpeg build has no "drawtext" filter. Use a BtbN/libfreetype build to render text.',
          },
        })
      } else {
        steps.push({ label: 's3-copy', args: ['-i', fp(preFinal), '-c', 'copy', '-y', fp('output.mp4')] })
      }

      // ══════════════════════════════════════════════════════════════════
      // STAGE 4 — End fade
      // ══════════════════════════════════════════════════════════════════
      const preWebFile = endFadeVideo || endFadeAudio ? 'output_final.mp4' : 'output.mp4'
      if (endFadeVideo || endFadeAudio) {
        const totalEncDur = segments.reduce((s, x) => s + x.actualDur, 0)
          - segments.slice(0, -1).reduce((s, x) => s + tdFor(x.clip), 0)
        const vfd = Math.min(endFadeVideoDuration, totalEncDur)
        const afd = Math.min(endFadeAudioDuration, totalEncDur)
        const fadeArgs = ['-i', fp('output.mp4')]
        if (endFadeVideo) fadeArgs.push('-vf', `fade=t=out:st=${(totalEncDur-vfd).toFixed(4)}:d=${vfd.toFixed(4)}:color=black`)
        if (endFadeAudio) fadeArgs.push('-af', `afade=t=out:st=${(totalEncDur-afd).toFixed(4)}:d=${afd.toFixed(4)}`)
        if (endFadeVideo) fadeArgs.push('-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS_HQ__')
        else              fadeArgs.push('-c:v', 'copy')
        if (endFadeAudio) fadeArgs.push('-c:a', 'aac', '-b:a', SEG_AUD_KBPS)
        else              fadeArgs.push('-c:a', 'copy')
        fadeArgs.push('-y', fp(preWebFile))
        steps.push({ label: 's4-fade', args: fadeArgs })
      }

      // ══════════════════════════════════════════════════════════════════
      // STAGE 5 — Deliverable format
      // ══════════════════════════════════════════════════════════════════
      // All formats are produced as a final pass off the finished H.264 master
      // (preWebFile), so the fragile per-clip / transition / text stages are
      // untouched. MP4 = lossless +faststart remux; WebM = VP9/Opus transcode;
      // GIF = two-pass palettegen/paletteuse (no audio).
      let outputFile, deliveredMime, deliveredExt
      if (exportFormat === 'webm') {
        outputFile = 'output.webm'; deliveredMime = 'video/webm'; deliveredExt = 'webm'
        const vp9Crf = ({ high: 24, balanced: 31, small: 40 })[exportQuality] ?? 31
        const vArgs  = exportBitrate
          ? ['-b:v', `${Math.round(exportBitrate * 1000)}k`]
          : ['-crf', String(vp9Crf), '-b:v', '0']
        const aArgs  = webmAudioCodec ? ['-c:a', webmAudioCodec, '-b:a', '128k'] : ['-an']
        steps.push({
          label: 's5-webm',
          args: ['-i', fp(preWebFile),
            '-c:v', 'libvpx-vp9', ...vArgs, '-pix_fmt', 'yuv420p', '-row-mt', '1', '-cpu-used', '3',
            ...aArgs, '-y', fp(outputFile)],
        })
      } else if (exportFormat === 'gif') {
        outputFile = 'output.gif'; deliveredMime = 'image/gif'; deliveredExt = 'gif'
        const gfps = 15
        const gw   = Math.min(W, 640)               // cap width — GIFs are huge
        const filt = `fps=${gfps},scale=${gw}:-1:flags=lanczos`
        steps.push({ label: 's5-gif-palette', args: ['-i', fp(preWebFile), '-vf', `${filt},palettegen=stats_mode=diff`, '-y', fp('palette.png')] })
        steps.push({ label: 's5-gif',         args: ['-i', fp(preWebFile), '-i', fp('palette.png'), '-lavfi', `${filt}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, '-y', fp(outputFile)] })
      } else {
        // MP4 — move the moov atom to the front (+faststart) so the file plays/
        // uploads progressively online. Lossless stream copy, no re-encode.
        outputFile = 'output_web.mp4'; deliveredMime = 'video/mp4'; deliveredExt = 'mp4'
        steps.push({
          label: 's5-faststart',
          args: ['-i', fp(preWebFile), '-c', 'copy', '-movflags', '+faststart', '-y', fp(outputFile)],
        })
      }

      // ── Single final quality pass ──────────────────────────────────────
      // All Stage 1–4 video encodes use __ENC_ARGS_HQ__ (near-lossless) so
      // generational loss doesn't compound across the per-clip → xfade → text →
      // fade re-encodes (the compounding is what makes transitions look
      // pixelated/banded even on "high"). The user's selected tier (__ENC_ARGS__)
      // is applied exactly ONCE, on the LAST H.264 encode in the chain — so the
      // transition takes lossy compression a single time, like the rest of the
      // video. For WebM/GIF the H.264 master stays HQ throughout and the user's
      // quality lands on the VP9/GIF transcode (its own CRF), so we don't swap.
      if (exportFormat !== 'webm' && exportFormat !== 'gif') {
        for (let i = steps.length - 1; i >= 0; i--) {
          const ai = steps[i].args.indexOf('__ENC_ARGS_HQ__')
          if (ai !== -1) { steps[i].args[ai] = '__ENC_ARGS__'; break }
        }
      }

      // ── Progress weighting ─────────────────────────────────────────────
      // Tag each step with the media-seconds it processes so the bar advances
      // proportionally to real encode work. Stage-1 steps carry a `[i]` clip
      // index → that clip's output seconds (a 2-pass clip is counted per pass,
      // which is fair — it's two encodes). Full-timeline re-encodes (xfade/music
      // mix, text, end-fade) weigh the whole timeline; stream-copies are cheap.
      const encSeconds = Math.max(
        0.1,
        segments.reduce((s, x) => s + x.actualDur, 0)
          - segments.slice(0, -1).reduce((s, x) => s + tdFor(x.clip), 0),
      )
      for (const s of steps) {
        const mIdx = /\[(\d+)\]/.exec(s.label)
        let w
        if (mIdx)                              w = clipDurByIndex[+mIdx[1]] || 1
        else if (/^s2-(music|xfade)/.test(s.label)) w = encSeconds
        else if (s.label === 's3-text')        w = encSeconds
        else if (s.label === 's4-fade')        w = encSeconds
        else if (/^s5-(webm|gif)/.test(s.label)) w = encSeconds   // full-timeline transcode
        else                                   w = Math.max(1, encSeconds * 0.05)  // concat/copy/faststart
        weightByLabel[s.label] = w
        totalWeight += w
      }

      // ── Send all steps to main process for native execution ────────────
      const result = await api.startExport({ jobId, steps, encoderOverride: encOvr, exportQuality, exportBitrate, tempDir: tmpDir })

      if (!result.ok) {
        if (result.cancelled) throw new Error('Export cancelled')
        throw new Error(result.error || 'Export failed')
      }

      // Read output and build blob for in-app preview
      pushLog('Reading output…')
      const b64Data = await api.readFile(p(outputFile))
      const binary  = atob(b64Data)
      const bytes   = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: deliveredMime })

      setProgress(100); onProgress?.(100); setEtaSeconds(null)
      pushLog(`✓ Done — ${(blob.size/1024/1024).toFixed(1)} MB · ${result.encoder}`)

      // Native save-file dialog — match the file name + filter to the format.
      const saveName  = outputName.replace(/\.[^.]+$/, '') + '.' + deliveredExt
      const saveFilter = exportFormat === 'webm' ? [{ name: 'WebM Video', extensions: ['webm'] }]
                       : exportFormat === 'gif'  ? [{ name: 'Animated GIF', extensions: ['gif'] }]
                       :                           [{ name: 'MP4 Video', extensions: ['mp4'] }]
      const savePath = await api.saveFileDialog({ defaultName: saveName, filters: saveFilter })
      if (savePath) {
        await api.copyFile(p(outputFile), savePath)
        pushLog(`  Saved → ${savePath}`)
        await api.openPath(savePath)
      }

      return { blob, url: URL.createObjectURL(blob) }

    } catch (err) {
      pushLog(`✖ Export error: ${err.message}`)
      throw err
    } finally {
      cleanup()
    }
  }, [pushLog])

  return {
    load, loaded, loading, progress, etaSeconds, logs, clearLogs,
    cancelExport, encoder, gpuCaps, encoderOverride, setEncoderOverride, resetGPU,
    exportMoment,
  }
}
