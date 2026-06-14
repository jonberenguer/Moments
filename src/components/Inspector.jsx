import { useRef, useCallback, useState } from 'react'
import styles from './Inspector.module.css'
import { PRESET_FONTS } from '../hooks/useFFmpeg'

const TRANSITIONS = [
  { value:'',           label:'Use global default' },
  { value:'none',       label:'Cut (no transition)' },
  { value:'crossfade',  label:'Crossfade' },
  { value:'slide_left', label:'Slide Left' },
  { value:'slide_up',   label:'Slide Up' },
  { value:'zoom_in',    label:'Zoom In' },
  { value:'dip_black',  label:'Dip to Black' },
]
const ANIM_OPTIONS = ['fade','slide','typewriter']

function TrimBar({ clip, onUpdate }) {
  const trackRef = useRef()
  const dragRef  = useRef(null)
  const fileDur  = clip.fileDuration || 0
  const trimStart = clip.trimStart || 0
  const trimEnd   = clip.trimEnd   || fileDur
  // Draft holds in-progress text for the start/end fields while typing.
  const [startDraft, setStartDraft] = useState(null)
  const [endDraft,   setEndDraft]   = useState(null)

  const commitStart = (raw) => {
    setStartDraft(null)
    if (raw === '') return
    const n = Number(raw); if (Number.isNaN(n)) return
    const clamped = Math.min(n, trimEnd - 0.5)
    onUpdate(clip.id, { trimStart: +Math.max(0, clamped).toFixed(2) })
  }
  const commitEnd = (raw) => {
    setEndDraft(null)
    if (raw === '') return
    const n = Number(raw); if (Number.isNaN(n)) return
    const clamped = Math.min(fileDur, Math.max(n, trimStart + 0.5))
    onUpdate(clip.id, { trimEnd: +clamped.toFixed(2), duration: +Math.min(clip.duration || 4, clamped - trimStart).toFixed(1) })
  }

  const startDrag = useCallback((which, e) => {
    e.preventDefault()
    const rect = trackRef.current.getBoundingClientRect()
    dragRef.current = { which, rect }
    const onMove = (ev) => {
      if (!dragRef.current) return
      const { rect, which } = dragRef.current
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      const val = +(pct * fileDur).toFixed(2)
      if (which === 'start') {
        const clamped = Math.min(val, (clip.trimEnd || fileDur) - 0.5)
        onUpdate(clip.id, { trimStart: Math.max(0, clamped) })
      } else {
        const clamped = Math.max(val, (clip.trimStart || 0) + 0.5)
        onUpdate(clip.id, { trimEnd: Math.min(fileDur, clamped), duration: +Math.min(clip.duration || 4, Math.min(fileDur, clamped) - (clip.trimStart || 0)).toFixed(1) })
      }
    }
    const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [clip, fileDur, onUpdate])

  if (!fileDur) return null
  const leftPct  = (trimStart / fileDur) * 100
  const rightPct = (trimEnd   / fileDur) * 100
  const fmt = s => `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}.${Math.floor((s%1)*10)}`

  return (
    <div className={styles.trimSection}>
      <div className={styles.sliderHeader} style={{marginBottom:6}}>
        <span className={styles.sliderLabel}>Trim Segment</span>
        <span className={styles.sliderVal}>{trimStart.toFixed(1)}s – {trimEnd.toFixed(1)}s</span>
      </div>
      <div ref={trackRef} className={styles.trimTrack}>
        <div className={styles.trimDimLeft}  style={{width:`${leftPct}%`}}/>
        <div className={styles.trimDimRight} style={{left:`${rightPct}%`}}/>
        <div className={styles.trimActive}   style={{left:`${leftPct}%`, right:`${100-rightPct}%`}}/>
        <div className={styles.trimHandle}   style={{left:`${leftPct}%`}}  onMouseDown={e=>startDrag('start',e)} title="Drag trim start"/>
        <div className={styles.trimHandle}   style={{left:`${rightPct}%`}} onMouseDown={e=>startDrag('end',e)}   title="Drag trim end"/>
      </div>
      <div className={styles.trimLabels}>
        <span>{fmt(trimStart)}</span>
        <span className={styles.trimDurLabel}>{(trimEnd-trimStart).toFixed(1)}s used</span>
        <span>{fmt(trimEnd)}</span>
      </div>
      <div className={styles.trimInputs}>
        <label className={styles.trimInputCell}>
          <span className={styles.trimInputKey}>Start</span>
          <span className={styles.sliderValEdit}>
            <input type="number" className={styles.sliderNum} value={startDraft ?? +trimStart.toFixed(2)}
              min={0} max={+(trimEnd-0.5).toFixed(2)} step={0.1}
              onChange={e=>setStartDraft(e.target.value)}
              onBlur={e=>commitStart(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter') e.currentTarget.blur() }}/>
            <span className={styles.sliderUnit}>s</span>
          </span>
        </label>
        <label className={styles.trimInputCell}>
          <span className={styles.trimInputKey}>End</span>
          <span className={styles.sliderValEdit}>
            <input type="number" className={styles.sliderNum} value={endDraft ?? +trimEnd.toFixed(2)}
              min={+(trimStart+0.5).toFixed(2)} max={+fileDur.toFixed(2)} step={0.1}
              onChange={e=>setEndDraft(e.target.value)}
              onBlur={e=>commitEnd(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter') e.currentTarget.blur() }}/>
            <span className={styles.sliderUnit}>s</span>
          </span>
        </label>
      </div>
      <button className={styles.resetBtn} onClick={()=>onUpdate(clip.id,{trimStart:0,trimEnd:null})}>Reset trim</button>
    </div>
  )
}

function MusicTrimBar({ musicDuration, musicTrimStart, musicTrimEnd, onMusicTrimChange }) {
  const trackRef = useRef()
  const dragRef  = useRef(null)
  const dur      = musicDuration || 0
  const tStart   = musicTrimStart || 0
  const tEnd     = musicTrimEnd != null ? musicTrimEnd : dur
  // Draft holds in-progress text for the start/end fields while typing.
  const [startDraft, setStartDraft] = useState(null)
  const [endDraft,   setEndDraft]   = useState(null)

  const commitStart = (raw) => {
    setStartDraft(null)
    if (raw === '') return
    const n = Number(raw); if (Number.isNaN(n)) return
    const clamped = Math.max(0, Math.min(n, tEnd - 0.5))
    onMusicTrimChange(+clamped.toFixed(2), tEnd >= dur ? null : tEnd)
  }
  const commitEnd = (raw) => {
    setEndDraft(null)
    if (raw === '') return
    const n = Number(raw); if (Number.isNaN(n)) return
    const clamped = Math.min(dur, Math.max(n, tStart + 0.5))
    onMusicTrimChange(tStart, clamped >= dur ? null : +clamped.toFixed(2))
  }

  const startDrag = useCallback((which, e) => {
    e.preventDefault()
    const rect = trackRef.current.getBoundingClientRect()
    dragRef.current = { which, rect }
    const onMove = (ev) => {
      if (!dragRef.current) return
      const pct = Math.max(0, Math.min(1, (ev.clientX - dragRef.current.rect.left) / dragRef.current.rect.width))
      const val = +(pct * dur).toFixed(2)
      if (dragRef.current.which === 'start') {
        const clamped = Math.max(0, Math.min(val, tEnd - 0.5))
        onMusicTrimChange(clamped, tEnd >= dur ? null : tEnd)
      } else {
        const clamped = Math.min(dur, Math.max(val, tStart + 0.5))
        onMusicTrimChange(tStart, clamped >= dur ? null : clamped)
      }
    }
    const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [dur, tStart, tEnd, onMusicTrimChange])

  if (!dur) return null
  const leftPct  = (tStart / dur) * 100
  const rightPct = (tEnd   / dur) * 100
  const fmt = s => `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}.${Math.floor((s%1)*10)}`

  return (
    <div className={styles.trimSection}>
      <div className={styles.sliderHeader} style={{marginBottom:6}}>
        <span className={styles.sliderLabel}>Music Trim</span>
        <span className={styles.sliderVal}>{tStart.toFixed(1)}s – {tEnd.toFixed(1)}s</span>
      </div>
      <div ref={trackRef} className={styles.trimTrack}>
        <div className={styles.trimDimLeft}  style={{width:`${leftPct}%`}}/>
        <div className={styles.trimDimRight} style={{left:`${rightPct}%`}}/>
        <div className={styles.trimActive}   style={{left:`${leftPct}%`, right:`${100-rightPct}%`}}/>
        <div className={styles.trimHandle}   style={{left:`${leftPct}%`}}  onMouseDown={e=>startDrag('start',e)} title="Drag trim start"/>
        <div className={styles.trimHandle}   style={{left:`${rightPct}%`}} onMouseDown={e=>startDrag('end',e)}   title="Drag trim end"/>
      </div>
      <div className={styles.trimLabels}>
        <span>{fmt(tStart)}</span>
        <span className={styles.trimDurLabel}>{(tEnd-tStart).toFixed(1)}s used</span>
        <span>{fmt(tEnd)}</span>
      </div>
      <div className={styles.trimInputs}>
        <label className={styles.trimInputCell}>
          <span className={styles.trimInputKey}>Start</span>
          <span className={styles.sliderValEdit}>
            <input type="number" className={styles.sliderNum} value={startDraft ?? +tStart.toFixed(2)}
              min={0} max={+(tEnd-0.5).toFixed(2)} step={0.1}
              onChange={e=>setStartDraft(e.target.value)}
              onBlur={e=>commitStart(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter') e.currentTarget.blur() }}/>
            <span className={styles.sliderUnit}>s</span>
          </span>
        </label>
        <label className={styles.trimInputCell}>
          <span className={styles.trimInputKey}>End</span>
          <span className={styles.sliderValEdit}>
            <input type="number" className={styles.sliderNum} value={endDraft ?? +tEnd.toFixed(2)}
              min={+(tStart+0.5).toFixed(2)} max={+dur.toFixed(2)} step={0.1}
              onChange={e=>setEndDraft(e.target.value)}
              onBlur={e=>commitEnd(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter') e.currentTarget.blur() }}/>
            <span className={styles.sliderUnit}>s</span>
          </span>
        </label>
      </div>
      <button className={styles.resetBtn} onClick={()=>onMusicTrimChange(0, null)}>Reset trim</button>
    </div>
  )
}

function Slider({ label, value, min, max, step=1, format=v=>v, onChange }) {
  // Draft holds the in-progress text while the user types so partial input
  // (e.g. "-", "1." ) isn't clobbered. null = not editing, show live value.
  const [draft, setDraft] = useState(null)
  // Derive the unit suffix ("s", "x", "%", …) from the display formatter so
  // callers don't have to pass it separately.
  const unit = String(format(value)).replace(/[-\d.]/g, '')
  const commit = (raw) => {
    setDraft(null)
    if (raw === '' ) return
    const n = Number(raw)
    if (Number.isNaN(n)) return
    onChange(Math.min(max, Math.max(min, n)))
  }
  return (
    <div className={styles.sliderRow}>
      <div className={styles.sliderHeader}>
        <span className={styles.sliderLabel}>{label}</span>
        <span className={styles.sliderValEdit}>
          <input type="number" className={styles.sliderNum} value={draft ?? value}
            min={min} max={max} step={step}
            onChange={e=>setDraft(e.target.value)}
            onBlur={e=>commit(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter') e.currentTarget.blur() }}/>
          {unit && <span className={styles.sliderUnit}>{unit}</span>}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} className={styles.slider} onChange={e=>onChange(Number(e.target.value))}/>
    </div>
  )
}

function ClipPanel({ clip, onUpdate, globalTransition, onGlobalTransitionChange, transitionDuration, onTransitionDurationChange, endFadeVideo, onEndFadeVideoChange, endFadeVideoDuration, onEndFadeVideoDurationChange, endFadeAudio, onEndFadeAudioChange, endFadeAudioDuration, onEndFadeAudioDurationChange, musicFile, musicVolume, onMusicVolumeChange, musicDuration, musicTrimStart, musicTrimEnd, onMusicTrimChange }) {
  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Clip</div>
        <div className={styles.metaRow}><span className={styles.metaKey}>Type</span><span className={styles.metaVal}>{clip.type==='image'?'Photo':'Video'}</span></div>
        <div className={styles.metaRow}><span className={styles.metaKey}>File</span><span className={styles.metaVal} title={clip.name}>{clip.name.length>16?clip.name.slice(0,14)+'…':clip.name}</span></div>
        <Slider label="Duration" value={clip.duration||4} min={1} max={15} step={0.5} format={v=>`${v}s`} onChange={v=>onUpdate(clip.id,{duration:v})}/>
        {clip.type==='video'&&<Slider label="Speed" value={clip.speed||1} min={0.25} max={4} step={0.25} format={v=>`${v}x`} onChange={v=>onUpdate(clip.id,{speed:v})}/>}
        {clip.type==='video'&&<TrimBar clip={clip} onUpdate={onUpdate}/>}
      </div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Options</div>
        {clip.type==='video'&&(
          <label className={styles.toggleRow}><span className={styles.toggleLabel}>Include audio</span>
            <input type="checkbox" className={styles.toggle} checked={clip.includeAudio!==false} onChange={e=>onUpdate(clip.id,{includeAudio:e.target.checked})}/></label>
        )}
        <label className={styles.toggleRow}><span className={styles.toggleLabel}>Blurred bg fill</span>
          <input type="checkbox" className={styles.toggle} checked={!!clip.blurBackground} onChange={e=>onUpdate(clip.id,{blurBackground:e.target.checked})}/></label>
      </div>
      {clip.type==='image'&&(
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Image Effect</div>
          <div className={styles.effectGrid}>
            {[
              {value:'',          label:'None',      icon:'◻'},
              {value:'ken_burns', label:'Ken Burns',  icon:'⤢'},
              {value:'fade_in',   label:'Fade In',    icon:'◑'},
            ].map(e=>(
              <button key={e.value}
                className={`${styles.effectBtn} ${(clip.imageEffect||'')=== e.value ? styles.effectBtnActive : ''}`}
                onClick={()=>onUpdate(clip.id,{imageEffect:e.value||null})}>
                <span className={styles.effectIcon}>{e.icon}</span>
                <span>{e.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Adjust</div>
        <Slider label="Brightness" value={clip.brightness} min={-50} max={50} onChange={v=>onUpdate(clip.id,{brightness:v})}/>
        <Slider label="Contrast"   value={clip.contrast}   min={-50} max={50} onChange={v=>onUpdate(clip.id,{contrast:v})}/>
        <Slider label="Saturation" value={clip.saturation} min={-50} max={50} onChange={v=>onUpdate(clip.id,{saturation:v})}/>
        <button className={styles.resetBtn} onClick={()=>onUpdate(clip.id,{brightness:0,contrast:0,saturation:0})}>Reset adjustments</button>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Transform</div>
        <Slider label="Scale"    value={Math.round((clip.scale??1)*100)} min={10} max={300} step={5} format={v=>`${v}%`} onChange={v=>onUpdate(clip.id,{scale:v/100})}/>
        <Slider label="Rotation" value={clip.rotation??0} min={-180} max={180} step={1} format={v=>`${v}°`} onChange={v=>onUpdate(clip.id,{rotation:v})}/>
        <Slider label="X position" value={clip.offsetX??0} min={-100} max={100} step={1} format={v=>`${v}%`} onChange={v=>onUpdate(clip.id,{offsetX:v})}/>
        <Slider label="Y position" value={clip.offsetY??0} min={-100} max={100} step={1} format={v=>`${v}%`} onChange={v=>onUpdate(clip.id,{offsetY:v})}/>
        <button className={styles.resetBtn} onClick={()=>onUpdate(clip.id,{scale:1,rotation:0,offsetX:0,offsetY:0})}>Reset transform</button>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Transition</div>
        <select className={styles.select} value={clip.transition||''} onChange={e=>onUpdate(clip.id,{transition:e.target.value||null})}>
          {TRANSITIONS.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <div className={styles.sectionSubtitle}>Global Default</div>
        <select className={styles.select} value={globalTransition} onChange={e=>onGlobalTransitionChange(e.target.value)}>
          {TRANSITIONS.slice(1).map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {globalTransition!=='none'&&<Slider label="Duration" value={transitionDuration} min={0.2} max={2} step={0.2} format={v=>`${v.toFixed(1)}s`} onChange={onTransitionDurationChange}/>}
      </div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>End Fade</div>
        <div className={styles.metaRow}>
          <label className={styles.checkLabel}>
            <input type="checkbox" checked={!!endFadeVideo} onChange={e=>onEndFadeVideoChange(e.target.checked)} />
            <span>Fade to black</span>
          </label>
        </div>
        {endFadeVideo&&<Slider label="Duration" value={endFadeVideoDuration} min={0.5} max={5} step={0.5} format={v=>`${v.toFixed(1)}s`} onChange={onEndFadeVideoDurationChange}/>}
        <div className={styles.metaRow} style={{marginTop:4}}>
          <label className={styles.checkLabel}>
            <input type="checkbox" checked={!!endFadeAudio} onChange={e=>onEndFadeAudioChange(e.target.checked)} />
            <span>Fade out volume</span>
          </label>
        </div>
        {endFadeAudio&&<Slider label="Duration" value={endFadeAudioDuration} min={0.5} max={5} step={0.5} format={v=>`${v.toFixed(1)}s`} onChange={onEndFadeAudioDurationChange}/>}
      </div>
      {musicFile&&(
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Music</div>
          <div className={styles.musicName}>{musicFile.name}</div>
          <Slider label="Volume" value={musicVolume??70} min={0} max={100} format={v=>`${v}%`} onChange={onMusicVolumeChange}/>
          <MusicTrimBar
            musicDuration={musicDuration}
            musicTrimStart={musicTrimStart}
            musicTrimEnd={musicTrimEnd}
            onMusicTrimChange={onMusicTrimChange}
          />
        </div>
      )}
    </>
  )
}

function TextPanel({ seg, onUpdate }) {
  const fontUploadRef = useRef()
  const handleFontUpload = (e) => {
    const file=e.target.files?.[0]; if(!file)return
    const r=new FileReader()
    r.onload=(ev)=>{
      // Use .slice() to create a copy whose ArrayBuffer is not the same object
      // as ev.target.result. This prevents postMessage transfer from detaching
      // the buffer stored in React state on the first export.
      const bytes = new Uint8Array(ev.target.result).slice()
      onUpdate({fontFile:'custom',customFontName:file.name,customFontData:bytes})
    }
    r.readAsArrayBuffer(file); e.target.value=''
  }
  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Text Overlay</div>
        <textarea className={styles.textArea} value={seg.text||''} placeholder="Caption text…" rows={2} onChange={e=>onUpdate({text:e.target.value})}/>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Timing</div>
        <div className={styles.metaRow}><span className={styles.metaKey}>Start</span>
          <input type="number" className={styles.numInput} value={(seg.startTime||0).toFixed(1)} min={0} step={0.5} onChange={e=>onUpdate({startTime:Number(e.target.value)})}/></div>
        <div className={styles.metaRow}><span className={styles.metaKey}>Duration</span>
          <input type="number" className={styles.numInput} value={seg.duration||3} min={0.5} step={0.5} onChange={e=>onUpdate({duration:Number(e.target.value)})}/></div>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Appearance</div>
        <Slider label="Font size" value={seg.fontSize||60} min={60} max={260} step={2} format={v=>`${v}px`} onChange={v=>onUpdate({fontSize:v})}/>
        <Slider label="Opacity" value={seg.opacity??100} min={0} max={100} step={1} format={v=>`${v}%`} onChange={v=>onUpdate({opacity:v})}/>
        <div className={styles.metaRow}><span className={styles.metaKey}>Color</span>
          <input type="color" className={styles.colorInput} value={seg.color||'#ffffff'} onChange={e=>onUpdate({color:e.target.value})}/></div>
        <label className={styles.toggleRow}><span className={styles.toggleLabel}>Drop shadow</span>
          <input type="checkbox" className={styles.toggle} checked={seg.shadow!==false} onChange={e=>onUpdate({shadow:e.target.checked})}/></label>
        <label className={styles.toggleRow}><span className={styles.toggleLabel}>Outline</span>
          <input type="checkbox" className={styles.toggle} checked={!!seg.outline} onChange={e=>onUpdate({outline:e.target.checked})}/></label>
        <div className={styles.metaRow}><span className={styles.metaKey}>Font</span>
          <select className={styles.selectSmall} value={seg.fontFile||'Poppins-Regular'} onChange={e=>onUpdate({fontFile:e.target.value,customFontName:null})}>
            {PRESET_FONTS.map(f=><option key={f.key} value={f.key}>{f.label}</option>)}
            {seg.fontFile==='custom'&&<option value="custom">{seg.customFontName||'Custom'}</option>}
          </select></div>
        <div className={styles.metaRow}>
          <button className={styles.uploadFontSmall} onClick={()=>fontUploadRef.current?.click()}>Upload font…</button>
          <input ref={fontUploadRef} type="file" accept=".ttf,.otf,.woff" style={{display:'none'}} onChange={handleFontUpload}/>
        </div>
        <Slider label="Box width" value={seg.boxWidth??80} min={20} max={100} step={1} format={v=>`${v}%`} onChange={v=>onUpdate({boxWidth:v})}/>
        <div className={styles.metaRow}><span className={styles.metaKey}>Align</span>
          <select className={styles.selectSmall} value={seg.textAlign||'center'} onChange={e=>onUpdate({textAlign:e.target.value})}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select></div>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Position & Animation</div>
        <Slider label="X %" value={seg.posX??50} min={5} max={95} format={v=>`${v}%`} onChange={v=>onUpdate({position:'custom',posX:v})}/>
        <Slider label="Y %" value={seg.posY??50} min={5} max={95} format={v=>`${v}%`} onChange={v=>onUpdate({position:'custom',posY:v})}/>
        <div className={styles.posHint}>Drag the caption in the preview to reposition.</div>
        <div className={styles.metaRow}><span className={styles.metaKey}>Animation</span>
          <select className={styles.selectSmall} value={seg.animation||'fade'} onChange={e=>onUpdate({animation:e.target.value})}>
            {ANIM_OPTIONS.map(a=><option key={a} value={a}>{a}</option>)}
          </select></div>
      </div>
    </>
  )
}

export default function Inspector({
  activeClip, onUpdateClip,
  globalTransition, onGlobalTransitionChange,
  transitionDuration, onTransitionDurationChange,
  endFadeVideo, onEndFadeVideoChange, endFadeVideoDuration, onEndFadeVideoDurationChange,
  endFadeAudio, onEndFadeAudioChange, endFadeAudioDuration, onEndFadeAudioDurationChange,
  musicFile, musicVolume, onMusicVolumeChange,
  musicDuration, musicTrimStart, musicTrimEnd, onMusicTrimChange,
  activeTextSegment, onUpdateTextSegment,
  activeSelection,
}) {
  const showType = activeSelection?.type
  if (!showType||(!activeClip&&!activeTextSegment)) {
    return (
      <aside className={styles.panel}>
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>◈</span>
          <span>Select a clip or text overlay to edit</span>
        </div>
      </aside>
    )
  }
  return (
    <aside className={styles.panel}>
      {showType==='clip'&&activeClip&&(
        <ClipPanel clip={activeClip} onUpdate={onUpdateClip}
          globalTransition={globalTransition} onGlobalTransitionChange={onGlobalTransitionChange}
          transitionDuration={transitionDuration} onTransitionDurationChange={onTransitionDurationChange}
          endFadeVideo={endFadeVideo} onEndFadeVideoChange={onEndFadeVideoChange}
          endFadeVideoDuration={endFadeVideoDuration} onEndFadeVideoDurationChange={onEndFadeVideoDurationChange}
          endFadeAudio={endFadeAudio} onEndFadeAudioChange={onEndFadeAudioChange}
          endFadeAudioDuration={endFadeAudioDuration} onEndFadeAudioDurationChange={onEndFadeAudioDurationChange}
          musicFile={musicFile} musicVolume={musicVolume} onMusicVolumeChange={onMusicVolumeChange}
          musicDuration={musicDuration} musicTrimStart={musicTrimStart} musicTrimEnd={musicTrimEnd} onMusicTrimChange={onMusicTrimChange}/>
      )}
      {showType==='text'&&activeTextSegment&&(
        <TextPanel seg={activeTextSegment} onUpdate={changes=>onUpdateTextSegment(activeTextSegment.id,changes)}/>
      )}
    </aside>
  )
}
