/**
 * Glyph-coverage detection so the preview and export can show real "tofu" (□) for
 * characters the SELECTED font can't render — instead of silently substituting a
 * different font. Both renderers sanitize the caption through the SAME function
 * (fontFallbackText) so they wrap and render identically (preview == export).
 *
 * - Preset fonts: coverage is decided by the `cjk` tag passed in by the caller
 *   (Latin presets can't render CJK; CJK presets can). Cheap, no parsing.
 * - Custom uploads: we parse the font's `cmap` table for exact per-codepoint
 *   coverage. Works on uncompressed sfnt (.ttf/.otf); WOFF/WOFF2 are compressed
 *   so we can't parse them synchronously → treated as "coverage unknown" (no tofu).
 */
import { hasCJK } from './textLayout'

const TOFU = '□'   // □ WHITE SQUARE — the "block char" shown for missing glyphs

// Parse an sfnt font's best Unicode cmap → Set of covered codepoints.
// Returns null for unsupported containers (WOFF/WOFF2) or on any parse error.
export function parseFontCoverage(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const tag = dv.getUint32(0)
    const WOFF = 0x774F4646, WOFF2 = 0x774F4632
    if (tag === WOFF || tag === WOFF2) return null          // compressed — skip
    let base = 0
    if (tag === 0x74746366 /* 'ttcf' collection */) base = dv.getUint32(12)
    const numTables = dv.getUint16(base + 4)
    let cmapOff = 0
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16
      if (dv.getUint32(rec) === 0x636D6170 /* 'cmap' */) { cmapOff = dv.getUint32(rec + 8); break }
    }
    if (!cmapOff) return null

    // Pick the most capable Unicode subtable.
    const numSub = dv.getUint16(cmapOff + 2)
    let best = null
    for (let i = 0; i < numSub; i++) {
      const rec = cmapOff + 4 + i * 8
      const plat = dv.getUint16(rec), enc = dv.getUint16(rec + 2)
      const subOff = cmapOff + dv.getUint32(rec + 4)
      const fmt = dv.getUint16(subOff)
      const score = (plat === 3 && enc === 10) ? 5            // Windows UCS-4
        : (plat === 0 && (enc === 4 || enc === 6)) ? 5         // Unicode full
        : (plat === 3 && enc === 1) ? 4                        // Windows BMP
        : (plat === 0) ? 3 : (plat === 3 && enc === 0) ? 2 : 1
      if (!best || score > best.score) best = { subOff, fmt, score }
    }
    if (!best) return null

    const set = new Set()
    const { subOff, fmt } = best
    if (fmt === 4) {
      const segX2 = dv.getUint16(subOff + 6), segCount = segX2 / 2
      const endO = subOff + 14, startO = endO + segX2 + 2
      const deltaO = startO + segX2, rangeO = deltaO + segX2
      for (let s = 0; s < segCount; s++) {
        const end = dv.getUint16(endO + s * 2)
        const start = dv.getUint16(startO + s * 2)
        const delta = dv.getUint16(deltaO + s * 2)
        const rangeOffset = dv.getUint16(rangeO + s * 2)
        if (start > end) continue
        for (let c = start; c <= end && c !== 0xFFFF; c++) {
          let g
          if (rangeOffset === 0) g = (c + delta) & 0xFFFF
          else {
            const gi = rangeO + s * 2 + rangeOffset + (c - start) * 2
            if (gi + 1 >= u8.byteLength) continue
            g = dv.getUint16(gi)
            if (g !== 0) g = (g + delta) & 0xFFFF
          }
          if (g !== 0) set.add(c)
        }
      }
    } else if (fmt === 12) {
      const nGroups = dv.getUint32(subOff + 12)
      let p = subOff + 16
      for (let i = 0; i < nGroups; i++, p += 12) {
        const startC = dv.getUint32(p), endC = dv.getUint32(p + 4)
        if (endC - startC > 0x20000) continue                 // guard absurd ranges
        for (let c = startC; c <= endC; c++) set.add(c)
      }
    } else if (fmt === 6) {
      const first = dv.getUint16(subOff + 6), count = dv.getUint16(subOff + 8)
      for (let i = 0; i < count; i++) if (dv.getUint16(subOff + 10 + i * 2) !== 0) set.add(first + i)
    } else if (fmt === 0) {
      for (let c = 0; c < 256; c++) if (u8[subOff + 6 + c] !== 0) set.add(c)
    } else return null
    return set
  } catch { return null }
}

// Coverage Set per custom font, cached by its content-stable family name.
const _coverageCache = new Map()   // family → Set<number> | null
export function customCoverage(family, bytes) {
  if (!family) return null
  if (_coverageCache.has(family)) return _coverageCache.get(family)
  const set = (bytes && bytes.byteLength) ? parseFontCoverage(bytes) : null
  _coverageCache.set(family, set)
  return set
}

// Replace every codepoint the selected font can't render with □, so the caption
// renders identically in the preview and the export. `presetCoversCJK` is the
// `cjk` flag of the chosen preset (ignored for custom fonts, which use the cmap).
export function fontFallbackText(text, seg, presetCoversCJK) {
  if (!text) return text
  if (seg?.fontFile === 'custom') {
    const set = customCoverage(seg.customFontFamily, seg.customFontData)
    if (!set) return text                                    // unknown (e.g. WOFF) → assume covered
    let out = ''
    for (const ch of text) out += set.has(ch.codePointAt(0)) ? ch : TOFU
    return out
  }
  if (presetCoversCJK) return text                           // CJK-capable preset → keep as-is
  // Latin preset: only CJK is out of range here (other scripts are out of scope).
  let out = ''
  for (const ch of text) out += hasCJK(ch) ? TOFU : ch
  return out
}

// True when the selected font can't render some character in the text.
export function hasUnsupportedGlyphs(text, seg, presetCoversCJK) {
  return !!text && fontFallbackText(text, seg, presetCoversCJK) !== text
}
