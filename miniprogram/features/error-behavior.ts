/**
 * T03b · 错误码 → 客户端行为（微信小程序端）。
 *
 * 为什么单独有这一个文件：
 *   契约 `errors.json` 只把「客户端处理」写成**给人看的文本**（clientHandling），
 *   而生成物 `errors.ts` 自己声明「程序分支只能依据 code，不得匹配 message 文本」。
 *   于是请求层需要一份**结构化的** code → 行为映射，本文件就是它。
 *
 * ⚠️ 本文件与 `frontend/src/api/error-behavior.ts` 必须逐项一致。
 *   由 `node contracts/tools/check-client-parity.mjs` 强制比对 ——
 *   T-10 的教训是「两端口径两份独立实现且无机器门禁」，那等于迟早漂移。
 *
 * ⚠️ 本文件只允许 `import type`，不得引入任何运行时依赖：
 *   门禁脚本用 Node 直接加载它（类型擦除后 import type 消失，不产生解析负担）。
 *   因此 ErrorCode 的覆盖由编译期（Record<ErrorCode, …>）与门禁双重保证。
 *
 * 规格依据：
 *   contracts/v1/errors.json（rules / unknownResultProcedure / errors）
 *   03-domain-rules.md §1 R07、§8 L194（撤权后两端旧会话都须失效）
 *   04-data-and-api.md §4 L75、§6 L128–L143
 */

import type { ErrorCode } from '../contracts/generated/errors'

/**
 * 客户端可执行的行为标签。
 * 这些是**程序依据**，不是展示文案；展示文案与服务端 message 的取舍见 fallbackMessage。
 */
export type ClientAction =
  /** 保留用户输入，在字段附近提示（禁止清空表单） */
  | 'keep-input'
  /** 清除身份缓存 */
  | 'clear-session'
  /** 清除本地草稿（撤权场景） */
  | 'clear-drafts'
  /** 跳转登录，并记住原目标页以便登录后恢复 */
  | 'goto-login'
  /** 明确不自动重试 */
  | 'no-auto-retry'
  /** 返回列表；不泄露其他店实体是否存在 */
  | 'back-to-list'
  /** 重新拉取该实体最新版本后再决定 */
  | 'reload-entity'
  /** 重新拉取余额后再提交 */
  | 'refetch-balance'
  /** 跳到对应核对项 */
  | 'goto-checklist'
  /** 展示前置步骤（回收 / 验机 / 整备） */
  | 'show-precondition'
  /** 保留本轮 requestId 与载荷摘要作为诊断，不得自动换 ID 重发 */
  | 'keep-diagnostics'
  /** 按响应等待提示等待后重试 */
  | 'wait-and-retry'
  /** 以原 requestId 查询操作结果（只对写动作有意义） */
  | 'query-operation'

export interface ErrorHandling {
  /** 是否属于「可重试」类（契约 errors.json 的 retryable，门禁逐项比对） */
  readonly retryable: boolean
  /** 程序依据：这个错误码要触发哪些客户端行为 */
  readonly actions: readonly ClientAction[]
  /**
   * 兜底文案：服务端响应**没有**给出 message 时才使用。
   * 服务端 message 永远优先（契约：code 决定行为，message 是中文说明）。
   */
  readonly fallbackMessage: string
}

/**
 * 契约错误码的完整行为表（数量随契约变化）。
 * 用 `Record<ErrorCode, ErrorHandling>` 是为了让 tsc 强制「不多不少」覆盖契约全部取值 ——
 * 契约新增错误码时这里会编译失败，而不是静默漏掉。
 */
