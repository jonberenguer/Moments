import { useState, useCallback, useRef } from 'react'

const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','heic','avif'])
const VIDEO_EXTS = new Set(['mp4','mov','webm','avi','mkv','m4v'])
const isImageFile = f => IMAGE_EXTS.has(f.name.split('.').pop().toLowerCase())
const isVideoFile = f => VIDEO_EXTS.has(f.name.split('.').pop().toLowerCase())

export function useMediaStore() {
  const [mediaLibrary,    setMediaLibrary]   = useState([])
  const [activeMediaId,   setActiveMediaId]  = useState(null)
  const [clips,           setClips]          = useState([])
  const [textSegments,    setTextSegments]   = useState([])
  const [activeClipId,    setActiveClipId]   = useState(null)
  const [activeSelection, setActiveSelection]= useState(null)
  const [musicFile,       setMusicFileRaw]   = useState(null)
  const [musicDuration,   setMusicDuration]   = useState(null)
  const [musicTrimStart,  setMusicTrimStart]  = useState(0)
  const [musicTrimEnd,    setMusicTrimEnd]    = useState(null) // null = full duration

  const setMusicFile = useCallback((file) => {
    setMusicFileRaw(file)
    // Reset trim and duration whenever the music file is replaced or cleared
    setMusicDuration(null)
    setMusicTrimStart(0)
    setMusicTrimEnd(null)
  }, [])
  const [momentTitle,     setMomentTitle]    = useState('My Moment')
  const [globalTransition,    setGlobalTransition]    = useState('crossfade')
  const [transitionDuration,  setTransitionDuration]  = useState(0.6)
  const [endFadeVideo,        setEndFadeVideo]        = useState(false)
  const [endFadeVideoDuration, setEndFadeVideoDuration] = useState(1.5)
  const [endFadeAudio,        setEndFadeAudio]        = useState(false)
  const [endFadeAudioDuration, setEndFadeAudioDuration] = useState(1.5)
  const [isPlaying,       setIsPlaying]      = useState(false)
  const [currentTime,     setCurrentTime]    = useState(0)
  const [aspectRatio,     setAspectRatio]    = useState('16:9')
  const [quality,         setQuality]        = useState('720p')
  const [musicVolume,     setMusicVolume]    = useState(70)

  const idCounter    = useRef(0)
  const segCounter   = useRef(0)
  const mediaCounter = useRef(0)

  // ── Media library ─────────────────────────────────────────────────────────
  const addToLibrary = useCallback((files) => {
    const mediaFiles = Array.from(files).filter(f => isImageFile(f) || isVideoFile(f))
    const items = mediaFiles.map(f => {
      const isImage = IMAGE_EXTS.has(f.name.split('.').pop().toLowerCase())
      mediaCounter.current++
      return { id:`media_${mediaCounter.current}`, file:f, url:URL.createObjectURL(f), name:f.name, type:isImage?'image':'video', duration:isImage?4:null }
    })
    setMediaLibrary(prev => [...prev, ...items])
    if (items.length > 0) setActiveMediaId(items[0].id)
    // Resolve any clips that were loaded from a workflow and are waiting for
    // their source file. Match by filename — if the user re-adds a file whose
    // name matches a _needsMedia clip, wire it up immediately.
    if (items.length > 0) {
      setClips(prev => prev.map(c => {
        if (!c._needsMedia) return c
        const match = items.find(item => item.name === c.name)
        if (!match) return c
        return { ...c, file: match.file, url: match.url, mediaId: match.id, _needsMedia: false }
      }))
    }
    return items
  }, [])

  const removeFromLibrary = useCallback((id) => {
    setMediaLibrary(prev => prev.filter(m => m.id !== id))
    setActiveMediaId(prev => prev === id ? null : prev)
  }, [])

  const updateMediaDuration = useCallback((id, duration) => {
    setMediaLibrary(prev => prev.map(m => m.id === id ? { ...m, duration } : m))
    // Also propagate fileDuration to any clips that came from this media item
    setClips(prev => prev.map(c => c.mediaId === id && !c.fileDuration ? { ...c, fileDuration: duration } : c))
  }, [])

  const addLibraryItemToTimeline = useCallback((mediaItem) => {
    idCounter.current++
    const clip = {
      id:`clip_${idCounter.current}`,
      file:mediaItem.file, url:mediaItem.url, name:mediaItem.name, type:mediaItem.type,
      duration:mediaItem.duration||(mediaItem.type==='image'?4:null),
      fileDuration:mediaItem.type==='video'?(mediaItem.duration||null):null,
      trimStart:0, trimEnd:null, brightness:0, contrast:0, saturation:0, speed:1,
      transition:null, transitionDuration:null,
      viewZoom:1, viewPanX:0, viewPanY:0, // kept for workflow backward compat (ignored by export)
      includeAudio:true, blurBackground:false, mediaId:mediaItem.id,
      imageEffect:null,
    }
    setClips(prev => [...prev, clip])
    setActiveClipId(clip.id)
    setActiveSelection({ type:'clip', id:clip.id })
    return clip.id
  }, [])

  // addFiles: adds to library AND timeline (for drag-drop onto dropzone)
  const addFiles = useCallback((files) => {
    const mediaFiles = Array.from(files).filter(f => isImageFile(f) || isVideoFile(f))
    const newClips = []; const newMedia = []
    mediaFiles.forEach(f => {
      const isImage = IMAGE_EXTS.has(f.name.split('.').pop().toLowerCase())
      mediaCounter.current++; idCounter.current++
      const url = URL.createObjectURL(f)
      const mediaId = `media_${mediaCounter.current}`
      newMedia.push({ id:mediaId, file:f, url, name:f.name, type:isImage?'image':'video', duration:isImage?4:null })
      newClips.push({
        id:`clip_${idCounter.current}`, file:f, url, name:f.name,
        type:isImage?'image':'video', duration:isImage?4:null,
        fileDuration: isImage ? null : null, // populated when video metadata loads
        trimStart:0, trimEnd:null, brightness:0, contrast:0, saturation:0, speed:1,
        transition:null, transitionDuration:null, viewZoom:1, viewPanX:0, viewPanY:0, // kept for workflow backward compat
        includeAudio:true, blurBackground:false, mediaId, imageEffect:null,
      })
    })
    setMediaLibrary(prev => [...prev, ...newMedia])
    setClips(prev => [...prev, ...newClips])
    if (newClips.length > 0) {
      setActiveClipId(newClips[0].id)
      setActiveSelection({ type:'clip', id:newClips[0].id })
      setActiveMediaId(newMedia[0].id)
    }
  }, [])

  // ── Main clips ────────────────────────────────────────────────────────────
  const removeClip   = useCallback((id) => {
    setClips(prev => prev.filter(c => c.id !== id))
    setActiveClipId(prev => prev === id ? null : prev)
    setActiveSelection(prev => prev?.id === id ? null : prev)
  }, [])
  const updateClip   = useCallback((id, changes) => setClips(prev => prev.map(c => c.id===id?{...c,...changes}:c)), [])
  const reorderClips = useCallback((fromIdx, toIdx) => {
    setClips(prev => { const a=[...prev]; const [m]=a.splice(fromIdx,1); a.splice(toIdx,0,m); return a })
  }, [])

  // ── Text segments ─────────────────────────────────────────────────────────
  const addTextSegment = useCallback((startTime=0) => {
    segCounter.current++
    const seg = { id:`seg_${segCounter.current}`, text:'Caption', startTime, duration:3, animation:'fade', fontSize:28, color:'#ffffff', fontFile:'Poppins-Regular', customFontName:null, position:'bottom', posX:50, posY:85 }
    setTextSegments(prev => [...prev, seg])
    setActiveSelection({ type:'text', id:seg.id })
    return seg.id
  }, [])
  const updateTextSegment = useCallback((id, changes) => setTextSegments(prev => prev.map(s => s.id===id?{...s,...changes}:s)), [])
  const removeTextSegment = useCallback((id) => { setTextSegments(prev => prev.filter(s => s.id!==id)); setActiveSelection(prev => prev?.id===id?null:prev) }, [])
  const selectTextSegment = useCallback((id) => setActiveSelection({ type:'text', id }), [])

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeClip       = clips.find(c => c.id===activeClipId) || null
  const totalDuration    = clips.reduce((s,c) => s+(c.duration||0), 0)

  // Trim-aware duration: for video clips use actual trimmed length (÷ speed),
  // for image clips use the slot duration. This is the true encoded output length
  // and must be used as the master timeline length for export.
  // Transitions create overlaps between adjacent clips, so subtract each
  // transition's effective duration from the total (N clips → N-1 transitions).
  const exportDuration = (() => {
    const rawTotal = clips.reduce((s, c) => {
      if (c.type === 'video' && c.fileDuration) {
        const trimStart = c.trimStart || 0
        const trimEnd   = c.trimEnd   || c.fileDuration
        const speed     = c.speed     || 1
        return s + (trimEnd - trimStart) / speed
      }
      return s + (c.duration || 0)
    }, 0)
    // Each boundary between adjacent clips has a transition; subtract its overlap.
    // Clip N's transition setting governs the N→N+1 boundary (same as export logic).
    let transitionOverlap = 0
    for (let i = 0; i < clips.length - 1; i++) {
      const clip = clips[i]
      const hasTransition = (clip.transition || globalTransition) !== 'none'
      if (hasTransition) {
        transitionOverlap += clip.transitionDuration ?? transitionDuration
      }
    }
    return Math.max(0, rawTotal - transitionOverlap)
  })()
  const getClipTransition = useCallback((clip) => clip?.transition||globalTransition, [globalTransition])
  const activeTextSegment = activeSelection?.type==='text' ? textSegments.find(s => s.id===activeSelection.id)||null : null
  const activeMediaItem   = mediaLibrary.find(m => m.id===activeMediaId) || null

  // ── Workflow ──────────────────────────────────────────────────────────────
  const saveWorkflow = useCallback(() => {
    // Build deduplicated font table keyed by a simple content hash (not filename)
    // so two different fonts named "Custom.ttf" don't collide.
    // We also guard against detached ArrayBuffers — if the buffer was transferred
    // to the Worker during a prior export, subarray() would throw. We skip those
    // entries rather than crash the whole save.
    const fontTable = {}   // hash → { name, b64 }
    const segFontKey = {}  // seg.id → hash (so load can re-match)
    for (const s of textSegments) {
      if (s.fontFile !== 'custom' || !s.customFontData || !s.customFontName) continue
      if (s.customFontData.buffer?.byteLength === 0) continue  // detached — skip
      const bytes = s.customFontData instanceof Uint8Array
        ? s.customFontData
        : new Uint8Array(s.customFontData)
      // Simple content hash: sum of bytes modulo a large prime, good enough for dedup
      let hash = 0
      for (let i = 0; i < Math.min(bytes.length, 4096); i++) hash = (hash * 31 + bytes[i]) >>> 0
      const key = `${s.customFontName}_${hash}`
      if (!fontTable[key]) {
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
        }
        fontTable[key] = { name: s.customFontName, b64: btoa(binary) }
      }
      segFontKey[s.id] = key
    }
    const w = {
      version: 10,
      title: momentTitle, aspectRatio, quality, musicVolume,
      globalTransition, transitionDuration,
      endFadeVideo, endFadeVideoDuration, endFadeAudio, endFadeAudioDuration,
      musicFileName: musicFile?.name || null, musicTrimStart, musicTrimEnd,
      customFonts: Object.keys(fontTable).length > 0 ? fontTable : undefined,
      clips: clips.map(c => ({
        id:c.id, name:c.name, type:c.type, duration:c.duration,
        trimStart:c.trimStart, trimEnd:c.trimEnd, fileDuration:c.fileDuration,
        brightness:c.brightness, contrast:c.contrast, saturation:c.saturation,
        speed:c.speed, transition:c.transition, transitionDuration:c.transitionDuration,
        viewZoom:c.viewZoom, viewPanX:c.viewPanX, viewPanY:c.viewPanY, // preserved for backward compat on load
        includeAudio:c.includeAudio, blurBackground:c.blurBackground, imageEffect:c.imageEffect,
      })),
      textSegments: textSegments.map(s => ({
        ...s,
        customFontData: undefined,
        // Store the hash key so load can look up the right font even if names collide
        _fontKey: segFontKey[s.id] ?? undefined,
      })),
      savedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(w, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${momentTitle.replace(/\s+/g, '_')}_workflow.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [clips, textSegments, momentTitle, aspectRatio, quality, musicVolume,
      globalTransition, transitionDuration,
      endFadeVideo, endFadeVideoDuration, endFadeAudio, endFadeAudioDuration,
      musicFile, musicTrimStart, musicTrimEnd])

  const loadWorkflow = useCallback((json, { onQualityChange, onMusicVolumeChange } = {}) => {
    try {
      const w = JSON.parse(json)
      // Version guard: warn on unknown future versions but still attempt load
      const v = w.version ?? 1
      if (v > 10) console.warn(`Workflow version ${v} is newer than this app (v10); some settings may not load correctly.`)

      setMomentTitle(w.title || 'My Moment')
      if (w.aspectRatio) setAspectRatio(w.aspectRatio)
      if (w.globalTransition) setGlobalTransition(w.globalTransition)
      if (w.transitionDuration) setTransitionDuration(w.transitionDuration)
      if (typeof w.endFadeVideo === 'boolean') setEndFadeVideo(w.endFadeVideo)
      if (typeof w.endFadeVideoDuration === 'number') setEndFadeVideoDuration(w.endFadeVideoDuration)
      if (typeof w.endFadeAudio === 'boolean') setEndFadeAudio(w.endFadeAudio)
      if (typeof w.endFadeAudioDuration === 'number') setEndFadeAudioDuration(w.endFadeAudioDuration)
      if (typeof w.musicTrimStart === 'number') setMusicTrimStart(w.musicTrimStart)
      if (typeof w.musicTrimEnd === 'number') setMusicTrimEnd(w.musicTrimEnd)

      // Restore quality and musicVolume — these lived in App.jsx before v10
      // and were not saved; fall back to current defaults if absent.
      if (w.quality && ['480p', '720p', '1080p'].includes(w.quality)) {
        setQuality(w.quality)
        onQualityChange?.(w.quality)
      }
      if (typeof w.musicVolume === 'number') {
        setMusicVolume(w.musicVolume)
        onMusicVolumeChange?.(w.musicVolume)
      }

      if (w.clips) setClips(w.clips.map(c => ({
        ...c,
        file: null, url: null, _needsMedia: true,
        viewZoom:       c.viewZoom       ?? 1,
        viewPanX:       c.viewPanX       ?? 0,
        viewPanY:       c.viewPanY       ?? 0,
        includeAudio:   c.includeAudio   ?? true,
        blurBackground: c.blurBackground ?? false,
        imageEffect:    c.imageEffect    ?? null,
        fileDuration:   c.fileDuration   ?? null,
      })))

      // Decode font table.
      // v10+: customFonts is { hashKey → { name, b64 } }, segments carry _fontKey
      // v9:   customFonts is { name → b64 }, no _fontKey (fall back to name matching)
      const fontDataMap = {}  // key → Uint8Array
      if (w.customFonts && typeof w.customFonts === 'object') {
        for (const [key, entry] of Object.entries(w.customFonts)) {
          try {
            // v10 entry: { name, b64 }  |  v9 entry: plain base64 string
            const b64 = typeof entry === 'string' ? entry : entry.b64
            const binary = atob(b64)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
            // .slice() gives each segment its own ArrayBuffer so postMessage
            // transfers during export never detach the copy held in state.
            fontDataMap[key] = bytes.slice()
          } catch { /* skip malformed entries */ }
        }
      }

      if (w.textSegments) setTextSegments(w.textSegments.map(s => {
        const base = { fontFile: 'Poppins-Regular', posX: 50, posY: 85, position: 'bottom', ...s }
        if (base.fontFile === 'custom' && base.customFontName) {
          // Try hash key first (v10), fall back to name key (v9 backward compat)
          const data = fontDataMap[base._fontKey] ?? fontDataMap[base.customFontName]
          if (data) base.customFontData = data.slice() // fresh copy per segment
        }
        delete base._fontKey  // internal field, don't keep in state
        return base
      }))

      return { ok: true, clipCount: w.clips?.length || 0 }
    } catch (e) { return { ok: false, error: e.message } }
  }, [])

  return {
    mediaLibrary, addToLibrary, removeFromLibrary, updateMediaDuration, addLibraryItemToTimeline,
    activeMediaId, setActiveMediaId, activeMediaItem,
    clips, setClips, activeClipId, setActiveClipId, activeClip,
    addFiles, removeClip, updateClip, reorderClips,
    textSegments, addTextSegment, updateTextSegment, removeTextSegment, selectTextSegment, activeTextSegment,
    activeSelection, setActiveSelection,
    musicFile, setMusicFile, musicDuration, setMusicDuration, musicTrimStart, setMusicTrimStart, musicTrimEnd, setMusicTrimEnd,
    momentTitle, setMomentTitle,
    globalTransition, setGlobalTransition,
    transitionDuration, setTransitionDuration,
    endFadeVideo, setEndFadeVideo, endFadeVideoDuration, setEndFadeVideoDuration,
    endFadeAudio, setEndFadeAudio, endFadeAudioDuration, setEndFadeAudioDuration,
    isPlaying, setIsPlaying,
    currentTime, setCurrentTime,
    totalDuration, exportDuration, aspectRatio, setAspectRatio,
    quality, setQuality, musicVolume, setMusicVolume,
    getClipTransition,
    saveWorkflow, loadWorkflow,
  }
}
