/**
 * T03b · 请求核心（网页端，与小程序端同构）。
 *
 * 解决的真问题：**动作发出后结果不确定时怎么办。**
 *   用户点了「确认收款」，请求超时 —— 钱扣了没有？旧写法是 `catch` 后弹个 toast 就当失败，
 *   用户再点一次，服务端收到第二个 requestId，于是重复扣款。
 *
 * 三条硬规则（全部来自规格，不是自创）：
 *   1. **一次动作只用一个 requestId**（03 §1 R07）。重试复用同一 ID；载荷变了才换新 ID。
 *      待确认动作（requestId + 载荷摘要）落进存储，刷新页面也不丢。
 *   2. **网络超时没有可信 code，必须进入「结果未知」，不等于失败**（errors.json rules 3）。
 *      所以本层**不抛异常** —— 抛异常会让调用方把「未知」误当「失败」。
 *   3. **程序分支只依据 code**；服务端 message 只用于展示（errors.json rules 1）。
 *
 * 为什么把「错误行为表」做成参数注入而不是直接 import：
 *   微信编译链能否接受带 `.ts` 扩展名的 import 尚未验证，因此本文件刻意**零运行时依赖**
 *   （只允许 import type），这样门禁脚本能用 Node 直接加载它并跑同一组输入做两端比对。
 *
 * ⚠️ 本文件与 `miniprogram/features/api-core.ts` 必须同构；
 *   `node contracts/tools/check-client-parity.mjs` 逐项比对常量与关键函数行为。
 *
 * 规格依据：03 §1 R07 / R10；04 §4 L75–L79、§6 L128–L143、§7 L156–L157；errors.json。
 */

import type { ClientAction } from './error-behavior.ts'
import type { SessionStore } from './session.ts'

// ─────────────────── 两端必须一致的常量（门禁脚本逐项比对） ───────────────────

/** 待确认动作的存储键。 */
export const PENDING_STORAGE_KEY = 'pc-quote:v2:pending-actions'
/** 默认超时。超时即「结果未知」，不是失败。 */
export const DEFAULT_TIMEOUT_MS = 15_000
/** requestId 前缀，两端一致，便于按 ID 跨端排查。 */
export const REQUEST_ID_PREFIX = 'req_'
/** 写动作幂等键的请求头名（契约：与 body 内 requestId 必须相同）。 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'

// ────────────────────────────── 传输层抽象 ──────────────────────────────

export interface TransportRequest {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  /** 已是 JSON 字符串；GET 时为 null。 */
  readonly body: string | null
  readonly timeoutMs: number
}

export interface TransportResponse {
  readonly status: number
  /** 原始响应文本；读取失败时为 null。 */
  readonly text: string | null
}

/**
 * 由各端适配：网页用 fetch + AbortController，小程序用 wx.request。
 * 传输层**必须**把超时 / 断网表达为 reject，本层据此判定「结果未知」。
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>

// ────────────────────────────── 结果类型 ──────────────────────────────

export interface ApiMeta {
  readonly requestId: string | null
  readonly serverTime: string | null
  readonly contractVersion: string | null
}

export interface ApiOk<T> {
  readonly ok: true
  readonly status: number
  readonly data: T
  readonly meta: ApiMeta
}

export interface ApiFail {
  readonly ok: false
  /**
   * 结果未知：网络超时、断网、网关错误。**不等于失败** ——
   * 写动作必须先用原 requestId 查 operation，再决定下一步。
   */
  readonly unknownResult: boolean
  readonly code: string | null
  /** 展示文案：服务端 message 优先，缺失时用契约兜底文案。 */
  readonly message: string
  readonly status: number | null
  readonly fieldErrors: Readonly<Record<string, string>> | null
  readonly currentVersion: number | null
  readonly retryable: boolean
  readonly operationId: string | null
  /** 本次动作使用的 requestId（写动作恒有请求方生成的值）。 */
  readonly requestId: string | null
  /** 程序依据：该触发哪些客户端行为。 */
  readonly actions: readonly ClientAction[]
}

export type ApiResult<T> = ApiOk<T> | ApiFail

export interface ReadOptions {
  readonly params?: Readonly<Record<string, string | number | boolean | null | undefined>>
}

