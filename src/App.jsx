import { useState, useCallback, useRef, useEffect } from 'react'
import Topbar      from './components/Topbar'
import MediaPanel  from './components/MediaPanel'
import Preview     from './components/Preview'
import Timeline    from './components/Timeline'
import Inspector   from './components/Inspector'
import ExportModal from './components/ExportModal'
import LogDrawer   from './components/LogDrawer'
import { useMediaStore } from './hooks/useMediaStore'
import { useFFmpeg }     from './hooks/useFFmpeg'
import styles from './App.module.css'

export default function App() {
  const store  = useMediaStore()
  const ffmpeg = useFFmpeg()

  const [showExport,  setShowExport]  = useState(false)
  const [exportState, setExportState] = useState('idle')
  const [outputUrl,   setOutputUrl]   = useState(null)
  const [exportStartedAt,   setExportStartedAt]   = useState(null)
  const [exportCompletedAt, setExportCompletedAt] = useState(null)
  const [showLogs,    setShowLogs]    = useState(false)

  const storeRef   = useRef(store)
  const ffmpegRef  = useRef(ffmpeg)
  storeRef.current  = store
  ffmpegRef.current = ffmpeg

  // Stop any in-progress resize when the mouse button is released anywhere
  // (including outside the resize handle div, or when the window loses focus).
  useEffect(() => {
    const stop = () => window.electronAPI?.stopResize?.()
    document.addEventListener('mouseup', stop)
    window.addEventListener('blur', stop)
    return () => {
      document.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
    }
  }, [])

  const handleExportOpen = useCallback(() => {
    setShowExport(true)
    setExportState('idle')
    setOutputUrl(null)
    setExportStartedAt(null)
    setExportCompletedAt(null)
    // Load (GPU detect) in background — doesn't auto-start export
    const f = ffmpegRef.current
    if (!f.loaded) f.load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleFFmpegLoad = useCallback(async () => {
    const f = ffmpegRef.current; const s = storeRef.current
    if (!f.loaded) { setExportState('loading-ffmpeg'); await f.load() }
    setExportState('exporting')
    setExportStartedAt(Date.now())
    try {
      const result = await f.exportMoment({
        clips:              s.clips,
        textSegments:       s.textSegments,
        musicFile:          s.musicFile,
        musicVolume:        s.musicVolume,
        musicTrimStart:     s.musicTrimStart,
        musicTrimEnd:       s.musicTrimEnd,
        aspectRatio:        s.aspectRatio,
        globalTransition:   s.globalTransition,
        transitionDuration: s.transitionDuration,
        endFadeVideo:       s.endFadeVideo,
        endFadeVideoDuration: s.endFadeVideoDuration,
        endFadeAudio:       s.endFadeAudio,
        endFadeAudioDuration: s.endFadeAudioDuration,
        quality:            s.quality,
        outputName:         s.momentTitle.replace(/\s+/g, '_') + '.mp4',
        encoderOverride:    ffmpegRef.current.encoderOverride,
      })
      setOutputUrl(result.url); setExportState('done'); setExportCompletedAt(Date.now())
    } catch (err) { console.error('Export error:', err); setExportState('error'); setExportCompletedAt(Date.now()) }
  }, [])

  const handleLoadWorkflow  = useCallback((json) => {
    const r = storeRef.current.loadWorkflow(json)
    if (!r.ok) console.error('Workflow load failed:', r.error)
  }, [])
  const handleClipTransition = useCallback((id, val) => { storeRef.current.updateClip(id, { transition: val||null }) }, [])
  const handleSelectClip     = useCallback((id) => { storeRef.current.setActiveClipId(id); storeRef.current.setActiveSelection({ type:'clip', id }) }, [])

  const handleDropMediaToMain = useCallback((mediaId) => {
    const item = storeRef.current.mediaLibrary.find(m => m.id === mediaId)
    if (item) storeRef.current.addLibraryItemToTimeline(item)
  }, [])

  const RESIZE_DIRS = ['n','ne','e','se','s','sw','w','nw']

  return (
    <div className={styles.app}>
      {window.electronAPI?.isElectron && (
        <div className={styles.resizeBorder} aria-hidden="true">
          {RESIZE_DIRS.map(dir => (
            <div
              key={dir}
              data-dir={dir}
              className={styles.resizeHandle}
              onMouseDown={e => { e.preventDefault(); window.electronAPI.startResize(dir) }}
            />
          ))}
        </div>
      )}
      <Topbar
        title={store.momentTitle} onTitleChange={store.setMomentTitle}
        onExport={handleExportOpen}
        exporting={exportState==='exporting'} exportProgress={ffmpeg.progress}
        totalDuration={store.totalDuration}
        aspectRatio={store.aspectRatio} onAspectRatioChange={store.setAspectRatio}
        quality={store.quality} onQualityChange={store.setQuality}
        onSaveWorkflow={store.saveWorkflow} onLoadWorkflow={handleLoadWorkflow}
        showLogs={showLogs} onToggleLogs={() => setShowLogs(v=>!v)}
        exportDone={exportState==='done'} outputUrl={outputUrl}
        outputName={store.momentTitle.replace(/\s+/g,'_')+'.mp4'}
        exportStartedAt={exportStartedAt} exportCompletedAt={exportCompletedAt}
        exportState={exportState}
      />

      <div className={styles.workspace}>
        <MediaPanel
          mediaLibrary={store.mediaLibrary}
          activeMediaId={store.activeMediaId}
          onSelectMedia={store.setActiveMediaId}
          onAddToTimeline={store.addLibraryItemToTimeline}
          onRemoveMedia={store.removeFromLibrary}
          onAddFiles={store.addToLibrary}
          onUpdateMediaDuration={store.updateMediaDuration}
          musicFile={store.musicFile}
          onMusicFile={store.setMusicFile}
          onMusicDuration={store.setMusicDuration}
        />

        <div className={styles.center}>
          <Preview
            clips={store.clips}
            activeClipId={store.activeClipId}
            onSelectClip={handleSelectClip}
            isPlaying={store.isPlaying}
            onPlayToggle={() => store.setIsPlaying(p=>!p)}
            getClipTransition={store.getClipTransition}
            aspectRatio={store.aspectRatio}
            textSegments={store.textSegments}
            onUpdateTextSegment={store.updateTextSegment}
          />

          <Timeline
            clips={store.clips}
            activeClipId={store.activeClipId}
            onSelectClip={handleSelectClip}
            onReorder={store.reorderClips}
            onRemoveClip={store.removeClip}
            globalTransition={store.globalTransition}
            onGlobalTransitionChange={store.setGlobalTransition}
            onClipTransitionChange={handleClipTransition}
            getClipTransition={store.getClipTransition}
            totalDuration={store.totalDuration}
            exportDuration={store.exportDuration}
            textSegments={store.textSegments}
            onAddTextSegment={store.addTextSegment}
            onSelectTextSegment={store.selectTextSegment}
            onRemoveTextSegment={store.removeTextSegment}
            onUpdateTextSegment={store.updateTextSegment}
            activeTextSegmentId={store.activeTextSegment?.id}
            onDropMediaToMain={handleDropMediaToMain}
          />

          {showLogs && <LogDrawer logs={ffmpeg.logs} onClose={() => setShowLogs(false)} onClear={ffmpeg.clearLogs} />}
        </div>

        <Inspector
          activeClip={store.activeClip}
          onUpdateClip={store.updateClip}
          globalTransition={store.globalTransition}
          onGlobalTransitionChange={store.setGlobalTransition}
          transitionDuration={store.transitionDuration}
          onTransitionDurationChange={store.setTransitionDuration}
          endFadeVideo={store.endFadeVideo}
          onEndFadeVideoChange={store.setEndFadeVideo}
          endFadeVideoDuration={store.endFadeVideoDuration}
          onEndFadeVideoDurationChange={store.setEndFadeVideoDuration}
          endFadeAudio={store.endFadeAudio}
          onEndFadeAudioChange={store.setEndFadeAudio}
          endFadeAudioDuration={store.endFadeAudioDuration}
          onEndFadeAudioDurationChange={store.setEndFadeAudioDuration}
          musicFile={store.musicFile}
          musicVolume={store.musicVolume}
          onMusicVolumeChange={store.setMusicVolume}
          musicDuration={store.musicDuration}
          musicTrimStart={store.musicTrimStart}
          musicTrimEnd={store.musicTrimEnd}
          onMusicTrimChange={(s,e) => { store.setMusicTrimStart(s); store.setMusicTrimEnd(e) }}
          activeTextSegment={store.activeTextSegment}
          onUpdateTextSegment={store.updateTextSegment}
          activeSelection={store.activeSelection}
        />
      </div>

      {showExport && (
        <ExportModal
          state={exportState} progress={ffmpeg.progress} logs={ffmpeg.logs}
          outputUrl={outputUrl} outputName={store.momentTitle.replace(/\s+/g,'_')+'.mp4'}
          quality={store.quality}
          aspectRatio={store.aspectRatio}
          onClose={() => setShowExport(false)}
          gpuCaps={ffmpeg.gpuCaps}
          encoderOverride={ffmpeg.encoderOverride}
          onEncoderChange={ffmpeg.setEncoderOverride}
          onRedetect={ffmpeg.resetGPU}
          currentEncoder={ffmpeg.encoder}
          onCancelExport={ffmpeg.cancelExport}
          onStartExport={handleFFmpegLoad}
        />
      )}
    </div>
  )
}
