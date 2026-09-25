const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const roadmap=require('./roadmap.cjs');
const ROOT=path.resolve(__dirname,'../../..'),PORT=43129;
function safe(root,p){if(typeof p!=='string'||! /^(docs|frontend\/src|backend\/src|backend\/scripts|backend\/tests|backend\/migrations|contracts\/v1|miniprogram)\//.test(p)||! /\.(md|json|ts|tsx|css|mjs|cjs|sql)$/.test(p))return null;const target=path.resolve(root,p);if(!target.startsWith(root+path.sep))return null;try{if(!fs.realpathSync(target).startsWith(fs.realpathSync(root)+path.sep))return null;return target}catch{return null}}
function info(root,p){const target=safe(root,p);if(!target)return {path:p,exists:false};try{const s=fs.statSync(target);return {path:p,exists:s.isFile(),modified:s.mtime.toISOString()}}catch{return {path:p,exists:false}}}
function scan(root=ROOT){
 const cards=roadmap.map(m=>{
  const reportPath=`docs/verification/progress/${m.id}.json`;let report=null,issue='';
  try{const p=safe(root,reportPath);if(p){const raw=JSON.parse(fs.readFileSync(p,'utf8'));if(raw.id!==m.id||!['working','blocked','review','verified'].includes(raw.status)||typeof raw.summary!=='string'||!Array.isArray(raw.evidence)||!Number.isFinite(Date.parse(raw.updatedAt)))throw Error('格式不完整');report={status:raw.status,summary:raw.summary.slice(0,1500),next:typeof raw.next==='string'?raw.next.slice(0,1500):'',updatedAt:raw.updatedAt,evidence:raw.evidence.filter(p=>typeof p==='string').slice(0,40).map(p=>info(root,p))};}}catch{issue='进度回执格式错误，需由开发对话修复';}
  const files=m.files.map(p=>info(root,p)),record=m.record?info(root,m.record):null;
  const verifiedEvidenceIncomplete=report?.status==='verified'&&(!report.evidence.some(e=>/^(backend|frontend|miniprogram)\//.test(e.path)&&e.exists)||!report.evidence.some(e=>/^docs\/verification\/.+\.md$/.test(e.path)&&e.exists));
  const stale=report&&(verifiedEvidenceIncomplete||report.evidence.length===0||Date.parse(report.updatedAt)>Date.now()+60000||[...report.evidence,...files.filter(f=>f.exists)].some(e=>!e.exists||Date.parse(e.modified)>Date.parse(report.updatedAt)));
  return {...m,files,record,report,issue,stale,label:issue?'回执需修复':report?(stale?'回执待复核':{working:'AI 回报进行中',blocked:'AI 回报受阻',review:'AI 回报待验收',verified:'AI 回报已验证'}[report.status]):record?.exists?'有历史记录':files.some(f=>f.exists)?'发现部分文件':'待开发核实'};
 });
 return {app:'pcquote-progress',scannedAt:new Date().toISOString(),root,cards,documents:['docs/STATUS.md','docs/NEXT-SESSION-PROMPT.md','docs/OPEN-ITEMS.md','docs/plans/2026-09-19-erp-first/04-delivery.md'].map(p=>info(root,p)),recommendation:cards.find(m=>m.issue||m.stale||m.report&&m.report.status!=='verified')?.id||cards.find(m=>!m.record?.exists&&!(m.report?.status==='verified'&&!m.stale))?.id||'E14'};
}
function createServer(root=ROOT){return http.createServer((req,res)=>{
 const allowedHost=`127.0.0.1:${PORT}`;if(req.headers.host!==allowedHost&&req.headers.host!==`localhost:${PORT}`){res.writeHead(403);return res.end('Forbidden host')}
 if(req.method!=='GET'){res.writeHead(405);return res.end()}
 const u=new URL(req.url,`http://${allowedHost}`);res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(u.pathname==='/api/progress'){res.setHeader('Content-Type','application/json; charset=utf-8');return res.end(JSON.stringify(scan(root)))}
 if(u.pathname==='/document'){const p=u.searchParams.get('path');const state=scan(root);const refs=new Set([...state.documents.map(d=>d.path),...state.cards.flatMap(c=>[c.record?.path,...c.files.map(f=>f.path),...(c.report?.evidence||[]).map(e=>e.path)])]);const file=refs.has(p)&&safe(root,p);if(!file){res.writeHead(404);return res.end('Not found')}res.setHeader('Content-Type','text/plain; charset=utf-8');return fs.createReadStream(file).pipe(res)}
 if(u.pathname==='/'||u.pathname==='/index.html'){res.setHeader('Content-Type','text/html; charset=utf-8');return fs.createReadStream(path.join(__dirname,'dashboard.html')).pipe(res)}
 res.writeHead(404);res.end('Not found');
 })}
if(require.main===module){const server=createServer();server.on('error',e=>{console.error(e.message);process.exitCode=1});server.listen(PORT,'127.0.0.1')}
module.exports={scan,createServer,safe};
