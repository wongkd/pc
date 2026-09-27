#!/usr/bin/env node
/** Compare the old customer-list query with the paged query on a private copy
 * of the existing 1,500-customer / 4,000-order synthetic pressure database.
 * The source database is never opened for writing. */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..', '..', '..')
const backendRoot = join(projectRoot, 'backend')
const sourceDb = join(backendRoot, '.node-host', 'pressure.sqlite')
const workDir = join(projectRoot, '.validation-customer-performance-20260927', 'customer-db-final2')
const dbPath = join(workDir, 'pressure-copy.sqlite')
const hostDbPath = '../.validation-customer-performance-20260927/customer-db-final2/pressure-copy.sqlite'
const dataDir = '../.validation-customer-performance-20260927/customer-db-final2/attachments'
const port = 8798
const outputPath = join(here, 'customer-query-benchmark.json')

if (!existsSync(sourceDb)) throw new Error(`缺少旧压测样本库：${sourceDb}`)
if (existsSync(dbPath)) throw new Error(`拒绝覆盖既有临时数据库：${dbPath}`)
mkdirSync(workDir, { recursive: true })
for (const suffix of ['', '-wal', '-shm']) {
  const source = `${sourceDb}${suffix}`
  if (existsSync(source)) copyFileSync(source, `${dbPath}${suffix}`)
}

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.exec('PRAGMA journal_mode=DELETE')
const counts = {
  customers: db.prepare("SELECT COUNT(*) AS n FROM customers WHERE store_id=1 AND status='active'").get().n,
  orders: db.prepare('SELECT COUNT(*) AS n FROM orders WHERE store_id=1').get().n,
}
if (counts.customers !== 1500 || counts.orders !== 4000) {
  db.close()
  throw new Error(`样本量不符：${JSON.stringify(counts)}`)
}

const oldSql = `SELECT c.id, c.name, c.phone, c.email, c.address, c.remark,
    NULLIF(c.source_channel, '') AS sourceChannel, c.status,
    c.created_at AS createdAt, c.updated_at AS updatedAt,
    CASE WHEN c.phone='' THEN 0 ELSE (SELECT COUNT(*) FROM orders o WHERE o.store_id=c.store_id AND o.customer_phone=c.phone) END AS orderCount,
    CASE WHEN c.phone='' THEN 0 ELSE (SELECT COALESCE(SUM(o.total_amount_cents),0) FROM orders o WHERE o.store_id=c.store_id AND o.customer_phone=c.phone) END AS totalCents,
    CASE WHEN c.phone='' THEN 0 ELSE (SELECT COALESCE(SUM(o.received_amount_cents),0) FROM orders o WHERE o.store_id=c.store_id AND o.customer_phone=c.phone) END AS receivedCents
  FROM customers c WHERE c.store_id=? AND c.status='active' AND (?='' OR c.name LIKE ? OR c.phone LIKE ?)
  ORDER BY c.updated_at DESC, c.id DESC`
const pageSql = `WITH customer_page AS (
    SELECT c.id, c.store_id, c.name, c.phone, c.email, c.address, c.remark,
      NULLIF(c.source_channel, '') AS sourceChannel, c.status,
      c.created_at AS createdAt, c.updated_at AS updatedAt
    FROM customers c
    WHERE c.store_id=? AND c.status='active'
      AND (?='' OR c.name LIKE ? OR c.phone LIKE ?)
      AND (? IS NULL OR c.updated_at < ? OR (c.updated_at=? AND c.id < ?))
    ORDER BY c.updated_at DESC, c.id DESC LIMIT ?
  )
  SELECT c.id, c.name, c.phone, c.email, c.address, c.remark, c.sourceChannel, c.status,
    c.createdAt, c.updatedAt,
    CASE WHEN c.phone='' THEN 0 ELSE COUNT(o.id) END AS orderCount,
    COALESCE(SUM(o.total_amount_cents),0) AS totalCents,
    COALESCE(SUM(o.received_amount_cents),0) AS receivedCents
  FROM customer_page c
  LEFT JOIN orders o ON c.phone<>'' AND o.store_id=c.store_id AND o.customer_phone=c.phone
  GROUP BY c.id ORDER BY c.updatedAt DESC, c.id DESC`
