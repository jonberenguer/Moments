#!/usr/bin/env node
/**
 * scripts/download-ffmpeg.js
 *
 * Downloads pre-built static FFmpeg binaries into the bin/ directory, which the
 * app spawns at runtime and the installer/CI bundles beside the binary.
 *
 * Usage:
 *   node scripts/download-ffmpeg.js            # both platforms (default)
 *   node scripts/download-ffmpeg.js both       # both platforms
 *   node scripts/download-ffmpeg.js linux      # Linux x64 only  → bin/linux/ffmpeg
 *   node scripts/download-ffmpeg.js win        # Windows x64 only → bin/win/ffmpeg.exe
 *
 * Binaries come from the BtbN GPL builds:
 *   https://github.com/BtbN/FFmpeg-Builds/releases
 * These include everything the app relies on:
 *   - drawtext   (text overlays — REQUIRES libfreetype; the ffmpeg-static /
 *                 johnvansickle static builds OMIT this filter, which breaks the
 *                 text-overlay export stage with "No such filter: 'drawtext'")
 *   - libx264    (CPU encoder — always available)
 *   - h264_nvenc (NVIDIA GPU), h264_amf (AMD GPU), h264_qsv (Intel iGPU)
 *
 * GPU encoders are compiled in but require the matching GPU drivers/hardware at
 * runtime; the app detects availability and falls back gracefully.
 *
 * Extraction shells out to `tar` (Linux .tar.xz) and `unzip` (Windows .zip),
 * which are standard on Linux build hosts. Install them if missing:
 *   apt-get install -y xz-utils unzip
 *
 * ── ALTERNATIVE: Bring Your Own FFmpeg ───────────────────────────────────────
 * Skip this script and place binaries yourself at:
 *   bin/linux/ffmpeg     (Linux x64, must be executable)
 *   bin/win/ffmpeg.exe   (Windows x64)
 * In dev mode the app will also pick up `ffmpeg` from PATH.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require('fs')
const path  = require('path')
const https = require('https')
const os    = require('os')
const { execSync } = require('child_process')

const SOURCES = {
  linux: {
    url:      'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
    archive:  'ffmpeg-linux64-gpl.tar.xz',
    innerBin: 'ffmpeg-master-latest-linux64-gpl/bin/ffmpeg',
    destDir:  path.join(__dirname, '..', 'bin', 'linux'),
    destName: 'ffmpeg',
    executable: true,
    extract: (archivePath, outDir) => execSync(`tar -xf "${archivePath}" -C "${outDir}"`, { stdio: 'inherit' }),
    needs: '`tar` with xz support (apt-get install -y xz-utils)',
  },
  win: {
    url:      'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    archive:  'ffmpeg-win64-gpl.zip',
    innerBin: 'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe',
    destDir:  path.join(__dirname, '..', 'bin', 'win'),
    destName: 'ffmpeg.exe',
    executable: false,
    // `unzip` on Linux (cross-compile dev / ubuntu CI); fall back to bsdtar's
    // zip support on the windows-latest runner, which has `tar` but not `unzip`.
    extract: (archivePath, outDir) => {
      try { execSync(`unzip -o -q "${archivePath}" -d "${outDir}"`, { stdio: 'inherit' }) }
      catch { execSync(`tar -xf "${archivePath}" -C "${outDir}"`, { stdio: 'inherit' }) }
    },
    needs: '`unzip` (apt-get install -y unzip) or `tar` (bsdtar, default on Windows)',
  },
}

// Resolve the requested targets from argv. Default: both.
function parseTargets(argv) {
  const arg = (argv[2] || 'both').toLowerCase()
  if (arg === 'both' || arg === 'all')        return ['linux', 'win']
  if (arg === 'linux')                        return ['linux']
  if (arg === 'win' || arg === 'windows')     return ['win']
  console.error(`Unknown target "${arg}". Use one of: both (default) | linux | win`)
  process.exit(2)
}

// Download a URL to a file, following GitHub's redirect to the asset CDN.
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('too many redirects'))
      https.get(u, { headers: { 'User-Agent': 'moments-ffmpeg-setup' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return get(res.headers.location, redirects + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`))
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let done = 0, lastPct = -1
        const file = fs.createWriteStream(destPath)
        res.on('data', (chunk) => {
          done += chunk.length
          if (total) {
            const pct = Math.floor((done / total) * 100)
            if (pct !== lastPct && pct % 5 === 0) { process.stdout.write(`\r  downloading… ${pct}%  `); lastPct = pct }
          }
        })
        res.pipe(file)
        file.on('finish', () => file.close(() => { process.stdout.write(`\r  downloaded ${(done / 1e6).toFixed(0)} MB        \n`); resolve() }))
        file.on('error', (err) => { fs.rm(destPath, { force: true }, () => reject(err)) })
      }).on('error', reject)
    }
    get(url)
  })
}

async function setup(plat) {
  const s = SOURCES[plat]
  console.log(`\n▶ ${plat}  ${s.url}`)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ffmpeg-${plat}-`))
  const archivePath = path.join(tmpDir, s.archive)
  try {
    await download(s.url, archivePath)
    console.log('  extracting…')
    try {
      s.extract(archivePath, tmpDir)
    } catch {
      throw new Error(`extraction failed — this step needs ${s.needs}`)
    }
    const innerPath = path.join(tmpDir, s.innerBin)
    if (!fs.existsSync(innerPath)) throw new Error(`binary not found after extract: ${s.innerBin}`)
    fs.mkdirSync(s.destDir, { recursive: true })
    const destPath = path.join(s.destDir, s.destName)
    fs.copyFileSync(innerPath, destPath)
    if (s.executable) fs.chmodSync(destPath, 0o755)
    console.log(`✓ ${plat} → ${destPath}`)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

;(async () => {
  const targets = parseTargets(process.argv)
  console.log(`FFmpeg setup — targets: ${targets.join(', ')}`)
  let failed = false
  for (const plat of targets) {
    try { await setup(plat) }
    catch (err) { console.error(`✗ ${plat} failed: ${err.message}`); failed = true }
  }
  console.log('')
  if (failed) {
    console.error('One or more targets failed. See messages above.')
    process.exit(1)
  }
  console.log('Done. These BtbN GPL builds include drawtext (text overlays) and NVENC/AMF/QSV.')
  console.log('Verify drawtext:  ./bin/linux/ffmpeg -hide_banner -filters | grep drawtext')
})()
