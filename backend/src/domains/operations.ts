/**
 * 关键写动作的幂等执行器（T04）。
 *
 * 依据：docs/plans/2026-09-17-web-wechat-plan/04-data-and-api.md §7。
 * 机制已在真实 workerd + D1 上实测（见 docs/verification/2026-09-17-T04/README.md）：
 *
 *   1. D1 的 batch 是一个事务：中间任一条语句失败，整批回滚。
 *   2. 「条件 UPDATE 影响 0 行」不是 SQL 错误 —— 批次会继续执行后面的语句，
 *      于是静默产生半截账。这是本模块存在的唯一理由。
 *   3. 因此本模块把每一处「这件事必须发生过」都表达成硬约束冲突：
 *      · 唯一约束 / 部分唯一索引  → 幂等、有效预留、有效交付
 *      · CHECK 约束              → 数量与金额非负、累计不超额
 *      · assertion_guards 守卫    → 其余复合条件，并把契约错误码带进异常消息
 *   4. 不使用 Worker 内存锁，不写 BEGIN / COMMIT 伪事务。
 *
 * 调用约定：
 *   · plan 回调必须是同步的。它只负责「拼 SQL」，不再发起读取 ——
 *     §7 第 2 条要求版本与余量校验落在 SQL 条件 / 约束 / 触发器内，
 *     JS 里的提前读取只能用于友好提示。
 *   · plan 产出的 outcome 不能依赖自增主键（batch 内取不到自增 ID）。
 *     业务记录的 ID 由服务端在拼 SQL 之前生成，随语句一起写入。
 */

import { findErrorDefinition, isErrorCode, type ErrorCode } from '../generated/error-codes'

/** 只依赖 D1 的两个方法，便于测试传入替身。 */
export interface OperationsDb {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

export interface OperationContext {
  /** 门店主键；由会话派生，不采信客户端。 */
  storeId: number
  /** 操作人主键；由会话派生。 */
  actorUserId: number
  /** 客户端在用户确认动作时生成并保留。 */
  requestId: string
  /** 契约动作码，例如 `sales.orders.payments`。 */
  action: string
  /** 载荷摘要（不含原文），用于「同 ID 改载荷必须拒绝」。 */
  payloadHash: string
}

export interface OperationOutcome {
  entityType?: string
  entityId?: string
  /** 动作完成后的实体版本。 */
  version?: number
  /** 面向用户的中文摘要。 */
  summary?: string
  /** 关联副作用 ID，例如 receiptId / reservationId / cashEntryId。 */
  effects?: Record<string, unknown>
}

export interface OperationPlan {
  /** 业务语句。断言守卫必须紧跟在其所断言的那条语句之后。 */
  statements: D1PreparedStatement[]
  /** 成功结果，会随幂等记录一起落库。 */
  outcome: OperationOutcome
  /**
   * 约束片段 → 契约错误码。
   * 约束名是比错误消息文本更稳定的锚点；不在此表内的约束冲突走兜底规则。
   */
  constraintCodes?: Record<string, ErrorCode>
}

export interface ClassifiedError {
  code: ErrorCode
  message: string
  retryable: boolean
  httpStatus: number
  /** 约束冲突时能拿到当前版本则带上，供客户端展示 diff。 */
  currentVersion?: number
}

export interface RunSucceeded {
  ok: true
  /** true 表示命中已有幂等记录，本次没有再次执行副作用。 */
  reused: boolean
  requestId: string
  outcome: OperationOutcome
}

export interface RunFailed extends ClassifiedError {
  ok: false
  requestId: string
}

export type RunResult = RunSucceeded | RunFailed

/** 幂等记录自身的唯一约束：撞上它说明是并发重复，不是业务失败。 */
export const OPERATION_UNIQUE_FRAGMENT = 'operations.store_id, operations.request_id'

const VERSION_LOG_UNIQUE_FRAGMENT = 'entity_version_log'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`${label} 不是合法 SQL 标识符：${value}`)
  }
  return value
}

