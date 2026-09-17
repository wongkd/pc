/**
 * T03b · 会话与「登录后回到原处」（微信小程序端）。
 *
 * 与 `frontend/src/api/session.ts` 同构，差异只有一处：存储适配器用 wx 同步存储。
 * 门禁脚本 `node contracts/tools/check-client-parity.mjs` 校验两端的清理范围与键语义一致。
 *
 * 这一层只做三件事，且都来自规格硬要求：
 *   1. 身份缓存的读出与清除 —— 03 §8 L194「撤权后两个端的旧会话都须失效」。
 *   2. 目标页恢复 —— 卡面 T03b「微信重新登录恢复目标页」：
 *      登录失效跳登录前，记住用户原本要办的页面，登录成功后回到那里。
 *   3. 提供可注入的键值存储，供请求核心保存「待确认动作」。
 *
 * ⚠️ 本文件只允许 import type，门禁脚本用 Node 直接加载它。
 *
 * 规格依据：03-domain-rules.md §8 L194；04-data-and-api.md §6 L131、§8 L171。
 */

/** 最小键值存储抽象：小程序传 wx 同步存储适配器。 */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SessionStore {
  /** 供请求核心保存待确认动作（requestId 与载荷摘要）。 */
  readonly storage: KeyValueStorage
  getToken(): string | null
  setToken(token: string): void
  /**
   * 登录失效（AUTH_REQUIRED）：清身份缓存，保留草稿 ——
   * 用户没做错什么，不应该丢掉他正在填的东西。
   */
  clearIdentity(): void
  /**
   * 会话被撤权（SESSION_REVOKED）：清身份缓存**与**本地草稿。
   */
  clearDrafts(): void
  /** 记住原目标页（跳登录前调用）。空串与非法路径一律忽略。 */
  rememberTarget(target: string): void
  /** 取出原目标页并清除（登录成功后调用一次）。 */
  consumeTarget(): string | null
  /** 只读当前记录的目标页，不消费。 */
  peekTarget(): string | null
}

export interface SessionStoreOptions {
  /** 会话 token 的存储键。T03a 若决定换键，只需在此改一处。 */
  readonly tokenKey?: string
  /** 本地草稿存储键。 */
  readonly draftsKey?: string
  /** 目标页存储键。 */
  readonly targetKey?: string
}

const DEFAULT_TOKEN_KEY = 'pc-auth-token'
const DEFAULT_DRAFTS_KEY = 'pc-quote:v2:drafts'
const DEFAULT_TARGET_KEY = 'pc-quote:v2:post-login-target'

/**
 * 目标页必须是站内路径。小程序页面路径（/pages/sales/index?tab=used）与
 * 网页相对路径（/inventory?tab=used）形状一致，两端共用同一判断。
 */
const SAFE_TARGET = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]*$/

export function createSessionStore(
  storage: KeyValueStorage,
  options: SessionStoreOptions = {},
): SessionStore {
  const tokenKey = options.tokenKey ?? DEFAULT_TOKEN_KEY
  const draftsKey = options.draftsKey ?? DEFAULT_DRAFTS_KEY
  const targetKey = options.targetKey ?? DEFAULT_TARGET_KEY

  return {
    storage,

    getToken() {
      return storage.getItem(tokenKey)
    },

    setToken(token: string) {
      storage.setItem(tokenKey, token)
    },

    clearIdentity() {
      storage.removeItem(tokenKey)
    },

    clearDrafts() {
      storage.removeItem(tokenKey)
      storage.removeItem(draftsKey)
    },

    rememberTarget(target: string) {
      if (!target || !SAFE_TARGET.test(target)) return
      storage.setItem(targetKey, target)
    },

    consumeTarget() {
      const value = storage.getItem(targetKey)
      storage.removeItem(targetKey)
      return value
    },

    peekTarget() {
      return storage.getItem(targetKey)
    },
  }
}

/** wx 同步存储适配器。数值等非字符串值不当作 token / 路径使用，一律返回 null。 */
export function wxStorage(): KeyValueStorage {
  return {
    getItem(key: string): string | null {
      const value = wx.getStorageSync(key)
      return typeof value === 'string' && value !== '' ? value : null
    },
    setItem(key: string, value: string): void {
      wx.setStorageSync(key, value)
    },
    removeItem(key: string): void {
      wx.removeStorageSync(key)
    },
  }
}
