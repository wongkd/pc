// Resize and encode only. Preserve mascot alpha; never retouch the artwork.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
async function main() {
  const browser = await puppeteer.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try {
    const page=await browser.newPage();
    for (const [name,size,format] of [['empty-cats',320,'png'],['brand-avatar',160,'jpeg']]) {
      const src='data:image/png;base64,'+fs.readFileSync(path.join(__dirname,'originals',name+'.png')).toString('base64');
      const result=await page.evaluate(async ({src,size,format})=>{
        const img=new Image();img.src=src;await img.decode();
        const c=document.createElement('canvas');c.width=c.height=size;
        const ctx=c.getContext('2d');ctx.drawImage(img,0,0,size,size);
        const rgba=ctx.getImageData(0,0,size,size).data;
        return {data:c.toDataURL('image/'+format,.88).split(',')[1],transparent:rgba[3]===0};
      },{src,size,format});
      if(name==='empty-cats'&&!result.transparent)throw Error('Mascot alpha missing');
      fs.writeFileSync(path.resolve(__dirname,'../../../miniprogram/assets/ui',name+'.'+(format==='jpeg'?'jpg':'png')),Buffer.from(result.data,'base64'));
    }
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
