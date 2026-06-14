import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { PRESET_FONTS, loadPreviewFont, CJK_FONT_KEY } from '../hooks/useFFmpeg'
import { hasCJK, wrapText } from '../textLayout'
import { usePlayhead } from '../playhead'
import styles from './Preview.module.css'

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

  // Load custom font into the browser whenever customFontData changes
  useEffect(() => {
    const customSeg = textSegments.find(s => s.fontFile === 'custom' && s.customFontData)
    if (!customSeg) return
    const { customFontData } = customSeg
    const fontFace = new FontFace('MomCustomFont', customFontData.buffer ?? customFontData)
    fontFace.load().then(loaded => {
      document.fonts.add(loaded)
    }).catch(() => {})
  }, [textSegments.find(s => s.fontFile === 'custom')?.customFontData])
  // Resolve a caption's render font + the single family name used to MEASURE
  // wrapping. Mirrors the export exactly: a CJK caption renders entirely in Noto
  // (drawtext is one-font-per-caption), so the preview previews the real export,
  // and wrapText measures in the same face the export will use → identical breaks.
  const famFor = (seg) => {
    if (hasCJK(seg.text)) return { css: `'MomNotoCJK', sans-serif`, measure: 'MomNotoCJK' }
    const k = seg.fontFile || 'Poppins-Regular'
    if (k === 'custom') return { css: `'MomCustomFont', sans-serif`, measure: 'MomCustomFont' }
    const p = PRESET_FONTS.find(f => f.key === k)
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

  return (
    <div className={styles.wrapper}>
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
                  ?<img src={clip.url} alt={clip.name} className={[styles.mediaEl, getEffectClass(clip)].filter(Boolean).join(' ')} draggable={false} style={{filter:filterStyle}}/>
                  :<video ref={videoRef} src={clip.url} className={styles.mediaEl} muted={isMuted} style={{filter:filterStyle}}/>}
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
