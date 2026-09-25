/**
 * /api/v2 工作台路由（R02）。
 *
 * 为什么单独成文件（与 `routes/finance-v2.ts`、`routes/sales-v2.ts` 同一理由）：
 * `validate-contracts.mjs` 第 10.6 节会把 `src/index.ts` 里所有 `'xx/yy'` 形态的
 * 字面量当成旧权限码，要求它们全部出现在 legacyPermissionMap 里。本模块目前没有
 * 新权限码（R02 无门槛），但把读模型链路留在本文件能让入口只保留分发行，
 * 与其余八条 v2 链路保持同一种形态。
 *
 * 承接的契约条目（前缀 /api/v2 由 conventions.api 声明）：
 *   · R02  GET /workbench  权限无门槛（03 §8 权限表首行：待办老板与店员均可）
 *        返回 metrics / tasks / filters / generatedAt（TaskReadModel 列表）
 *
 * ⚠️ 只认领 `/api/v2/workbench` **这一条精确路径**，不对 `/api/v2` 或任何更宽的前缀
 * 兜底 404 —— 兜底会吃掉后面接的链路（E05 实测过 `/inventory` 那次）。
 */

import type { PermissionHolder } from '../domains/access'
import {
  TASK_CATEGORIES,
  queryWorkbench,
  type TaskCategory,
  type WorkbenchQuery,
} from '../domains/workbench'
import { appendReadableDiagnostic } from '../domains/operations'

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface WorkbenchRouteEnv {
  DB: D1Database
}

/** 与入口的 AuthContext 结构一致；R02 不判权限，但仍要知道是哪家店。 */
export interface WorkbenchRouteContext extends PermissionHolder {
  userId: number
  storeId: number
}

const CONTRACT_VERSION = 'v1'
const PREFIX = '/api/v2'
const WORKBENCH_PATH = `${PREFIX}/workbench`

// ────────────────────────────── 契约信封 ──────────────────────────────

function meta(requestId: string | null) {
  return { requestId, serverTime: new Date().toISOString(), contractVersion: CONTRACT_VERSION }
}

function ok(data: unknown, requestId: string | null = null, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: meta(requestId) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fail(
  code: string,
  message: string,
  status: number,
  options: { requestId?: string | null } = {},
): Response {
  const error: Record<string, unknown> = {
    code,
    message,
    retryable: code === 'AUTH_REQUIRED' || code === 'SESSION_REVOKED' || code === 'RATE_LIMITED' || code === 'SERVICE_UNAVAILABLE',
  }
  return new Response(JSON.stringify({ error, meta: meta(options.requestId ?? null) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ────────────────────────────── 入参解析 ──────────────────────────────

/** 认不出的筛选值直接拒绝，不猜也不忽略 —— 静默忽略会让人以为筛选生效了。 */
function parseQuery(url: URL): { query: WorkbenchQuery | null; problem: string | null } {
  const rawCategory = url.searchParams.get('category')
  let category: TaskCategory | null = null
  if (rawCategory !== null && rawCategory !== '' && rawCategory !== 'all') {
    if (!(TASK_CATEGORIES as readonly string[]).includes(rawCategory)) {
      return { query: null, problem: `category 只能是 ${TASK_CATEGORIES.join(' / ')}（或 all）` }
    }
    category = rawCategory as TaskCategory
  }

  const rawScope = url.searchParams.get('scope')
  if (rawScope !== null && rawScope !== '' && rawScope !== 'open') {
    return { query: null, problem: 'scope 目前只支持 open（未结事项）' }
  }

  const rawLimit = url.searchParams.get('limit')
  let limit: number | null = null
  if (rawLimit !== null && rawLimit !== '') {
    if (!/^\d+$/.test(rawLimit)) return { query: null, problem: 'limit 必须是正整数' }
    limit = Number(rawLimit)
    if (limit === 0) return { query: null, problem: 'limit 必须是正整数' }
  }

  const rawQ = url.searchParams.get('q')
  return {
    query: { scope: 'open', q: rawQ && rawQ.trim() ? rawQ : null, category, limit },
    problem: null,
  }
}

// ────────────────────────────── 路由 ──────────────────────────────

async function handleWorkbench(req: Request, env: WorkbenchRouteEnv, context: WorkbenchRouteContext): Promise<Response> {
  const { query, problem } = parseQuery(new URL(req.url))
  if (!query) return fail('VALIDATION_ERROR', problem ?? '查询参数无效', 400)
  return ok(await queryWorkbench(env.DB, context.storeId, query))
}

/**
 * 分发入口。返回 null 表示「不是本模块的路径」，交给后面的链路与 404。
 */
export async function routeWorkbenchV2(
  req: Request,
  env: WorkbenchRouteEnv,
  context: WorkbenchRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (path !== WORKBENCH_PATH) return null

  if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)

  try {
    return await handleWorkbench(req, env, context)
  } catch (error) {
    // 读接口失败要把真因说出来，不能只回一句「服务器错误」（T-11 的同一口径）。
    const message = error instanceof Error ? error.message : String(error)
    const diagnostic = error instanceof Error ? error.stack : null
    return fail('SERVICE_UNAVAILABLE', appendReadableDiagnostic(`工作台读取失败：${message}`, diagnostic), 500)
  }
}
