import { useRef, useState, useCallback } from 'react'
import { X, Plus, Type } from 'lucide-react'
import styles from './Timeline.module.css'

const TRANSITIONS = ['none','crossfade','slide_left','slide_up','zoom_in','dip_black']
const TRANS_ICONS  = { none:'✕', crossfade:'⟷', slide_left:'←', slide_up:'↑', zoom_in:'⊕', dip_black:'●' }
const TRANS_LABELS = { none:'Cut', crossfade:'Crossfade', slide_left:'Slide ←', slide_up:'Slide ↑', zoom_in:'Zoom', dip_black:'Dip' }
const PX_PER_SEC   = 16

// ── ClipRow ───────────────────────────────────────────────────────────────────
function ClipRow({ clips, activeClipId, onSelectClip, onReorder, onRemoveClip, globalTransition, onGlobalTransitionChange, onClipTransitionChange, getClipTransition, accentColor='var(--accent)' }) {
  const [dragIdx,  setDragIdx]  = useState(null)
  const [dragOver, setDragOver] = useState(null)
  const [pillMenu, setPillMenu] = useState(null)
  const trackRef = useRef()
  const panRef   = useRef({ active:false, startX:0, startScrollLeft:0 })

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
      <div ref={trackRef} className={styles.track} style={{'--track-accent':accentColor}}
        onMouseDown={onTrkDown} onMouseMove={onTrkMove} onMouseUp={onTrkUp} onMouseLeave={onTrkUp}>
        {clips.length===0 && <div className={styles.emptyTrack}>Drop media here or drag from panel</div>}
        {clips.map((clip,idx) => {
          const t=getClipTransition(clip), hasCustom=!!clip.transition
          return (
            <div key={clip.id} className={styles.clipGroup}>
              <div data-clip
                className={[styles.clip,activeClipId===clip.id?styles.active:'',dragOver===idx?styles.dragOver:'',dragIdx===idx?styles.dragging:''].join(' ')}
                style={{width:`${Math.max(64,(clip.duration||4)*PX_PER_SEC)}px`,'--clip-active-color':accentColor}}
                draggable onDragStart={e=>onDragStart(e,idx)} onDragOver={e=>onDragOver(e,idx)} onDrop={e=>onDrop(e,idx)} onDragEnd={onDragEnd}
                onClick={() => onSelectClip(clip.id)}>
                {clip._needsMedia
                  ? <div className={styles.needsMedia}>⚠</div>
                  : clip.type==='image'
                    ? <img src={clip.url} alt={clip.name} className={styles.clipThumb}/>
                    : <video src={clip.url} className={styles.clipThumb} muted/>}
                {/* Trim region indicator for video clips */}
                {clip.type==='video'&&clip.fileDuration>0&&(clip.trimStart>0||(clip.trimEnd&&clip.trimEnd<clip.fileDuration))&&(
                  <div className={styles.trimOverlay}>
                    {clip.trimStart>0&&<div className={styles.trimLeft} style={{width:`${(clip.trimStart/clip.fileDuration)*100}%`}}/>}
                    {clip.trimEnd&&clip.trimEnd<clip.fileDuration&&<div className={styles.trimRight} style={{width:`${(1-clip.trimEnd/clip.fileDuration)*100}%`}}/>}
                  </div>
                )}
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
                  <div data-pill className={`${styles.transitionPill} ${hasCustom?styles.pillCustom:''} ${t==='none'?styles.pillNone:''}`}
                    style={hasCustom&&t!=='none'?{borderColor:accentColor,color:accentColor,background:'rgba(0,0,0,.3)'}:{}}
                    onClick={e=>onPillClick(e,idx)}
                    title={`${TRANS_LABELS[t]||t}${hasCustom?' (custom)':' (global)'}`}>
                    {TRANS_ICONS[t]||'⟷'}
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

// ── Main Timeline ─────────────────────────────────────────────────────────────
export default function Timeline({
  clips, activeClipId, onSelectClip, onReorder, onRemoveClip,
  globalTransition, onGlobalTransitionChange, onClipTransitionChange, getClipTransition,
  totalDuration, exportDuration,
  textSegments, onAddTextSegment, onSelectTextSegment, onUpdateTextSegment, onRemoveTextSegment, activeTextSegmentId,
  onDropMediaToMain,
}) {
  const totalPx   = Math.max(totalDuration * PX_PER_SEC, 320)
  const segDragRef = useRef(null)
  const [mainDropOver, setMainDropOver] = useState(false)

  const fmtDur = (s) => {
    const m = Math.floor(s / 60)
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
  }

  const handleSegMouseDown = useCallback((e, seg) => {
    e.stopPropagation()
    onSelectTextSegment(seg.id)
    segDragRef.current = { segId:seg.id, startX:e.clientX, startTime:seg.startTime }
    const mv = (ev) => {
      if (!segDragRef.current) return
      const dx = ev.clientX - segDragRef.current.startX
      onUpdateTextSegment?.(segDragRef.current.segId, { startTime:+Math.max(0, segDragRef.current.startTime+dx/PX_PER_SEC).toFixed(2) })
    }
    const up = () => { segDragRef.current=null; window.removeEventListener('mouseup',up); window.removeEventListener('mousemove',mv) }
    window.addEventListener('mousemove',mv); window.addEventListener('mouseup',up)
  }, [onSelectTextSegment, onUpdateTextSegment])

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
    <div className={styles.container} data-timeline>
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
          <span className={styles.hint}>Drag clips to reorder · drag track to pan</span>
          <button className={styles.transBtn} onClick={() => { const i=TRANSITIONS.indexOf(globalTransition); onGlobalTransitionChange(TRANSITIONS[(i+1)%TRANSITIONS.length]) }}>
            {TRANS_ICONS[globalTransition]} Global: {TRANS_LABELS[globalTransition]}
          </button>
        </div>
      </div>

      <div className={`${styles.mainDropZone} ${mainDropOver?styles.dropZoneActive:''}`}
        onDragOver={onMainDragOver} onDragLeave={onMainDragLeave} onDrop={onMainDrop}>
        <ClipRow
          clips={clips} activeClipId={activeClipId} onSelectClip={onSelectClip}
          onReorder={onReorder} onRemoveClip={onRemoveClip}
          globalTransition={globalTransition} onGlobalTransitionChange={onGlobalTransitionChange}
          onClipTransitionChange={onClipTransitionChange} getClipTransition={getClipTransition}
          accentColor="var(--accent)"
        />
        {mainDropOver && <div className={styles.dropHintBanner}>Drop to add to timeline</div>}
      </div>

      <div className={styles.trackSectionHeader}>
        <Type size={11} strokeWidth={1.5} style={{color:'#e8c96a',flexShrink:0}}/>
        <span className={styles.trackSectionLabel} style={{color:'#e8c96a'}}>Text overlays</span>
        <button className={styles.addTrackBtn} style={{color:'#e8c96a',borderColor:'rgba(232,201,106,0.35)'}}
          onClick={() => onAddTextSegment(Math.min(2,totalDuration*0.1))}>
          <Plus size={10} strokeWidth={2}/> Add
        </button>
      </div>
      <div className={styles.textTrack}>
        <div className={styles.textTrackInner} style={{width:`${totalPx+32}px`}}>
          {(textSegments||[]).map(seg => (
            <div key={seg.id}
              className={`${styles.textSeg} ${activeTextSegmentId===seg.id?styles.textSegActive:''}`}
              style={{left:`${seg.startTime*PX_PER_SEC}px`,width:`${Math.max(48,seg.duration*PX_PER_SEC)}px`}}
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
