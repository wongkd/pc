/**
 * MP16 · 顾客端运行环境与演示开关。
 *
 * 解决的真问题：**同一份代码要跑开发版 / 体验版 / 正式版三套后端，且三者不能互相串。**
 *   - 正式版连到测试库 → 顾客看到内部数据；
 *   - 体验版连到生产库 → 一次误点就写进真实账本；
 *   - 真实模式缺地址时悄悄回落演示样本 → 顾客看到虚构商品与虚构价格，比直接报错更糟。
 *
 * 所以本层只做一件事：**把「当前该连哪里」算成唯一结论；算不出来就抛错，绝不降级。**
 *
 * ⚠️ 零运行时依赖（只允许 `import type`）：`node --test` 会直接加载本文件跑同一组输入验证规则，
 *    与 `api-core.ts` / `session.ts` 同一约定。
 * ⚠️ 本文件只放**地址与开关**：小程序包可被反编译，密钥必须留在服务端。
 *
 * 规格依据：本卡（MP16）实施步骤 1–3；`03-execution-and-acceptance.md`「阻塞与止损」。
 */

// ─────────────────────────── 环境与版本 ───────────────────────────

/** 顾客端可选的运行环境。三档结构固定；具体地址见文末地址表。 */
export type CustomerEnvironmentName = 'demo' | 'test' | 'prod'

/** 微信运行版本，取自 `wx.getAccountInfoSync().miniProgram.envVersion`。 */
export type MiniProgramEnvVersion = 'develop' | 'trial' | 'release' | 'unknown'

export interface CustomerEnvironment {
  readonly name: CustomerEnvironmentName
  /** 真实模式的 HTTPS API 前缀；demo 恒为 null。 */
  readonly apiBaseUrl: string | null
  /**
   * 是否使用本地固定演示样本。
   * 真实模式必须为 false —— `features/customer/fixtures.ts` 的样本只允许 demo 载入。
   */
  readonly demoData: boolean
}

/** 解析入参。全部可注入，便于测试与后续卡在不改本文件的前提下接入新地址。 */
export interface CustomerEnvironmentInput {
  /** 显式指定环境；缺省时按微信版本推断。 */
  readonly name?: CustomerEnvironmentName
  /** 显式指定 API 地址；缺省时取地址表。传 null 表示「明确知道没有」，与缺省同义。 */
  readonly apiBaseUrl?: string | null
  /** 显式指定微信版本；缺省时读真实小程序环境。 */
  readonly envVersion?: MiniProgramEnvVersion
}

/** 环境未就绪 / 配置非法。调用方必须显式处理，不得吞掉后回落演示数据。 */
export class CustomerEnvironmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustomerEnvironmentError'
  }
}

// ─────────────────────── 顾客与员工的存储隔离 ───────────────────────

/**
 * 顾客端存储命名空间。
 *
 * 挂在 wx storage 的键前缀上，使顾客端的**会话、草稿、待确认动作**与员工端物理隔离：
 * 同一台设备上店员与顾客登录互不覆盖，撤权也不会误清对方的草稿。
 *
 * ⚠️ 待确认动作的键由 `api-core.ts` 的 `PENDING_STORAGE_KEY` 固定，无法按调用方配置；
 *    因此隔离**必须**做在前缀层，而不是逐个键去改核心。
 */
export const CUSTOMER_STORAGE_PREFIX = 'pc-customer:'

/** 顾客端会话键（相对命名空间，实际写入时自动加前缀）。 */
export const CUSTOMER_SESSION_KEYS = {
  token: 'token',
  drafts: 'drafts',
  target: 'post-login-target',
} as const

/** 员工端默认键（`features/session.ts` 与 `api-core.ts` 的现状值）。只作对照，顾客端不得写入。 */
export const STAFF_STORAGE_KEYS: readonly string[] = [
  'pc-auth-token',
  'pc-quote:v2:drafts',
  'pc-quote:v2:post-login-target',
  'pc-quote:v2:pending-actions',
]

/** 最小键值存储抽象的结构副本；只 import type，故本文件仍零运行时依赖。 */
export interface CustomerKeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * 给存储适配器加命名空间。**所有键**（含请求核心固定写入的待确认动作键）都会带上前缀，
 * 因此不需要改动、也无法漏掉任何一处。
 */
export function createCustomerStorage(base: CustomerKeyValueStorage): CustomerKeyValueStorage {
  return {
    getItem: (key) => base.getItem(`${CUSTOMER_STORAGE_PREFIX}${key}`),
    setItem: (key, value) => base.setItem(`${CUSTOMER_STORAGE_PREFIX}${key}`, value),
    removeItem: (key) => base.removeItem(`${CUSTOMER_STORAGE_PREFIX}${key}`),
  }
}

