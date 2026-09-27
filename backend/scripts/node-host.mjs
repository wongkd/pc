/**
 * Node 宿主：把**真实的 Worker 入口**跑在 Node 进程里，用本地 SQLite 当 D1、
 * 本地磁盘当日志存储（R2）。用途是回答「换到国内轻量后内存够不够」。
 *
 * ── 为什么需要它 ──
 * 现在唯一的运行方式是 `dev:local`（miniflare 起 workerd + 内存 D1）。
 * workerd 是 Cloudflare 的运行时，**它的内存水位不代表 Linux 上 Node 的水位**，
 * 拿它测「2核2G 够不够」是问错了对象。所以要让同一份源码在 Node 上跑。
 *
 * ── 为什么不用 Docker ──
 * 本机（2026-09-27 实测）没有 Docker，且生产要走的形态是「Node + SQLite + 反代」，
 * 不是容器编排。用 node:http 直接起，测到的就是将来真跑的那一层。
 *
 * ── 与生产的差距（必须知道）──
 *   1. 无 TLS / 无反代：生产是 Nginx 终止 TLS 再转发；这里直连 HTTP。
 *      ⇒ 本夹具测不到 Nginx 的内存占用（约几十 MB），评估总内存时要单独加。
 *   2. 无静态资源：`wrangler.toml` 的 `[assets]` 由 Cloudflare 资源层处理，
 *      Worker 代码里根本没引用 `ASSETS`（实测 grep 无命中）。所以本宿主只服务 `/api/*`，
 *      其余路径会是 Worker 自己的 404 —— 这是**预期行为**，不是缺陷。
 *   3. 单进程单连接：测不到真并发写入一致性。SQLite 的并发模型与 D1 不同，
 *      本夹具的结论**不能**用来替并发正确性背书。
 *   4. Windows 工作集 ≠ Linux RSS。内存数字只能看量级，不能当精确值。
 *
 * 边界：只监听回环地址，不 deploy、不连远端、不读生产数据。
 *
 * 用法：
 *   node scripts/node-host.mjs                      # 内存库，起在 127.0.0.1:8790
 *   node scripts/node-host.mjs --db .node-host/db.sqlite --seed
 *   node scripts/node-host.mjs --fresh --port 8791  # 重建库后启动
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleModule } from '../tests/lib/build.mjs'
import { applyMigrations } from '../tests/lib/env.mjs'
import { login, seedOwner } from '../tests/lib/worker.mjs'
import { createLocalD1 } from './lib/d1-sqlite.mjs'
import { createLocalBucket } from './lib/local-bucket.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(here, '..')

// ────────────────────────────── 参数 ──────────────────────────────

function parseArgs(argv) {
  const args = { port: 8790, db: ':memory:', dataDir: join(backendRoot, '.node-host', 'attachments'), fresh: false, seed: false, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--port') args.port = Number(argv[++i])
    else if (token === '--db') args.db = argv[++i]
    else if (token === '--data-dir') args.dataDir = argv[++i]
    else if (token === '--fresh') args.fresh = true
    else if (token === '--seed') args.seed = true
    else if (token === '--verbose') args.verbose = true
    else throw new Error(`未知参数：${token}`)
  }
  return args
}

// ────────────────────────────── 绑定装配 ──────────────────────────────

function openDatabase(dbPath, fresh) {
  if (dbPath === ':memory:') return { db: createLocalD1(':memory:'), applied: true, existed: false }

  const absolute = resolve(backendRoot, dbPath)
  mkdirSync(dirname(absolute), { recursive: true })
  if (fresh) {
    // WAL 模式会额外留下 -wal / -shm，一起清掉才算真「重建」。
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${absolute}${suffix}`
      if (existsSync(path)) rmSync(path)
    }
  }
  const existed = existsSync(absolute)
  return { db: createLocalD1(absolute), applied: !existed, existed, path: absolute }
}

/** 与 wrangler.toml 的绑定对齐；密钥一律用「明确不是真密钥」的占位值。 */
function buildEnv({ db, bucket }) {
  return {
    DB: db,
    BUCKET: bucket,
    JWT_SECRET: 'node-host-secret-not-a-real-secret',
    DEEPSEEK_KEY: '',
    PDD_CLIENT_ID: '',
    PDD_CLIENT_SECRET: '',
    PDD_PID: '',
    INVENTORY_OPENING_MODE: 'preview',
    // 与生产同口径：强制走持久化存储分支，缺绑定就该失败而不是静默降级。
    REQUIRE_PERSISTENT_STORAGE: 'true',
  }
}