export const ERROR_HANDLING: Record<ErrorCode, ErrorHandling> = {
  VALIDATION_ERROR: {
    retryable: false,
    actions: ['keep-input', 'no-auto-retry'],
    fallbackMessage: '字段无效，或金额不是整数分',
  },
  AUTH_REQUIRED: {
    retryable: true,
    actions: ['clear-session', 'goto-login', 'no-auto-retry'],
    fallbackMessage: '未登录或登录已失效',
  },
  SESSION_REVOKED: {
    retryable: true,
    actions: ['clear-session', 'clear-drafts', 'goto-login', 'no-auto-retry'],
    fallbackMessage: '会话被撤权',
  },
  PERMISSION_DENIED: {
    retryable: false,
    actions: ['no-auto-retry'],
    fallbackMessage: '无该动作权限',
  },
  ENTITY_NOT_FOUND: {
    retryable: false,
    actions: ['back-to-list', 'no-auto-retry'],
    fallbackMessage: '不存在或不属于当前可见范围',
  },
  VERSION_CONFLICT: {
    retryable: false,
    actions: ['reload-entity', 'no-auto-retry'],
    fallbackMessage: '对象已被更新',
  },
  STOCK_CONFLICT: {
    retryable: false,
    actions: ['keep-input', 'no-auto-retry'],
    fallbackMessage: '无足量库存，或指定实物已被占用',
  },
  IDEMPOTENCY_MISMATCH: {
    retryable: false,
    actions: ['keep-diagnostics', 'no-auto-retry'],
    fallbackMessage: '同一 requestId 对应不同动作或不同载荷',
  },
  CHECKLIST_INCOMPLETE: {
    retryable: false,
    actions: ['goto-checklist', 'keep-input', 'no-auto-retry'],
    fallbackMessage: '交付材料不足，检查项未完成',
  },
  SERIAL_MISMATCH: {
    retryable: false,
    actions: ['goto-checklist', 'keep-input', 'no-auto-retry'],
    fallbackMessage: 'SN 与商品或订单数量不匹配',
  },
  BALANCE_EXCEEDED: {
    retryable: false,
    actions: ['refetch-balance', 'keep-input', 'no-auto-retry'],
    fallbackMessage: '超收、超退或超出可退现金上限',
  },
  OFFSET_EXCEEDED: {
    retryable: false,
    actions: ['refetch-balance', 'keep-input', 'no-auto-retry'],
    fallbackMessage: '折抵累计超出应收或应付',
  },
  PURCHASE_PAYMENT_CONFLICT: {
    retryable: false,
    actions: ['show-precondition', 'reload-entity', 'keep-input', 'no-auto-retry'],
    fallbackMessage: '采购已有净付款，不能直接取消未到数量',
  },
  PURCHASE_CANCEL_EXCEEDED: {
    retryable: false,
    actions: ['reload-entity', 'keep-input', 'no-auto-retry'],
    fallbackMessage: '取消数量超过采购单尚未处置的数量',
  },
  OWNERSHIP_INVALID: {
    retryable: false,
    actions: ['show-precondition', 'no-auto-retry'],
    fallbackMessage: '对象非门店所有，或所有权尚未取得',
  },
  INSPECTION_REQUIRED: {
    retryable: false,
    actions: ['show-precondition', 'no-auto-retry'],
    fallbackMessage: '尚未验机或整备门槛未达成',
  },
  RATE_LIMITED: {
    retryable: true,
    actions: ['wait-and-retry'],
    fallbackMessage: '请求过频',
  },
  SERVICE_UNAVAILABLE: {
    retryable: true,
    actions: ['wait-and-retry', 'query-operation'],
    fallbackMessage: '服务暂不可用',
  },
  // ── MP17 顾客身份（2026-09-23）────────────────────────────────────────
  // 顾客会话与员工会话是两条链路，故顾客的登录失效不复用 AUTH_REQUIRED / SESSION_REVOKED。
  CUSTOMER_CODE_INVALID: {
    retryable: true,
    // code 换 openid 失败：会话没建起来，清掉可能存在的半成品身份并重走登录。
    actions: ['clear-session', 'goto-login', 'no-auto-retry'],
    fallbackMessage: '顾客微信登录凭证无效：code 缺失、重复使用、已过期，或与当前 AppID 不匹配',
  },
  CUSTOMER_IDENTITY_REVOKED: {
    retryable: true,
    // 身份解绑 / 会话版本递增：与员工撤权同处理，连本地草稿一起清，避免新身份看到旧输入。
    actions: ['clear-session', 'clear-drafts', 'goto-login', 'no-auto-retry'],
    fallbackMessage: '顾客微信身份已解绑，或该顾客的会话版本已被递增',
  },
  CUSTOMER_CLAIM_REQUIRED: {
    retryable: false,
    // 未认领不是「没有记录」，必须走认领前置步骤；自动重试永远不会变绿。
    actions: ['show-precondition', 'no-auto-retry'],
    fallbackMessage: '微信身份有效，但尚未认领到门店客户档案，或认领被驳回',
  },
}

/** 结果未知（网络超时 / 断网 / 非契约响应）：没有可信 HTTP code，**不等于失败**。 */
export const UNKNOWN_RESULT_ACTIONS: readonly ClientAction[] = ['query-operation']

/** 未知结果时，读动作没有副作用，可以等待后重试。 */
export const UNKNOWN_RESULT_READ_ACTIONS: readonly ClientAction[] = ['wait-and-retry']

export interface DecideOptions {
  /** 是否为写动作。写动作的结果未知必须去查 operation，读动作可以直接重试。 */
  readonly isWrite: boolean
}

/**
 * 决定一个错误码应当触发哪些客户端行为。
 *
 * @param code 服务端返回的契约错误码；null / 未知取值为「结果未知」
 * @param options isWrite 决定是否启用 query-operation
 */
export function decideClientHandling(
  code: string | null | undefined,
  options: DecideOptions,
): readonly ClientAction[] {
  const known = code ? (ERROR_HANDLING as Record<string, ErrorHandling | undefined>)[code] : undefined
  if (!known) {
    return options.isWrite ? UNKNOWN_RESULT_ACTIONS : UNKNOWN_RESULT_READ_ACTIONS
  }
  // query-operation 只对写动作有意义：读动作没有副作用可查。
  return options.isWrite ? known.actions : known.actions.filter((a) => a !== 'query-operation')
}

/** 兜底文案。服务端给了 message 就用服务端的，本函数只在缺失时使用。 */
export function fallbackMessageFor(code: string | null | undefined): string {
  const known = code ? (ERROR_HANDLING as Record<string, ErrorHandling | undefined>)[code] : undefined
  return known ? known.fallbackMessage : '操作结果待确认'
}

/** 该 code 是否属于已知的可重试类。未知取值一律按不可自动重试处理。 */
export function isRetryableCode(code: string | null | undefined): boolean {
  const known = code ? (ERROR_HANDLING as Record<string, ErrorHandling | undefined>)[code] : undefined
  return known ? known.retryable : false
}
