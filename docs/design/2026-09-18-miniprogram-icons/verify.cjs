const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../../..');
async function main(){
  const results=[];
  const browser=await puppeteer.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage();
    for(const width of [320,375,390,430,1440]){
      await page.setViewport({width,height:900,hasTouch:width<500});
      await page.goto(pathToFileURL(path.join(__dirname,'index.html')).href);
      await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
      const ok=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&[...document.images].every(i=>i.naturalWidth>0));
      if(!ok)throw Error('Image/overflow failure '+width);
      await page.click('button');
      if(!await page.$eval('#feedback',e=>e.textContent.includes('未创建')))throw Error('Feedback failure');
      await page.screenshot({path:path.join(__dirname,`preview-${width}.png`),fullPage:true});
      results.push({width,images:true,noHorizontalOverflow:true,buttonFeedback:true});
    }
    await page.keyboard.press('Tab');
    await page.focus('button');await page.keyboard.press('Enter');
    results.push({keyboard:await page.$eval('#feedback',e=>e.textContent.includes('未创建'))});
    const config=JSON.parse(fs.readFileSync(path.join(root,'miniprogram/app.json'),'utf8'));
    for(const tab of config.tabBar.list)for(const key of ['iconPath','selectedIconPath']){
      const file=path.join(root,'miniprogram',tab[key]);const b=fs.readFileSync(file);
      if(b.readUInt32BE(16)!==81||b.readUInt32BE(20)!==81||b.length>40960)throw Error('Tab icon invalid');
    }
    const assets=fs.readdirSync(path.join(root,'miniprogram/assets/ui'));
    const totalBytes=assets.reduce((sum,f)=>sum+fs.statSync(path.join(root,'miniprogram/assets/ui',f)).size,0);
    fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify({date:'2026-09-18',environment:'Windows / headless Edge; gallery only, not WeChat',results,tabIcons:8,assetCount:assets.length,totalBytes},null,2));
    console.log(JSON.stringify({results,assetCount:assets.length,totalBytes}));
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
