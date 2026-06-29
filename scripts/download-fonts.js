/**
 * Downloads the bundled CJK preset fonts into public/ffmpeg/fonts/.
 *
 *   node scripts/download-fonts.js
 *
 * These must match the filenames registered in PRESET_FONTS (src/hooks/useFFmpeg.js):
 *
 *   NotoSansJP-Regular.otf   Noto Sans Japanese              (scripted below)
 *   NotoSansTC-Regular.otf   Noto Sans Traditional Chinese   (scripted below)
 *   NotoSansSC-Regular.otf   Noto Sans Simplified Chinese    (scripted below)
 *   NotoSansKR-Regular.otf   Noto Sans Korean                (scripted below)
 *   GenSekiGothicTW-Regular.otf   源石黑體 GenSekiGothic     (MANUAL — see below)
 *   TaipeiSansTCBeta-Regular.ttf  台北黑體 Taipei Sans        (MANUAL — see below)
 *
 * Manual fonts (their hosts don't allow scripted download):
 *   - 源石黑體 GenSekiGothicTW : https://font.emtech.cc/fonts/GenSekiGothicTW
 *       Save the Regular weight as  public/ffmpeg/fonts/GenSekiGothicTW-Regular.otf
 *   - 台北黑體 Taipei Sans      : https://sites.google.com/view/jtfoundry/zh-tw/downloads
 *       Save "Taipei Sans TC Beta Regular" as
 *       public/ffmpeg/fonts/TaipeiSansTCBeta-Regular.ttf
 *
 * The Noto URLs point at the notofonts/noto-cjk SubsetOTF tree. If a path 404s
 * (repo layout changed), grab the Regular OTF from https://fonts.google.com and
 * save it under the matching filename above.
 */
const fs    = require('fs')
const path  = require('path')
const https = require('https')

const DEST = path.join(__dirname, '..', 'public', 'ffmpeg', 'fonts')
const BASE = 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF'
const NOTO = [
  { file: 'NotoSansJP-Regular.otf', url: `${BASE}/JP/NotoSansJP-Regular.otf` },
  { file: 'NotoSansTC-Regular.otf', url: `${BASE}/TC/NotoSansTC-Regular.otf` },
  { file: 'NotoSansSC-Regular.otf', url: `${BASE}/SC/NotoSansSC-Regular.otf` },
  { file: 'NotoSansKR-Regular.otf', url: `${BASE}/KR/NotoSansKR-Regular.otf` },
]

function download(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    https.get(url, { headers: { 'User-Agent': 'moments-font-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(download(res.headers.location, destPath, redirects + 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const file = fs.createWriteStream(destPath)
      let done = 0
      res.on('data', c => { done += c.length })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve(done)))
      file.on('error', err => { fs.rm(destPath, { force: true }, () => reject(err)) })
    }).on('error', reject)
  })
}

;(async () => {
  fs.mkdirSync(DEST, { recursive: true })
  let failed = false
  for (const { file, url } of NOTO) {
    const dest = path.join(DEST, file)
    if (fs.existsSync(dest)) { console.log(`• ${file} already present — skipping`); continue }
    process.stdout.write(`▶ ${file} … `)
    try { const n = await download(url, dest); console.log(`${(n / 1e6).toFixed(1)} MB`) }
    catch (e) { console.error(`FAILED (${e.message}) — get it from https://fonts.google.com`); failed = true }
  }
  console.log('\nManual fonts (download from the source, save into public/ffmpeg/fonts/):')
  console.log('  • GenSekiGothicTW-Regular.otf  ← https://font.emtech.cc/fonts/GenSekiGothicTW')
  console.log('  • TaipeiSansTCBeta-Regular.ttf ← https://sites.google.com/view/jtfoundry/zh-tw/downloads')
  if (failed) process.exitCode = 1
})()
