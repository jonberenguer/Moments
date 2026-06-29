/**
 * Shared text layout — used by BOTH the Preview and the FFmpeg export so the two
 * break lines at exactly the same points (the long-standing "preview wraps, export
 * doesn't" mismatch). Wrapping is computed with an offscreen canvas `measureText`
 * at a fixed reference width; because fontSize and box width both scale linearly
 * with the canvas/screen width, the break decisions are scale-invariant — preview
 * (screenW) and export (the W×H canvas) get identical lines from the same inputs.
 */

// CJK codepoint ranges (kept in sync with the export's CJK font fallback). A run
// of these is breakable between every character (CJK has no spaces).
const CJK_CHAR_RE = /[ᄀ-ᇿ⺀-⿟　-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]/
export function hasCJK(text) { return CJK_CHAR_RE.test(text || '') }

// Stable content hash of font bytes → a unique CSS family name. Shared by the
// upload handler, preview, export, and workflow save/load so the SAME font
// always resolves to the SAME @font-face family (uploads repaint, re-uploads
// swap correctly, and the same font across captions/workflows dedupes).
export function hashFontBytes(bytes) {
  let h = 0
  const n = Math.min(bytes.length, 4096)
  for (let i = 0; i < n; i++) h = (h * 31 + bytes[i]) >>> 0
  return h
}
export function customFontFamily(bytes) { return `MomCustom_${hashFontBytes(bytes)}` }

// Wrapping is computed as if the canvas were this many px wide; both renderers
// scale from here, so a given (fontSize, boxWidth%) yields the same line breaks.
export const WRAP_REF_W = 1280

let _ctx
function ctx() { return _ctx || (_ctx = document.createElement('canvas').getContext('2d')) }

// Split a paragraph into breakable units: a space, a single CJK char, or a run of
// non-space non-CJK chars (a "word").
function tokenize(s) {
  const toks = []
  let buf = ''
  const flush = () => { if (buf) { toks.push(buf); buf = '' } }
  for (const ch of s) {
    if (ch === ' ' || ch === '\t') { flush(); toks.push(' ') }
    else if (CJK_CHAR_RE.test(ch)) { flush(); toks.push(ch) }
    else buf += ch
  }
  flush()
  return toks
}

/**
 * Wrap `text` to fit `boxWidthPct`% of the reference canvas, in `fontFamily` at
 * `fontSize` units. Existing '\n' are honored as hard breaks. Returns string[].
 * The fontFamily must be loaded in the document for accurate measurement.
 */
export function wrapText(text, fontFamily, fontSize, boxWidthPct) {
  const maxW = Math.max(1, ((boxWidthPct ?? 80) / 100) * WRAP_REF_W)
  const c = ctx()
  c.font = `${Math.max(1, Math.round(fontSize || 60))}px ${fontFamily || 'sans-serif'}`
  const width = (s) => c.measureText(s).width
  const lines = []
  for (const para of String(text ?? '').split('\n')) {
    if (para === '') { lines.push(''); continue }
    let line = ''
    const tokens = tokenize(para)
    for (const tok of tokens) {
      const cand = line + tok
      if (width(cand) <= maxW || line === '') {
        line = cand
      } else {
        lines.push(line.replace(/[ \t]+$/, ''))
        line = (tok === ' ') ? '' : tok
      }
      // Hard-break a single unbreakable token (a long Latin word with no spaces)
      // that overflows the box on its own.
      while (line.length > 1 && !line.includes(' ') && width(line) > maxW) {
        let i = line.length - 1
        while (i > 1 && width(line.slice(0, i)) > maxW) i--
        lines.push(line.slice(0, i))
        line = line.slice(i)
      }
    }
    lines.push(line.replace(/[ \t]+$/, ''))
  }
  return lines
}