/**
 * 断言守卫：conditionFails 为真时插入一行，触发器随即中止整个批次。
 * conditionFails 是 SQL 片段，只允许由服务端代码拼接，不接受用户输入。
 * params 按 conditionFails 中占位符的出现顺序传入。
 */
export function guardStatement(
  db: OperationsDb,
  code: ErrorCode,
  conditionFails: string,
  ...params: (string | number | null)[]
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO assertion_guards (code) SELECT ? WHERE ${conditionFails}`)
    .bind(code, ...params)
}

/**
 * 版本推进 = 往版本日志插一行。
 *
 * 主键 (entity_type, entity_id, version) 就是断言本身：两个客户端从版本 N 同时推进到 N+1，
 * 只有一个能插入成功，另一个整批回滚并报 VERSION_CONFLICT。
 * 这比「条件 UPDATE 后检查影响行数」可靠 —— 后者在并发下会把别人的推进误判成自己的。
 */
export function bumpVersionStatement(
  db: OperationsDb,
  ctx: OperationContext,
  entityType: string,
  entityId: string,
  nextVersion: number,
): D1PreparedStatement {
  if (!Number.isInteger(nextVersion) || nextVersion <= 0) {
    throw new Error(`nextVersion 必须是正整数，收到 ${nextVersion}`)
  }
  return db
    .prepare(
      `INSERT INTO entity_version_log (entity_type, entity_id, version, request_id, store_id, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(entityType, entityId, nextVersion, ctx.requestId, ctx.storeId, ctx.actorUserId)
}

/**
 * 断言业务表的版本列确实已经推进到 expectedVersion。
 *
 * 只用于「推进语句是条件更新」的场景：万一条件不匹配导致 0 行更新，
 * 这条守卫会把静默的半截账变成硬错误。
 */
export function assertRowVersionStatement(
  db: OperationsDb,
  code: ErrorCode,
  table: string,
  idColumn: string,
  id: string | number,
  expectedVersion: number,
): D1PreparedStatement {
  const safeTable = assertIdentifier(table, 'table')
  const safeColumn = assertIdentifier(idColumn, 'idColumn')
  return guardStatement(
    db,
    code,
    `NOT EXISTS (SELECT 1 FROM ${safeTable} WHERE ${safeColumn} = ? AND version = ?)`,
    id,
    expectedVersion,
  )
}

interface OperationRow {
  action: string
  payload_hash: string
  status: string
  result_json: string
  result_entity_type: string | null
  result_entity_id: string | null
  result_version: number | null
}

function failure(code: ErrorCode, requestId: string, message?: string, currentVersion?: number): RunFailed {
  const definition = findErrorDefinition(code)
  return {
    ok: false,
    requestId,
    code,
    message: message ?? definition?.meaning ?? '操作失败',
    httpStatus: definition?.httpStatus ?? 500,
    retryable: definition?.retryable ?? false,
    ...(currentVersion === undefined ? {} : { currentVersion }),
  }
}

function outcomeFromRow(row: OperationRow): OperationOutcome {
  let parsed: OperationOutcome = {}
  try {
    const value = JSON.parse(row.result_json)
    if (value && typeof value === 'object') parsed = value as OperationOutcome
  } catch {
    // result_json 只有本模块写入；解析失败说明数据被外部破坏，按空结果返回即可，
    // 但不能因此谎报成功 —— 调用方仍会看到 reused=true 与原实体 ID。
  }
  return {
    ...parsed,
    ...(row.result_entity_type ? { entityType: row.result_entity_type } : {}),
    ...(row.result_entity_id ? { entityId: row.result_entity_id } : {}),
    ...(row.result_version === null ? {} : { version: row.result_version }),
  }
}

/**
 * 读取既有幂等记录并按契约规则处置：
 *   同 ID 同载荷 → 复用原结果；同 ID 改载荷 → IDEMPOTENCY_MISMATCH。
 */
function resumeExisting(row: OperationRow, ctx: OperationContext): RunResult {
  if (row.action !== ctx.action || row.payload_hash !== ctx.payloadHash) {
    return failure(
      'IDEMPOTENCY_MISMATCH',
      ctx.requestId,
      '同一 requestId 已用于不同的动作或不同的载荷，已中止；请勿更换 ID 重复提交',
    )
  }
  if (row.status !== 'succeeded') {
    // T04 的实现是同步事务：只有成功才落库，因此这里不该出现 pending。
    return failure('SERVICE_UNAVAILABLE', ctx.requestId, '该请求的处理结果尚未确认，请稍后查询')
  }
  return { ok: true, reused: true, requestId: ctx.requestId, outcome: outcomeFromRow(row) }
}

async function readOperation(
  db: OperationsDb,
  storeId: number,
  requestId: string,
): Promise<OperationRow | null> {
  const row = await db
    .prepare(
      `SELECT action, payload_hash, status, result_json,
              result_entity_type, result_entity_id, result_version
       FROM operations WHERE store_id = ? AND request_id = ?`,
    )
    .bind(storeId, requestId)
    .first<OperationRow>()
  return row ?? null
}

/**
 * 把 D1 抛出的异常翻译成契约错误码。
 *
 * 优先顺序：
 *   1. assertion_guards 触发器带出的错误码（最精确）
 *   2. plan 显式声明的「约束片段 → 错误码」
 *   3. 通用兜底（CHECK / FOREIGN KEY 属于调用方数据问题；其余视为服务暂不可用）
 */
export function classifyDatabaseError(
  error: unknown,
  constraintCodes: Record<string, ErrorCode> = {},
): ClassifiedError {
  const text = error instanceof Error ? `${error.message}` : String(error)

  // 1. RAISE(ABORT, NEW.code) —— 消息形如 "D1_ERROR: VERSION_CONFLICT: SQLITE_CONSTRAINT ..."
  const raised = text.match(/D1_ERROR:\s*([A-Z][A-Z0-9_]+):\s*SQLITE_CONSTRAINT/)
  if (raised && isErrorCode(raised[1])) {
    const definition = findErrorDefinition(raised[1])!
    return {
      code: definition.code,
      message: definition.meaning,
      retryable: definition.retryable,
      httpStatus: definition.httpStatus,
    }
  }

  // 2. 调用方声明的约束映射（长片段优先，避免子串误匹配）
  const entries = Object.entries(constraintCodes).sort((a, b) => b[0].length - a[0].length)
  for (const [fragment, code] of entries) {
    if (text.includes(fragment)) {
      const definition = findErrorDefinition(code)
      if (!definition) continue
      return {
        code: definition.code,
        message: definition.meaning,
        retryable: definition.retryable,
        httpStatus: definition.httpStatus,
      }
    }
  }

  // 3. 兜底
  if (text.includes('CHECK constraint failed') || text.includes('FOREIGN KEY constraint failed')) {
    const definition = findErrorDefinition('VALIDATION_ERROR')!
    return {
      code: definition.code,
      message: definition.meaning,
      retryable: definition.retryable,
      httpStatus: definition.httpStatus,
    }
  }

  const definition = findErrorDefinition('SERVICE_UNAVAILABLE')!
  return {
    code: definition.code,
    message: definition.meaning,
    retryable: definition.retryable,
    httpStatus: definition.httpStatus,
  }
}

/** 落一条脱敏失败诊断。失败本身不影响主流程，也不代表动作失败之外的任何账务事实。 */
async function recordFailure(
  db: OperationsDb,
  ctx: OperationContext,
  code: ErrorCode,
  diagnostic: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO operation_failures
           (store_id, request_id, action, actor_user_id, payload_hash, error_code, diagnostic)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ctx.storeId, ctx.requestId, ctx.action, ctx.actorUserId, ctx.payloadHash, code, diagnostic.slice(0, 500))
      .run()
  } catch {
    // 诊断写入失败不得掩盖真正的业务错误；契约 §7 第 8 条允许不写诊断。
  }
}

