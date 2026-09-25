import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Script} from 'node:vm';
import {tasks} from './task-data.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));
const errors=[],ids=new Set(tasks.map(t=>t.id));
if(ids.size!==tasks.length)errors.push('重复任务编号');
for(let i=0;i<tasks.length;i++){
 const t=tasks[i];
 if(t.id!==`MP${String(i).padStart(2,'0')}`)errors.push('编号不连续 '+t.id);
 for(const d of t.deps)if(!ids.has(d)||d>=t.id)errors.push(`${t.id} 前置无效/非先行 ${d}`);
 for(const k of ['title','phase','gate','level'])if(!t[k])errors.push(`${t.id} 缺 ${k}`);
 for(const k of ['files','steps','accept'])if(!t[k]?.length)errors.push(`${t.id} 缺 ${k}`);
}
function walk(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);}
let links=0;
for(const f of walk(dir).filter(f=>f.endsWith('.md'))){
 let fenced=false;
 for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/)){
  if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;continue;}if(fenced)continue;
  for(const m of line.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)){
   const target=m[1];if(/^(?:[a-z]+:|#|\/)/i.test(target))continue;
   links++;if(!fs.existsSync(path.resolve(path.dirname(f),decodeURIComponent(target.split(/[?#]/)[0]))))errors.push(`断链 ${path.relative(dir,f)} ${target}`);
  }
 }
}
try{execFileSync(process.execPath,[path.join(dir,'build.mjs'),'--check'],{stdio:'pipe'});}catch(e){errors.push(String(e.stdout||e.message));}
// 只读取 HTML 和解析脚本语法，不启动浏览器、不执行界面脚本或剪贴板操作。
let htmlLinks=0;
try{
 const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
 const embedded=JSON.parse(html.match(/<script id="task-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
 if(embedded.length!==tasks.length)errors.push('HTML 任务数不一致');
 for(const t of embedded){
  if(!ids.has(t.id))errors.push('HTML 未知编号 '+t.id);
  else if(t.prompt!==fs.readFileSync(path.join(dir,'tasks',`${t.id}.md`),'utf8'))errors.push('HTML/Markdown 提示词不一致 '+t.id);
 }
 for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(m[1]);
 for(const m of html.matchAll(/(?:src|href)="([^"<>]+)"/g)){
  if(/^(?:[a-z]+:|#)/i.test(m[1]))continue;
  htmlLinks++;if(!fs.existsSync(path.resolve(dir,m[1])))errors.push('HTML 断链 '+m[1]);
 }
}catch(e){errors.push('HTML 静态检查：'+e.message);}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log(`通过：${tasks.length} 张卡，编号/前置无环/必需字段/生成同步；${links} 个本包文档链接；HTML ${htmlLinks} 个资源链接、全部提示词一致、脚本语法通过。未执行浏览器 UI。`);
