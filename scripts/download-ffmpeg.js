#!/usr/bin/env node
/**
 * scripts/download-ffmpeg.js
 *
 * Downloads pre-built static FFmpeg binaries for Windows and Linux
 * into the bin/ directory used by electron-builder's extraResources.
 *
 * Run once before building:
 *   node scripts/download-ffmpeg.js
 *
 * Binaries are sourced from the ffmpeg-static npm package, which bundles
 * static FFmpeg builds for each platform. These include:
 *   - libx264  (CPU encoder — always available)
 *   - h264_nvenc (NVIDIA GPU — requires NVIDIA drivers at runtime)
 *   - h264_amf  (AMD GPU — requires AMD drivers at runtime)
 *   - h264_qsv  (Intel iGPU — requires Intel drivers at runtime)
 *
 * NOTE: GPU encoders are compiled into the binary but require the
 * corresponding GPU drivers and hardware to be present at runtime.
 * The app detects availability automatically and falls back gracefully.
 *
 * ── ALTERNATIVE: Bring Your Own FFmpeg ───────────────────────────────────────
 * If you already have FFmpeg installed on your system, you can skip this script.
 * The app will pick up `ffmpeg` from PATH in development mode.
 *
 * For production builds, place FFmpeg binaries at:
 *   bin/linux/ffmpeg        (Linux x64, must be executable)
 *   bin/win/ffmpeg.exe      (Windows x64)
 *
 * Recommended builds with full GPU support:
 *   Linux:   https://github.com/BtbN/FFmpeg-Builds/releases
 *            → ffmpeg-master-latest-linux64-gpl-shared.tar.xz (includes NVENC/AMF/QSV)
 *   Windows: https://github.com/BtbN/FFmpeg-Builds/releases
 *            → ffmpeg-master-latest-win64-gpl-shared.zip (includes NVENC/AMF/QSV)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs')
const path = require('path')
const https = require('https')

const FFMPEG_VERSION = '7.1'   // adjust as needed

// BtbN static GPL builds (include NVENC, AMF, QSV support compiled in)
const SOURCES = {
  linux: {
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz`,
    binPath: 'ffmpeg-master-latest-linux64-gpl/bin/ffmpeg',
    destDir: path.join(__dirname, '..', 'bin', 'linux'),
    destName: 'ffmpeg',
  },
  win: {
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip`,
    binPath: 'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe',
    destDir: path.join(__dirname, '..', 'bin', 'win'),
    destName: 'ffmpeg.exe',
  },
}

// ── Simple approach: use ffmpeg-static npm package ────────────────────────────
// This is the easiest method. ffmpeg-static bundles pre-compiled binaries.
// Run: npm install --save-dev ffmpeg-static
// Then this script copies them to bin/.

async function copyFromNpmPackage() {
  let ffmpegStatic
  try {
    ffmpegStatic = require('ffmpeg-static')
  } catch {
    console.log('ffmpeg-static not installed. Installing...')
    const { execSync } = require('child_process')
    execSync('npm install --save-dev ffmpeg-static', { stdio: 'inherit' })
    ffmpegStatic = require('ffmpeg-static')
  }

  const platform = process.platform
  const srcPath  = ffmpegStatic

  if (!fs.existsSync(srcPath)) {
    console.error(`FFmpeg binary not found at: ${srcPath}`)
    process.exit(1)
  }

  const destInfo = platform === 'win32' ? SOURCES.win : SOURCES.linux
  fs.mkdirSync(destInfo.destDir, { recursive: true })
  const destPath = path.join(destInfo.destDir, destInfo.destName)

  fs.copyFileSync(srcPath, destPath)

  if (platform !== 'win32') {
    fs.chmodSync(destPath, 0o755)
  }

  console.log(`✓ FFmpeg copied to ${destPath}`)
  console.log(`  Source: ${srcPath}`)
  console.log('')
  console.log('NOTE: The ffmpeg-static binary uses libx264 (CPU) by default.')
  console.log('For GPU support (NVENC/AMF/QSV), use a GPL build from:')
  console.log('  https://github.com/BtbN/FFmpeg-Builds/releases')
  console.log('Place at: bin/linux/ffmpeg  or  bin/win/ffmpeg.exe')
}

copyFromNpmPackage().catch(err => {
  console.error('Failed to set up FFmpeg:', err.message)
  process.exit(1)
})
