// DO NOT EDIT — 本文件由 backend/scripts/sync-error-codes.mjs 生成。
// 来源：contracts/v1.2/errors.json（v1.2，T26a 冻结，21 个错误码）。
// 重新生成：node backend/scripts/sync-error-codes.mjs
// 校验漂移：node backend/scripts/sync-error-codes.mjs --check
//
// 结果未知时的处置见契约 unknownResultProcedure：保存 requestId 与载荷摘要，
// 再以操作结果查询接口确认，不把「网络超时」当作失败。

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'SESSION_REVOKED'
  | 'PERMISSION_DENIED'
  | 'ENTITY_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'STOCK_CONFLICT'
  | 'PURCHASE_PAYMENT_CONFLICT'
  | 'IDEMPOTENCY_MISMATCH'
  | 'CHECKLIST_INCOMPLETE'
  | 'SERIAL_MISMATCH'
  | 'BALANCE_EXCEEDED'
  | 'PURCHASE_CANCEL_EXCEEDED'
  | 'OFFSET_EXCEEDED'
  | 'OWNERSHIP_INVALID'
  | 'INSPECTION_REQUIRED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'CUSTOMER_CODE_INVALID'
  | 'CUSTOMER_IDENTITY_REVOKED'
  | 'CUSTOMER_CLAIM_REQUIRED'

export interface ErrorDefinition {
  httpStatus: number
  code: ErrorCode
  retryable: boolean
  meaning: string
}

export const ERROR_DEFINITIONS: readonly ErrorDefinition[] = [
  { httpStatus: 400, code: 'VALIDATION_ERROR', retryable: false, meaning: '字段无效，或金额不是整数分' },
  { httpStatus: 401, code: 'AUTH_REQUIRED', retryable: true, meaning: '未登录或登录已失效' },
  { httpStatus: 401, code: 'SESSION_REVOKED', retryable: true, meaning: '会话被撤权' },
  { httpStatus: 403, code: 'PERMISSION_DENIED', retryable: false, meaning: '无该动作权限' },
  { httpStatus: 404, code: 'ENTITY_NOT_FOUND', retryable: false, meaning: '不存在或不属于当前可见范围' },
  { httpStatus: 409, code: 'VERSION_CONFLICT', retryable: false, meaning: '对象已被更新' },
  { httpStatus: 409, code: 'STOCK_CONFLICT', retryable: false, meaning: '无足量库存，或指定实物已被占用' },
  { httpStatus: 409, code: 'PURCHASE_PAYMENT_CONFLICT', retryable: false, meaning: '采购已有净付款，不能直接取消未到数量' },
  { httpStatus: 409, code: 'IDEMPOTENCY_MISMATCH', retryable: false, meaning: '同一 requestId 对应不同动作或不同载荷' },
  { httpStatus: 422, code: 'CHECKLIST_INCOMPLETE', retryable: false, meaning: '交付材料不足，检查项未完成' },
  { httpStatus: 422, code: 'SERIAL_MISMATCH', retryable: false, meaning: 'SN 与商品或订单数量不匹配' },
  { httpStatus: 422, code: 'BALANCE_EXCEEDED', retryable: false, meaning: '超收、超退或超出可退现金上限' },
  { httpStatus: 422, code: 'PURCHASE_CANCEL_EXCEEDED', retryable: false, meaning: '取消数量超过采购单尚未处置的数量' },
  { httpStatus: 422, code: 'OFFSET_EXCEEDED', retryable: false, meaning: '折抵累计超出应收或应付' },
  { httpStatus: 422, code: 'OWNERSHIP_INVALID', retryable: false, meaning: '对象非门店所有，或所有权尚未取得' },
  { httpStatus: 422, code: 'INSPECTION_REQUIRED', retryable: false, meaning: '尚未验机或整备门槛未达成' },
  { httpStatus: 429, code: 'RATE_LIMITED', retryable: true, meaning: '请求过频' },
  { httpStatus: 503, code: 'SERVICE_UNAVAILABLE', retryable: true, meaning: '服务暂不可用' },
  { httpStatus: 401, code: 'CUSTOMER_CODE_INVALID', retryable: true, meaning: '顾客微信登录凭证无效：code 缺失、重复使用、已过期，或与当前 AppID 不匹配' },
  { httpStatus: 401, code: 'CUSTOMER_IDENTITY_REVOKED', retryable: true, meaning: '顾客微信身份已解绑，或该顾客的会话版本已被递增' },
  { httpStatus: 403, code: 'CUSTOMER_CLAIM_REQUIRED', retryable: false, meaning: '微信身份有效，但尚未认领到门店客户档案，或认领被驳回' },
]

const byCode = new Map<string, ErrorDefinition>()
for (const definition of ERROR_DEFINITIONS) {
  byCode.set(definition.code, definition)
}

/** 按错误码取定义；未知码返回 undefined，调用方必须自行兜底。 */
export function findErrorDefinition(code: string): ErrorDefinition | undefined {
  return byCode.get(code)
}

/** 判断任意字符串是否为契约内已登记的错误码。 */
export function isErrorCode(value: string): value is ErrorCode {
  return byCode.has(value)
}
