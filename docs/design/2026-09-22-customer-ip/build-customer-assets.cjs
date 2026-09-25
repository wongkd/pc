const fs = require('node:fs')
const path = require('node:path')
const puppeteer = require('puppeteer')

const root = path.resolve(__dirname, '../../..')
const assetDir = path.join(root, 'miniprogram/assets/customer')
const originalDir = path.join(__dirname, 'originals/customer-assets')
const svgDir = path.join(__dirname, 'svg')

const icons = {
  serviceBuild: '<path d="M14.7 5.3a5 5 0 0 0-6.4 6.4L3 17l4 4 5.3-5.3a5 5 0 0 0 6.4-6.4l-3.2 3.2-4-4z"/>',
  serviceRecycle: '<path d="M7 7a7 7 0 0 1 11 2l1 2M19 6v5h-5M17 17a7 7 0 0 1-11-2l-1-2M5 18v-5h5"/>',
  serviceRepair: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8 2v4m8-4v4M8 11h8m-8 4h5"/>',
  serviceLocation: '<path d="M12 22s7-6 7-13a7 7 0 1 0-14 0c0 7 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/>',
  tabHome: '<path d="m3 11 9-8 9 8v10h-6v-6H9v6H3z"/>',
  tabShop: '<path d="M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2"/>',
  tabCommunity: '<path d="M4 5h16v12H9l-5 4z"/><circle cx="9" cy="11" r=".5"/><circle cx="12" cy="11" r=".5"/><circle cx="15" cy="11" r=".5"/>',
  tabMine: '<circle cx="12" cy="7" r="4"/><path d="M4 22a8 8 0 0 1 16 0"/>',
  menuQuote: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h4"/>',
  menuOrder: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-11 4h6m-6 3h4"/>',
  menuAppointment: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-11 5 2 2 4-4"/>',
  menuAfterSales: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  menuQr: '<path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm11 0h2v2h-2zm3 0h2v6h-2zm-3 4h2v2h-2z"/>',
  menuSettings: '<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.8-.7-1.7.8-2-2.1-2.1-2 .8-1.7-.7-.8-2h-3l-.8 2-1.7.7-2-.8L.9 6l.8 2-.7 1.7-2 .8v3l2 .8.7 1.7-.8 2L3 20.1l2-.8 1.7.7.8 2h3l.8-2 1.7-.7 2 .8 2.1-2.1-.8-2 .7-1.7z" transform="translate(2) scale(.83)"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>'
}

const rasters = [
  ['hero-home.png', 'hero-home.jpg', 900, 675, 'image/jpeg', 0.84],
  ['banner-home.png', 'banner-home.jpg', 900, 300, 'image/jpeg', 0.84],
  ['hero-shop.png', 'hero-shop.jpg', 900, 506, 'image/jpeg', 0.84],
  ['product-black-tower.png', 'product-black-tower.jpg', 600, 600, 'image/jpeg', 0.84],
  ['product-white-tower.png', 'product-white-tower.jpg', 600, 600, 'image/jpeg', 0.84],
  ['product-gpu.png', 'product-gpu.jpg', 600, 600, 'image/jpeg', 0.84],
  ['product-monitor.png', 'product-monitor.jpg', 600, 600, 'image/jpeg', 0.84],
  ['post-cream-desk.png', 'post-cream-desk.jpg', 900, 506, 'image/jpeg', 0.84],
  ['post-dark-desk.png', 'post-dark-desk.jpg', 900, 506, 'image/jpeg', 0.84],
  ['post-cooling.png', 'post-cooling.jpg', 600, 450, 'image/jpeg', 0.84],
  ['cat-home-pair.png', 'cat-home-pair.png', 420, 280, 'image/png'],
  ['cat-silver-standing.png', 'cat-silver-standing.png', 260, 390, 'image/png'],
  ['cat-gold-lounging.png', 'cat-gold-lounging.png', 420, 280, 'image/png'],
  ['cat-archive-folder.png', 'cat-archive-folder.png', 420, 320, 'image/png'],
  ['avatar-cat.png', 'avatar-cat.png', 320, 320, 'image/png'],
  ['brand-wordmark.png', 'brand-wordmark.png', 900, 300, 'image/png']
]

function svg(name, geometry, color, filled) {
  const fill = filled ? color : 'none'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${fill}" stroke="${color}" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${geometry}</svg>`
}

async function main() {
  fs.mkdirSync(assetDir, { recursive: true })
  fs.mkdirSync(svgDir, { recursive: true })
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    for (const [name, geometry] of Object.entries(icons)) {
      for (const [variant, color] of Object.entries({ active: '#111111', muted: '#8C9094' })) {
        const source = svg(name, geometry, color, name.startsWith('tab') && variant === 'active')
        fs.writeFileSync(path.join(svgDir, `${name}-${variant}.svg`), source)
        const data = await page.evaluate(async (source) => {
          const img = new Image()
          img.src = `data:image/svg+xml;base64,${btoa(source)}`
          await img.decode()
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 81
          canvas.getContext('2d').drawImage(img, 0, 0, 81, 81)
          return canvas.toDataURL('image/png').split(',')[1]
        }, source)
        fs.writeFileSync(path.join(assetDir, `${name}-${variant}.png`), Buffer.from(data, 'base64'))
      }
    }

    for (const [input, output, width, height, mime, quality] of rasters) {
      const inputPath = path.join(originalDir, input)
      if (!fs.existsSync(inputPath)) throw new Error(`missing raster source: ${input}`)
      const src = `data:image/png;base64,${fs.readFileSync(inputPath).toString('base64')}`
      const data = await page.evaluate(async ({ src, width, height, mime, quality }) => {
        const img = new Image()
        img.src = src
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        if (mime === 'image/jpeg') {
          ctx.fillStyle = '#FFFFFF'
          ctx.fillRect(0, 0, width, height)
        }
        ctx.drawImage(img, 0, 0, width, height)
        return canvas.toDataURL(mime, quality).split(',')[1]
      }, { src, width, height, mime, quality })
      fs.writeFileSync(path.join(assetDir, output), Buffer.from(data, 'base64'))
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
