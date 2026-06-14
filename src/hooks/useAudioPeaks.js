import { useState, useEffect } from 'react'

// Decodes an audio File once into a compact min/max peak array for waveform
// rendering. Renderer-only (preview/timeline) — has no bearing on the FFmpeg
// export. Returns { peaks, duration }, where peaks = { mins, maxs, buckets }
// over channel 0 (mixed to mono). Buckets are resolution-independent: the
// consumer maps a pixel column's time span onto a bucket range, so the same
// decoded data serves any timeline zoom level.
const BUCKETS = 6000
const EMPTY = { peaks: null, duration: 0 }

export default function useAudioPeaks(file) {
  const [state, setState] = useState(EMPTY)

  useEffect(() => {
    let cancelled = false

    // All state updates happen inside this async callback (never synchronously
    // in the effect body) to avoid cascading-render churn on every file swap.
    const run = async () => {
      if (!file) { if (!cancelled) setState(EMPTY); return }
      if (!cancelled) setState(EMPTY)   // clear stale waveform while decoding

      let ctx
      try {
        const buf = await file.arrayBuffer()
        if (cancelled) return
        const AC = window.AudioContext || window.webkitAudioContext
        ctx = new AC()
        const audio = await ctx.decodeAudioData(buf)
        if (cancelled) return

        const len = audio.length
        const chCount = audio.numberOfChannels
        const buckets = Math.min(BUCKETS, len || 1)
        const per = Math.max(1, Math.floor(len / buckets))
        const mins = new Float32Array(buckets)
        const maxs = new Float32Array(buckets)
        // Read channel 0; fold in a second channel if present for a fuller shape.
        const a = audio.getChannelData(0)
        const b = chCount > 1 ? audio.getChannelData(1) : null

        for (let i = 0; i < buckets; i++) {
          const start = i * per
          const end = Math.min(len, start + per)
          let mn = 1, mx = -1
          for (let j = start; j < end; j++) {
            let v = a[j]
            if (b) v = (v + b[j]) * 0.5
            if (v < mn) mn = v
            if (v > mx) mx = v
          }
          if (mn > mx) { mn = 0; mx = 0 }
          mins[i] = mn
          maxs[i] = mx
        }

        if (!cancelled) setState({ peaks: { mins, maxs, buckets }, duration: audio.duration })
      } catch {
        if (!cancelled) setState(EMPTY)
      } finally {
        ctx?.close?.()
      }
    }

    run()
    return () => { cancelled = true }
  }, [file])

  return state
}
