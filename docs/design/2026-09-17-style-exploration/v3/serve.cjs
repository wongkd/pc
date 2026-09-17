const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Serve only the design directory, including the existing v2 icons/photos registry.
const root = path.resolve(__dirname, '..');
const port = 8818;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.md': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8' };

http.createServer((request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400); return response.end('Bad request'); }
  if (pathname === '/') { response.writeHead(302, { Location: '/v3/index.html' }); return response.end(); }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/v3/index.html' : pathname));
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403); return response.end('Forbidden'); }
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(404); return response.end('Not found'); }
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`A+B preview: http://127.0.0.1:${port}/v3/index.html`));
