/**
 * T03b · 微信小程序端请求层装配。
 *
 * 只做装配：把 wx.request 传输、会话存储、错误行为表接到 `api-core.ts` 的请求核心上。
 * 真正的逻辑在 `api-core.ts`（零运行时依赖，两端同构、可被门禁脚本直接加载）。
 *
 * ⚠️ 小程序 `wx.request` 只能请求**在后台登记过的 HTTPS 域名**（04 §10 L195）。
 *   API 域名尚未提供（OPEN-ITEMS T-05），因此 baseUrl 必须显式传入，
 *   缺配置时**立刻抛错**，不允许静默打到空地址上假装能用。
 *
 * 规格依据：04-data-and-api.md §8、§10 L195；微信网络能力官方文档（T03 实施时复核）。
 */

import { createRequestCore } from './api-core'
import type { RequestCore, RequestCoreOptions, Transport } from './api-core'
import { decideClientHandling, fallbackMessageFor, isRetryableCode } from './error-behavior'
import { createSessionStore, wxStorage } from './session'
import type { SessionStore } from './session'

/**
 * 微信传输层：`dataType: 'text'` 保证拿到原始响应文本（不让微信自动 JSON.parse 后丢字段）。
 * 超时 / 断网由 wx.request 以 fail 表达为 reject，交由请求核心判定「结果未知」。
 */
export const wxTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    wx.request({
      url: request.url,
      method: request.method,
      header: request.headers,
      data: request.body ?? undefined,
      timeout: request.timeoutMs,
      // 关键：禁止微信自动解析 JSON。解析由请求核心统一做，行为才与网页端一致。
      dataType: 'text',
      responseType: 'text',
      success: (res) => {
        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
        resolve({ status: res.statusCode, text })
      },
      fail: () => reject(new Error('NETWORK_ERROR')),
    })
  })

export interface MiniProgramApiClientOptions {
  /** API 域名（必填，如 `https://api.huangqidong.cn/api/v2`）。 */
  readonly baseUrl: string
  readonly session?: SessionStore
  readonly transport?: Transport
  /**
   * 当前页面路径（小程序路由，如 `/packages/sales/order-detail/index?orderId=...`），
   * 供登录失效时记录目标页。默认取 getCurrentPages 的栈顶。
   */
  readonly currentTarget?: () => string | null
  readonly timeoutMs?: number
  readonly newRequestId?: () => string
  readonly now?: () => number
}

export interface MiniProgramApiClient {
  readonly client: RequestCore
  readonly session: SessionStore
}

/** 默认目标页：当前页面栈栈顶的完整路由（含 query）。 */
export function currentPageTarget(): string | null {
  try {
    const pages = getCurrentPages()
    const top = pages[pages.length - 1]
    if (!top) return null
    const route = typeof top.route === 'string' ? top.route : ''
    if (!route) return null
    const query = (top as { options?: Record<string, string> }).options ?? {}
    const search = Object.entries(query)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    return `/${route}${search ? `?${search}` : ''}`
  } catch {
    return null
  }
}

export function createMiniProgramApiClient(options: MiniProgramApiClientOptions): MiniProgramApiClient {
  if (!options.baseUrl || !/^https:\/\//.test(options.baseUrl)) {
    // 04 §10：开发 / 验收 / 生产分别配置 API 域名。这里缺配置就明确失败。
    throw new Error('T03b: 小程序端必须配置 HTTPS 的 API 域名（baseUrl），不得静默使用空地址')
  }
  const session = options.session ?? createSessionStore(wxStorage())

  const coreOptions: RequestCoreOptions = {
    baseUrl: options.baseUrl,
    transport: options.transport ?? wxTransport,
    session,
    behavior: {
      decide: (code, { isWrite }) => decideClientHandling(code, { isWrite }),
      fallbackMessage: fallbackMessageFor,
      isRetryable: isRetryableCode,
    },
    currentTarget: options.currentTarget ?? currentPageTarget,
    timeoutMs: options.timeoutMs,
    newRequestId: options.newRequestId,
    now: options.now,
  }

  return { client: createRequestCore(coreOptions), session }
}

export type { ApiFail, ApiMeta, ApiOk, ApiResult, QueryOperationResult } from './api-core'
