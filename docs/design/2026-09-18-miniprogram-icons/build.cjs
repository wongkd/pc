// Original SVG geometry; PNG export for native mini program image/tabBar support.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const dest = path.join(root, 'miniprogram/assets/ui');
const shapes = {
  today: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-12 5 2 2 5-4"/>',
  sales: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7m-7 4h4"/>',
  inventory: '<path d="m3 7 9-4 9 4v11l-9 4-9-4zM3 7l9 4 9-4M12 11v11M8 5l9 4"/>',
  more: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  scan: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 8v8m4-8v8m3-8v8m3-8v8"/>',
  build: '<rect x="4" y="3" width="12" height="18" rx="2"/><circle cx="10" cy="9" r="3"/><path d="M7 17h6m6-6v8m-4-4h8"/>',
  retail: '<path d="M4 8h16l-1 13H5zM8 8V6a4 4 0 0 1 8 0v2"/>',
  ledger: '<path d="M5 3h14v18H5zM3 7h4m-4 5h4m-4 5h4m3-10 2 3 2-3m-5 5h6m-6 3h6m-3-5v8"/>',
  repair: '<path d="M14 4a5 5 0 0 0-6 6L3 15a3 3 0 0 0 4 4l5-5a5 5 0 0 0 7-6l-3 3-3-3z"/>',
  recycle: '<path d="M5 9a7 7 0 0 1 12-3l2 2M19 3v5h-5M19 15A7 7 0 0 1 7 18l-2-2M5 21v-5h5"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><rect x="7" y="4" width="3" height="4" rx="1"/><rect x="14" y="10" width="3" height="4" rx="1"/><rect x="8" y="16" width="3" height="4" rx="1"/>',
  cat: '<path d="M4 10V4h4v3h8V4h4v14h-3v3H7v-3H4zM8 12v2m8-2v2m-5 3h2"/>',
};
const labels = ['今天','开单','库存','更多','新建','搜索','扫码','装机报价','零售','账本','维修','回收置换','设置','品牌猫'];
async function main() {
  fs.mkdirSync(dest, {recursive:true});
  fs.mkdirSync(path.join(__dirname,'svg'), {recursive:true});
  const browser = await puppeteer.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try {
    const page = await browser.newPage();
    for (const [name, geometry] of Object.entries(shapes)) {
      for (const [variant,color] of Object.entries({default:'#334B42', muted:'#687365', white:'#FFFEF9'})) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${geometry}</svg>`;
        fs.writeFileSync(path.join(__dirname,'svg',`${name}-${variant}.svg`),svg);
        const data = await page.evaluate(async svg => {
          const img = new Image(); img.src = 'data:image/svg+xml;base64,'+btoa(svg); await img.decode();
          const c=document.createElement('canvas'); c.width=c.height=81; c.getContext('2d').drawImage(img,0,0,81,81); return c.toDataURL().split(',')[1];
        },svg);
        fs.writeFileSync(path.join(dest,`${name}-${variant}.png`),Buffer.from(data,'base64'));
      }
    }
    const cards = Object.keys(shapes).map((n,i)=>`<article><img src="../../../miniprogram/assets/ui/${n}-default.png" alt=""><span>${labels[i]}</span><small>${n}</small></article>`).join('');
    fs.writeFileSync(path.join(__dirname,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>装一下机 · 小程序图形资源</title><style>*{box-sizing:border-box}body{margin:0;background:#f8f6ef;color:#334b42;font:16px/1.6 system-ui}main{max-width:960px;margin:auto;padding:32px 20px}h1{font:32px Georgia,serif}p{color:#687365}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:12px}article{display:flex;align-items:center;flex-direction:column;background:#fffef9;border:1px solid #d9ddd0;padding:24px 12px;border-radius:8px}article img{width:28px;height:28px;margin-bottom:12px}small{color:#687365}.brand{display:flex;align-items:center;gap:16px}.avatar{width:64px;height:64px;border-radius:50%}.mascot{display:block;width:200px;height:200px;object-fit:contain;margin:20px auto}.tabs{display:flex;justify-content:space-around;background:#fffef9;padding:16px;margin-top:24px;border:1px solid #d9ddd0}.tabs img{width:27px;height:27px;display:block;margin:auto}.tabs span{font-size:12px}button{display:inline-flex;align-items:center;gap:8px;min-height:44px;background:#334b42;color:#fffef9;border:0;border-radius:4px;padding:0 20px;font:inherit}button img{width:20px;height:20px}button:focus-visible{outline:3px solid #68cfe6;outline-offset:3px}button:active{opacity:.8}</style><main><div class="brand"><img class="avatar" src="../../../miniprogram/assets/ui/brand-avatar.jpg" alt="用户提供的装一下机头像"><div><small>装一下机 / 图形资源 01</small><h1>熟悉的双猫，更清楚的入口。</h1></div></div><p>奶油白 × 森林绿 · 统一线宽 · 品牌猫与冰蓝点缀<br>资源评审页，非微信模拟器；演示按钮不提交业务。</p><h2>按钮与业务入口</h2><div class="grid">${cards}</div><h2>按钮示例</h2><button onclick="document.getElementById('feedback').textContent='按钮图标预览，未创建单据。'"><img src="../../../miniprogram/assets/ui/plus-white.png" alt="">开单</button><p id="feedback" aria-live="polite">点击查看按压反馈</p><div class="tabs">${['today','sales','inventory','more'].map((n,i)=>`<div><img src="../../../miniprogram/assets/ui/${n}-${i?'muted':'default'}.png" alt=""><span>${labels[i]}</span></div>`).join('')}</div><h2>品牌空状态</h2><img class="mascot" src="../../../miniprogram/assets/ui/empty-cats.png" alt="双猫与配件盒插画"><p style="text-align:center">没有找到匹配的事项<br><small>试试调整关键词或筛选条件</small></p></main></html>`);
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
