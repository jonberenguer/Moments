import { useCallback, useRef, useState, useEffect } from 'react'
import { Plus, Music, Trash2, Upload, Play, Pause, GripVertical, PlusCircle, ListPlus } from 'lucide-react'
import styles from './MediaPanel.module.css'

// Convert base64 + mime into a File object the existing onAddFiles pipeline accepts
function base64ToFile(base64, name, mime) {
  const binary = atob(base64)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}

// Use native Electron dialog when available, fall back to HTML input otherwise
const api = window.electronAPI

export default function MediaPanel({
  mediaLibrary, activeMediaId, onSelectMedia, onAddToTimeline, onRemoveMedia, onAddFiles, onUpdateMediaDuration,
  musicFile, onMusicFile, onMusicDuration,
}) {
  const fileInputRef   = useRef()   // fallback for non-Electron environments
  const musicInputRef  = useRef()
  const previewVideoRef= useRef()
  const audioRef       = useRef()
  const panelRef       = useRef()
  const resizeRef      = useRef({ active: false })

  const [previewPlaying,     setPreviewPlaying]     = useState(false)
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0)
  const [previewHeight,      setPreviewHeight]      = useState(160)
  const [panelWidth,         setPanelWidth]         = useState(220)
  const [isDraggingPanel,    setIsDraggingPanel]    = useState(false)
  const [isDraggingPrev,     setIsDraggingPrev]     = useState(false)
  const [isDraggingVideo,    setIsDraggingVideo]    = useState(false)
  const videoProgressRef = useRef()

  // ── Multi-select ──────────────────────────────────────────────────────────
  const [selectedIds,    setSelectedIds]    = useState(new Set())
  const lastClickedIdxRef = useRef(null)

  // Keep selection in sync when items are removed from the library
  useEffect(() => {
    setSelectedIds(prev => {
      const valid = new Set(mediaLibrary.map(m => m.id))
      const next  = new Set([...prev].filter(id => valid.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [mediaLibrary])

  const toggleSelect = useCallback((id, idx, e) => {
    e.stopPropagation()
    // Read shiftKey before any async work — synthetic events are pooled
    const isShift = e.shiftKey
    const anchorIdx = lastClickedIdxRef.current
    // Update the anchor immediately, outside the state updater
    lastClickedIdxRef.current = idx
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (isShift && anchorIdx != null) {
        const lo = Math.min(anchorIdx, idx)
        const hi = Math.max(anchorIdx, idx)
        const adding = !prev.has(id)
        for (let i = lo; i <= hi; i++) {
          if (mediaLibrary[i]) adding ? next.add(mediaLibrary[i].id) : next.delete(mediaLibrary[i].id)
        }
      } else {
        prev.has(id) ? next.delete(id) : next.add(id)
      }
      return next
    })
  }, [mediaLibrary])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(mediaLibrary.map(m => m.id)))
  }, [mediaLibrary])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    lastClickedIdxRef.current = null
  }, [])

  const addSelectedToTimeline = useCallback(() => {
    mediaLibrary.filter(m => selectedIds.has(m.id)).forEach(item => onAddToTimeline(item))
    clearSelection()
  }, [mediaLibrary, selectedIds, onAddToTimeline, clearSelection])

  // ── Native file open (remembers last folder via Electron dialog) ─────────
  const openMediaFiles = useCallback(async () => {
    if (api?.openFilesDialog) {
      // Electron path — native dialog with remembered directory
      const results = await api.openFilesDialog({ accept: 'image/*,video/*' })
      if (!results.length) return
      const files = results.map(r => base64ToFile(r.base64, r.name, r.mime))
      // Wrap in a FileList-like object the existing onAddFiles handler accepts
      const dt = new DataTransfer()
      files.forEach(f => dt.items.add(f))
      onAddFiles(dt.files)
    } else {
      // Browser / dev fallback
      fileInputRef.current?.click()
    }
  }, [onAddFiles])
  const [musicPlaying,    setMusicPlaying]    = useState(false)
  const [musicCurrentTime,setMusicCurrentTime]= useState(0)
  const [musicDuration,   setMusicDuration]   = useState(0)
  const [isDraggingMusic, setIsDraggingMusic] = useState(false)
  const musicProgressRef = useRef()

  const activeClip = mediaLibrary.find(m => m.id === activeMediaId) || null

  useEffect(() => {
    setPreviewPlaying(false)
    if (previewVideoRef.current) previewVideoRef.current.pause()
  }, [activeMediaId])

  const [musicUrl, setMusicUrl] = useState(null)
  useEffect(() => {
    if (!musicFile) { setMusicUrl(null); return }
    const url = URL.createObjectURL(musicFile)
    setMusicUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [musicFile])

  useEffect(() => {
    setMusicPlaying(false); setMusicCurrentTime(0); setMusicDuration(0)
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0 }
  }, [musicUrl])

  const togglePreviewPlay = useCallback(() => {
    const vid = previewVideoRef.current; if (!vid) return
    if (vid.paused) { vid.play(); setPreviewPlaying(true) }
    else            { vid.pause(); setPreviewPlaying(false) }
  }, [])

  useEffect(() => {
    setPreviewCurrentTime(0); setPreviewPlaying(false)
    if (previewVideoRef.current) { previewVideoRef.current.pause(); previewVideoRef.current.currentTime = 0 }
  }, [activeMediaId])

  const toggleMusicPlay = useCallback(() => {
    const aud = audioRef.current; if (!aud) return
    if (aud.paused) { aud.play(); setMusicPlaying(true) }
    else            { aud.pause(); setMusicPlaying(false) }
  }, [])

  const seekFromEvent = useCallback((e) => {
    const aud = audioRef.current; const bar = musicProgressRef.current
    if (!aud || !bar || !musicDuration) return
    const rect = bar.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * musicDuration
    aud.currentTime = t; setMusicCurrentTime(t)
  }, [musicDuration])

  const onProgressMouseDown = useCallback((e) => { e.preventDefault(); seekFromEvent(e); setIsDraggingMusic(true) }, [seekFromEvent])

  useEffect(() => {
    if (!isDraggingMusic) return
    const onMove = (e) => seekFromEvent(e); const onUp = () => setIsDraggingMusic(false)
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isDraggingMusic, seekFromEvent])

  const seekVideoFromEvent = useCallback((e) => {
    const vid = previewVideoRef.current; const bar = videoProgressRef.current; const dur = vid?.duration
    if (!vid || !bar || !dur || !isFinite(dur)) return
    const rect = bar.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * dur
    vid.currentTime = t; setPreviewCurrentTime(t)
  }, [])

  const onVideoProgressMouseDown = useCallback((e) => { e.preventDefault(); seekVideoFromEvent(e); setIsDraggingVideo(true) }, [seekVideoFromEvent])

  useEffect(() => {
    if (!isDraggingVideo) return
    const onMove = (e) => seekVideoFromEvent(e); const onUp = () => setIsDraggingVideo(false)
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isDraggingVideo, seekVideoFromEvent])

  const handleDrop = useCallback((e) => { e.preventDefault(); onAddFiles(e.dataTransfer.files) }, [onAddFiles])

  const handleVideoDuration = useCallback((item, e) => {
    const dur = e.target.duration
    if (dur && isFinite(dur) && !item.duration) onUpdateMediaDuration(item.id, parseFloat(dur.toFixed(1)))
  }, [onUpdateMediaDuration])

  const fmtTime = (s) => `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`

  // ── Panel resize ──────────────────────────────────────────────────────────
  const onPanelResizeStart = useCallback((e) => {
    e.preventDefault()
    resizeRef.current = { active: true, startX: e.clientX, startW: panelWidth }
    setIsDraggingPanel(true)
  }, [panelWidth])

  useEffect(() => {
    if (!isDraggingPanel) return
    const onMove = (e) => setPanelWidth(Math.max(180, Math.min(420, resizeRef.current.startW + (e.clientX - resizeRef.current.startX))))
    const onUp   = () => { resizeRef.current.active = false; setIsDraggingPanel(false) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isDraggingPanel])

  // ── Preview height resize ─────────────────────────────────────────────────
  const onPrevResizeStart = useCallback((e) => {
    e.preventDefault()
    resizeRef.current = { active: true, startY: e.clientY, startH: previewHeight }
    setIsDraggingPrev(true)
  }, [previewHeight])

  useEffect(() => {
    if (!isDraggingPrev) return
    const onMove = (e) => setPreviewHeight(Math.max(80, Math.min(400, resizeRef.current.startH - (e.clientY - resizeRef.current.startY))))
    const onUp   = () => { resizeRef.current.active = false; setIsDraggingPrev(false) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isDraggingPrev])

  const hasSelection = selectedIds.size > 0

  return (
    <aside ref={panelRef} className={styles.panel} style={{ width: panelWidth }}>
      <div className={styles.panelResizeHandle} onMouseDown={onPanelResizeStart} title="Drag to resize panel">
        <GripVertical size={12} strokeWidth={1.5} />
      </div>

      <div className={styles.header}>
        <span className={styles.sectionLabel}>Media Library</span>
        <div className={styles.headerActions}>
          {hasSelection && (
            <>
              <span className={styles.selectionCount}>{selectedIds.size} selected</span>
              <button className={styles.clearSelBtn} onClick={clearSelection} title="Clear selection">✕</button>
            </>
          )}
          <button className={styles.addBtn} onClick={openMediaFiles} title="Add media">
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Selection action bar — visible when items are selected */}
      {hasSelection && (
        <div className={styles.selectionBar}>
          <button className={styles.selectAllBtn} onClick={selectAll}>All</button>
          <button className={styles.addSelectedBtn} onClick={addSelectedToTimeline}>
            <ListPlus size={12} strokeWidth={2} />
            Add {selectedIds.size} to Timeline
          </button>
        </div>
      )}

      <div className={styles.dropzone} onDrop={handleDrop} onDragOver={e => e.preventDefault()} onClick={openMediaFiles}>
        <Upload size={18} strokeWidth={1.5} className={styles.uploadIcon} />
        <span>Drop photos & videos</span>
        <span className={styles.dropHint}>or click to browse</span>
      </div>

      <input ref={fileInputRef} type="file" multiple accept="image/*,video/*" style={{ display:'none' }}
        onChange={e => { onAddFiles(e.target.files); e.target.value='' }} />

      <div
        className={styles.grid}
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === ' ' || e.code === 'Space') {
            e.preventDefault() // prevent page scroll
            const activeIdx = mediaLibrary.findIndex(m => m.id === activeMediaId)
            if (activeIdx === -1) return
            const activeItem = mediaLibrary[activeIdx]
            toggleSelect(activeItem.id, activeIdx, { shiftKey: false, stopPropagation: () => {} })
          }
        }}
      >
        {mediaLibrary.map((item, idx) => {
          const isSelected = selectedIds.has(item.id)
          return (
            <div
              key={item.id}
              className={[styles.thumb, activeMediaId===item.id?styles.active:'', isSelected?styles.selected:''].join(' ')}
              onClick={() => onSelectMedia(item.id)}
              draggable
              onDragStart={e => {
                // Drag all selected if this item is part of the selection, otherwise just this one
                const ids = isSelected && selectedIds.size > 1
                  ? [...selectedIds].join(',')
                  : item.id
                e.dataTransfer.setData('application/x-media-id', ids)
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              {item.type==='image'
                ? <img src={item.url} alt={item.name} className={styles.thumbImg} />
                : <video src={item.url} className={styles.thumbImg} muted preload="metadata" onLoadedMetadata={e => handleVideoDuration(item,e)} />
              }
              <div className={styles.thumbOverlay}>
                <span className={styles.thumbType}>{item.type==='video' ? '▶' : '◉'}</span>
                {item.duration && <span className={styles.thumbDur}>{item.duration.toFixed(1)}s</span>}
              </div>

              {/* Checkbox — visible on hover or when selected */}
              <div
                className={`${styles.checkbox} ${isSelected ? styles.checkboxChecked : ''}`}
                onMouseDown={e => e.stopPropagation()}
                onClick={e => toggleSelect(item.id, idx, e)}
                title={isSelected ? 'Deselect' : 'Select (shift-click for range)'}
              >
                {isSelected && <span className={styles.checkmark}>✓</span>}
              </div>

              <button className={styles.removeBtn} title="Remove from library"
                onClick={e => { e.stopPropagation(); onRemoveMedia(item.id) }}>
                <Trash2 size={10} strokeWidth={2} />
              </button>
            </div>
          )
        })}
      </div>

      {/* Music */}
      <div className={styles.musicSection}>
        <div className={styles.musicHeader}>
          <Music size={12} strokeWidth={1.5} />
          <span>Background Music</span>
        </div>
        {musicFile ? (
          <div className={styles.musicPlayer}>
            <audio ref={audioRef} src={musicUrl || ''}
              onTimeUpdate={e => setMusicCurrentTime(e.target.currentTime)}
              onLoadedMetadata={e => { const d=e.target.duration; if(d&&isFinite(d)){setMusicDuration(d);onMusicDuration?.(d)} }}
              onEnded={() => setMusicPlaying(false)} />
            <div className={styles.musicTrack}>
              <span className={styles.musicName}>{musicFile.name}</span>
              <button onClick={() => onMusicFile(null)} className={styles.musicRemove} title="Remove music">
                <Trash2 size={11} strokeWidth={1.5} />
              </button>
            </div>
            <div className={styles.musicControls}>
              <button className={styles.musicPlayBtn} onClick={toggleMusicPlay} title={musicPlaying ? 'Pause' : 'Play'}>
                {musicPlaying ? <Pause size={12} strokeWidth={2}/> : <Play size={12} strokeWidth={2} style={{marginLeft:1}}/>}
              </button>
              <span className={styles.musicTime}>
                {fmtTime(musicCurrentTime)}
                {musicDuration > 0 && <span className={styles.musicTimeSep}> / {fmtTime(musicDuration)}</span>}
              </span>
            </div>
            <div ref={musicProgressRef} className={styles.musicProgressBar} onMouseDown={onProgressMouseDown} title="Click or drag to seek">
              <div className={styles.musicProgressFill} style={{ width: musicDuration>0?`${(musicCurrentTime/musicDuration)*100}%`:'0%' }} />
              <div className={styles.musicProgressThumb} style={{ left: musicDuration>0?`${(musicCurrentTime/musicDuration)*100}%`:'0%' }} />
            </div>
          </div>
        ) : (
          <button className={styles.musicAdd} onClick={() => musicInputRef.current?.click()}>
            <Plus size={12} strokeWidth={2} /> Add audio file
          </button>
        )}
        <input ref={musicInputRef} type="file" accept="audio/*" style={{ display:'none' }}
          onChange={e => { if(e.target.files[0]) onMusicFile(e.target.files[0]); e.target.value='' }} />
      </div>

      {/* Preview */}
      {activeClip && (
        <div className={styles.previewSection}>
          <div className={styles.previewResizeHandle} onMouseDown={onPrevResizeStart} title="Drag to resize preview">
            <div className={styles.previewHeader}>
              <span className={styles.previewLabel}>Preview</span>
              <span className={styles.previewName}>{activeClip.name}</span>
              <GripVertical size={11} strokeWidth={1.5} className={styles.previewGrip} />
            </div>
          </div>
          <div className={styles.previewMedia} style={{ height: previewHeight }}>
            {activeClip.type === 'image' ? (
              <img src={activeClip.url} alt={activeClip.name} className={styles.previewImg} />
            ) : (
              <div className={styles.previewVideoWrap}>
                <video ref={previewVideoRef} src={activeClip.url} className={styles.previewImg}
                  loop playsInline onEnded={() => setPreviewPlaying(false)}
                  onTimeUpdate={e => setPreviewCurrentTime(e.target.currentTime)}
                  onLoadedMetadata={e => { const dur=e.target.duration; if(dur&&isFinite(dur))onUpdateMediaDuration(activeClip.id,parseFloat(dur.toFixed(2))) }} />
                <button className={styles.previewPlayBtn} onClick={togglePreviewPlay}>
                  {previewPlaying ? <Pause size={14} strokeWidth={2}/> : <Play size={14} strokeWidth={2} style={{marginLeft:1}}/>}
                </button>
              </div>
            )}
            {activeClip.type === 'image' && activeClip.duration && (
              <div className={styles.previewMeta}>
                <span>◉ image</span><span>{activeClip.duration.toFixed(1)}s</span>
              </div>
            )}
          </div>
          {activeClip.type === 'video' && (
            <div className={styles.videoProgressWrap}>
              <span className={styles.videoProgressTime}>{fmtTime(previewCurrentTime)}</span>
              <div ref={videoProgressRef} className={styles.videoProgressBar} onMouseDown={onVideoProgressMouseDown}>
                <div className={styles.videoProgressFill} style={{ width: activeClip.duration?`${(previewCurrentTime/activeClip.duration)*100}%`:'0%' }} />
                <div className={styles.videoProgressThumb} style={{ left: activeClip.duration?`${(previewCurrentTime/activeClip.duration)*100}%`:'0%' }} />
              </div>
              <span className={styles.videoProgressTime}>{fmtTime(activeClip.duration || 0)}</span>
            </div>
          )}
          <button className={styles.addToTimelineFullBtn} onClick={() => onAddToTimeline(activeClip)}>
            <PlusCircle size={12} strokeWidth={2} /> Add to Timeline
          </button>
        </div>
      )}
    </aside>
  )
}
