const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=__dirname;
http.createServer((q,r)=>{if(q.url==='/favicon.ico'){r.writeHead(204);return r.end()}const p=path.join(root,q.url==='/'?'index.html':q.url);fs.readFile(p,(e,d)=>{if(e){r.writeHead(404);return r.end('Not found')}r.end(d)})}).listen(8831,'127.0.0.1',()=>console.log('http://127.0.0.1:8831/'));