const oldQuery = db.prepare(oldSql)
const oldParams = [1, '', '%%', '%%']
const pageParams = [1, '', '%%', '%%', null, null, null, null, 51]
const oldResponseBytes = (rows) => Buffer.byteLength(JSON.stringify({ items: rows }))
oldQuery.all(...oldParams)
const oldMs = []
let oldRows
for (let i = 0; i < 5; i += 1) {
  const started = performance.now()
  oldRows = oldQuery.all(...oldParams)
  oldMs.push(performance.now() - started)
}

db.exec(`CREATE INDEX idx_customers_store_status_updated
  ON customers(store_id, status, updated_at DESC, id DESC)`)
db.exec(`CREATE INDEX idx_orders_store_customer_totals
  ON orders(store_id, customer_phone, total_amount_cents, received_amount_cents)`)
const pageQuery = db.prepare(pageSql)
pageQuery.all(...pageParams)
const pageMs = []
let pageRows
for (let i = 0; i < 5; i += 1) {
  const started = performance.now()
  pageRows = pageQuery.all(...pageParams)
  pageMs.push(performance.now() - started)
}
const explain = db.prepare(`EXPLAIN QUERY PLAN ${pageSql}`).all(...pageParams).map((row) => row.detail)
db.close()

const child = spawn(process.execPath, [
  'scripts/node-host.mjs', '--port', String(port), '--db', hostDbPath, '--data-dir', dataDir,
], { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'] })
let hostLog = ''
child.stdout.on('data', (chunk) => { hostLog += chunk })
child.stderr.on('data', (chunk) => { hostLog += chunk })
const base = `http://127.0.0.1:${port}`
let ready = false
try {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      await (await fetch(`${base}/__host/stats`)).json()
      ready = true
      break
    } catch {
      await new Promise((done) => setTimeout(done, 250))
    }
  }
  if (!ready) throw new Error(`Node 宿主未启动：${hostLog}`)
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@local.test', password: 'local-preview-pass' }),
  })
  const loginBody = await login.json()
  if (!loginBody.token) throw new Error(`本地测试账号登录失败：${JSON.stringify(loginBody)}`)
  const samples = []
  for (let i = 0; i < 6; i += 1) {
    const started = performance.now()
    const response = await fetch(`${base}/api/customers?limit=50`, {
      headers: { Authorization: `Bearer ${loginBody.token}` },
    })
    const bodyText = await response.text()
    const body = JSON.parse(bodyText)
    samples.push({ ms: performance.now() - started, status: response.status, bytes: Buffer.byteLength(bodyText), items: body.items?.length, hasMore: Boolean(body.nextCursor) })
  }
  const report = {
    generatedAt: new Date().toISOString(),
    environment: 'Windows node:sqlite; private copy of synthetic pressure DB; same Worker source via node-host; old query sampled before either new customer-list index',
    data: counts,
    sqlSamples: 5,
    oldFullList: { medianMs: median(oldMs), rows: oldRows.length, responseBytes: oldResponseBytes(oldRows), samplesMs: oldMs.map(round) },
    indexedPage: {
      medianMs: median(pageMs),
      rowsFetchedIncludingLookahead: pageRows.length,
      visibleRows: Math.min(50, pageRows.length),
      responseBytes: Buffer.byteLength(JSON.stringify({ items: pageRows.slice(0, 50), nextCursor: `${pageRows[49].updatedAt}|${pageRows[49].id}` })),
      samplesMs: pageMs.map(round),
    },
    nodeHostEndpoint: { samples, medianMs: median(samples.map((sample) => sample.ms)), allStatus200: samples.every((sample) => sample.status === 200 && sample.items === 50) },
    explainQueryPlan: explain,
    caveat: '合成旧客户/订单样本上的本机查询证据，不代表 Linux 目标机、共享带宽或生产容量。',
  }
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
} finally {
  child.kill('SIGTERM')
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return round(sorted[Math.floor(sorted.length / 2)])
}
function round(value) { return Number(value.toFixed(2)) }
