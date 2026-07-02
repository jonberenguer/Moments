import { useSyncExternalStore } from 'react'

// ── Playhead — external store (out of React state) ────────────────────────────
// The playback rAF loop advances the playhead ~60×/s. If that value lived in
// useMediaStore (React state threaded through App), every frame would re-render
// the entire App tree — Topbar, MediaPanel, Inspector and the whole Timeline —
// even though none of them depend on the playhead. Holding it in a tiny
// subscribe/get external store means only the components that actually read it
// (the Preview surface and the three thin Timeline playhead lines) re-render.
//
// Single-window desktop app → a module singleton is sufficient and avoids
// threading the store through props.

let value = 0
const listeners = new Set()

export const playhead = {
  get: () => value,
  set: (v) => {
    const next = typeof v === 'function' ? v(value) : v
    const nv = Number.isFinite(next) ? next : 0
    if (nv === value) return
    value = nv
    for (const l of listeners) l()
  },
  subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
}

// Subscribe a component to the playhead. Re-renders only that component on change.
export function usePlayhead() {
  return useSyncExternalStore(playhead.subscribe, playhead.get, playhead.get)
}
