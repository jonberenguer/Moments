import { useEffect, useRef } from 'react'
import { X, Trash2 } from 'lucide-react'
import styles from './LogDrawer.module.css'

export default function LogDrawer({ logs, onClose, onClear }) {
  const bottomRef = useRef()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  return (
    <div className={styles.drawer}>
      <div className={styles.header}>
        <span className={styles.title}>Console Log</span>
        <div className={styles.actions}>
          <button className={styles.actionBtn} onClick={onClear} title="Clear logs">
            <Trash2 size={12} strokeWidth={1.5} />
          </button>
          <button className={styles.actionBtn} onClick={onClose} title="Close">
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className={styles.body}>
        {logs.length === 0 ? (
          <span className={styles.empty}>No logs yet. Start an export to see FFmpeg output.</span>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={styles.line}>
              <span className={styles.lineNum}>{i + 1}</span>
              <span className={styles.lineText}>{line}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