// ────────────────────────────── HTTP 桥接 ──────────────────────────────

/** IncomingMessage → Request。Node 的 headers 已小写化，可直接喂给 Headers。 */
async function toRequest(req, port) {
  const host = req.headers.host ?? `127.0.0.1:${port}`
  const url = `http://${host}${req.url}`
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }

  const method = req.method ?? 'GET'
  const withoutBody = method === 'GET' || method === 'HEAD'
  let body
  if (!withoutBody) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    body = Buffer.concat(chunks)
  }
  return new Request(url, { method, headers, body: withoutBody ? undefined : body })
}

/** Response → Node 响应。set-cookie 可能是多条，必须用 getSetCookie() 才不丢。 */
async function writeResponse(response, res) {
  const headers = {}
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') continue
    headers[key] = value
  }
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  if (cookies.length) headers['set-cookie'] = cookies

  // 直接缓冲：/api 响应最大是附件体（契约上限 20MB），压测时缓冲比流式更好统计。
  const buffer = Buffer.from(await response.arrayBuffer())
  res.writeHead(response.status, headers)
  res.end(buffer)
  return buffer.byteLength
}

// ────────────────────────────── 自测统计 ──────────────────────────────

/**
 * 宿主自报内存与请求计数。
 *
 * 为什么自己上报而不是外部采样：Windows 上 `wmic` 已不可用（2026-09-26 实测），
 * `tasklist /FO CSV` 的内存字段是 `"117,648 K"` 这种带千分位逗号的形态，按逗号切分会切错；
 * 而从 PowerShell 拿 stdout 又要落盘中转。`process.memoryUsage().rss` 就是本进程的
 * 常驻集大小，**测的是同一个进程**，比绕一圈外部工具更准也更省事。
 *
 * 峰值必须靠采样抓：请求峰值只持续几十毫秒，事后查只能拿到回落后的值。
 */
function createHostState() {
  const startedAt = Date.now()
  const state = {
    requests: 0,
    errors: 0,
    byStatus: {},
    peakRss: 0,
    samples: 0,
    lastRss: 0,
    sample() {
      const rss = process.memoryUsage().rss
      state.samples += 1
      state.lastRss = rss
      if (rss > state.peakRss) state.peakRss = rss
    },
    mark(status) {
      state.requests += 1
      const key = String(status)
      state.byStatus[key] = (state.byStatus[key] ?? 0) + 1
    },
    reset() {
      state.peakRss = 0
      state.samples = 0
      state.requests = 0
      state.errors = 0
      state.byStatus = {}
      state.startedAt = Date.now()
    },
    report(extra) {
      const memory = process.memoryUsage()
      return {
        uptimeSec: Number(((Date.now() - (state.startedAt ?? startedAt)) / 1000).toFixed(2)),
        requests: state.requests,
        errors: state.errors,
        byStatus: state.byStatus,
        // 单位统一给 MiB，避免读数时反复换算
        rssMiB: Number((memory.rss / 1048576).toFixed(1)),
        peakRssMiB: Number((state.peakRss / 1048576).toFixed(1)),
        heapUsedMiB: Number((memory.heapUsed / 1048576).toFixed(1)),
        heapTotalMiB: Number((memory.heapTotal / 1048576).toFixed(1)),
        externalMiB: Number((memory.external / 1048576).toFixed(1)),
        samples: state.samples,
        ...extra,
      }
    },
  }
  return state
}

