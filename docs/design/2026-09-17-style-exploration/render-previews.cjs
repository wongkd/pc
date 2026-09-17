const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 const puppeteer=await import('puppeteer');
 const browser=await puppeteer.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--no-first-run']});
 try{
  const page=await browser.newPage();
  await page.setViewport({width:1600,height:1030,deviceScaleFactor:1.5});
  for(const style of ['apple','oce','muji']){
   await page.goto(pathToFileURL(path.join(__dirname,'rendered-preview.html')).href+'?style='+style,{waitUntil:'networkidle2',timeout:60000});
   await page.evaluate(()=>document.fonts.ready);
   const images=await page.evaluate(()=>Array.from(document.images).map(i=>({loaded:i.complete&&i.naturalWidth>0,src:i.src})));
   if(images.some(i=>!i.loaded))throw new Error('Product photo failed to load: '+JSON.stringify(images));
   await page.screenshot({path:path.join(__dirname,style+'-rendered-desktop-mobile.png'),fullPage:true});
   console.log(style+': screenshot saved; '+images.length+' photos loaded');
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
