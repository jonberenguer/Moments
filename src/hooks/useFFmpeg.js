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
  { key: 'Poppins-Regular',         label: 'Poppins',      file: 'Poppins-Regular.ttf',        cssFamily: 'MomPoppins' },
  { key: 'Poppins-Bold',            label: 'Poppins Bold', file: 'Poppins-Bold.ttf',           cssFamily: 'MomPoppinsBold' },
  { key: 'LiberationSans-Regular',  label: 'Sans',         file: 'LiberationSans-Regular.ttf', cssFamily: 'MomSans' },
  { key: 'LiberationSans-Bold',     label: 'Sans Bold',    file: 'LiberationSans-Bold.ttf',    cssFamily: 'MomSansBold' },
  { key: 'LiberationSerif-Regular', label: 'Serif',        file: 'LiberationSerif-Regular.ttf',cssFamily: 'MomSerif' },
  { key: 'LiberationMono-Regular',  label: 'Mono',         file: 'LiberationMono-Regular.ttf', cssFamily: 'MomMono' },
]

// ─── Preview font loader (same as WASM version) ───────────────────────────────
const _loadedFonts = new Set()
export function loadPreviewFont(fontKey) {
  if (_loadedFonts.has(fontKey)) return
  const preset = PRESET_FONTS.find(f => f.key === fontKey)
  if (!preset) return
  const style = document.createElement('style')
  style.textContent = `@font-face{font-family:'${preset.cssFamily}';src:url('/ffmpeg/fonts/${preset.file}') format('truetype');font-display:block;}`
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
  const fps    = 25
  const frames = Math.max(2, Math.ceil(duration * fps))
  switch (effect) {
    case 'ken_burns': {
      const z = `1+(0.18*on/${frames})`
      const x = `(iw/2-(iw/zoom/2))-(iw*0.03*on/${frames})`
      const y = `(ih/2-(ih/zoom/2))-(ih*0.02*on/${frames})`
      return `fps=${fps},scale=${W*1.25|0}:${H*1.25|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps}`
    }
    case 'pan_zoom': {
      const z = `1+(0.12*sin(PI*on/${frames}))`
      const x = `(iw/2-(iw/zoom/2))-(iw*0.04*sin(PI*on/${frames}))`
      const y = `ih/2-(ih/zoom/2)`
      return `fps=${fps},scale=${W*1.25|0}:${H*1.25|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps}`
    }
    case 'parallax': {
      const z = `1.08+(0.02*sin(2*PI*on/${frames}))`
      const x = `(iw/2-(iw/zoom/2))+(iw*0.02*sin(2*PI*on/${frames}))`
      const y = `(ih/2-(ih/zoom/2))-(ih*0.01*cos(2*PI*on/${frames}))`
      return `fps=${fps},scale=${W*1.25|0}:${H*1.25|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps}`
    }
    case 'fade_in': {
      const z    = `1.04-(0.04*on/${frames})`
      const x    = `iw/2-(iw/zoom/2)`
      const y    = `ih/2-(ih/zoom/2)`
      const fade = Math.min(1.2, duration * 0.4).toFixed(2)
      return `fps=${fps},scale=${W*1.1|0}:${H*1.1|0},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps},fade=t=in:st=0:d=${fade}`
    }
    default: return null
  }
}

