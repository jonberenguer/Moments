import { useState, useRef, useEffect } from 'react'
import { Film, Download, Save, FolderOpen, Monitor, Smartphone, Terminal, CheckCircle, Clock, Undo2, Redo2, AlertTriangle } from 'lucide-react'
import styles from './Topbar.module.css'
import AboutModal from './AboutModal'

export default function Topbar({
  title, onTitleChange,
  onExport, exporting, exportProgress, totalDuration,
  aspectRatio, onAspectRatioChange,
  quality, onQualityChange,
  onSaveWorkflow, onLoadWorkflow,
  onUndo, onRedo, canUndo, canRedo,
  ffmpegMissing, ffmpegPath,
  showLogs, onToggleLogs,
  exportDone, outputUrl, outputName,
  exportStartedAt, exportCompletedAt, exportState,
}) {
  const [editing,    setEditing]    = useState(false)
  const [draft,      setDraft]      = useState(title)
  const [elapsed,    setElapsed]    = useState(0)
  const [showAbout,  setShowAbout]  = useState(false)
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const tickRef   = useRef(null)
  const fileInputRef = useRef()

  // Live ticker while exporting; freeze when done/error
  useEffect(() => {
    clearInterval(tickRef.current)
    if ((exportState === 'exporting' || exportState === 'loading-ffmpeg') && exportStartedAt) {
      setElapsed(Date.now() - exportStartedAt)
      tickRef.current = setInterval(() => setElapsed(Date.now() - exportStartedAt), 500)
    } else if (exportCompletedAt && exportStartedAt) {
      setElapsed(exportCompletedAt - exportStartedAt)
    }
    return () => clearInterval(tickRef.current)
  }, [exportState, exportStartedAt, exportCompletedAt])

  // The main process intercepts the native close (X / Alt+F4) and asks us to
  // confirm — open the same exit dialog the toolbar used to.
  useEffect(() => {
    return window.electronAPI?.onConfirmClose?.(() => setShowExitConfirm(true))
  }, [])

  // On Windows/macOS the title bar is hidden, so the toolbar doubles as the
  // drag region; on Windows reserve space on the right for the native overlay
  // (min/max/close) buttons so they don't overlap our controls.
  const hiddenTitleBar = !!window.electronAPI && window.electronAPI.platform !== 'linux'
  const isWindows      = window.electronAPI?.platform === 'win32'

  const fmtElapsed = (ms) => {
    const totalSec = Math.floor(ms / 1000)
    const m = Math.floor(totalSec / 60)
    const s = (totalSec % 60).toString().padStart(2, '0')
    return m > 0 ? `${m}m ${s}s` : `${s}s`
  }

  const showTimer = exportState === 'exporting' || exportState === 'loading-ffmpeg' ||
                    exportState === 'done' || exportState === 'error'

  const fmt = (s) => {
    const m = Math.floor(s / 60)
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
  }

  const handleLoadFile = (e) => {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => onLoadWorkflow(ev.target.result)
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <>
    <header className={`${styles.bar} ${hiddenTitleBar ? styles.dragBar : ''}`}
      style={isWindows ? { paddingRight: 148 } : undefined}>
      <div className={styles.left}>
        <button className={styles.logoBtn} onClick={() => setShowAbout(true)} title="About moments">
          <div className={styles.logo}>
            <Film size={15} strokeWidth={1.5} />
            <span className={styles.logoText}>moments</span>
          </div>
        </button>
        <div className={styles.divider} />
        {editing ? (
          <input className={styles.titleInput} value={draft} autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={() => { onTitleChange(draft); setEditing(false) }}
            onKeyDown={e => { if (e.key === 'Enter') { onTitleChange(draft); setEditing(false) } }} />
        ) : (
          <span className={styles.title} onClick={() => { setDraft(title); setEditing(true) }}>{title}</span>
        )}
        {totalDuration > 0 && <span className={styles.duration}>{fmt(totalDuration)}</span>}
        {showTimer && (
          <span className={`${styles.exportTimer} ${exportState === 'done' ? styles.exportTimerDone : exportState === 'error' ? styles.exportTimerError : styles.exportTimerActive}`}>
            <Clock size={10} strokeWidth={2} />
            {exportState === 'done' ? `Exported in ${fmtElapsed(elapsed)}` :
             exportState === 'error' ? `Failed after ${fmtElapsed(elapsed)}` :
             `Exporting… ${fmtElapsed(elapsed)}`}
          </span>
        )}
      </div>

      <div className={styles.center}>
        <div className={styles.arToggle}>
          <button className={`${styles.arBtn} ${aspectRatio === '16:9' ? styles.arActive : ''}`}
            onClick={() => onAspectRatioChange('16:9')} title="Horizontal (16:9)">
            <Monitor size={13} strokeWidth={1.5} /><span>16:9</span>
          </button>
          <button className={`${styles.arBtn} ${aspectRatio === '9:16' ? styles.arActive : ''}`}
            onClick={() => onAspectRatioChange('9:16')} title="Vertical (9:16)">
            <Smartphone size={13} strokeWidth={1.5} /><span>9:16</span>
          </button>
        </div>

        <div className={styles.centerDivider} />

        <div className={styles.arToggle}>
          <button className={`${styles.arBtn} ${quality === '480p' ? styles.arActive : ''}`}
            onClick={() => onQualityChange('480p')} title="480p — quick preview render">
            <span>480p</span>
          </button>
          <button className={`${styles.arBtn} ${quality === '720p' ? styles.arActive : ''}`}
            onClick={() => onQualityChange('720p')} title="720p — faster, smaller file">
            <span>720p</span>
          </button>
          <button className={`${styles.arBtn} ${quality === '1080p' ? styles.arActive : ''}`}
            onClick={() => onQualityChange('1080p')} title="1080p — sharper, larger file">
            <span>1080p</span>
          </button>
        </div>

      </div>

      <div className={styles.right}>
        <button className={styles.iconBtn} onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Undo2 size={14} strokeWidth={1.5} />
        </button>
        <button className={styles.iconBtn} onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          <Redo2 size={14} strokeWidth={1.5} />
        </button>
        <div className={styles.divider} />

        <button className={styles.iconBtn} onClick={() => fileInputRef.current?.click()} title="Load workflow">
          <FolderOpen size={14} strokeWidth={1.5} />
        </button>
        <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoadFile} />

        <button className={styles.iconBtn} onClick={onSaveWorkflow} title="Save workflow">
          <Save size={14} strokeWidth={1.5} />
        </button>

        <button className={`${styles.iconBtn} ${showLogs ? styles.iconBtnActive : ''}`}
          onClick={onToggleLogs} title="Toggle console log">
          <Terminal size={14} strokeWidth={1.5} />
        </button>

        <div className={styles.divider} />

        {/* Download button — appears when export is complete */}
        {exportDone && outputUrl && (
          <a href={outputUrl} download={outputName || 'moment.mp4'} className={styles.downloadReadyBtn} title="Download exported MP4">
            <CheckCircle size={13} strokeWidth={1.5} />
            Download
          </a>
        )}

        {ffmpegMissing && (
          <span className={styles.ffmpegWarn}
            title={`FFmpeg not found${ffmpegPath ? ` at ${ffmpegPath}` : ''} — run "node scripts/download-ffmpeg.js" to enable export`}>
            <AlertTriangle size={13} strokeWidth={1.8} />
            <span className={styles.ffmpegWarnText}>FFmpeg missing</span>
          </span>
        )}

        <button className={styles.exportBtn} onClick={onExport} disabled={exporting || ffmpegMissing}
          title={ffmpegMissing ? 'FFmpeg not found — install it to enable export' : undefined}>
          <Download size={13} strokeWidth={1.5} />
          {exporting ? `${exportProgress}%` : 'Export MP4'}
        </button>
      </div>
    </header>

    {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}

    {showExitConfirm && (
      <div className={styles.exitOverlay}>
        <div className={styles.exitDialog}>
          <p className={styles.exitMsg}>Exit moments?</p>
          <p className={styles.exitSub}>Any unsaved changes will be lost.</p>
          <div className={styles.exitBtns}>
            <button className={styles.exitCancel} onClick={() => setShowExitConfirm(false)}>
              Cancel
            </button>
            <button className={styles.exitConfirm} onClick={() => {
              if (window.electronAPI?.forceClose) window.electronAPI.forceClose()
              else window.close()
            }}>
              Exit
            </button>
          </div>
        </div>
      </div>
    )}
  </>
  )
}
