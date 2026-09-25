/**
 * 真实 Worker 入口的本地运行夹具（测试与本地预览环境共用）。
 *
 * 与 `lib/env.mjs` 的分工：
 *   · `env.mjs` 只给「真实 D1 + 能被 Node 直接调用的领域函数」，测的是领域逻辑；
 *   · 本文件把 `backend/src/index.ts` 这个**真正的 Worker 入口**跑起来，
 *     路由分发、鉴权、权限判断、CORS 一起生效，用 `dispatchFetch` 发真实 HTTP 请求。
 *
 * 为什么需要它：入口层才会有的错误（路由正则漏子路径、改了数据却没过权限、
 * 校验报错被 catch 吞成 500）在领域测试里根本照不到。
 *
 * 边界：只跑本机 workerd + 内存 D1，不连远端、不 deploy、不读生产数据。
 * 目录名带 `.validation-` 前缀，匹配 .gitignore，不会进仓库。
 */

import { Miniflare, Log, LogLevel } from 'miniflare'
import esbuild from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from './env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const backendRoot = resolve(here, '..', '..')
const buildRoot = join(backendRoot, '.validation-t04', 'build')

/** 默认绑定。JWT_SECRET 只在本机内存里用，不是任何环境的真实密钥。 */
const DEFAULT_BINDINGS = {
  JWT_SECRET: 'local-preview-secret-not-a-real-secret',
  DEEPSEEK_KEY: '',
  PDD_CLIENT_ID: '',
  PDD_CLIENT_SECRET: '',
  PDD_PID: '',
  INVENTORY_OPENING_MODE: 'preview',
}

/**
 * 把 Worker 入口打包成单个 ESM。
 * workerd 不认 TS，也不做无扩展名的相对导入解析，所以先由 esbuild 打成一份。
 */
export async function buildWorkerBundle({ cache = false } = {}) {
  const outfile = join(buildRoot, 'worker-entry.mjs')
  // 默认不读缓存：复用旧产物会在改了 src 之后静默测到上一份代码，
  // 这种「测试通过但测的不是当前源码」比多花几百毫秒贵得多。
  if (cache) {
    try {
      return { outfile, source: readFileSync(outfile, 'utf8') }
    } catch {
      // 没构建过，往下走
    }
  }
  mkdirSync(buildRoot, { recursive: true })
  await esbuild.build({
    entryPoints: [join(backendRoot, 'src', 'index.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'warning',
    minify: false,
    keepNames: true,
  })
  return { outfile, source: readFileSync(outfile, 'utf8') }
}

/**
 * 起一个跑着真实 Worker 的隔离环境。
 *
 * @param {{ bindings?: Record<string, string>, migrations?: boolean, bundleCache?: boolean, persistPath?: string }} options
 */
export async function createWorkerEnv({ bindings = {}, migrations = true, bundleCache = false, d1Name, withR2 = false } = {}) {
  const { source } = await buildWorkerBundle({ cache: bundleCache })
  const miniflare = new Miniflare({
    modules: true,
    script: source,
    compatibilityDate: '2025-06-01',
    d1Databases: { DB: `e04-${Math.random().toString(36).slice(2, 10)}` },
    ...(withR2 ? { r2Buckets: { BUCKET: 'test-bucket' } } : {}),
    bindings: { ...DEFAULT_BINDINGS, ...bindings },
    log: new Log(LogLevel.ERROR),
  })

  const db = await miniflare.getD1Database('DB')
  const applied = migrations ? await applyMigrations(db) : []

  /** 发一个真实 HTTP 请求到 Worker。path 形如 `/api/customers`。 */
  const call = (path, init = {}) => miniflare.dispatchFetch(`http://local.test${path}`, init)

  return {
    miniflare,
    db,
    migrations: applied,
    call,
    async dispose() {
      await miniflare.dispose()
    },
  }
}

/**
 * 旧格式口令哈希：base64(SHA-256(口令 + 固定盐))。
 * 与 `src/index.ts` 的 `verifyPassword` 旧分支完全一致 —— 这样夹具可以在库里
 * 直接放一条能登录的账号，不必先把 PBKDF2 那套复制一遍；首次登录时服务端
 * 会自动把它升级成 PBKDF2 格式，顺带也覆盖到那条升级路径。
 */
export async function legacyPasswordHash(password) {
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`${password}salt-pc`))
  return Buffer.from(new Uint8Array(digest)).toString('base64')
}

/** 播一个老板账号 + 一家门店。老板在 `loadAuthContext` 里拿到 `['*']`，不需要再播角色表。 */
export async function seedOwner(db, { email = 'owner@local.test', password = 'local-preview-pass', storeId = 1, userId = 1, storeName = '本地预览门店' } = {}) {
  await db.prepare('INSERT INTO users (id, email, password_hash, status) VALUES (?, ?, ?, \'active\')')
    .bind(userId, email, await legacyPasswordHash(password)).run()
  await db.prepare('INSERT INTO stores (id, name, status) VALUES (?, ?, \'active\')')
    .bind(storeId, storeName).run()
  await db.prepare('INSERT INTO store_members (store_id, user_id, status, is_owner, created_by, updated_by) VALUES (?, ?, \'active\', 1, ?, ?)')
    .bind(storeId, userId, userId, userId).run()
  return { userId, storeId, email, password }
}

/** 登录并拿 token。走的是真实登录路由，不是伪造凭证。 */
export async function login(call, { email, password }) {
  const response = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await response.json()
  if (!response.ok || !data.token) throw new Error(`登录失败（${response.status}）：${data.error ?? '无 token'}`)
  return data.token
}

/** 带 token 的 JSON 请求助手，省掉每个用例重复拼头。 */
export function createClient(call, token) {
  const auth = { Authorization: `Bearer ${token}` }
  const write = (method, body) => ({
    method,
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {
    get: (path) => call(path, { headers: auth }),
    post: (path, body) => call(path, write('POST', body)),
    put: (path, body) => call(path, write('PUT', body)),
    del: (path) => call(path, write('DELETE')),
  }
}
