import { X, Loader, CheckCircle, AlertCircle, Play } from 'lucide-react'
import GPUSelector from './GPUSelector'
import styles from './ExportModal.module.css'

export default function ExportModal({
  state, progress, logs, outputUrl, outputName,
  quality, aspectRatio, onClose,
  // GPU props
  gpuCaps, encoderOverride, onEncoderChange, onRedetect, currentEncoder,
  onCancelExport, onStartExport,
}) {
  const isVertical = aspectRatio === '9:16'
  const dims = {
    '480p':  isVertical ? '480×854'   : '854×480',
    '720p':  isVertical ? '720×1280'  : '1280×720',
    '1080p': isVertical ? '1080×1920' : '1920×1080',
  }
  const canClose = state === 'done' || state === 'error'
  const isIdle   = state === 'idle'

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>Export Moment</span>
          <button
            className={styles.closeBtn}
            onClick={canClose || isIdle ? onClose : undefined}
            disabled={!canClose && !isIdle}
            style={(!canClose && !isIdle) ? {opacity:0.35, cursor:'not-allowed'} : {}}
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className={styles.body}>

          {/* ── Idle: show GPU selector before export ── */}
          {state === 'idle' && (
            <div className={styles.idleState}>
              <p className={styles.qualityLine}>{quality} · {dims[quality] || ''} · 30 fps</p>
              <GPUSelector
                gpuCaps={gpuCaps}
                encoderOverride={encoderOverride}
                onEncoderChange={onEncoderChange}
                onRedetect={onRedetect}
                currentEncoder={currentEncoder}
              />
            </div>
          )}

          {/* ── Loading / detecting GPU ── */}
          {state === 'loading-ffmpeg' && (
            <div className={styles.centeredState}>
              <Loader size={24} strokeWidth={1} className={styles.spin} />
              <p className={styles.stateLabel}>Detecting GPU…</p>
              <p className={styles.hint}>Checking for NVENC · AMF · QSV hardware encoders</p>
            </div>
          )}

          {/* ── Exporting ── */}
          {state === 'exporting' && (
            <div className={styles.exportingState}>
              <p className={styles.qualityLine}>
                {quality} · {dims[quality] || ''} · 30 fps
                {currentEncoder && <span style={{marginLeft:8,opacity:0.6}}>{currentEncoder}</span>}
              </p>
              <div className={styles.progressWrap}>
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
                </div>
                <span className={styles.progressPct}>{Math.min(100, progress)}%</span>
              </div>
              <div className={styles.logBox}>
                {logs.slice(-6).map((l, i) => (
                  <div key={i} className={styles.logLine}>{l}</div>
                ))}
              </div>
              <button className={styles.cancelInline} onClick={onCancelExport}>Cancel export</button>
            </div>
          )}

          {/* ── Done ── */}
          {state === 'done' && (
            <div className={styles.centeredState}>
              <CheckCircle size={32} strokeWidth={1} className={styles.iconDone} />
              <p className={styles.stateLabel}>Export complete</p>
              <p className={styles.hint}>File saved via the system dialog. Check your chosen location.</p>
              {outputUrl && <video src={outputUrl} controls className={styles.preview} />}
            </div>
          )}

          {/* ── Error ── */}
          {state === 'error' && (
            <div className={styles.centeredState}>
              <AlertCircle size={32} strokeWidth={1} className={styles.iconError} />
              <p className={styles.stateLabel}>Export failed</p>
              <p className={styles.hint}>
                If a GPU error occurred, try switching to CPU encoding and retry.
              </p>
              <GPUSelector
                gpuCaps={gpuCaps}
                encoderOverride={encoderOverride}
                onEncoderChange={onEncoderChange}
                onRedetect={onRedetect}
                currentEncoder={currentEncoder}
              />
              {logs.slice(-3).map((l, i) => (
                <div key={i} className={styles.errorLogLine}>{l}</div>
              ))}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          {state === 'idle' && (
            <>
              <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
              <button className={styles.downloadBtn} onClick={onStartExport}>
                <Play size={13} strokeWidth={2} /> Start Export
              </button>
            </>
          )}
          {(state === 'error') && (
            <>
              <button className={styles.cancelBtn} onClick={onClose}>Close</button>
              <button className={styles.downloadBtn} onClick={onStartExport}>
                <Play size={13} strokeWidth={2} /> Retry Export
              </button>
            </>
          )}
          {state === 'done' && (
            <button className={styles.cancelBtn} onClick={onClose}>Close</button>
          )}
          {(state === 'exporting' || state === 'loading-ffmpeg') && (
            <button className={styles.cancelBtn} disabled style={{opacity:0.35,cursor:'not-allowed'}}>
              Exporting…
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