// ─────────────────────────── 环境地址表 ───────────────────────────

export interface CustomerEnvironmentSpec {
  /** 已就绪的 HTTPS API 前缀；未就绪写 null。 */
  readonly apiBaseUrl: string | null
  /** 该环境是否允许加载本地演示样本。 */
  readonly allowsDemoData: boolean
}

/**
 * 环境地址表。
 *
 * `null` = **该环境尚未就绪**：一旦被选中就抛错，绝不回落到别的环境。
 * 未就绪原因（属事实记录，不是猜测）：
 *   - `test`：本地 Worker 入口是 `http://127.0.0.1:8787`（`backend/scripts/dev-server.mjs`），
 *     而小程序 `wx.request` 只接受**已登记的 HTTPS 域名**；开发工具虽设了 `urlCheck: false`，
 *     体验版/真机不认。且 `pc.huangqidong.cn` 挂在 Cloudflare、未做国内接入备案，不能作为合法域名。
 *   - `prod`：同上，备案域名不存在。
 * 拿到备案域名后，只需在**此处**填入地址，其余代码零改动。
 */
export const CUSTOMER_ENVIRONMENT_SPECS: Readonly<Record<CustomerEnvironmentName, CustomerEnvironmentSpec>> = {
  demo: { apiBaseUrl: null, allowsDemoData: true },
  test: { apiBaseUrl: null, allowsDemoData: false },
  prod: { apiBaseUrl: null, allowsDemoData: false },
}

/**
 * 按微信版本推断默认环境。
 * 体验版与正式版**不默认演示数据**：走查和上线的版本显示虚构商品，比打不开更糟。
 */
export function defaultEnvironmentFor(envVersion: MiniProgramEnvVersion): CustomerEnvironmentName {
  if (envVersion === 'release') return 'prod'
  if (envVersion === 'trial') return 'test'
  return 'demo'
}

/** 读取真实微信版本；非小程序运行时（含 `node --test`）返回 unknown。 */
export function readMiniProgramEnvVersion(): MiniProgramEnvVersion {
  try {
    const info = wx.getAccountInfoSync()
    const version = info?.miniProgram?.envVersion
    if (version === 'develop' || version === 'trial' || version === 'release') return version
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 解析当前环境。**这是全端唯一的「该连哪里」结论来源。**
 *
 * 三条守卫（每条都对应一种真实事故）：
 *   1. 正式版不得解析为 demo / test —— 防止上线版本连测试库或展示虚构数据。
 *   2. 真实模式缺 API 地址立即抛错 —— 防止静默回落演示样本。
 *   3. 真实模式地址必须是 HTTPS —— 与 `api-client.ts` 的既有校验一致，提前在这里失败。
 */
export function resolveCustomerEnvironment(input: CustomerEnvironmentInput = {}): CustomerEnvironment {
  const envVersion = input.envVersion ?? readMiniProgramEnvVersion()
  const name = input.name ?? defaultEnvironmentFor(envVersion)

  if (envVersion === 'release' && name !== 'prod') {
    throw new CustomerEnvironmentError(
      `正式版只能连生产环境，当前被要求解析为「${name}」。不要用演示或测试数据覆盖正式版。`,
    )
  }

  const spec = CUSTOMER_ENVIRONMENT_SPECS[name]
  const apiBaseUrl = input.apiBaseUrl === undefined ? spec.apiBaseUrl : input.apiBaseUrl

  if (name === 'demo') {
    if (!spec.allowsDemoData) {
      throw new CustomerEnvironmentError(`「${name}」环境不允许加载演示样本。`)
    }
    // demo 恒无地址：即使被显式传入也丢弃，避免演示模式误发真实请求。
    return { name, apiBaseUrl: null, demoData: true }
  }

  if (!apiBaseUrl) {
    throw new CustomerEnvironmentError(
      `「${name}」环境缺少 HTTPS API 地址：真实模式不回落演示数据。请在环境地址表补齐后重试。`,
    )
  }
  if (!/^https:\/\//.test(apiBaseUrl)) {
    throw new CustomerEnvironmentError(`「${name}」环境的 API 地址必须是 HTTPS，当前为「${apiBaseUrl}」。`)
  }
  return { name, apiBaseUrl, demoData: false }
}

/** 一行诊断文案，供启动日志与「尚未接入」提示复用。 */
export function describeCustomerEnvironment(environment: CustomerEnvironment): string {
  if (environment.demoData) {
    return '演示模式：门店、商品与记录均为本地固定样本，未连接在线服务。'
  }
  return `已连接在线服务（${environment.name}）。`
}