export interface WriteOptions {
  /** 契约动作码（如 `B13`）。用于待确认动作的键与诊断，不参与鉴权。 */
  readonly action: string
  /** 动作作用的实体；无实体时传 null。 */
  readonly entityId?: string | null
  /** 业务字段。requestId / expectedVersion 由本层补齐，不要在这里重复传。 */
  readonly payload: Readonly<Record<string, unknown>>
  /** 已有实体的版本前提。 */
  readonly expectedVersion?: number | null
}

export interface QueryOperationResult {
  readonly ok: boolean
  readonly status: 'pending' | 'succeeded' | 'failed' | 'unknown'
  readonly code: string | null
  readonly message: string
  readonly resultRef: string | null
}

/** 错误行为决策（由装配层注入 error-behavior 的真实实现）。 */
export interface ErrorBehavior {
  decide(code: string | null | undefined, options: { isWrite: boolean }): readonly ClientAction[]
  fallbackMessage(code: string | null | undefined): string
  isRetryable(code: string | null | undefined): boolean
}

export interface RequestCore {
  read<T>(path: string, options?: ReadOptions): Promise<ApiResult<T>>
  write<T>(path: string, options: WriteOptions): Promise<ApiResult<T>>
  /** 以原 requestId 查询写动作结果（结果未知后的第一步）。 */
  queryOperation(requestId: string): Promise<QueryOperationResult>
  /** 清空全部待确认动作（登出 / 撤权后调用）。 */
  clearPendingActions(): void
  /** 只读：当前待确认动作数量，供诊断与测试。 */
  pendingActionCount(): number
  /** 只读：某个动作当前绑定的 requestId（测试与诊断用）。 */
  pendingRequestId(action: string, entityId?: string | null): string | null
}

export interface RequestCoreOptions {
  readonly baseUrl: string
  readonly transport: Transport
  readonly session: SessionStore
  readonly behavior: ErrorBehavior
  /** 当前页面路径，供登录失效时记录目标页。返回 null 表示不记录。 */
  readonly currentTarget?: () => string | null
  readonly timeoutMs?: number
  /** 可注入，便于测试与跨端一致性验证。 */
  readonly newRequestId?: () => string
  readonly now?: () => number
}

// ────────────────────────────── 纯工具 ──────────────────────────────

/** 递归按键排序的稳定序列化，用于计算载荷摘要。数组顺序保留（顺序有语义）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/**
 * FNV-1a 32 位载荷摘要。不用 crypto：
 * 小程序 JSCore 的 crypto 支持不完整（同 R-11 一类的平台限制）。
 */
export function payloadHash(payload: unknown): string {
  const text = stableStringify(payload)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

let requestCounter = 0

/** 默认 requestId。格式两端一致：`req_<时间戳36>_<计数36><随机36>`。 */
export function defaultRequestId(now: () => number = () => Date.now()): string {
  requestCounter = (requestCounter + 1) % 0xffff
  const time = now().toString(36)
  const seq = requestCounter.toString(36).padStart(3, '0')
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(5, '0')
  return `${REQUEST_ID_PREFIX}${time}_${seq}${rand}`
}

export function pendingKeyOf(action: string, entityId: string | null): string {
  return `${action}@${entityId ?? '-'}`
}

function buildQuery(params: ReadOptions['params']): string {
  if (!params) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 网关类状态码：请求可能已到达后端并执行，只是响应没回来。
 * 与网络超时同样归入「结果未知」，不能当失败。
 */
export function isGatewayFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

interface ParsedError {
  readonly code: string | null
  readonly message: string | null
  readonly fieldErrors: Record<string, string> | null
  readonly currentVersion: number | null
  readonly retryable: boolean | null
  readonly operationId: string | null
  readonly requestId: string | null
}

/** 契约错误体：`{ error: { code, message, fieldErrors, currentVersion, retryable, operationId }, meta }`。 */
export function parseErrorBody(text: string | null): ParsedError {
  const empty: ParsedError = {
    code: null,
    message: null,
    fieldErrors: null,
    currentVersion: null,
    retryable: null,
    operationId: null,
    requestId: null,
  }
  if (!text) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  if (!isRecord(parsed)) return empty
  const meta = isRecord(parsed.meta) ? parsed.meta : {}
  const raw = isRecord(parsed.error) ? parsed.error : null
  if (!raw) {
    // 旧式 `{ error: "中文串" }` 或非契约形状：没有 code，由状态码分类兜底。
    return {
      ...empty,
      message: typeof parsed.error === 'string' ? parsed.error : null,
      requestId: typeof meta.requestId === 'string' ? meta.requestId : null,
    }
  }
  return {
    code: typeof raw.code === 'string' ? raw.code : null,
    message: typeof raw.message === 'string' ? raw.message : null,
    fieldErrors: isRecord(raw.fieldErrors)
      ? Object.fromEntries(Object.entries(raw.fieldErrors).map(([k, v]) => [k, String(v)]))
      : null,
    currentVersion: typeof raw.currentVersion === 'number' ? raw.currentVersion : null,
    retryable: typeof raw.retryable === 'boolean' ? raw.retryable : null,
    operationId: typeof raw.operationId === 'string' ? raw.operationId : null,
    requestId: typeof meta.requestId === 'string' ? meta.requestId : null,
  }
}

export function parseSuccessMeta(text: string | null): ApiMeta {
  const empty: ApiMeta = { requestId: null, serverTime: null, contractVersion: null }
  if (!text) return empty
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) return empty
    const meta = isRecord(parsed.meta) ? parsed.meta : {}
    return {
      requestId: typeof meta.requestId === 'string' ? meta.requestId : null,
      serverTime: typeof meta.serverTime === 'string' ? meta.serverTime : null,
      contractVersion: typeof meta.contractVersion === 'string' ? meta.contractVersion : null,
    }
  } catch {
    return empty
  }
}

