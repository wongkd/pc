const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {scan,safe}=require('./server.cjs');
const puppeteer=require('puppeteer');
(async()=>{
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pcquote-progress-test-'));
const put=(p,s)=>{const t=path.join(tmp,p);fs.mkdirSync(path.dirname(t),{recursive:true});fs.writeFileSync(t,s)};
try{
 put('docs/verification/progress/E08.json','{');assert.equal(scan(tmp).cards.find(c=>c.id==='E08').label,'回执需修复');
 put('backend/src/domains/fulfillment.ts','// test fixture');
 put('docs/verification/E08/README.md','test fixture verification');
 const recordPast=new Date(Date.now()-1000);fs.utimesSync(path.join(tmp,'docs/verification/E08/README.md'),recordPast,recordPast);
 const past=new Date(Date.now()-1000);fs.utimesSync(path.join(tmp,'backend/src/domains/fulfillment.ts'),past,past);
 put('docs/verification/progress/E08.json',JSON.stringify({id:'E08',status:'verified',summary:'test fixture',next:'',updatedAt:new Date().toISOString(),evidence:['backend/src/domains/fulfillment.ts']}));
 assert.equal(scan(tmp).cards.find(c=>c.id==='E08').label,'回执待复核');
 put('docs/verification/progress/E08.json',JSON.stringify({id:'E08',status:'verified',summary:'test fixture',next:'',updatedAt:new Date().toISOString(),evidence:['backend/src/domains/fulfillment.ts','docs/verification/E08/README.md']}));
 assert.equal(scan(tmp).cards.find(c=>c.id==='E08').label,'AI 回报已验证');
 const future=new Date(Date.now()+2000);fs.utimesSync(path.join(tmp,'backend/src/domains/fulfillment.ts'),future,future);
 assert.equal(scan(tmp).cards.find(c=>c.id==='E08').label,'回执待复核');assert.equal(safe(tmp,'docs/../../../outside.md'),null);
 console.log('PASS 回执解析、源码变化使回执失效、目录越界拒绝');
}finally{fs.rmSync(tmp,{recursive:true,force:true})}
const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
try{
const page=await browser.newPage();let errors=[];page.on('pageerror',e=>errors.push(e.message));const origin='http://127.0.0.1:43129';await browser.defaultBrowserContext().overridePermissions(origin,['clipboard-read','clipboard-sanitized-write']);
await page.setViewport({width:1366,height:900});await page.goto(origin);await page.waitForFunction(()=>document.querySelector('#copyNext').disabled===false);
assert.match(await page.$eval('#nextTitle',e=>e.textContent),/E08/);
await page.click('#copyNext');await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('已复制'));
const clipboard=await page.evaluate(()=>navigator.clipboard.readText());assert.match(clipboard,/B10/);assert.match(clipboard,/docs\/verification\/progress\/E08.json/);
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
await page.screenshot({path:path.join(__dirname,'dashboard-1366.png'),fullPage:true});
await page.click('[data-tab="roadmap"]');assert.equal(await page.$$eval('#allRows .row',r=>r.length),14);
await page.setViewport({width:1920,height:1080});await page.screenshot({path:path.join(__dirname,'blueprint-1920.png'),fullPage:true});
await page.click('#allRows [data-detail="E08"]');assert.equal(await page.$eval('#detail',d=>d.open),true);await page.keyboard.press('Escape');assert.equal(await page.$eval('#detail',d=>d.open),false);
await page.setRequestInterception(true);page.on('request',r=>{if(r.url().endsWith('/api/progress'))r.abort();else r.continue()});await page.click('#refresh');await page.waitForFunction(()=>!document.querySelector('#connection').classList.contains('hidden'));assert.equal(await page.$eval('#copyNext',b=>b.disabled),true);
assert.deepEqual(errors,[]);console.log('PASS 1366/1920 桌面、14 项蓝图、真实浏览器剪贴板、弹窗 Esc、断线提示与暂停推荐复制');
}finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
