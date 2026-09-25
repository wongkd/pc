const puppeteer=require('puppeteer');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs');
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try{
 const page=await browser.newPage();let errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:1440,height:1000});await page.goto(pathToFileURL(path.join(__dirname,'index.html')).href);
 const assert=(ok,msg)=>{if(!ok)throw Error(msg);console.log('PASS '+msg)};
 assert(await page.$eval('#business button',b=>b.disabled),'业务卡前置锁定');
 assert(await page.$$eval('.card',a=>a.length)===9,'9 张卡完整');
 await page.evaluate(()=>{window.copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>{window.copied=t}},configurable:true})});
 await page.click('#base .primary');assert(await page.evaluate(()=>window.copied.includes('公共')&&window.copied.includes('底座阶段特别职责')),'复制包含公共要求和阶段例外');
 await page.select('#base select','done');assert(await page.$eval('#business button',b=>!b.disabled),'底座完成解锁业务');
 await page.reload();assert(await page.$eval('#base select',s=>s.value)==='done','刷新保留手动进度');
 await page.screenshot({path:path.join(__dirname,'desktop.png'),fullPage:true});
 await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw Error('blocked')}},configurable:true});document.execCommand=()=>false});
 await page.click('#business .primary');await page.waitForSelector('dialog[open]');assert(await page.$eval('#text',t=>t.value.includes('销售')&&t.selectionEnd===t.value.length),'复制失败显示并全选全文');
 await page.click('#close');
 await page.setViewport({width:320,height:850});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px 无横向溢出');await page.screenshot({path:path.join(__dirname,'mobile.png'),fullPage:true});
 assert(errors.length===0,'无页面脚本错误');
 const source=fs.readFileSync(path.join(__dirname,'index.html'),'utf8'),desktop=fs.readFileSync('C:/Users/wuerl/Desktop/PC-Quote-一键复制提示词.html','utf8');assert(source===desktop,'桌面交付与验证文件一致');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