interface PendingAction {
  readonly requestId: string
  readonly hash: string
  readonly action: string
  readonly entityId: string | null
  readonly createdAt: number
}

// ────────────────────────────── 工厂 ──────────────────────────────

export function createRequestCore(options: RequestCoreOptions): RequestCore {
  const { baseUrl, transport, session, behavior } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? (() => Date.now())
  const newRequestId = options.newRequestId ?? (() => defaultRequestId(now))
  const currentTarget = options.currentTarget ?? (() => null)

  function readPendingMap(): Record<string, PendingAction> {
    const raw = session.storage.getItem(PENDING_STORAGE_KEY)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as unknown
      return isRecord(parsed) ? (parsed as Record<string, PendingAction>) : {}
    } catch {
      return {}
    }
  }

  function writePendingMap(map: Record<string, PendingAction>): void {
    if (!Object.keys(map).length) session.storage.removeItem(PENDING_STORAGE_KEY)
    else session.storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(map))
  }

  function clearPending(): void {
    session.storage.removeItem(PENDING_STORAGE_KEY)
  }

  /**
   * 登录失效的副作用在这里落地，调用方不需要自己记得清什么。
   * 03 §8 L194：撤权后两端的旧会话都须失效。
   */
  function applySessionSideEffects(actions: readonly ClientAction[]): void {
    if (actions.includes('clear-session')) session.clearIdentity()
    // clear-drafts 内部同时清身份（撤权场景），见 session.ts 的说明。
    if (actions.includes('clear-drafts')) {
      session.clearDrafts()
      // 待确认动作属于草稿语义：撤权后一并清掉，避免新身份残留上一个身份的旧动作。
      // AUTH_REQUIRED 则**保留** pending —— 与保留草稿一致，重新登录后可继续刚才的动作。
      clearPending()
    }
    if (actions.includes('goto-login')) {
      const target = currentTarget()
      if (target) session.rememberTarget(target)
    }
  }

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = session.getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  function failureFrom(
    status: number | null,
    text: string | null,
    isWrite: boolean,
    usedRequestId: string | null,
  ): ApiFail {
    const parsed = parseErrorBody(text)
    // 无 code 且是网关 / 服务端错误 → 请求很可能已经到达后端：结果未知。
    const unknownResult =
      status === null || (parsed.code === null && (isGatewayFailure(status) || status >= 500))
    const actions = behavior.decide(parsed.code, { isWrite })
    return {
      ok: false,
      unknownResult,
      code: parsed.code,
      message: parsed.message ?? behavior.fallbackMessage(parsed.code),
      status,
      fieldErrors: parsed.fieldErrors,
      currentVersion: parsed.currentVersion,
      retryable: parsed.retryable ?? behavior.isRetryable(parsed.code),
      operationId: parsed.operationId,
      requestId: parsed.requestId ?? usedRequestId,
      actions,
    }
  }

  async function send(request: TransportRequest, isWrite: boolean): Promise<ApiResult<unknown>> {
    let response: TransportResponse
    try {
      response = await transport(request)
    } catch {
      // 超时 / 断网：没有可信 code → 结果未知。
      const failure = failureFrom(null, null, isWrite, null)
      return failure
    }
    if (response.status >= 200 && response.status < 300) {
      let data: unknown = null
      if (response.text) {
        try {
          const parsed = JSON.parse(response.text) as unknown
          data = isRecord(parsed) && 'data' in parsed ? parsed.data : parsed
        } catch {
          data = null
        }
      }
      return { ok: true, status: response.status, data, meta: parseSuccessMeta(response.text) }
    }
    const failure = failureFrom(response.status, response.text, isWrite, null)
    // 只有明确的契约错误码才触发会话副作用；非契约响应不动本地会话，
    // 否则一次网关抖动就会把用户踢下线。
    if (failure.code) applySessionSideEffects(failure.actions)
    return failure
  }

  return {
    async read<T>(path: string, readOptions: ReadOptions = {}): Promise<ApiResult<T>> {
      const url = `${baseUrl}${path}${buildQuery(readOptions.params)}`
      return (await send(
        { url, method: 'GET', headers: authHeaders(), body: null, timeoutMs },
        false,
      )) as ApiResult<T>
    },

    async write<T>(path: string, writeOptions: WriteOptions): Promise<ApiResult<T>> {
      const entityId = writeOptions.entityId ?? null
      const hash = payloadHash(writeOptions.payload)
      const key = pendingKeyOf(writeOptions.action, entityId)
      const map = readPendingMap()
      const previous = map[key]
      // 复用条件：同一动作 + 同一实体 + 载荷摘要相同。
      // 载荷变了必须换新 ID —— 否则服务端会判 IDEMPOTENCY_MISMATCH，
      // 那是它该做的判断，客户端不该主动制造这个冲突。
      const reuse = Boolean(previous && previous.hash === hash)
      const requestId = reuse && previous ? previous.requestId : newRequestId()
      map[key] = {
        requestId,
        hash,
        action: writeOptions.action,
        entityId,
        createdAt: reuse && previous ? previous.createdAt : now(),
      }
      writePendingMap(map)

      const body: Record<string, unknown> = { ...writeOptions.payload, requestId }
      if (writeOptions.expectedVersion !== undefined && writeOptions.expectedVersion !== null) {
        body.expectedVersion = writeOptions.expectedVersion
      }
      const headers = authHeaders()
      headers[IDEMPOTENCY_HEADER] = requestId

      const result = await send(
        { url: `${baseUrl}${path}`, method: 'POST', headers, body: JSON.stringify(body), timeoutMs },
        true,
      )
      // 只在**服务端明确成功**后清除待确认动作。
      // 结果未知时保留，这样下一次重试才复用得上同一个 requestId。
      if (result.ok) {
        const latest = readPendingMap()
        delete latest[key]
        writePendingMap(latest)
      }
      return result as ApiResult<T>
    },

    async queryOperation(requestId: string): Promise<QueryOperationResult> {
      const result = await this.read<{ status?: string; errorCode?: string; resultRef?: string }>(
        `/operations/${encodeURIComponent(requestId)}`,
      )
      if (!result.ok) {
        return { ok: false, status: 'unknown', code: result.code, message: result.message, resultRef: null }
      }
      const status = result.data?.status
      const code = result.data?.errorCode ?? null
      return {
        ok: true,
        status:
          status === 'pending' || status === 'succeeded' || status === 'failed' ? status : 'unknown',
        code,
        message: code ? behavior.fallbackMessage(code) : '',
        resultRef: result.data?.resultRef ?? null,
      }
    },

    clearPendingActions() {
      clearPending()
    },

    pendingActionCount() {
      return Object.keys(readPendingMap()).length
    },

    pendingRequestId(action: string, entityId: string | null = null) {
      const entry = readPendingMap()[pendingKeyOf(action, entityId)]
      return entry ? entry.requestId : null
    },
  }
}
