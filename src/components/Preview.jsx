import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { PRESET_FONTS, loadPreviewFont } from '../hooks/useFFmpeg'
import styles from './Preview.module.css'

const TRANS_OUT = { crossfade:'fadeOut', slide_left:'slideLeftOut', slide_up:'slideUpOut', zoom_in:'zoomOut', dip_black:'dipOut' }
const TRANS_LABELS = { crossfade:'Crossfade', slide_left:'Slide ←', slide_up:'Slide ↑', zoom_in:'Zoom', dip_black:'Dip ●' }
const VIEWPORT_MIN = 30, VIEWPORT_MAX = 100

export default function Preview({
  clips, activeClipId, onSelectClip,
  isPlaying, onPlayToggle,
  getClipTransition, aspectRatio,
  textSegments = [],
  onUpdateTextSegment,
}) {
  const [displayIdx,    setDisplayIdx]   = useState(0)
  const [transKey,      setTransKey]     = useState('visible')
  const [viewportSize,  setViewportSize] = useState(100)
  const [playTime,      setPlayTime]     = useState(0)
  const [draggingSegId, setDraggingSegId]= useState(null)
  const [isMuted,       setIsMuted]      = useState(false)

  const intervalRef  = useRef(null)
  const playTimerRef = useRef(null)
  const segDragRef   = useRef(null)
  const screenRef    = useRef(null)
  const videoRef     = useRef(null)

  const activeIdx  = clips.findIndex(c => c.id===activeClipId)
  const clip       = clips[displayIdx]
  const isVertical = aspectRatio === '9:16'

  useEffect(() => { if(activeIdx>=0) setDisplayIdx(activeIdx) }, [activeIdx])

  useEffect(() => {
    clearTimeout(intervalRef.current); clearInterval(playTimerRef.current)
    if(!isPlaying||clips.length===0) return
    const clipStart=clips.slice(0,displayIdx).reduce((s,c)=>s+(c.duration||4),0)
    setPlayTime(clipStart)
    let elapsed=0
    playTimerRef.current=setInterval(()=>{elapsed+=0.1;setPlayTime(clipStart+elapsed)},100)
    const dur=(clips[displayIdx]?.duration||4)*1000
    intervalRef.current=setTimeout(()=>{
      clearInterval(playTimerRef.current)
      setTransKey(TRANS_OUT[getClipTransition(clips[displayIdx])]||'fadeOut')
      setTimeout(()=>{
        const next=(displayIdx+1)%clips.length
        setDisplayIdx(next); if(clips[next])onSelectClip(clips[next].id); setTransKey('visible')
      },350)
    },dur)
    return ()=>{clearTimeout(intervalRef.current);clearInterval(playTimerRef.current)}
  },[isPlaying,displayIdx,clips])

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

  const totalDur    = clips.reduce((s,c)=>s+(c.duration||0),0)
  const effTrans    = getClipTransition(clip)
  const fmt         = (s)=>`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`
  const filterStyle = clip ? `brightness(${1+(clip.brightness||0)/100}) contrast(${1+(clip.contrast||0)/100}) saturate(${1+(clip.saturation||0)/100})` : undefined

  // Get CSS animation class for image effects
  const getEffectClass = (clip) => {
    if (!clip || clip.type !== 'image') return ''
    switch(clip.imageEffect) {
      case 'ken_burns':   return styles.effectKenBurns
      case 'pan_zoom':    return styles.effectPanZoom
      case 'parallax':    return styles.effectParallax
      case 'fade_in':     return styles.effectFadeIn
      default: return ''
    }
  }

  // Sync video element: mute, trimStart seek on clip change
  useEffect(() => {
    const v = videoRef.current; if (!v) return
    v.muted = isMuted
  }, [isMuted])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !clip || clip.type !== 'video') return
    const trimStart = clip.trimStart || 0
    v.currentTime = trimStart
    if (isPlaying) {
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [clip?.id]) // only re-run when clip changes — play/pause handled below

  // Play/pause control when isPlaying toggles
  useEffect(() => {
    const v = videoRef.current
    if (!v || !clip || clip.type !== 'video') return
    if (isPlaying) {
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [isPlaying])

  const allFontKeys = [...new Set(textSegments.map(s=>s.fontFile||'Poppins-Regular'))]
  allFontKeys.forEach(k=>{if(k!=='custom')loadPreviewFont(k)})

  // Load custom font into the browser whenever customFontData changes
  useEffect(() => {
    const customSeg = textSegments.find(s => s.fontFile === 'custom' && s.customFontData)
    if (!customSeg) return
    const { customFontData, customFontName } = customSeg
    const fontFace = new FontFace('MomCustomFont', customFontData.buffer ?? customFontData)
    fontFace.load().then(loaded => {
      document.fonts.add(loaded)
    }).catch(() => {})
  }, [textSegments.find(s => s.fontFile === 'custom')?.customFontData])
  const getFontFamily = (seg)=>{
    const k=seg.fontFile||'Poppins-Regular'; if(k==='custom')return `'MomCustomFont', sans-serif`
    const p=PRESET_FONTS.find(f=>f.key===k); return p?.cssFamily?`'${p.cssFamily}', sans-serif`:'sans-serif'
  }
  // Compute timeline start time of the currently displayed clip
  const clipTimeStart = clips.slice(0, displayIdx).reduce((s, c) => s + (c.duration || 4), 0)
  const clipTimeEnd   = clipTimeStart + (clips[displayIdx]?.duration || 4)

  // When not playing: only show text segments that overlap the current clip's time window
  // When playing: filter by exact playTime as before
  const visibleSegs = isPlaying
    ? textSegments.filter(s => playTime >= s.startTime && playTime < s.startTime + s.duration)
    : textSegments.filter(s => s.startTime < clipTimeEnd && (s.startTime + s.duration) > clipTimeStart)
  const screenStyle = isVertical ? {height:`${viewportSize}%`,aspectRatio:'9/16'} : {width:`${viewportSize}%`,aspectRatio:'16/9'}

  return (
    <div className={styles.wrapper}>
      <div className={styles.viewportWrap}>
        <div ref={screenRef}
          className={styles.screen}
          style={screenStyle}>

          <div className={`${styles.mediaLayer} ${styles[transKey]}`}>
            {clip&&!clip._needsMedia?(
              <>
                {clip.type==='image'
                  ?<img src={clip.url} alt={clip.name} className={[styles.mediaEl, getEffectClass(clip)].filter(Boolean).join(' ')} draggable={false} style={{filter:filterStyle}}/>
                  :<video ref={videoRef} src={clip.url} className={styles.mediaEl} muted={isMuted} loop style={{filter:filterStyle}}/>}
              </>
            ):clip?._needsMedia?(
              <div className={styles.needsMedia}><span className={styles.nmIcon}>⚠</span><span className={styles.nmName}>{clip.name}</span><span className={styles.nmHint}>Re-add file</span></div>
            ):(
              <div className={styles.empty}><span className={styles.emptyIcon}>◈</span><span className={styles.emptyText}>Drop media to begin</span></div>
            )}
          </div>

          {visibleSegs.map(seg=>{
            const isCustom=seg.position==='custom'
            return (
              <div key={seg.id} data-textseg
                className={[isCustom?styles.textOverlayCustom:styles.textOverlay,!isCustom?styles[`pos_${seg.position||'bottom'}`]:'',isPlaying?styles[`anim_${seg.animation||'fade'}`]:''].join(' ')}
                style={{fontSize:`${Math.round((seg.fontSize||28)*0.55)}px`,color:seg.color||'#fff',fontFamily:getFontFamily(seg),cursor:draggingSegId===seg.id?'grabbing':'grab',...(isCustom?{position:'absolute',left:`${seg.posX??50}%`,top:`${seg.posY??85}%`,transform:'translate(-50%,-50%)',textAlign:'center',width:'max-content',maxWidth:'90%'}:{})}}
                onMouseDown={e=>onSegMouseDown(e,seg)} title="Drag to reposition">
                {seg.text}
              </div>
            )
          })}

          <div className={styles.hud}>
            <div className={styles.counter}>{clips.length>0?`${displayIdx+1} / ${clips.length}`:''}</div>
            <div className={styles.transBadge}>{TRANS_LABELS[effTrans]||effTrans}</div>
          </div>
        </div>
      </div>

      <div className={styles.controlsBar}>
        <div className={styles.playbackGroup}>
          <button className={styles.ctrl} onClick={()=>{const i=Math.max(0,activeIdx-1);if(clips[i])onSelectClip(clips[i].id)}}><SkipBack size={14} strokeWidth={1.5}/></button>
          <button className={`${styles.ctrl} ${styles.playBtn}`} onClick={onPlayToggle} disabled={clips.length===0}>
            {isPlaying?<Pause size={16} strokeWidth={1.5}/>:<Play size={16} strokeWidth={1.5}/>}
          </button>
          <button className={styles.ctrl} onClick={()=>{const i=Math.min(clips.length-1,activeIdx+1);if(clips[i])onSelectClip(clips[i].id)}}><SkipForward size={14} strokeWidth={1.5}/></button>
          <button className={`${styles.ctrl} ${isMuted?styles.ctrlMuted:''}`} onClick={()=>setIsMuted(m=>!m)} title={isMuted?'Unmute':'Mute'}>
            {isMuted?<VolumeX size={14} strokeWidth={1.5}/>:<Volume2 size={14} strokeWidth={1.5}/>}
          </button>
          <span className={styles.timeLabel}>{fmt(totalDur)}</span>
        </div>
        <div className={styles.vpGroup}>
          <span className={styles.controlLabel}>Viewport</span>
          <input type="range" min={VIEWPORT_MIN} max={VIEWPORT_MAX} step={5} value={viewportSize} className={styles.vpSlider} onChange={e=>setViewportSize(Number(e.target.value))}/>
          <span className={styles.zoomLabel}>{viewportSize}%</span>
        </div>
      </div>
    </div>
  )
}