/**
 * 执行一个关键写动作。
 *
 * 幂等记录、断言守卫、业务语句、版本推进、成功结果在同一个 batch 内写入，
 * 因此「副作用恰好一次」由数据库保证，而不是由调用方小心程度保证。
 */
export async function runIdempotent(
  db: OperationsDb,
  ctx: OperationContext,
  plan: (context: OperationContext) => OperationPlan,
): Promise<RunResult> {
  if (!ctx.requestId) {
    return failure('VALIDATION_ERROR', ctx.requestId, '缺少 requestId')
  }

  const existing = await readOperation(db, ctx.storeId, ctx.requestId)
  if (existing) {
    // 已有记录且载荷一致 → 直接复用；载荷不同 → 冲突。
    if (existing.action === ctx.action && existing.payload_hash === ctx.payloadHash) {
      return resumeExisting(existing, ctx)
    }
    // 载荷不一致时不能再往下走，也不允许换 ID 重试。
    await recordFailure(db, ctx, 'IDEMPOTENCY_MISMATCH', `${existing.action} -> ${ctx.action}`)
    return resumeExisting(existing, ctx)
  }

  const { statements, outcome, constraintCodes } = plan(ctx)

  const resultJson = JSON.stringify({
    summary: outcome.summary,
    effects: outcome.effects,
  })

  const batch = [
    db
      .prepare(
        `INSERT INTO operations
           (store_id, request_id, action, actor_user_id, payload_hash, status,
            result_json, result_entity_type, result_entity_id, result_version)
         VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`,
      )
      .bind(
        ctx.storeId,
        ctx.requestId,
        ctx.action,
        ctx.actorUserId,
        ctx.payloadHash,
        resultJson,
        outcome.entityType ?? null,
        outcome.entityId ?? null,
        outcome.version ?? null,
      ),
    ...statements,
  ]

  try {
    await db.batch(batch)
  } catch (error) {
    const classified = classifyDatabaseError(error, {
      [OPERATION_UNIQUE_FRAGMENT]: 'SERVICE_UNAVAILABLE',
      ...constraintCodes,
    })

    // 并发重复：另一个请求先写入了同一个 (store_id, requestId)。
    // 不能就此报错 —— 契约要求同 ID 同载荷复用原结果。
    if (`${error instanceof Error ? error.message : error}`.includes(OPERATION_UNIQUE_FRAGMENT)) {
      const winner = await readOperation(db, ctx.storeId, ctx.requestId)
      if (winner) return resumeExisting(winner, ctx)
    }

    await recordFailure(db, ctx, classified.code, String(error instanceof Error ? error.message : error))
    return failure(classified.code, ctx.requestId, classified.message, classified.currentVersion)
  }

  return { ok: true, reused: false, requestId: ctx.requestId, outcome }
}

