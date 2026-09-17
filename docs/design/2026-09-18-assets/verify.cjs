// Local component harness. No login, API proxy or production calls.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer');
async function main() {
  const root = path.resolve(__dirname, '../../..');
  const frontend = path.join(root, 'frontend');
  const harness = path.join(frontend, '.validation-assets');
  fs.mkdirSync(harness, { recursive: true });
  fs.writeFileSync(path.join(harness, 'index.html'), '<html><div id="root"></div><script type="module" src="./main.tsx"></script></html>');
  fs.writeFileSync(path.join(harness, 'main.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {WorkbenchTodayPage} from '../src/features/workbench/WorkbenchTodayPage';import {AppShell} from '../src/app/AppShell';import '../src/index.css';const profile={user:{id:1,email:'demo@example.com'},stores:[{id:1,name:'演示门店'}],currentStoreId:1,memberId:1,roles:['owner'],permissions:['*']};createRoot(document.getElementById('root')).render(<MemoryRouter><AppShell profile={profile} currentStore={{id:1,name:'演示门店',status:'active'}} onStoreSelect={()=>{}} onLogout={()=>{}} onChangePassword={()=>{}}><WorkbenchTodayPage/></AppShell></MemoryRouter>);`);
  const { createServer } = await import(pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')));
  const react = (await import(pathToFileURL(path.join(frontend, 'node_modules/@vitejs/plugin-react/dist/index.js')))).default;
  const server = await createServer({ configFile:false,root:frontend,plugins:[react()],server:{host:'127.0.0.1',port:8824,strictPort:true} });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true });
  const report = { scope:'Local web component and resource gallery; not WeChat runtime acceptance',checks:[],errors:[] };
  try {
    const page = await browser.newPage();
    page.on('pageerror', e=>report.errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request',req=>/^(http:\/\/127\.0\.0\.1:8824\/|file:|data:)/.test(req.url())?req.continue():req.abort());
    const check = (value,label)=>{assert.ok(value,label);report.checks.push(label)};
    for(const width of [1366,1440,1920]) {
      await page.setViewport({width,height:900});
      await page.goto('http://127.0.0.1:8824/.validation-assets/index.html',{waitUntil:'networkidle0'});
      await page.waitForSelector('.wb-device-photo img');
      await page.evaluate(async()=>Promise.all([...document.images].map(img=>img.decode())));
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`desktop ${width}: no horizontal overflow`);
    }
    await page.setViewport({width:1440,height:1000});
    await page.screenshot({path:path.join(__dirname,'workbench.png')});
    await page.evaluate(()=>[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent==='设备看板').click());
    await page.evaluate(async()=>Promise.all([...document.images].map(img=>img.decode())));
    check(await page.$$eval('.wb-board img',imgs=>imgs.length===7&&imgs.every(i=>i.naturalWidth>0)),'all 7 demo board images load locally');
    check(await page.$$eval('.wb-device-photo figcaption',els=>els.every(e=>e.textContent==='AI 示意 · 非实拍')),'generated images explicitly labeled');
    await page.screenshot({path:path.join(__dirname,'board.png')});
    await page.evaluate(()=>document.querySelector('.wb-detail img').dispatchEvent(new Event('error')));
    check(await page.$('.wb-detail .wb-photo-placeholder'),'image failure fallback');
    await page.evaluate(()=>[...document.querySelectorAll('.wb-board-card')].find(x=>x.textContent.includes('DEMO-SO-002')).click());
    check(await page.$('.wb-detail img'),'switch after image failure recovers');
    await page.type('input[placeholder="搜索单号 / 客户 / 设备"]','不存在');
    await page.waitForSelector('.wb-empty .wb-state-graphic');
    check(await page.$('.wb-empty .wb-state-graphic'),'empty-state graphic');
    check(!await page.$('article.wb-detail'),'empty search clears selected detail');
    await page.screenshot({path:path.join(__dirname,'empty.png')});
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    check(await page.$eval('.wb-btn',e=>getComputedStyle(e).transitionDuration==='0s'),'reduced-motion disables press transition');
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
    await page.goto(pathToFileURL(path.join(__dirname,'index.html')).href,{waitUntil:'load'});
    for(const width of [1440,320,375,390,430]) {
      await page.setViewport({width,height:900});
      await page.evaluate(async()=>Promise.all([...document.images].map(img=>img.decode())));
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`resource gallery ${width}: no horizontal overflow`);
      if(width===1440)await page.screenshot({path:path.join(__dirname,'gallery.png'),fullPage:true});
    }
    await page.focus('#try'); await page.keyboard.press('Enter');
    check(await page.$eval('#feedback',e=>e.textContent.includes('已响应')),'gallery keyboard activation');
    await page.tap('#try');
    check(await page.$eval('#feedback',e=>e.textContent.includes('已响应')),'gallery touch activation');
    check(report.errors.length===0,'no page errors');
  } finally {
    fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(report,null,2)+'\n');
    await browser.close(); await server.close();
  }
  console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
