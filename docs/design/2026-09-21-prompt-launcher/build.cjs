const fs=require('node:fs'),path=require('node:path');
const at=name=>path.join(__dirname,name);
// 首次从上版已交付 HTML 恢复提示词，后续以 prompts.json 为源；无需桌面原 TXT。
if(!fs.existsSync(at('prompts.json'))){const html=fs.readFileSync(at('index.html'),'utf8');const match=html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);if(!match)throw Error('找不到上版提示词');fs.writeFileSync(at('prompts.json'),JSON.stringify(JSON.parse(match[1]),null,2));}
const data=JSON.stringify(JSON.parse(fs.readFileSync(at('prompts.json'),'utf8'))).replace(/<\//g,'<\\/');
let legacy=fs.readFileSync(at('template.html'),'utf8').replace('__DATA__',data);
legacy=legacy.replace('<main>','<main><div class="note"><b>已升级：自动进度与完整开发蓝图</b><br>双击桌面「PC Quote 开发进度台」即可启动。启动后可 <a href="http://127.0.0.1:43129">打开实时进度台</a>。下方保留旧版手动卡片。</div>');
fs.writeFileSync(at('index.html'),legacy);
fs.writeFileSync(path.join(process.env.USERPROFILE,'Desktop','PC-Quote-一键复制提示词.html'),legacy);
fs.writeFileSync(at('dashboard.html'),fs.readFileSync(at('dashboard-template.html'),'utf8').replace('__DATA__',data));
console.log('Built dashboard and legacy entry.');
