import { useRef, useState, useCallback, useMemo, useEffect } from 'react'
import { X, Plus, Type, Music, ZoomIn, ZoomOut } from 'lucide-react'
import { playhead, usePlayhead } from '../playhead'
import useAudioPeaks from '../hooks/useAudioPeaks'
import styles from './Timeline.module.css'

const TRANSITIONS = ['none','crossfade','slide_left','slide_up','zoom_in','dip_black']
const TRANS_ICONS  = { none:'✕', crossfade:'⟷', slide_left:'←', slide_up:'↑', zoom_in:'⊕', dip_black:'●' }
const TRANS_LABELS = { none:'Cut', crossfade:'Crossfade', slide_left:'Slide ←', slide_up:'Slide ↑', zoom_in:'Zoom', dip_black:'Dip' }
// Base pixels-per-second at zoom 1.0. The timeline zoom multiplies this; every
// pixel position flows from buildMetrics, so a single factor scales the whole
// timeline (clips, ruler, captions, waveform, playhead) coherently.
const PX_PER_SEC_BASE = 16
const ZOOM_MIN = 0.25
const ZOOM_MAX = 8
const MUSIC_ROW_H = 30   // height of the music waveform lane

// Effective horizontal advance of a transition pill in the flex row
// (22px wide with margin: 0 -2px → ~18px of layout advance). Used to keep the
// playhead aligned with clip boundaries, which the pills sit between.
const PILL_ADVANCE = 18
const TRACK_PAD    = 14   // .track padding-left
const TEXT_ROW_H   = 24   // height of one text-overlay lane

// Greedy lane assignment so overlapping captions stack into separate rows
// instead of piling on top of each other. Returns { laneOf, count }.
function assignLanes(textSegments) {
  const sorted = [...(textSegments || [])].sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
  const laneEnds = []   // running end time of each lane
  const laneOf = {}
  for (const s of sorted) {
    const start = s.startTime || 0
    const end   = start + (s.duration || 0)
    let lane = laneEnds.findIndex(e => e <= start + 1e-6)
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(end) }
    else laneEnds[lane] = end
    laneOf[s.id] = lane
  }
  return { laneOf, count: Math.max(1, laneEnds.length) }
}

// ── Shared time↔pixel mapping ─────────────────────────────────────────────────
// One coordinate system for the clip row AND the text track, so the playhead,
// clips and caption blocks all line up. Replicates the flex clip layout: each
// clip's pixel width is max(64, len*PX) and a transition pill adds PILL_ADVANCE
// between clips (pills carry no time). Pixel positions are measured from the
// content origin (0); callers add TRACK_PAD where their container is padded.
function buildMetrics(clips, lenAt, pxPerSec) {
  let accT = 0, px = 0
  const segs = clips.map((c, i) => {
    const len = Math.max(0.1, lenAt(i))
    const w   = Math.max(64, len * pxPerSec)
    const seg = { id: c.id, startT: accT, len, leftPx: px, w }
    accT += len
    px   += w + (i < clips.length - 1 ? PILL_ADVANCE : 0)
    return seg
  })
  return { segs, totalT: accT, contentPx: px }
}
function timeToPx(t, m) {
  for (const s of m.segs) if (t < s.startT + s.len) return s.leftPx + s.w * Math.max(0, Math.min(1, (t - s.startT) / s.len))
  return m.contentPx
}
function pxToTime(px, m) {
  for (const s of m.segs) if (px < s.leftPx + s.w) return s.startT + Math.max(0, Math.min(1, (px - s.leftPx) / s.w)) * s.len
  return m.totalT
}

// ── Playhead line ─────────────────────────────────────────────────────────────
// Subscribes to the playhead store on its own, so during playback only these
// thin indicator lines re-render — not the whole Timeline (clips, pills, ruler
// ticks and caption blocks all stay put). One instance per lane (clip row,
// ruler, text track); `padLeft` accounts for the clip row's container padding.
function TimelinePlayhead({ metrics, axisDur, className, padLeft = 0, children = null }) {
  const ct = usePlayhead()
  if (!(axisDur > 0)) return null
  const t = Math.max(0, Math.min(ct, axisDur))
  return <div className={className} style={{ left: `${padLeft + timeToPx(t, metrics)}px` }}>{children}</div>
}

