// AUTO-GENERATED FROM contracts/v1 — DO NOT EDIT
// 生成命令：node contracts/tools/generate-dto.mjs
// 来源：contracts/v1/errors.json；程序分支只能依据 code，不得匹配 message 文本。

export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  SESSION_REVOKED: "SESSION_REVOKED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  ENTITY_NOT_FOUND: "ENTITY_NOT_FOUND",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  STOCK_CONFLICT: "STOCK_CONFLICT",
  IDEMPOTENCY_MISMATCH: "IDEMPOTENCY_MISMATCH",
  CHECKLIST_INCOMPLETE: "CHECKLIST_INCOMPLETE",
  SERIAL_MISMATCH: "SERIAL_MISMATCH",
  BALANCE_EXCEEDED: "BALANCE_EXCEEDED",
  OFFSET_EXCEEDED: "OFFSET_EXCEEDED",
  OWNERSHIP_INVALID: "OWNERSHIP_INVALID",
  INSPECTION_REQUIRED: "INSPECTION_REQUIRED",
  RATE_LIMITED: "RATE_LIMITED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export interface ErrorDefinition {
  code: ErrorCode
  httpStatus: number
  meaning: string
  clientHandling: string
  retryable: boolean
}
export const ERRORS: readonly ErrorDefinition[] = [
  { code: "VALIDATION_ERROR", httpStatus: 400, meaning: "字段无效，或金额不是整数分", clientHandling: "字段附近提示，保留输入", retryable: false },
  { code: "AUTH_REQUIRED", httpStatus: 401, meaning: "未登录或登录已失效", clientHandling: "清身份缓存，登录后重新取数据", retryable: true },
  { code: "SESSION_REVOKED", httpStatus: 401, meaning: "会话被撤权", clientHandling: "清身份缓存与本地草稿，重新登录", retryable: true },
  { code: "PERMISSION_DENIED", httpStatus: 403, meaning: "无该动作权限", clientHandling: "说明需老板处理，不重试", retryable: false },
  { code: "ENTITY_NOT_FOUND", httpStatus: 404, meaning: "不存在或不属于当前可见范围", clientHandling: "返回列表；不泄露其他店实体是否存在", retryable: false },
  { code: "VERSION_CONFLICT", httpStatus: 409, meaning: "对象已被更新", clientHandling: "展示最新摘要 / diff，用户确认后重新提交", retryable: false },
  { code: "STOCK_CONFLICT", httpStatus: 409, meaning: "无足量库存，或指定实物已被占用", clientHandling: "提示具体行，换件或重新分配；不得擅自替换成同型号其他实物", retryable: false },
  { code: "IDEMPOTENCY_MISMATCH", httpStatus: 409, meaning: "同一 requestId 对应不同动作或不同载荷", clientHandling: "中止，记录诊断；不能自动换 ID 重复扣款", retryable: false },
  { code: "CHECKLIST_INCOMPLETE", httpStatus: 422, meaning: "交付材料不足，检查项未完成", clientHandling: "跳到对应核对项", retryable: false },
  { code: "SERIAL_MISMATCH", httpStatus: 422, meaning: "SN 与商品或订单数量不匹配", clientHandling: "跳到对应核对项；重复 SN 进入人工核对", retryable: false },
  { code: "BALANCE_EXCEEDED", httpStatus: 422, meaning: "超收、超退或超出可退现金上限", clientHandling: "刷新余额并更正金额", retryable: false },
  { code: "OFFSET_EXCEEDED", httpStatus: 422, meaning: "折抵累计超出应收或应付", clientHandling: "刷新双方余额并更正折抵金额", retryable: false },
  { code: "OWNERSHIP_INVALID", httpStatus: 422, meaning: "对象非门店所有，或所有权尚未取得", clientHandling: "展示回收 / 收购前置步骤", retryable: false },
  { code: "INSPECTION_REQUIRED", httpStatus: 422, meaning: "尚未验机或整备门槛未达成", clientHandling: "展示检测 / 整备前置步骤", retryable: false },
  { code: "RATE_LIMITED", httpStatus: 429, meaning: "请求过频", clientHandling: "按响应等待提示，不批量重复写", retryable: true },
  { code: "SERVICE_UNAVAILABLE", httpStatus: 503, meaning: "服务暂不可用", clientHandling: "读可重试；写先查 operation 结果，再决定是否重发", retryable: true },
]

// 结果未知的处理流程：以原 requestId 查询 /operations/:requestId，不按失败直接重发新 ID。
export const UNKNOWN_RESULT_PROCEDURE: readonly string[] = ["保存 requestId 与载荷摘要。","以 GET /operations/:requestId 查询操作结果（路径以 T01b 冻结为准）。","status=succeeded 按原结果继续；status=failed 按错误码处理；仍 pending 则等待或提示稍后查询。","确需重发时使用相同 ID、相同载荷；载荷变更必须重新审核并使用新 ID。"]
