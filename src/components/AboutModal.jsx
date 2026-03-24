import { useEffect, useState } from 'react'
import { X, Film, Github, Calendar, Tag, User } from 'lucide-react'
import styles from './AboutModal.module.css'

export default function AboutModal({ onClose }) {
  const [info, setInfo] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    fetch('/app-info.json')
      .then(r => { if (!r.ok) throw new Error('not found'); return r.json() })
      .then(setInfo)
      .catch(() => setError(true))
  }, [])

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const fmtDate = (str) => {
    if (!str) return null
    try {
      return new Date(str).toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' })
    } catch { return str }
  }

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>

        <div className={styles.header}>
          <div className={styles.headerLogo}>
            <Film size={16} strokeWidth={1.5} className={styles.headerIcon} />
            <span className={styles.headerTitle}>About</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className={styles.body}>
          {error && (
            <p className={styles.errorMsg}>
              Could not load <code>app-info.json</code>. Place it in the <code>/public</code> folder.
            </p>
          )}

          {!info && !error && (
            <p className={styles.loading}>Loading…</p>
          )}

          {info && (
            <>
              {/* App name + purpose */}
              <div className={styles.appHeader}>
                <div className={styles.appIconWrap}>
                  <Film size={22} strokeWidth={1.2} />
                </div>
                <div>
                  <div className={styles.appName}>{info.name}</div>
                  {info.version && <div className={styles.appVersion}>v{info.version}</div>}
                </div>
              </div>

              {info.purpose && (
                <p className={styles.purpose}>{info.purpose}</p>
              )}

              <div className={styles.divider} />

              {/* Metadata rows */}
              <div className={styles.metaList}>
                {info.createdBy && (
                  <div className={styles.metaRow}>
                    <span className={styles.metaIcon}><User size={11} strokeWidth={1.8} /></span>
                    <span className={styles.metaKey}>Created by</span>
                    <span className={styles.metaVal}>{info.createdBy}</span>
                  </div>
                )}
                {info.releaseDate && (
                  <div className={styles.metaRow}>
                    <span className={styles.metaIcon}><Calendar size={11} strokeWidth={1.8} /></span>
                    <span className={styles.metaKey}>Released</span>
                    <span className={styles.metaVal}>{fmtDate(info.releaseDate)}</span>
                  </div>
                )}
                {info.version && (
                  <div className={styles.metaRow}>
                    <span className={styles.metaIcon}><Tag size={11} strokeWidth={1.8} /></span>
                    <span className={styles.metaKey}>Version</span>
                    <span className={styles.metaVal}>{info.version}</span>
                  </div>
                )}
                {info.repository && (
                  <div className={styles.metaRow}>
                    <span className={styles.metaIcon}><Github size={11} strokeWidth={1.8} /></span>
                    <span className={styles.metaKey}>Repository</span>
                    <a
                      href={info.repository}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.metaLink}
                    >
                      {info.repository.replace(/^https?:\/\//, '')}
                    </a>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.closeFooterBtn} onClick={onClose}>Close</button>
        </div>

      </div>
    </div>
  )
}
