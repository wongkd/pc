/**
 * T03b · 网页端请求层装配。
 *
 * 本文件只做装配：把 fetch 传输、会话存储、错误行为表接到 `core.ts` 的请求核心上。
 * 真正的逻辑在 `core.ts`（零运行时依赖，两端同构、可被门禁脚本直接加载）。
 *
 * 新业务 API 前缀 `/api/v2`（04 §1）；旧 `/api` 读写保留到兼容任务完成，
 * 两者**不得**对同一笔新订单同时记账。
 *
 * 规格依据：04-data-and-api.md §1 L7、§3 L50、§4 L75。
 */

import { createRequestCore } from './core.ts'
import type { RequestCore, RequestCoreOptions, Transport } from './core.ts'
import { decideClientHandling, fallbackMessageFor, isRetryableCode } from './error-behavior.ts'
import { browserStorage, createSessionStore } from './session.ts'
import type { KeyValueStorage, SessionStore } from './session.ts'

/** 新业务 API 前缀。与旧 `/api` 并存，切换由各业务卡决定，不在本层偷偷改。 */
export const V2_BASE_URL = '/api/v2'

/** 浏览器传输层：超时通过 AbortController 表达为 reject，交由核心判定「结果未知」。 */
export const browserTransport: Transport = async (request) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body ?? undefined,
      signal: controller.signal,
    })
    const text = await response.text()
    return { status: response.status, text }
  } finally {
    clearTimeout(timer)
  }
}

export interface WebApiClientOptions {
  readonly baseUrl?: string
  readonly storage?: KeyValueStorage
  readonly session?: SessionStore
  readonly transport?: Transport
  /** 当前页面路径（含 query），供登录失效时记录目标页。 */
  readonly currentTarget?: () => string | null
  readonly timeoutMs?: number
  readonly newRequestId?: () => string
  readonly now?: () => number
}

export interface WebApiClient {
  readonly client: RequestCore
  readonly session: SessionStore
}

export function createWebApiClient(options: WebApiClientOptions = {}): WebApiClient {
  const storage = options.storage ?? browserStorage()
  const session = options.session ?? createSessionStore(storage)

  const coreOptions: RequestCoreOptions = {
    baseUrl: options.baseUrl ?? V2_BASE_URL,
    transport: options.transport ?? browserTransport,
    session,
    behavior: {
      decide: (code, { isWrite }) => decideClientHandling(code, { isWrite }),
      fallbackMessage: fallbackMessageFor,
      isRetryable: isRetryableCode,
    },
    currentTarget: options.currentTarget,
    timeoutMs: options.timeoutMs,
    newRequestId: options.newRequestId,
    now: options.now,
  }

  return { client: createRequestCore(coreOptions), session }
}

export type { ApiFail, ApiMeta, ApiOk, ApiResult, QueryOperationResult } from './core.ts'
export { payloadHash, stableStringify } from './core.ts'
