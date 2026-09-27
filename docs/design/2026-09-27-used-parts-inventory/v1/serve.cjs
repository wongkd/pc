// 本地静态预览，只监听 127.0.0.1。没有接口代理，不写任何数据。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const files = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/styles.css': 'styles.css',
  '/data.js': 'data.js',
  '/app.js': 'app.js',
};
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const port = Number(process.env.USED_PARTS_PREVIEW_PORT || 8846);

http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { res.writeHead(400).end(); return; }
  const name = files[pathname];
  if (!name) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, {
    'Content-Type': mime[path.extname(name)],
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
  });
  fs.createReadStream(path.join(__dirname, name)).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Used-parts inventory prototype: http://127.0.0.1:${port}/`);
});
