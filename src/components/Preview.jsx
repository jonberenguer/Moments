import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { PRESET_FONTS, loadPreviewFont, CJK_FONT_KEY } from '../hooks/useFFmpeg'
import { hasCJK, wrapText } from '../textLayout'
import { usePlayhead } from '../playhead'
import styles from './Preview.module.css'

// Custom @font-face families already registered in the document, keyed by the
// content-stable family name. Module-level so a font, once loaded, is never
// re-added and never dropped — even after the segment's bytes detach post-export
// or the caption is deselected.
const _loadedCustomFonts = new Set()

const TRANS_LABELS = { crossfade:'Crossfade', slide_left:'Slide ←', slide_up:'Slide ↑', zoom_in:'Zoom', dip_black:'Dip ●' }
// Per-transition "enter" animation played on the incoming clip when the playhead
// crosses a clip boundary during playback (restores the clip-change flourish).
const ENTER_ANIM = { crossfade:'enterFade', slide_left:'enterSlideLeft', slide_up:'enterSlideUp', zoom_in:'enterZoom', dip_black:'enterDip', none:'' }

export default function Preview({
  clips, activeClipId, onSelectClip,
  isPlaying, onPlayToggle,
  onSeek,
  getClipTransition, aspectRatio,
  textSegments = [],
  onUpdateTextSegment,
  clipPlayLen = (c) => c?.duration || 4,
  timelineDuration = 0,
  timeline = [],
  musicFile = null,
  musicVolume = 70,
  musicTrimStart = 0,
  musicTrimEnd = null,
}) {
  // Playhead comes from the external store — this is the only subscription that
  // re-renders Preview each frame during playback (App/Timeline body do not).
  const currentTime = usePlayhead()
  const [draggingSegId, setDraggingSegId]= useState(null)
  const [isMuted,       setIsMuted]      = useState(false)
  const [enterAnim,     setEnterAnim]    = useState('')
  const [screenW,       setScreenW]      = useState(0)

  const segDragRef = useRef(null)
  const screenRef  = useRef(null)
  const videoRef   = useRef(null)
  const bgVideoRef = useRef(null)   // blurred background copy (blurBackground clips)
  const audioRef   = useRef(null)   // background music, synced to the playhead
  // Latest values funnelled through a ref so the rAF loop and convergence
  // effects don't need unstable callbacks/props in their dependency arrays.
  const timeRef = useRef(currentTime)
  const cbRef   = useRef({ onSeek, onPlayToggle, onSelectClip })
  cbRef.current = { onSeek, onPlayToggle, onSelectClip }
  useEffect(() => { timeRef.current = currentTime }, [currentTime])

  const isVertical = aspectRatio === '9:16'

  // ── Shared export-compressed timeline (built in useMediaStore). The playhead,
  // clip widths and text track all ride this axis, so the preview matches the
  // exported timing even across transitions. Fall back to a raw end-to-end
  // layout if the prop is absent (e.g. tests). ───────────────────────────────
  const layout = useMemo(() => {
    if (timeline.length) return { arr: timeline, total: timelineDuration }
    let acc = 0
    const arr = clips.map(c => { const len = Math.max(0.1, clipPlayLen(c)); const seg = { clip:c, start:acc, len }; acc += len; return seg })
    return { arr, total: acc }
  }, [timeline, timelineDuration, clips, clipPlayLen])
  const total = layout.total

  // Which clip is under the playhead, and how far into it we are.
  const t = Math.max(0, Math.min(currentTime, total))
  let curIdx = layout.arr.findIndex(s => t < s.start + s.len - 1e-6)
  if (curIdx < 0) curIdx = layout.arr.length - 1
  const current   = layout.arr[curIdx]
  const clip      = current?.clip
  const clipStart = current?.start || 0
  const clipLen   = current?.len || 0
  const offset    = t - clipStart                    // seconds into this clip's output
  const curClipId = clip?.id || null

  // ── Playback loop — advance currentTime by real elapsed time. ───────────────
  useEffect(() => {
    if (!isPlaying || total <= 0) return
    let raf, last = performance.now()
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now
      const nt = timeRef.current + dt
      // Advance the ref synchronously so back-to-back frames before the next
      // commit don't read a stale value and stall playback.
      timeRef.current = Math.min(nt, total)
      if (nt >= total) { cbRef.current.onSeek(total); cbRef.current.onPlayToggle(); return }
      cbRef.current.onSeek(nt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, total])

  const handlePlay = useCallback(() => {
    // Restart from the top if we're sitting at the end.
    if (total > 0 && timeRef.current >= total - 1e-3) { timeRef.current = 0; onSeek?.(0) }
    onPlayToggle?.()
  }, [total, onSeek, onPlayToggle])

  // Keep the inspector + timeline highlight following the playhead. Selection
  // deliberately does NOT move the playhead: batch-adding clips changes
  // activeClipId repeatedly, and seeking on every change made the playhead jump
  // around. Playhead moves are explicit only — scrubbing, clicking a clip on the
  // timeline, the skip buttons, and playback.
  useEffect(() => {
    if (curClipId && curClipId !== activeClipId) cbRef.current.onSelectClip?.(curClipId)
  }, [curClipId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Video element sync ──────────────────────────────────────────────────────
  // Map the compressed playhead offset back to a source-file timestamp:
  // fraction through the displayed clip → position within the trimmed region.
  const trimStartS = clip?.trimStart || 0
  const trimEndS   = clip?.trimEnd || clip?.fileDuration || 0
  const srcSpan    = Math.max(0, trimEndS - trimStartS)
  const frac       = clipLen > 0 ? Math.min(1, Math.max(0, offset / clipLen)) : 0
  const srcTime    = clip?.type === 'video' ? trimStartS + frac * srcSpan : 0
  const playRate   = clip?.type === 'video' && clipLen > 0 ? Math.max(0.0625, Math.min(16, srcSpan / clipLen)) : 1
  useEffect(() => { const v = videoRef.current; if (v) v.muted = isMuted }, [isMuted])
  // On clip change: set playback rate, seek to the mapped source frame, play/pause.
  useEffect(() => {
    const v = videoRef.current
    if (!v || clip?.type !== 'video') return
    v.playbackRate = playRate
    v.currentTime  = srcTime
    if (isPlaying) v.play().catch(() => {}); else v.pause()
  }, [clip?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Play/pause toggle.
  useEffect(() => {
    const v = videoRef.current
    if (!v || clip?.type !== 'video') return
    v.playbackRate = playRate
    if (isPlaying) {
      // Align the element to the playhead before resuming. Without this,
      // replaying a single clip from the end leaves the video parked on its last
      // frame — the clip-change seek above doesn't fire because the clip id is
      // unchanged, so it never rewinds.
      if (Math.abs(v.currentTime - srcTime) > 0.05) v.currentTime = srcTime
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [isPlaying]) // eslint-disable-line react-hooks/exhaustive-deps
  // While paused (scrubbing), keep the frame pinned to the playhead.
  useEffect(() => {
    const v = videoRef.current
    if (!v || clip?.type !== 'video' || isPlaying) return
    if (Math.abs(v.currentTime - srcTime) > 0.05) v.currentTime = srcTime
  }, [currentTime, clip?.id, isPlaying]) // eslint-disable-line react-hooks/exhaustive-deps
  // Mirror the main video into the blurred-background copy (loose sync — it's blurred).
  useEffect(() => {
    const bg = bgVideoRef.current
    if (!bg || clip?.type !== 'video') return
    bg.muted = true
    bg.playbackRate = playRate
    if (Math.abs(bg.currentTime - srcTime) > 0.1) bg.currentTime = srcTime
    if (isPlaying) bg.play().catch(() => {}); else bg.pause()
  }, [clip?.id, isPlaying, currentTime, srcTime, playRate]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Background music sync ───────────────────────────────────────────────────
  // A hidden <audio> rides the same playhead so the preview plays what the
  // export mixes: music starts at the timeline's t=0 mapped to musicTrimStart,
  // and the export uses atrim→amix=duration=first, so it stops at trimEnd (or
  // when the file/timeline ends). Volume/mute mirror the export + preview mute.
  const [musicUrl, setMusicUrl] = useState(null)
  useEffect(() => {
    if (!musicFile) { setMusicUrl(null); return }
    const url = URL.createObjectURL(musicFile)
    setMusicUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [musicFile])
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    a.volume = Math.max(0, Math.min(1, (musicVolume ?? 70) / 100))
    a.muted  = isMuted
  }, [musicVolume, isMuted, musicUrl])
  // Play/pause + seek to the trimmed start. The seek must wait until the element
  // is seekable — on a freshly-mounted <audio> (blob src) readyState is 0 and an
  // early currentTime= is clamped/ignored, so play() would start from 0 instead
  // of musicTrimStart. Defer the seek to 'loadedmetadata' when not yet ready.
  useEffect(() => {
    const a = audioRef.current
    if (!a || !musicUrl) return
    if (!isPlaying) { a.pause(); return }
    let cancelled = false
    const seekAndPlay = () => {
      if (cancelled) return
      const target = (musicTrimStart || 0) + timeRef.current
      try { a.currentTime = target } catch { /* not seekable yet */ }
      a.play().catch(() => {})
    }
    if (a.readyState >= 1) seekAndPlay()
    else a.addEventListener('loadedmetadata', seekAndPlay, { once: true })
    return () => { cancelled = true; a.removeEventListener('loadedmetadata', seekAndPlay) }
  }, [isPlaying, musicUrl, musicTrimStart])
  // Keep music aligned to the playhead on scrub/skip (large jumps only, so we
  // don't stutter steady playback), and stop at trimEnd / timeline end.
  useEffect(() => {
    const a = audioRef.current
    if (!a || !musicUrl) return
    const target = (musicTrimStart || 0) + currentTime
    const end    = (typeof musicTrimEnd === 'number' ? musicTrimEnd : (a.duration || Infinity))
    if (target >= end || currentTime >= total) {
      if (!a.paused) a.pause()
      return
    }
    if (isPlaying && a.paused) a.play().catch(() => {})
    if (a.readyState >= 1 && Math.abs(a.currentTime - target) > 0.3) a.currentTime = target
  }, [currentTime, isPlaying, musicUrl, musicTrimStart, musicTrimEnd, total])

  // ── Clip-change transition flourish (restores animated transitions) ─────────
  const prevClipRef = useRef(curClipId)
  useEffect(() => {
    const prev = prevClipRef.current
    prevClipRef.current = curClipId
    if (!isPlaying || !curClipId || prev === curClipId) return
    // The transition that governs this boundary belongs to the clip we just left.
    const fromSeg  = layout.arr.find(s => s.id === prev) || layout.arr.find(s => s.clip?.id === prev)
    const fromClip = fromSeg?.clip
    const cls = ENTER_ANIM[getClipTransition(fromClip)] ?? 'enterFade'
    setEnterAnim(cls)
    const id = setTimeout(() => setEnterAnim(''), 380)
    return () => clearTimeout(id)
  }, [curClipId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Text overlay drag-to-reposition ─────────────────────────────────────────
  const onSegMouseDown = useCallback((e,seg)=>{
    e.stopPropagation(); e.preventDefault()
    const rect=screenRef.current?.getBoundingClientRect(); if(!rect)return
    setDraggingSegId(seg.id)
    segDragRef.current={segId:seg.id,rect,startX:e.clientX,startY:e.clientY,startPosX:seg.posX??50,startPosY:seg.posY??85}
  },[])
  const onSegMouseMove = useCallback((e)=>{
    if(!segDragRef.current)return
    const {rect,startX,startY,startPosX,startPosY,segId}=segDragRef.current
    onUpdateTextSegment?.(segId,{position:'custom',posX:+Math.max(5,Math.min(95,startPosX+((e.clientX-startX)/rect.width)*100)).toFixed(1),posY:+Math.max(5,Math.min(95,startPosY+((e.clientY-startY)/rect.height)*100)).toFixed(1)})
  },[onUpdateTextSegment])
  const onSegMouseUp = useCallback(()=>{segDragRef.current=null;setDraggingSegId(null)},[])
  useEffect(()=>{
    if(!draggingSegId)return
    window.addEventListener('mousemove',onSegMouseMove); window.addEventListener('mouseup',onSegMouseUp)
    return ()=>{window.removeEventListener('mousemove',onSegMouseMove);window.removeEventListener('mouseup',onSegMouseUp)}
  },[draggingSegId,onSegMouseMove,onSegMouseUp])

  // Measure the on-screen frame width so text matches export size. Export sets
  // drawtext fontsize = seg.fontSize * (W/1280) on the W-wide canvas; on screen
  // that same text is seg.fontSize * (screenW/1280) px, independent of quality
  // or aspect ratio. The old fixed 0.55 only matched at one screen width, so
  // text looked too big/small as the viewport scaled.
  useEffect(() => {
    const el = screenRef.current; if (!el) return
    setScreenW(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(entries => { for (const e of entries) setScreenW(e.contentRect.width) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const fontScale     = screenW > 0 ? screenW / 1280 : 0.55
  const previewFontPx = (s) => Math.max(1, Math.round((s.fontSize || 60) * fontScale))
  // Bake caption opacity into the colour's alpha (not element `opacity`) so it
  // composes with the fade-in animation, which forces element opacity to 1.
  const hexToRgba = (hex, a) => {
    let h = (hex || '#ffffff').replace('#', '')
    if (h.length === 3) h = h.split('').map(c => c + c).join('')
    const n = parseInt(h, 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }

  const effTrans    = getClipTransition(clip)
  const fmt         = (s)=>`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`
  const filterStyle = clip ? `brightness(${1+(clip.brightness||0)/100}) contrast(${1+(clip.contrast||0)/100}) saturate(${1+(clip.saturation||0)/100})` : undefined

  // Get CSS animation class for image effects
  const getEffectClass = (clip) => {
    if (!clip || clip.type !== 'image') return ''
    switch(clip.imageEffect) {
      case 'ken_burns':   return styles.effectKenBurns
      case 'fade_in':     return styles.effectFadeIn
      default: return ''
    }
  }

  const allFontKeys = [...new Set(textSegments.map(s=>s.fontFile||'Poppins-Regular'))]
  allFontKeys.forEach(k=>{if(k!=='custom')loadPreviewFont(k)})
  // Mirror the export's CJK fallback in the preview: if any caption contains
  // Korean/Chinese/Japanese text, load the bundled CJK font so the preview shows
  // those glyphs in the same face the export will use (not the OS fallback).
  const anyCJK = textSegments.some(s => hasCJK(s.text))
  if (anyCJK) loadPreviewFont(CJK_FONT_KEY)

  // Register EVERY custom font used by any caption (each as its own content-stable
  // @font-face family), so uploading a font repaints the caption, re-uploading a
  // different one swaps cleanly, multiple captions can use different custom fonts,
  // and a font reused across captions resolves to the same family. bumpFonts
  // forces a re-render once a face finishes loading async.
  const [, bumpFonts] = useState(0)
  useEffect(() => {
    for (const s of textSegments) {
      if (s.fontFile !== 'custom' || !s.customFontFamily) continue
      const data = s.customFontData
      if (!data || data.byteLength === 0) continue          // missing/detached → skip
      if (_loadedCustomFonts.has(s.customFontFamily)) continue
      _loadedCustomFonts.add(s.customFontFamily)
      try {
        new FontFace(s.customFontFamily, data).load()
          .then(loaded => { document.fonts.add(loaded); bumpFonts(v => v + 1) })
          .catch(() => { _loadedCustomFonts.delete(s.customFontFamily) })
      } catch { _loadedCustomFonts.delete(s.customFontFamily) }
    }
  }, [textSegments])
  // Resolve a caption's render font + the single family name used to MEASURE
  // wrapping. Mirrors the export's routing exactly so preview==export: a CJK
  // caption renders in the selected font if it covers CJK (Noto JP/TC/SC/KR,
  // Taipei, GenSeki), else falls back to the bundled Noto CJK; custom fonts fall
  // back to Noto for CJK text (they rarely contain CJK glyphs).
  const famFor = (seg) => {
    const k = seg.fontFile || 'Poppins-Regular'
    if (k === 'custom') {
      if (hasCJK(seg.text)) return { css: `'MomNotoCJK', sans-serif`, measure: 'MomNotoCJK' }
      const fam = seg.customFontFamily || 'MomCustomFont'
      return { css: `'${fam}', sans-serif`, measure: fam }
    }
    const p = PRESET_FONTS.find(f => f.key === k)
    if (!p?.cjk && hasCJK(seg.text)) return { css: `'MomNotoCJK', sans-serif`, measure: 'MomNotoCJK' }
    const cf = p?.cssFamily || 'sans-serif'
    return { css: `'${cf}', sans-serif`, measure: cf }
  }

  // Text visibility — identical predicate to the FFmpeg export
  // (enable='between(t,startTime,startTime+duration)'), whether playing or
  // paused. This is what makes the preview match the exported timing exactly.
  const visibleSegs = textSegments.filter(s => t >= s.startTime && t < s.startTime + s.duration)
  // Always fit the largest aspect-correct box into the viewport area (both
  // dimensions), no zoom control. `cqw/cqh` are the container's width/height
  // (viewportWrap is a size container); width is capped so the derived height
  // (width / AR) never exceeds the container. Recomputes on any window resize.
  const screenStyle = isVertical
    ? { width: 'min(100cqw, 100cqh * 9 / 16)', aspectRatio: '9 / 16' }
    : { width: 'min(100cqw, 100cqh * 16 / 9)', aspectRatio: '16 / 9' }

  // Phase A clip transform (preview). translate is % of the canvas (element is
  // 100% of the canvas-aspect screen), scale/rotate around centre — same model the
  // export composites. Mutually exclusive with the Ken Burns effect (both drive
  // transform), so when a transform is set we drop the effect class.
  // Transform applies to the foreground media element; the blur background (a
  // separate full-canvas element) is unaffected — matching the export, which
  // composites the transformed fg over the blur bg.
  const tfHas = clip && ((clip.scale ?? 1) !== 1 || (clip.rotation ?? 0) !== 0 || (clip.offsetX ?? 0) !== 0 || (clip.offsetY ?? 0) !== 0)
  const tfStyle = tfHas
    ? `translate(${clip.offsetX || 0}%, ${clip.offsetY || 0}%) scale(${clip.scale ?? 1}) rotate(${clip.rotation || 0}deg)`
    : undefined

  return (
    <div className={styles.wrapper}>
      {/* Background music — hidden, lives outside the per-clip media layer so it
          isn't remounted on clip changes; synced to the playhead by the effects above. */}
      {musicUrl && <audio ref={audioRef} src={musicUrl} preload="auto" style={{ display: 'none' }} />}
      <div className={styles.viewportWrap}>
        <div ref={screenRef}
          className={styles.screen}
          style={screenStyle}>

          <div key={clip?.id} className={[styles.mediaLayer, styles.visible, enterAnim&&styles[enterAnim]].filter(Boolean).join(' ')}>
            {clip&&!clip._needsMedia?(
              <>
                {clip.blurBackground && (clip.type==='image'
                  ?<img src={clip.url} className={styles.blurBg} aria-hidden="true" draggable={false}/>
                  :<video ref={bgVideoRef} src={clip.url} className={styles.blurBg} muted aria-hidden="true"/>)}
                {clip.type==='image'
                  ?<img src={clip.url} alt={clip.name} className={[styles.mediaEl, tfHas?'':getEffectClass(clip)].filter(Boolean).join(' ')} draggable={false} style={{filter:filterStyle, transform:tfStyle}}/>
                  :<video ref={videoRef} src={clip.url} className={styles.mediaEl} muted={isMuted} style={{filter:filterStyle, transform:tfStyle}}/>}
              </>
            ):clip?._needsMedia?(
              <div className={styles.needsMedia}><span className={styles.nmIcon}>⚠</span><span className={styles.nmName}>{clip.name}</span><span className={styles.nmHint}>Re-add file</span></div>
            ):(
              <div className={styles.empty}><span className={styles.emptyIcon}>◈</span><span className={styles.emptyText}>Drop media to begin</span></div>
            )}
          </div>

          {visibleSegs.map(seg=>{
            const isCustom=seg.position==='custom'
            const px=previewFontPx(seg)
            const sOff=Math.max(1,Math.round(px*0.06))
            const oFrac=Math.max(0,Math.min(1,(seg.opacity??100)/100))
            const fam=famFor(seg)
            // Pre-wrap with the shared layout (same algo + font the export uses) and
            // render explicit lines, so the preview breaks exactly where the export
            // will. fit-content + text-align aligns lines within the text block —
            // matching drawtext's text_align within text_w.
            const lines=wrapText(seg.text||'', fam.measure, seg.fontSize||60, seg.boxWidth ?? 80)
            return (
              <div key={seg.id} data-textseg
                className={[isCustom?styles.textOverlayCustom:styles.textOverlay,!isCustom?styles[`pos_${seg.position||'bottom'}`]:'',isPlaying?styles[`anim_${seg.animation||'fade'}`]:''].join(' ')}
                style={{fontSize:`${px}px`,color:hexToRgba(seg.color,oFrac),fontFamily:fam.css,textShadow:seg.shadow!==false?`${sOff}px ${sOff}px ${sOff*1.5}px rgba(0,0,0,${(0.78*oFrac).toFixed(2)})`:'none',...(seg.outline?{WebkitTextStroke:`${Math.max(1,Math.round(px*0.04))}px rgba(0,0,0,${oFrac.toFixed(2)})`,paintOrder:'stroke fill'}:{}),cursor:draggingSegId===seg.id?'grabbing':'grab',width:'fit-content',maxWidth:`${seg.boxWidth??80}%`,textAlign:seg.textAlign||'center',whiteSpace:'pre',...(isCustom?{position:'absolute',left:`${seg.posX??50}%`,top:`${seg.posY??85}%`,transform:'translate(-50%,-50%)'}:{})}}
                onMouseDown={e=>onSegMouseDown(e,seg)} title="Drag to reposition">
                {lines.join('\n')}
              </div>
            )
          })}

          <div className={styles.hud}>
            <div className={styles.counter}>{clips.length>0?`${curIdx+1} / ${clips.length}`:''}</div>
            <div className={styles.transBadge}>{TRANS_LABELS[effTrans]||effTrans}</div>
          </div>
        </div>
      </div>

      <div className={styles.controlsBar}>
        <div className={styles.playbackGroup}>
          <button className={styles.ctrl} onClick={()=>{const s=layout.arr[Math.max(0,curIdx-1)];if(s){onSeek?.(s.start);onSelectClip(s.clip.id)}}}><SkipBack size={14} strokeWidth={1.5}/></button>
          <button className={`${styles.ctrl} ${styles.playBtn}`} onClick={handlePlay} disabled={clips.length===0}>
            {isPlaying?<Pause size={16} strokeWidth={1.5}/>:<Play size={16} strokeWidth={1.5}/>}
          </button>
          <button className={styles.ctrl} onClick={()=>{const s=layout.arr[Math.min(layout.arr.length-1,curIdx+1)];if(s){onSeek?.(s.start);onSelectClip(s.clip.id)}}}><SkipForward size={14} strokeWidth={1.5}/></button>
          <button className={`${styles.ctrl} ${isMuted?styles.ctrlMuted:''}`} onClick={()=>setIsMuted(m=>!m)} title={isMuted?'Unmute':'Mute'}>
            {isMuted?<VolumeX size={14} strokeWidth={1.5}/>:<Volume2 size={14} strokeWidth={1.5}/>}
          </button>
          <span className={styles.timeLabel}>{fmt(t)} / {fmt(total)}</span>
        </div>
      </div>
    </div>
  )
}
