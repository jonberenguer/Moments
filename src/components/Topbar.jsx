import { useState, useRef, useEffect } from 'react'
import { Film, Download, Save, FolderOpen, Monitor, Smartphone, Terminal, CheckCircle, Clock, X } from 'lucide-react'
import styles from './Topbar.module.css'
import AboutModal from './AboutModal'

export default function Topbar({
  title, onTitleChange,
  onExport, exporting, exportProgress, totalDuration,
  aspectRatio, onAspectRatioChange,
  quality, onQualityChange,
  onSaveWorkflow, onLoadWorkflow,
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
    <header className={styles.bar}>
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

        <button className={styles.exportBtn} onClick={onExport} disabled={exporting}>
          <Download size={13} strokeWidth={1.5} />
          {exporting ? `${exportProgress}%` : 'Export MP4'}
        </button>

        {/* Close / exit button — always visible, calls Electron close or window.close fallback */}
        <div className={styles.dividerThin} />
        <button
          className={styles.closeBtn}
          onClick={() => setShowExitConfirm(true)}
          title="Exit moments"
        >
          <X size={14} strokeWidth={1.5} />
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
              if (window.electronAPI?.closeApp) window.electronAPI.closeApp()
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