/** `/__host/*` 控制面：只在本机夹具里有，不会进 Worker，也不会进生产。 */
function handleHostControl(req, res, state, extra) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const payload =
    url.pathname === '/__host/reset'
      ? (state.reset(), state.report(extra()))
      : state.report(extra())
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) })
  res.end(body)
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const workerModule = await bundleModule('src/index.ts', 'worker-node-entry')
  const worker = workerModule.default
  if (!worker || typeof worker.fetch !== 'function') {
    throw new Error('Worker 入口未导出 default.fetch —— 宿主与入口形态不匹配')
  }

  const { db, existed, path } = openDatabase(args.db, args.fresh)
  let migrations = 0
  if (!existed) {
    const applied = await applyMigrations(db)
    migrations = applied.length
  }

  const bucket = createLocalBucket(args.dataDir)
  const env = buildEnv({ db, bucket })

  if (args.seed) await seedOwner(db)

  // 峰值采样：请求高峰只持续几十毫秒，事后再查只能拿到回落值，必须后台持续采。
  const hostState = createHostState()
  const sampler = setInterval(() => hostState.sample(), 100)
  sampler.unref()

  const extraStats = () => ({
    coercions: db.coercions,
    attachments: bucket.usage(),
    dbFile: path ?? ':memory:',
  })

  const server = createServer((req, res) => {
    const started = performance.now()
    // 控制面先拦：`/__host/*` 不能落到 Worker（那边只会 404，读起来像是 bug）。
    if (req.url?.startsWith('/__host/')) return handleHostControl(req, res, hostState, extraStats)
    toRequest(req, args.port)
      .then(async (request) => {
        const response = await worker.fetch(request, env)
        const bytes = await writeResponse(response, res)
        hostState.mark(response.status)
        if (args.verbose) {
          console.log(`${req.method} ${req.url} → ${response.status} ${bytes}B ${(performance.now() - started).toFixed(1)}ms`)
        }
      })
      .catch((error) => {
        // 这里只兜「桥接层」的错。业务错应当由 Worker 自己转成响应返回，
        // 若走到这里说明是宿主问题，必须暴露而不是吞掉。
        console.error(`[宿主异常] ${req.method} ${req.url}`, error)
        hostState.errors += 1
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'HOST_BRIDGE_ERROR', message: String(error?.message ?? error) } }))
      })
  })

  await new Promise((done) => server.listen(args.port, '127.0.0.1', done))

  const coercions = db.coercions
  console.log('── Node 宿主已就绪 ──')
  console.log(`Worker 入口   : src/index.ts（真实入口，esbuild 打包）`)
  console.log(`监听          : http://127.0.0.1:${args.port}`)
  console.log(`数据库        : ${path ?? '内存库（进程退出即丢）'}`)
  console.log(`迁移          : ${existed ? '沿用已有库，未重放' : `${migrations} 个迁移文件已应用`}`)
  console.log(`附件目录      : ${resolve(backendRoot, args.dataDir)}`)
  console.log(`已播种老板账号: ${args.seed ? '是（owner@local.test / local-preview-pass）' : '否'}`)
  // 参数强制转换次数不为 0，说明本地比原生 node:sqlite 宽松，存在与 D1 的口径差异。
  console.log(`参数强转次数  : undefined→null ${coercions.undefinedToNull}，boolean→int ${coercions.booleanToInt}${coercions.undefinedToNull || coercions.booleanToInt ? '  ⚠️ 出现强转，上生产前须复核' : ''}`)

  // 供压测脚本调用：验证登录链路真的通。
  const call = (path2, init) => fetch(`http://127.0.0.1:${args.port}${path2}`, init)
  if (args.seed) {
    const token = await login(call, { email: 'owner@local.test', password: 'local-preview-pass' })
    console.log(`登录自检      : 通过（token ${token.length} 字符）`)
  }

  const shutdown = () => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('宿主启动失败：', error)
  process.exit(1)
})