function buildDrawtext(seg, W, H, fontPath) {
  // Scale fontSize from the design base (28px at preview) to export canvas width.
  // The Inspector stores fontSize in "preview px" units; export scales to W/1280 reference.
  const fontSize  = Math.round((seg.fontSize || 28) * (W / 1280))
  const color     = (seg.color || '#ffffff').replace('#', '')

  // Resolve x/y from position preset or custom posX/posY percentages.
  // Preview CSS: preset positions use bottom:14px / top:14px / center.
  //              custom uses left:posX%, top:posY%, transform:translate(-50%,-50%).
  // Scale the 14px margin proportionally to canvas height.
  const margin = Math.round(14 * (H / 720))
  let x, y
  const pos = seg.position || 'bottom'
  if (pos === 'custom') {
    // posX/posY are percentages (0–100); text is centered on that point.
    const pctX = (seg.posX ?? 50) / 100
    const pctY = (seg.posY ?? 85) / 100
    x = `${Math.round(W * pctX)}-text_w/2`
    y = `${Math.round(H * pctY)}-text_h/2`
  } else if (pos === 'top') {
    x = `(w-text_w)/2`
    y = String(margin)
  } else if (pos === 'center') {
    x = `(w-text_w)/2`
    y = `(h-text_h)/2`
  } else {
    // 'bottom' (default)
    x = `(w-text_w)/2`
    y = `h-text_h-${margin}`
  }

  const tStart    = (seg.startTime || 0).toFixed(4)
  // endTime is not stored on segments — derive it from startTime + duration.
  const tEndRaw   = seg.endTime != null
    ? seg.endTime
    : seg.duration != null
      ? (seg.startTime || 0) + seg.duration
      : 1e9
  const tEnd      = tEndRaw.toFixed(4)
  const safeText  = (seg.text || '').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/\\/g,'\\\\').replace(/\[/g,'\\[').replace(/\]/g,'\\]')

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
  // Escape the font path for FFmpeg's drawtext filter syntax.
  // Rules (applied in order):
  //   1. Normalise backslashes to forward slashes (FFmpeg accepts both on Windows)
  //   2. Escape Windows drive-letter colon: C:/... → C\:/...
  //      The colon is FFmpeg's filter option separator; it must be escaped even
  //      inside single-quoted values — quotes do NOT protect colons here.
  //   3. Escape any single quotes in the path itself
  const escapedPath = fontPath
    .replace(/\\/g, '/')          // backslash → forward slash
    .replace(/^([A-Za-z]):/, '$1\\:')  // C: → C\:  (drive letter only)
    .replace(/'/g, "\\'")         // escape single quotes
  return (
    `drawtext=fontfile='${escapedPath}':text='${safeText}':` +
    `fontsize=${fontSize}:fontcolor=${color}:x=${x}:y=${y}:` +
    `alpha='${alphaExpr}':enable='between(t,${tStart},${tEnd})'`
  )
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
    onProgress,
    encoderOverride: encOvr = 'auto',
  }) => {
    if (runningRef.current) throw new Error('Export already in progress')
    runningRef.current = true
    setProgress(0)

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
    const td       = Math.max(0.1, transitionDuration)

    // Subscribe to IPC events for real-time logging
    const unsubLog     = api.onLog(({ line }) => pushLog(`  ${line}`))
    const unsubStep    = api.onStepStart(({ label }) => pushLog(`▶ ${label}`))
    const unsubDone    = api.onStepDone(({ label }) => pushLog(`  ✓ ${label}`))
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

    let stepsDone = 0
    const tick = (label) => {
      stepsDone++
      const pct = Math.min(99, Math.round(stepsDone / Math.max(clips.length + 3, 5) * 100))
      setProgress(pct); onProgress?.(pct)
      pushLog(label)
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

      tick(`${validClips.length} clip(s) ready`)

      // ══════════════════════════════════════════════════════════════════
      // STAGE 1 — Encode each clip → normalised seg_N.mp4
      // ══════════════════════════════════════════════════════════════════
      pushLog('── Stage 1: Encoding clips ──')

      for (let i = 0; i < validClips.length; i++) {
        const c = validClips[i]
        const eqFilter = buildEqFilter(c.brightness, c.contrast, c.saturation)

        let actualDur
        if (c._isImg) {
          actualDur = Math.max(td + 0.5, c.duration || 4)
        } else {
          const spd = c.speed > 0 ? c.speed : 1
          const ts  = c.trimStart || 0
          const te  = (c.trimEnd && c.trimEnd > ts) ? c.trimEnd : (c.fileDuration || c.duration || 4)
          actualDur = Math.max(td + 0.5, (te - ts) / spd)
        }
        const durStr  = actualDur.toFixed(4)
        const segFile = `seg_${i}.mp4`

        pushLog(`\n  ┌─ [${i+1}/${validClips.length}] "${c.name}" — ${c._isImg ? 'IMAGE' : 'VIDEO'} — ${actualDur.toFixed(2)}s`)

        if (c._isImg) {
          // ── IMAGE: placement + optional effect/EQ in one pass ────────

          if (c.blurBackground) {
            // ── BLUR BACKGROUND: single-pass filter_complex ─────────────
            // bg: scale source to FILL canvas → crop centre → boxblur → [_bg]
            // fg: scale source to FIT canvas (letterboxed, NO padding) → even-align → [_feven]
            //     The fg stays at its natural letterbox size (e.g. 960×720 for 4:3 in 16:9).
            //     overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2 centres it over the blur.
            //     The blurred bg shows through the letterbox bars naturally.
            // NOTE: do NOT pad the fg to W×H — that makes overlay_w=main_w → offset=0 → blur hidden.
            const fgNodes = [
              `[_fg0]scale=${W}:${H}:force_original_aspect_ratio=decrease[_ffit]`,
              `[_ffit]scale=trunc(iw/2)*2:trunc(ih/2)*2[_feven]`,
            ]
            const fgOut   = eqFilter ? `[_feven]${eqFilter}[_fpadded]` : null
            const finalFg = eqFilter ? '[_fpadded]' : '[_feven]'

            const blurFc = [
              `[0:v]split=2[_bg0][_fg0]`,
              `[_bg0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=20:luma_power=2[_bg]`,
              ...fgNodes,
              ...(fgOut ? [fgOut] : []),
              `[_bg]${finalFg}overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[vout]`,
            ].join(';')

            steps.push({
              label: `img-place[${i}]`,
              args: [
                '-loop', '1', '-i', fp(c._fname),
                '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
                '-filter_complex', blurFc,
                '-map', '[vout]', '-map', '1:a',
                '-t', durStr,
                '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS__',
                '-r', String(SEG_FPS), '-fps_mode', 'cfr',
                '-video_track_timescale', String(SEG_TIMEBASE),
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-t', durStr, '-y', fp(segFile),
              ],
            })
            segments.push({ file: segFile, actualDur, clip: c })
            continue
          }

          // ── Non-blur: fit → pad → optional effect/EQ ─────────────────
          const placeFc = [
            `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[_fit]`,
            `[_fit]scale=trunc(iw/2)*2:trunc(ih/2)*2[_even]`,
            `[_even]pad=${W}:${H}:-1:-1:color=black[_padded]`,
            `[_padded]setsar=1[vout]`,
          ].join(';')
          let termFc    = placeFc
          let termLabel = '[vout]'
          const effectVf = buildImageEffectVf(c.imageEffect, W, H, actualDur)
          if (effectVf || eqFilter) {
            termFc    = `${placeFc};${termLabel}${[effectVf, eqFilter].filter(Boolean).join(',')}[vfinal]`
            termLabel = '[vfinal]'
          }

          steps.push({
            label: `img-place[${i}]`,
            args: [
              '-loop', '1', '-i', fp(c._fname),
              '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
              '-filter_complex', termFc,
              '-map', termLabel, '-map', '1:a',
              '-t', durStr,
              '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS__',
              '-r', String(SEG_FPS), '-fps_mode', 'cfr',
              '-video_track_timescale', String(SEG_TIMEBASE),
              '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
              '-t', durStr, '-y', fp(segFile),
            ],
          })
          segments.push({ file: segFile, actualDur, clip: c })

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

            const blurFc = [
              `[0:v]split=2[_bg0][_fg0]`,
              `[_bg0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=20:luma_power=2[_bg]`,
              ...fgNodes,
              `[_bg]${finalFg}overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[vout]`,
            ].join(';')

            steps.push({
              label: `vid-place[${i}]`,
              args: [
                '-ss', String(ts), '-i', fp(c._fname), '-t', String(srcDur),
                '-i', fp(audOut),
                '-filter_complex', blurFc,
                '-map', '[vout]', '-map', '1:a',
                '-t', durStr,
                '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS__',
                '-r', String(SEG_FPS), '-fps_mode', 'cfr',
                '-video_track_timescale', String(SEG_TIMEBASE),
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-t', durStr, '-y', fp(segFile),
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
                '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS__',
                '-r', String(SEG_FPS), '-fps_mode', 'cfr',
                '-video_track_timescale', String(SEG_TIMEBASE),
                '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-ar', String(SEG_AUD_RATE), '-ac', '2',
                '-y', fp(segFile),
              ],
            })
            segments.push({ file: segFile, actualDur, clip: c })
          }
        }

        tick(`  ✓ Clip ${i+1}/${validClips.length} queued`)
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
            timeOff += segments[i].actualDur - td
            vParts.push(`${vLabel}[${i+1}:v]xfade=transition=${xfName}:duration=${td}:offset=${timeOff.toFixed(4)}${vOut}`)
            aParts.push(`${aLabel}[${i+1}:a]acrossfade=d=${td.toFixed(4)}${aOut}`)
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
              '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS__',
              '-c:a', 'aac', '-b:a', SEG_AUD_KBPS, '-shortest', '-y', fp(preFinal)],
          })
        } else {
          steps.push({
            label: 's2-xfade',
            args: [...segInputs, '-filter_complex', [...vParts, ...aParts].join(';'),
              '-map', '[vfinal]', '-map', '[afinal]',
              '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS__',
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
        // Write custom font data to temp dir if needed
        for (const seg of activeSegs) {
          if (seg.fontFile === 'custom' && seg.customFontData) {
            await writeUint8ToPath(seg.customFontData.slice(), p('font_custom.ttf'))
            fontPathCache['custom'] = fp('font_custom.ttf')
          }
        }

        const vfChain = activeSegs.map(seg => {
          const key      = seg.fontFile || 'Poppins-Regular'
          const fontPath = (key === 'custom' && fontPathCache['custom'])
            ? fontPathCache['custom']
            : (fontPathCache[key] || fontPathCache['Poppins-Regular'])
          return buildDrawtext(seg, W, H, fontPath)
        }).join(',')

        steps.push({
          label: 's3-text',
          args: [
            '-i', fp(preFinal),
            '-vf', vfChain,
            '-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS__',
            '-c:a', 'copy', '-y', fp('output.mp4'),
          ],
        })
      } else {
        steps.push({ label: 's3-copy', args: ['-i', fp(preFinal), '-c', 'copy', '-y', fp('output.mp4')] })
      }

      // ══════════════════════════════════════════════════════════════════
      // STAGE 4 — End fade
      // ══════════════════════════════════════════════════════════════════
      const outputFile = endFadeVideo || endFadeAudio ? 'output_final.mp4' : 'output.mp4'
      if (endFadeVideo || endFadeAudio) {
        const totalEncDur = segments.reduce((s, x) => s + x.actualDur, 0)
          - (segments.length > 1 ? (segments.length - 1) * td : 0)
        const vfd = Math.min(endFadeVideoDuration, totalEncDur)
        const afd = Math.min(endFadeAudioDuration, totalEncDur)
        const fadeArgs = ['-i', fp('output.mp4')]
        if (endFadeVideo) fadeArgs.push('-vf', `fade=t=out:st=${(totalEncDur-vfd).toFixed(4)}:d=${vfd.toFixed(4)}:color=black`)
        if (endFadeAudio) fadeArgs.push('-af', `afade=t=out:st=${(totalEncDur-afd).toFixed(4)}:d=${afd.toFixed(4)}`)
        if (endFadeVideo) fadeArgs.push('-c:v', '__ENCODER__', '-pix_fmt', SEG_PIX_FMT, '__ENC_ARGS__')
        else              fadeArgs.push('-c:v', 'copy')
        if (endFadeAudio) fadeArgs.push('-c:a', 'aac', '-b:a', SEG_AUD_KBPS)
        else              fadeArgs.push('-c:a', 'copy')
        fadeArgs.push('-y', fp(outputFile))
        steps.push({ label: 's4-fade', args: fadeArgs })
      }

      // ── Send all steps to main process for native execution ────────────
      const result = await api.startExport({ jobId, steps, encoderOverride: encOvr, tempDir: tmpDir })

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
      const blob = new Blob([bytes], { type: 'video/mp4' })

      setProgress(100); onProgress?.(100)
      pushLog(`✓ Done — ${(blob.size/1024/1024).toFixed(1)} MB · ${result.encoder}`)

      // Native save-file dialog
      const savePath = await api.saveFileDialog({ defaultName: outputName })
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
    load, loaded, loading, progress, logs, clearLogs,
    cancelExport, encoder, gpuCaps, encoderOverride, setEncoderOverride, resetGPU,
    exportMoment,
  }
}
