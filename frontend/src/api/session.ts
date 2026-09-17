/**
 * T03b · 会话与「登录后回到原处」（网页端）。
 *
 * 这一层只做三件事，且都来自规格硬要求：
 *   1. 身份缓存的读出与清除 —— 03 §8 L194「撤权后两个端的旧会话都须失效」。
 *      401 分两种：AUTH_REQUIRED 只清身份缓存；SESSION_REVOKED 还要清本地草稿。
 *   2. 目标页恢复 —— 卡面 T03b「微信重新登录恢复目标页」的同构需求：
 *      在权限被收回导致跳登录时，先记住用户原本要办的页面，登录成功后回到那里。
 *   3. 提供一个可注入的键值存储，供请求层保存「待确认动作」。
 *
 * ⚠️ 与 `miniprogram/features/session.ts` 同构；
 *   `node contracts/tools/check-client-parity.mjs` 校验两端的清理范围与键语义一致。
 * ⚠️ 本文件不得引入运行时依赖（只允许 import type），门禁脚本用 Node 直接加载它。
 *
 * 规格依据：03-domain-rules.md §8 L194；04-data-and-api.md §6 L131、§8 L171。
 */

/** 最小键值存储抽象：浏览器传 localStorage，小程序传 wx 同步存储适配器。 */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SessionStore {
  /** 供请求层保存待确认动作（requestId 与载荷摘要）。 */
  readonly storage: KeyValueStorage
  getToken(): string | null
  setToken(token: string): void
  /**
   * 登录失效（AUTH_REQUIRED）：清身份缓存，保留草稿 ——
   * 用户没做错什么，不应该丢掉他正在填的东西。
   */
  clearIdentity(): void
  /**
   * 会话被撤权（SESSION_REVOKED）：清身份缓存**与**本地草稿 ——
   * 权限已被收回，保留草稿会让人误以为还能继续办。
   */
  clearDrafts(): void
  /** 记住原目标页（跳登录前调用）。空串与 null 一律忽略。 */
  rememberTarget(target: string): void
  /** 取出原目标页并清除（登录成功后调用一次）。 */
  consumeTarget(): string | null
  /** 只读当前记录的目标页，不消费。 */
  peekTarget(): string | null
}

export interface SessionStoreOptions {
  /**
   * 会话 token 的存储键。
   * 默认复用旧报价系统的键，使新工作台与旧页面共享同一个登录态；
   * T03a 若决定换键，只需在此处改一处，不要散落到各调用点。
   */
  readonly tokenKey?: string
  /** 本地草稿存储键（v2 自己的草稿，不动旧系统的 `pc-quote-app`）。 */
  readonly draftsKey?: string
  /** 目标页存储键。 */
  readonly targetKey?: string
}

const DEFAULT_TOKEN_KEY = 'pc-auth-token'
const DEFAULT_DRAFTS_KEY = 'pc-quote:v2:drafts'
const DEFAULT_TARGET_KEY = 'pc-quote:v2:post-login-target'

/** 目标页必须是站内相对路径，避免把用户送到外部地址。 */
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
      // 只接受站内相对路径：外部地址与空值一律丢弃，不覆盖已有目标。
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

/**
 * 浏览器 localStorage 适配器。
 * 注意：隐私模式下 `localStorage` 可能抛异常，这里降级为内存存储而不是让页面崩掉。
 */
export function browserStorage(): KeyValueStorage {
  const memory = new Map<string, string>()
  const fallback: KeyValueStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
    removeItem: (key) => void memory.delete(key),
  }
  try {
    const probe = '__pc_v2_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return fallback
  }
}
