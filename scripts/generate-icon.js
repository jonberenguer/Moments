#!/usr/bin/env node
/**
 * scripts/generate-icon.js
 *
 * Renders public/icon.png (256×256 RGBA) — the film-strip app icon, matching
 * public/favicon.svg. electron-builder needs a PNG (it can't convert SVG), and
 * this keeps the raster icon reproducible without any image tooling: it draws
 * the same shapes with 4× supersampling and encodes the PNG using only Node's
 * built-in zlib.
 *
 * Run after changing the design:  node scripts/generate-icon.js
 */
const fs   = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 256, SS = 4
const DARK = [26, 26, 32], AMBER = [232, 201, 106]

// Signed distance to a rounded rect (centre cx,cy, half-extents hw,hh, radius r).
function sdRR(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r)
  const dy = Math.abs(py - cy) - (hh - r)
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r
}
const inRR = (px, py, x0, y0, x1, y1, r) =>
  sdRR(px, py, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, r) <= 0

const HOLE_ROWS = [60, 95, 130, 165, 200]
const DIVIDERS  = [95, 130, 165]

// Colour at a point in 256-space. Returns [r,g,b,a]. Mirrors favicon.svg.
function sample(px, py) {
  if (!inRR(px, py, 8, 8, 248, 248, 52)) return [0, 0, 0, 0]      // transparent outside the rounded square
  let col = [DARK[0], DARK[1], DARK[2], 255]                       // dark background
  if (inRR(px, py, 64, 40, 192, 216, 16)) {                        // amber film body
    col = [AMBER[0], AMBER[1], AMBER[2], 255]
    for (const cy of HOLE_ROWS) {                                  // sprocket holes (punch to dark)
      if (inRR(px, py, 72,  cy - 10, 88,  cy + 10, 5)) col = [DARK[0], DARK[1], DARK[2], 255]
      if (inRR(px, py, 168, cy - 10, 184, cy + 10, 5)) col = [DARK[0], DARK[1], DARK[2], 255]
    }
    for (const cy of DIVIDERS) {                                   // centre frame dividers
      if (inRR(px, py, 96, cy - 4, 160, cy + 4, 3)) col = [DARK[0], DARK[1], DARK[2], 255]
    }
  }
  return col
}

// Render with SS×SS supersampling, box-downsample to SIZE for anti-aliasing.
const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)
      r += c[0]; g += c[1]; b += c[2]; a += c[3]
    }
    const n = SS * SS, i = (y * SIZE + x) * 4
    rgba[i] = Math.round(r / n); rgba[i + 1] = Math.round(g / n)
    rgba[i + 2] = Math.round(b / n); rgba[i + 3] = Math.round(a / n)
  }
}

// ── Minimal PNG encoder (RGBA, 8-bit) ────────────────────────────────────────
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t   = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function encodePNG(w, h, buf) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6   // 8-bit depth, colour type 6 (RGBA)
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0  // filter: none
    buf.copy(raw, y * (1 + w * 4) + 1, y * w * 4, y * w * 4 + w * 4)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const outPath = path.join(__dirname, '..', 'public', 'icon.png')
fs.writeFileSync(outPath, encodePNG(SIZE, SIZE, rgba))
console.log(`wrote ${outPath} (${SIZE}×${SIZE})`)
