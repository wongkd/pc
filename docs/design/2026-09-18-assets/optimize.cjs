// Only resize/encode generated originals; do not retouch device content.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
async function main() {
  const root = path.resolve(__dirname, '../../..');
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    for (const name of ['tower', 'gpu', 'laptop', 'monitor']) {
      const data = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'originals', name + '.png')).toString('base64');
      for (const [dir, size] of [['frontend/public/assets/workbench', 640], ['miniprogram/assets/workbench', 320]]) {
        const jpg = await page.evaluate(async ({ data, size }) => {
          const img = new Image(); img.src = data; await img.decode();
          const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
          canvas.getContext('2d').drawImage(img, 0, 0, size, size);
          return canvas.toDataURL('image/jpeg', .84).split(',')[1];
        }, { data, size });
        const dest = path.join(root, dir); fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, name + '.jpg'), Buffer.from(jpg, 'base64'));
      }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
