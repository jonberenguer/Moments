/**
 * GPUSelector — encoder fallback UI
 * Shown in the Export Modal when GPU is available or when an error occurs.
 */
import { Cpu, Zap, AlertTriangle, RefreshCw } from 'lucide-react'
import styles from './GPUSelector.module.css'

const ENCODER_OPTIONS = [
  { value: 'auto',     label: 'Auto (recommended)',  desc: 'Best available encoder' },
  { value: 'nvenc',    label: 'NVENC',               desc: 'NVIDIA GPU' },
  { value: 'amf',      label: 'AMF',                 desc: 'AMD GPU' },
  { value: 'qsv',      label: 'Quick Sync',          desc: 'Intel iGPU' },
  { value: 'v4l2m2m',  label: 'V4L2 M2M',           desc: 'Linux HW (fallback)' },
  { value: 'cpu',      label: 'CPU (libx264)',        desc: 'Software — always works' },
]

export default function GPUSelector({ gpuCaps, encoderOverride, onEncoderChange, onRedetect, currentEncoder }) {
  if (!gpuCaps) return null

  const available = {
    auto:    true,
    nvenc:   gpuCaps.nvenc,
    amf:     gpuCaps.amf,
    qsv:     gpuCaps.qsv,
    v4l2m2m: gpuCaps.v4l2m2m,
    cpu:     gpuCaps.cpu,
  }

  const hasGPU = gpuCaps.nvenc || gpuCaps.amf || gpuCaps.qsv || gpuCaps.v4l2m2m

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        {hasGPU
          ? <><Zap size={13} strokeWidth={2} className={styles.iconGpu} /> GPU Accelerated</>
          : <><Cpu size={13} strokeWidth={2} className={styles.iconCpu} /> CPU Encoding</>
        }
        {currentEncoder && <span className={styles.currentEnc}>{currentEncoder}</span>}
        <button className={styles.redetect} onClick={onRedetect} title="Re-detect GPU">
          <RefreshCw size={11} strokeWidth={2} />
        </button>
      </div>

      {!hasGPU && (
        <div className={styles.warning}>
          <AlertTriangle size={12} strokeWidth={2} />
          No GPU encoder detected — using CPU. This is slower but always works.
        </div>
      )}

      <div className={styles.options}>
        {ENCODER_OPTIONS.filter(opt => available[opt.value] || opt.value === 'auto' || opt.value === 'cpu').map(opt => (
          <label key={opt.value} className={`${styles.option} ${encoderOverride === opt.value ? styles.selected : ''} ${!available[opt.value] && opt.value !== 'auto' ? styles.unavailable : ''}`}>
            <input
              type="radio"
              name="encoder"
              value={opt.value}
              checked={encoderOverride === opt.value}
              disabled={!available[opt.value] && opt.value !== 'auto'}
              onChange={() => onEncoderChange(opt.value)}
            />
            <span className={styles.optLabel}>{opt.label}</span>
            <span className={styles.optDesc}>{opt.desc}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
