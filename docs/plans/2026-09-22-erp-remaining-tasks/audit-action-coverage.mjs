#!/usr/bin/env node
/**
 * 契约动作 / 读接口的「实现覆盖率」审计脚本
 *
 * 用途：回答「契约里定义了、但后端没有实现的动作还有哪些」。
 * 产出：主动作、读接口、预留动作三张清单 + 未实现项汇总。
 *
 * 用法：node docs/plans/2026-09-22-erp-remaining-tasks/audit-action-coverage.mjs
 *
 * ⚠️ 已知假阴性来源（本轮实测踩过，改脚本时别退化）：
 *   1. 路由可能写成**正则常量**，例如
 *        const ORDER_CANCEL_PATH = /^\/api\/v2\/sales\/orders\/([^/]+)\/cancel$/
 *      纯字符串 includes 搜不到 ⇒ 必须先把 `\/` 还原成 `/`、把参数段统一成占位符。
 *      （B09 / B11 / B18 / B43 曾因此被误判为「无路由」。）
 *   2. readActions 的 path 字段可能把**多条路径用顿号写在一个字符串里**，例如
 *        "/sales/orders、/sales/orders/:id"
 *     必须按 `、` 或 `,` 拆开逐条判定。
 *      （R04 / R05 / R08 / R09 曾因此被误判。）
 *   3. readActions 用 `path` 字段，主动作用 `operations[].path`，两者字段名不同。
 *   4. 参数占位有三种写法：契约用 `:id`、新 v2 路由用 `([^/]+)`、旧 /api 路由用 `(\d+)`。
 *      只归一化其中一种，另一种就假阴性。（R13 曾因此被误判——它其实走旧 /api/customers/(\d+)。）
 *
 * 判定口径：把契约路径去掉参数段后，在 backend/src 全部 .ts/.mjs/.js 里查找同一段
 *          固定路径序列。命中即视为「有实现证据」。
 *          这是**启发式**证据，不等于「已验收」——真伪仍以测试与验证卡为准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SRC_DIR = path.join(ROOT, 'backend/src');
const ACTIONS = path.join(ROOT, 'contracts/v1/actions.json');

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|mjs|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/**
 * 规范化：还原正则里的 `\/`，把所有参数占位写法统一成 `<p>`
 * 今天已知的三种写法都要覆盖，否则会假阴性：
 *   `:id`（契约路径）／`([^/]+)`（新 v2 路由）／`(\d+)`（旧 /api 路由）
 */
function norm(s) {
  return s
    .replace(/\\\//g, '/')
    .replace(/\((?:\[\^\/\]\+|\\d\+|\[0-9\]\+)\)/g, '<p>')
    .replace(/:[A-Za-z_]+/g, '<p>');
}

const corpus = walk(SRC_DIR).map((f) => ({ f, t: norm(fs.readFileSync(f, 'utf8')) }));

function findOne(p) {
  const key = norm(String(p).replace(/^\//, '').replace(/:[A-Za-z]+/g, '<p>'));
  const hits = [];
  for (const { f, t } of corpus) if (t.includes(key)) hits.push(path.relative(ROOT, f));
  return hits;
}

function findMulti(raw) {
  return String(raw || '')
    .split(/[、,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => ({ p, h: findOne(p) }));
}

const a = JSON.parse(fs.readFileSync(ACTIONS, 'utf8'));
const rel = (f) => f.replace(/^backend[\\/]src[\\/]/, '');

console.log('=== 主动作（B 码） ===');
const missingActions = [];
for (const x of a.actions || []) {
  const ops = x.operations || [];
  let best = null;
  for (const o of ops) {
    const h = findOne(o.path);
    if (h.length && (!best || h.length < best.h.length)) best = { o, h };
  }
  const codeRef = corpus.some(({ t }) => new RegExp('\\b' + x.code + '\\b').test(t));
  if (!best) missingActions.push({ ...x, codeRef });
  console.log(
    (x.code || '').padEnd(5),
    (x.name || '').slice(0, 18).padEnd(20),
    (x.status || '').padEnd(7),
    (best ? 'OK ' + rel(best.h[0]) : codeRef ? '仅代码引用' : '** 未找到 **').padEnd(40),
    ops.map((o) => `${o.method} ${o.path}`).join(' | ').slice(0, 52)
  );
}

console.log('\n=== 读接口（R 码） ===');
const missingReads = [];
for (const x of a.readActions || []) {
  const res = findMulti(x.path);
  const bad = res.filter((r) => !r.h.length);
  if (bad.length) missingReads.push({ code: x.code, bad });
  console.log(
    (x.code || '').padEnd(5),
    (x.path || '').slice(0, 44).padEnd(46),
    bad.length ? '** 未见 ** ' + bad.map((b) => b.p).join(' , ') : 'OK ' + rel(res[0].h[0])
  );
}

console.log('\n=== 预留动作（reserved，未提升为正式动作） ===');
const reserved = (a.supplementaryActions || []).filter((x) => x.status !== 'frozen');
for (const x of a.supplementaryActions || []) {
  console.log((x.code || '').padEnd(5), (x.name || '').slice(0, 16).padEnd(18), x.status || '', 'owner=' + (x.owner || '-'));
}

console.log('\n=== 汇总：未实现 ===');
console.log(`主动作：${(a.actions || []).length - missingActions.length}/${(a.actions || []).length} 有实现证据`);
for (const m of missingActions) console.log('  -', m.code, m.name, m.codeRef ? '(代码里有引用，需人工看)' : '(无任何证据)');
console.log(`读接口：${(a.readActions || []).length - missingReads.length}/${(a.readActions || []).length} 有实现证据`);
for (const m of missingReads) console.log('  -', m.code, m.bad.map((b) => b.p).join(' , '));
console.log(`预留动作待提升：${reserved.length} 个 -> ${reserved.map((r) => r.code).join(', ')}`);

process.exitCode = 0;