// ── ClipRow ───────────────────────────────────────────────────────────────────
function ClipRow({ clips, activeClipId, onSelectClip, onReorder, onRemoveClip, globalTransition, onGlobalTransitionChange, onClipTransitionChange, getClipTransition, metrics={segs:[],totalT:0,contentPx:0}, total=0, onSeek, registerScroll, onScroll, accentColor='var(--accent)' }) {
  const [dragIdx,  setDragIdx]  = useState(null)
  const [dragOver, setDragOver] = useState(null)
  const [pillMenu, setPillMenu] = useState(null)
  const trackRef = useRef()
  const panRef   = useRef({ active:false, startX:0, startScrollLeft:0 })

  // Register the scroll element with the parent (for cross-track scroll sync)
  // without disturbing the internal trackRef the pan logic relies on.
  const setTrackEl = (el) => { trackRef.current = el; registerScroll?.(el) }

  const onTrkDown = useCallback((e) => {
    if (e.target.closest('[data-clip]')||e.target.closest('[data-pill]')) return
    const el=trackRef.current; if(!el) return
    panRef.current={active:true,startX:e.clientX,startScrollLeft:el.scrollLeft}; el.style.cursor='grabbing'
  },[])
  const onTrkMove = useCallback((e) => { if(!panRef.current.active)return; trackRef.current.scrollLeft=panRef.current.startScrollLeft-(e.clientX-panRef.current.startX) },[])
  const onTrkUp   = useCallback(() => { panRef.current.active=false; if(trackRef.current)trackRef.current.style.cursor='grab' },[])

  const onDragStart = (e,i) => { setDragIdx(i); e.dataTransfer.effectAllowed='move' }
  const onDragOver  = (e,i) => { e.preventDefault(); setDragOver(i) }
  const onDrop      = (e,i) => { e.preventDefault(); if(dragIdx!==null&&dragIdx!==i)onReorder(dragIdx,i); setDragIdx(null); setDragOver(null) }
  const onDragEnd   = () => { setDragIdx(null); setDragOver(null) }

  const onPillClick = (e,idx) => {
    e.stopPropagation()
    const r=e.currentTarget.getBoundingClientRect()
    const cr=trackRef.current?.closest('[data-timeline]')?.getBoundingClientRect()||{top:0,left:0}
    setPillMenu(pillMenu?.idx===idx?null:{idx,x:r.left-cr.left,y:r.top-cr.top-128})
  }

  return (
    <div className={styles.clipRowWrap}>
      <div ref={setTrackEl} className={styles.track} style={{'--track-accent':accentColor}}
        onScroll={onScroll}
        onMouseDown={onTrkDown} onMouseMove={onTrkMove} onMouseUp={onTrkUp} onMouseLeave={onTrkUp}>
        {clips.length===0 && <div className={styles.emptyTrack}>Drop media here or drag from panel</div>}
        {/* Thin indicator line only — the draggable knob lives in the ruler row above. */}
        {clips.length>0 && <TimelinePlayhead metrics={metrics} axisDur={total} className={styles.playhead} padLeft={TRACK_PAD}/>}
        {clips.map((clip,idx) => {
          const trans=getClipTransition(clip), hasCustom=!!clip.transition
          return (
            <div key={clip.id} className={styles.clipGroup}>
              <div data-clip
                className={[styles.clip,activeClipId===clip.id?styles.active:'',dragOver===idx?styles.dragOver:'',dragIdx===idx?styles.dragging:''].join(' ')}
                style={{width:`${metrics.segs[idx]?.w ?? 64}px`,'--clip-active-color':accentColor}}
                draggable onDragStart={e=>onDragStart(e,idx)} onDragOver={e=>onDragOver(e,idx)} onDrop={e=>onDrop(e,idx)} onDragEnd={onDragEnd}
                onClick={() => { onSelectClip(clip.id); onSeek?.(metrics.segs[idx]?.startT ?? 0) }}>
                {clip._needsMedia
                  ? <div className={styles.needsMedia}>⚠</div>
                  : clip.type==='image'
                    ? <img src={clip.url} alt={clip.name} className={styles.clipThumb}/>
                    : <video src={clip.url} className={styles.clipThumb} muted/>}
                <div className={styles.clipInfo}>
                  <span className={styles.clipTypeIcon}>{clip.type==='video'?'▶':'◉'}</span>
                  <span className={styles.clipDur}>{(clip.duration||0).toFixed(1)}s</span>
                  {clip.blurBackground&&<span className={styles.badge}>⬜</span>}
                  {clip.type==='video'&&!clip.includeAudio&&<span className={styles.badge}>🔇</span>}
                </div>
                <button className={styles.clipRemove} onClick={e=>{e.stopPropagation();onRemoveClip(clip.id)}}><X size={9} strokeWidth={2.5}/></button>
                {activeClipId===clip.id&&<div className={styles.activeIndicator} style={{background:accentColor}}/>}
              </div>
              {idx<clips.length-1&&(
                <div className={styles.pillWrapper}>
                  <div data-pill className={`${styles.transitionPill} ${hasCustom?styles.pillCustom:''} ${trans==='none'?styles.pillNone:''}`}
                    style={hasCustom&&trans!=='none'?{borderColor:accentColor,color:accentColor,background:'rgba(0,0,0,.3)'}:{}}
                    onClick={e=>onPillClick(e,idx)}
                    title={`${TRANS_LABELS[trans]||trans}${hasCustom?' (custom)':' (global)'}`}>
                    {TRANS_ICONS[trans]||'⟷'}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {pillMenu&&(
        <>
          <div className={styles.pillMenuOverlay} onClick={()=>setPillMenu(null)}/>
          <div className={styles.pillMenu} style={{left:pillMenu.x,top:pillMenu.y}}>
            <div className={styles.pillMenuTitle}>After clip {pillMenu.idx+1}</div>
            {TRANSITIONS.map(t=>(
              <button key={t} className={`${styles.pillMenuItem} ${getClipTransition(clips[pillMenu.idx])===t?styles.pillMenuActive:''}`}
                onClick={()=>{onClipTransitionChange(clips[pillMenu.idx].id,t);setPillMenu(null)}}>
                <span className={styles.pillMenuIcon}>{TRANS_ICONS[t]}</span>{TRANS_LABELS[t]}
              </button>
            ))}
            {clips[pillMenu.idx]?.transition&&(
              <button className={styles.pillMenuReset} onClick={()=>{onClipTransitionChange(clips[pillMenu.idx].id,null);setPillMenu(null)}}>↩ Use global default</button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── MusicTrack ──────────────────────────────────────────────────────────────
// Renders the background music's *trimmed* waveform on its own lane, aligned to
// the same time↔px metrics as the clip row. Background music starts at timeline
// t=0 and the export mixes only [trimStart, trimEnd] (amix duration=first cuts
// it to the video length), so we draw that slice from x=0 across its mapped
// width. Display-only: trim is still set via the Inspector's MusicTrimBar.
function MusicTrack({ musicFile, musicNeedsRelink, peaks, peakDuration, trimStart = 0, trimEnd, metrics, axisDur, onScrub, registerScroll, onScroll }) {
  const canvasRef = useRef(null)
  const wrapRef   = useRef(null)
  const setScrollEl = (el) => { wrapRef.current = el; registerScroll?.(el) }

  // The music's audible duration after trim, clamped to what the export keeps.
  const dur = peakDuration || 0
  const tEnd = (typeof trimEnd === 'number' ? trimEnd : dur)
  const segDur = Math.max(0, Math.min(tEnd, dur) - trimStart)
  const spanT  = Math.min(segDur, axisDur || segDur)        // cut to video length
  const widthPx = Math.max(metrics.contentPx, 1)
  const segPx   = timeToPx(spanT, metrics)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    const cssH = MUSIC_ROW_H - 8
    cv.width  = Math.max(1, Math.round(widthPx * dpr))
    cv.height = Math.max(1, Math.round(cssH * dpr))
    const ctx = cv.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, widthPx, cssH)
    if (!peaks || segDur <= 0 || segPx <= 0) return

    const mid = cssH / 2
    const amp = mid - 1
    const { mins, maxs, buckets } = peaks
    // Map a pixel column → the bucket range covering its time span [t0,t1],
    // measured from trimStart. Aggregating buckets avoids aliasing when zoomed
    // out; a single bucket is sampled when zoomed in.
    ctx.fillStyle = 'rgba(232,201,106,0.55)'
    const cols = Math.ceil(segPx)
    for (let x = 0; x < cols; x++) {
      const t0 = trimStart + (x / segPx) * spanT
      const t1 = trimStart + ((x + 1) / segPx) * spanT
      let b0 = Math.floor((t0 / dur) * buckets)
      let b1 = Math.ceil((t1 / dur) * buckets)
      b0 = Math.max(0, Math.min(buckets - 1, b0))
      b1 = Math.max(b0 + 1, Math.min(buckets, b1))
      let mn = 1, mx = -1
      for (let b = b0; b < b1; b++) { if (mins[b] < mn) mn = mins[b]; if (maxs[b] > mx) mx = maxs[b] }
      if (mn > mx) { mn = 0; mx = 0 }
      const yTop = mid - mx * amp
      const h = Math.max(1, (mx - mn) * amp)
      ctx.fillRect(x, yTop, 1, h)
    }
  }, [peaks, widthPx, segPx, spanT, segDur, dur, trimStart])

  return (
    <div className={styles.musicTrack} ref={setScrollEl} onScroll={onScroll} title="Background music waveform (trimmed)">
      <div className={styles.musicTrackInner} style={{ width: `${widthPx}px` }} onMouseDown={onScrub}>
        <canvas ref={canvasRef} className={styles.musicCanvas} style={{ width: `${widthPx}px`, height: `${MUSIC_ROW_H - 8}px` }} />
        <TimelinePlayhead metrics={metrics} axisDur={axisDur} className={styles.playhead} />
        {!peaks && musicFile && <span className={styles.musicTrackHint}>Decoding waveform…</span>}
        {musicNeedsRelink && <span className={styles.musicTrackHint}>Re-link music to show waveform</span>}
      </div>
    </div>
  )
}

// ── Main Timeline ─────────────────────────────────────────────────────────────
export default function Timeline({
  clips, activeClipId, onSelectClip, onReorder, onRemoveClip,
  globalTransition, onGlobalTransitionChange, onClipTransitionChange, getClipTransition,
  totalDuration, exportDuration, timelineDuration=0, timeline=[], clipPlayLen=(c)=>c?.duration||4,
  onSeek,
  textSegments, onAddTextSegment, onSelectTextSegment, onUpdateTextSegment, onRemoveTextSegment, activeTextSegmentId,
  onDropMediaToMain,
  musicFile, musicNeedsRelink, musicDuration, musicTrimStart=0, musicTrimEnd=null,
}) {
  const axisDur   = timelineDuration || totalDuration
  const lenAt     = (i) => (timeline[i] ? timeline[i].len : Math.max(0.1, clipPlayLen?.(clips[i]) ?? 4))
  const [zoom, setZoom] = useState(1)
  const pxPerSec  = PX_PER_SEC_BASE * zoom
  // One shared coordinate system for the clip row and the text track.
  const metrics   = useMemo(() => buildMetrics(clips, lenAt, pxPerSec), [clips, timeline, pxPerSec]) // eslint-disable-line react-hooks/exhaustive-deps
  const lanes     = useMemo(() => assignLanes(textSegments), [textSegments])
  const segDragRef = useRef(null)
  const [mainDropOver, setMainDropOver] = useState(false)

  // Decode the background music to a waveform once per file (renderer-only).
  const { peaks, duration: peakDur } = useAudioPeaks(musicFile)
  const musicLane = !!musicFile || !!musicNeedsRelink

  // Keep the ruler, clip row and text track scrolled together so their
  // playheads and the clip↔caption columns stay vertically aligned on screen.
  const rulerScrollRef = useRef(null)
  const clipScrollRef  = useRef(null)
  const textScrollRef  = useRef(null)
  const musicScrollRef = useRef(null)
  const syncingRef     = useRef(false)
  const onAnyScroll = useCallback((e) => {
    if (syncingRef.current) return
    const src = e.currentTarget, left = src.scrollLeft
    syncingRef.current = true
    for (const ref of [rulerScrollRef, clipScrollRef, textScrollRef, musicScrollRef]) {
      const el = ref.current
      if (el && el !== src && el.scrollLeft !== left) el.scrollLeft = left
    }
    requestAnimationFrame(() => { syncingRef.current = false })
  }, [])

  // Ruler tick marks — aim for ~72px between labels, snapped to a nice step.
  const tickStep = useMemo(() => {
    const target = 72 / pxPerSec
    return [1, 2, 5, 10, 15, 30, 60, 120, 300].find(n => n >= target) || 300
  }, [pxPerSec])
  const ticks = useMemo(() => {
    const out = []
    for (let t = 0; t <= axisDur + 1e-6; t += tickStep) out.push(t)
    return out
  }, [axisDur, tickStep])

  // Click/drag anywhere on the text-overlay track to move the playhead, using
  // the same time↔px mapping as the clip row. Grabbing a segment is excluded.
  const onScrub = useCallback((e) => {
    if (e.target.closest('[data-textseg]')) return
    const inner = e.currentTarget
    const rect = inner.getBoundingClientRect()
    const toTime = (cx) => Math.max(0, Math.min(axisDur, pxToTime(cx - rect.left, metrics)))
    onSeek?.(toTime(e.clientX))
    const mv = (ev) => onSeek?.(toTime(ev.clientX))
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
  }, [axisDur, metrics, onSeek])

  const fmtDur = (s) => {
    const m = Math.floor(s / 60)
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
  }

  const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))
  const zoomBy = useCallback((factor) => setZoom(z => clampZoom(z * factor)), [])
  // Ctrl/Cmd + wheel zooms (the familiar NLE gesture); plain wheel scrolls.
  // React registers onWheel as passive, so attach a native non-passive listener
  // to allow preventDefault and stop the page/track from scrolling while zooming.
  const containerRef = useRef(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setZoom(z => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const handleSegMouseDown = useCallback((e, seg) => {
    e.stopPropagation()
    onSelectTextSegment(seg.id)
    segDragRef.current = { segId:seg.id, startX:e.clientX, startPx:timeToPx(seg.startTime, metrics) }
    const mv = (ev) => {
      if (!segDragRef.current) return
      const dx = ev.clientX - segDragRef.current.startX
      const nt = Math.max(0, pxToTime(segDragRef.current.startPx + dx, metrics))
      onUpdateTextSegment?.(segDragRef.current.segId, { startTime:+nt.toFixed(2) })
    }
    const up = () => { segDragRef.current=null; window.removeEventListener('mouseup',up); window.removeEventListener('mousemove',mv) }
    window.addEventListener('mousemove',mv); window.addEventListener('mouseup',up)
  }, [onSelectTextSegment, onUpdateTextSegment, metrics])

  const isMediaDrag = (e) => e.dataTransfer.types.includes('application/x-media-id')
  const onMainDragOver  = useCallback((e) => { if(!isMediaDrag(e))return; e.preventDefault(); setMainDropOver(true) },[])
  const onMainDragLeave = useCallback(() => setMainDropOver(false),[])
  const onMainDrop = useCallback((e) => {
    e.preventDefault(); setMainDropOver(false)
    const data = e.dataTransfer.getData('application/x-media-id')
    if (!data) return
    data.split(',').forEach(id => { if (id) onDropMediaToMain?.(id) })
  }, [onDropMediaToMain])

  return (
    <div className={styles.container} data-timeline ref={containerRef}>
      <div className={styles.stickyTop}>
      <div className={styles.header}>
        <span className={styles.label}>Timeline</span>
        {exportDuration > 0 && (
          <div className={styles.exportDurationChip} title="Total encoded output length (trim-adjusted). This is the master duration used for export.">
            <span className={styles.exportDurationIcon}>⏱</span>
            <span className={styles.exportDurationVal}>{fmtDur(exportDuration)}</span>
            <span className={styles.exportDurationLabel}>export</span>
          </div>
        )}
        <div className={styles.headerActions}>
          <span className={styles.hint}>Drag clips to reorder · drag track to pan · ⌘/Ctrl+scroll to zoom</span>
          <div className={styles.zoomControls}>
            <button className={styles.zoomBtn} onClick={() => zoomBy(1/1.5)} disabled={zoom<=ZOOM_MIN} title="Zoom out"><ZoomOut size={12} strokeWidth={1.8}/></button>
            <input type="range" className={styles.zoomSlider} min={ZOOM_MIN} max={ZOOM_MAX} step={0.05}
              value={zoom} onChange={e => setZoom(clampZoom(+e.target.value))} title={`Zoom ${zoom.toFixed(2)}×`} />
            <button className={styles.zoomBtn} onClick={() => zoomBy(1.5)} disabled={zoom>=ZOOM_MAX} title="Zoom in"><ZoomIn size={12} strokeWidth={1.8}/></button>
          </div>
          <button className={styles.transBtn} onClick={() => { const i=TRANSITIONS.indexOf(globalTransition); onGlobalTransitionChange(TRANSITIONS[(i+1)%TRANSITIONS.length]) }}>
            {TRANS_ICONS[globalTransition]} Global: {TRANS_LABELS[globalTransition]}
          </button>
        </div>
      </div>

      {/* Dedicated ruler / scrubber lane — click to jump, drag the knob to scrub */}
      <div className={styles.ruler} ref={rulerScrollRef} onScroll={onAnyScroll}>
        <div className={styles.rulerInner} style={{width:`${Math.max(metrics.contentPx,1)}px`}}
          onMouseDown={onScrub} title="Click or drag to move the playhead">
          {ticks.map(tk => (
            <div key={tk} className={styles.rulerTick} style={{left:`${timeToPx(tk, metrics)}px`}}>
              <span className={styles.rulerTickLabel}>{fmtDur(tk)}</span>
            </div>
          ))}
          <TimelinePlayhead metrics={metrics} axisDur={axisDur} className={styles.rulerPlayhead}>
            <div className={styles.rulerKnob}/>
          </TimelinePlayhead>
        </div>
      </div>
      </div>

      <div className={`${styles.mainDropZone} ${mainDropOver?styles.dropZoneActive:''}`}
        onDragOver={onMainDragOver} onDragLeave={onMainDragLeave} onDrop={onMainDrop}>
        <ClipRow
          clips={clips} activeClipId={activeClipId} onSelectClip={onSelectClip}
          onReorder={onReorder} onRemoveClip={onRemoveClip}
          globalTransition={globalTransition} onGlobalTransitionChange={onGlobalTransitionChange}
          onClipTransitionChange={onClipTransitionChange} getClipTransition={getClipTransition}
          metrics={metrics} total={axisDur} onSeek={onSeek}
          registerScroll={el => { clipScrollRef.current = el }} onScroll={onAnyScroll}
          accentColor="var(--accent)"
        />
        {mainDropOver && <div className={styles.dropHintBanner}>Drop to add to timeline</div>}
      </div>

      {musicLane && (
        <>
          <div className={styles.trackSectionHeader}>
            <Music size={11} strokeWidth={1.5} style={{color:'#7fb5d8',flexShrink:0}}/>
            <span className={styles.trackSectionLabel} style={{color:'#7fb5d8'}}>Music</span>
            <span className={styles.musicSectionName}>{musicFile?.name || musicNeedsRelink || ''}</span>
          </div>
          <MusicTrack
            musicFile={musicFile} musicNeedsRelink={musicNeedsRelink}
            peaks={peaks} peakDuration={peakDur || musicDuration || 0}
            trimStart={musicTrimStart} trimEnd={musicTrimEnd}
            metrics={metrics} axisDur={axisDur} onScrub={onScrub}
            registerScroll={el => { musicScrollRef.current = el }} onScroll={onAnyScroll}
          />
        </>
      )}

      <div className={styles.trackSectionHeader}>
        <Type size={11} strokeWidth={1.5} style={{color:'#e8c96a',flexShrink:0}}/>
        <span className={styles.trackSectionLabel} style={{color:'#e8c96a'}}>Text overlays</span>
        <button className={styles.addTrackBtn} style={{color:'#e8c96a',borderColor:'rgba(232,201,106,0.35)'}}
          onClick={() => onAddTextSegment(+Math.max(0, Math.min(axisDur, playhead.get())).toFixed(2))}>
          <Plus size={10} strokeWidth={2}/> Add
        </button>
      </div>
      <div className={styles.textTrack} ref={textScrollRef} onScroll={onAnyScroll} style={{height:`${lanes.count*TEXT_ROW_H+8}px`}}>
        <div className={styles.textTrackInner} style={{width:`${Math.max(metrics.contentPx, 1)}px`,height:`${lanes.count*TEXT_ROW_H}px`}} onMouseDown={onScrub} title="Click or drag to move the playhead">
          <TimelinePlayhead metrics={metrics} axisDur={axisDur} className={styles.playhead}/>
          {(textSegments||[]).map(seg => (
            <div key={seg.id}
              className={`${styles.textSeg} ${activeTextSegmentId===seg.id?styles.textSegActive:''}`}
              style={{left:`${timeToPx(seg.startTime, metrics)}px`,width:`${Math.max(36, timeToPx(seg.startTime+seg.duration, metrics) - timeToPx(seg.startTime, metrics))}px`,top:`${(lanes.laneOf[seg.id]||0)*TEXT_ROW_H}px`,height:`${TEXT_ROW_H-4}px`}}
              onMouseDown={e=>handleSegMouseDown(e,seg)}>
              <span className={styles.textSegLabel}>{seg.text||'…'}</span>
              <button className={styles.textSegRemove} onMouseDown={e=>e.stopPropagation()} onClick={()=>onRemoveTextSegment(seg.id)}>
                <X size={8} strokeWidth={2.5}/>
              </button>
            </div>
          ))}
          {!(textSegments?.length)&&<span className={styles.textTrackEmpty}>Click "Add" to place text on the timeline</span>}
        </div>
      </div>
    </div>
  )
}
