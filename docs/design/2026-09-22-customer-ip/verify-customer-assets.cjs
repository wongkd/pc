const fs = require('node:fs')
const path = require('node:path')
const puppeteer = require('puppeteer')

const root = path.resolve(__dirname, '../../..')
const assetDir = path.join(root, 'miniprogram/assets/customer')
const expected = {
  'hero-home.jpg': [900, 675], 'banner-home.jpg': [900, 300], 'hero-shop.jpg': [900, 506],
  'product-black-tower.jpg': [600, 600], 'product-white-tower.jpg': [600, 600],
  'product-gpu.jpg': [600, 600], 'product-monitor.jpg': [600, 600],
  'post-cream-desk.jpg': [900, 506], 'post-dark-desk.jpg': [900, 506], 'post-cooling.jpg': [600, 450],
  'cat-home-pair.png': [420, 280], 'cat-silver-standing.png': [260, 390],
  'cat-gold-lounging.png': [420, 280], 'cat-archive-folder.png': [420, 320],
  'avatar-cat.png': [320, 320], 'brand-wordmark.png': [900, 300]
}
const iconBases = ['serviceBuild','serviceRecycle','serviceRepair','serviceLocation','tabHome','tabShop','tabCommunity','tabMine','menuQuote','menuOrder','menuAppointment','menuAfterSales','menuQr','menuSettings','chevron']
for (const base of iconBases) for (const variant of ['active', 'muted']) expected[`${base}-${variant}.png`] = [81, 81]

async function main() {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const page = await browser.newPage()
  const rows = []
  try {
    for (const [name, dimensions] of Object.entries(expected)) {
      const full = path.join(assetDir, name)
      if (!fs.existsSync(full)) throw new Error(`missing: ${name}`)
      const bytes = fs.statSync(full).size
      const source = `data:image/${name.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${fs.readFileSync(full).toString('base64')}`
      const actual = await page.evaluate(async source => {
        const img = new Image(); img.src = source; await img.decode()
        const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
        const corners = [[0,0],[canvas.width-1,0],[0,canvas.height-1],[canvas.width-1,canvas.height-1]]
        return { width: img.naturalWidth, height: img.naturalHeight, cornerAlpha: corners.map(([x,y]) => ctx.getImageData(x,y,1,1).data[3]) }
      }, source)
      if (actual.width !== dimensions[0] || actual.height !== dimensions[1]) throw new Error(`size mismatch: ${name}`)
      rows.push({ name, bytes, ...actual })
    }
  } finally { await browser.close() }
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0)
  if (totalBytes >= 1.5 * 1024 * 1024) throw new Error(`asset package exceeds internal 1.5 MiB buffer: ${totalBytes}`)
  const report = { date: '2026-09-22', status: 'passed', count: rows.length, totalBytes, internalBudgetBytes: Math.floor(1.5 * 1024 * 1024), rows }
  fs.writeFileSync(path.join(__dirname, 'customer-assets-verification.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ status: report.status, count: report.count, totalBytes: report.totalBytes }))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
