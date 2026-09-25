// 只读对比线上 HTML 引用与本地构建；不登录、不访问业务 API、不发布。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localFile = path.join(root, 'frontend/dist/index.html');
const url = new URL(process.argv[2] || 'https://erp.huangqidong.cn/');
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
  throw new Error('只接受不带凭据的 HTTP(S) 页面地址');
}
function assets(html) {
  return [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map(match => match[1]).sort();
}
if (!fs.existsSync(localFile)) throw new Error('请先构建 frontend，再对照线上版本');
const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
if (!response.ok) throw new Error(`页面读取失败 HTTP ${response.status}`);
const remote = assets(await response.text());
const local = assets(fs.readFileSync(localFile, 'utf8'));
const matches = local.length > 0 && remote.length > 0 && JSON.stringify(remote) === JSON.stringify(local);
console.log(JSON.stringify({ url: url.href, status: response.status, local, remote, matches,
  note: '仅比较页面引用的构建文件名；不代表登录、API、缓存内容或业务验收通过。' }, null, 2));
process.exitCode = matches ? 0 : 1;