/**
 * 计算载荷摘要。用 JSON 稳定序列化（键排序）避免字段顺序造成假冲突。
 * 这是摘要不是加密；它只需要稳定、不可被业务误读为原文。
 */
export async function hashPayload(payload: unknown): Promise<string> {
  const canonical = stableStringify(payload)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface OperationQueryResult {
  found: boolean
  status?: 'pending' | 'succeeded'
  outcome?: OperationOutcome
  /**
   * 记录存在但与本次查询携带的动作 / 载荷摘要不一致。
   * 查询接口本身不做拦截，由调用方决定如何提示。
   */
  mismatch?: boolean
}

/**
 * 查询某个 requestId 的处置结果 —— 对应契约的 GET /operations/:requestId。
 *
 * 这是「网络超时 ≠ 失败」的落点：客户端在超时后先查这里，
 * status=succeeded 就按原结果继续，不要贸然重发。
 */
export async function queryOperation(
  db: OperationsDb,
  storeId: number,
  requestId: string,
  expected?: { action: string; payloadHash: string },
): Promise<OperationQueryResult> {
  const row = await readOperation(db, storeId, requestId)
  if (!row) return { found: false }

  const mismatch = expected
    ? row.action !== expected.action || row.payload_hash !== expected.payloadHash
    : false

  return {
    found: true,
    status: row.status === 'succeeded' ? 'succeeded' : 'pending',
    outcome: outcomeFromRow(row),
    mismatch,
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}
