/**
 * T03a · 身份域：微信绑定码、openid 交换、会话版本轮转。
 *
 * 规格依据（契约冻结点）：
 *   · contracts/v1/actions.json A01 `/auth/wechat/login`  inputs: code:string!, bindingCode:string?
 *     —— 「openid 不是业务 token，未绑定不获任何门店权限」；已绑定时只凭新的微信凭证登录
 *   · 同文件 A02 `/auth/wechat/binding-codes`  inputs: memberId:int!
 *     —— 「有期限、一次使用；数据库只存摘要，限尝试次数」
 *   · 同文件 A03 `/auth/logout` —— 「会话撤销复用现有 token_version 机制」
 *   · 同文件 A04 `/me` —— 返回 user / store / permissions / sessionVersion / capabilities
 *
 * 三条硬约束（本模块自己遵守，也要求调用方遵守）：
 *   1. **明文绑定码只在生成这一次出现**，库里只有 SHA-256 摘要；
 *   2. **不新增错误码**：一律映射到契约既有码（见 code → httpStatus 表），
 *      不为了内部方便往契约里塞新码（那属于新增规范性表面，须提 contractVersion）；
 *   3. **不依赖「条件 UPDATE 影响了几行」**（T04 的血泪：D1 里 0 行不是报错，
 *      batch 会继续往下走，静默产生半截账）。所有"抢到了没有"一律：
 *      UPDATE + SELECT 复核，或者干脆让唯一约束成为断言。
 *
 * 尚未接线：本模块现在没有被任何 HTTP 路由调用，处于「地基已验证、未接入」状态。
 * 接线属于下一步（T03a 的路由层），那时才动 index.ts 的请求入口。
 */

import { signJWT } from './session'

/** 契约既有错误码 → HTTP 状态。新增码前先看这里能不能复用。 */
const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  SESSION_REVOKED: 401,
  PERMISSION_DENIED: 403,
  ENTITY_NOT_FOUND: 404,
} as const

export type IdentityErrorCode = keyof typeof ERROR_STATUS

/** 身份域的失败一律抛这个；调用方把它翻译成契约错误响应。 */
export class IdentityFailure extends Error {
  readonly code: IdentityErrorCode
  readonly httpStatus: number

  constructor(code: IdentityErrorCode, message: string) {
    super(message)
    this.name = 'IdentityFailure'
    this.code = code
    this.httpStatus = ERROR_STATUS[code]
  }
}

/** Crockford base32：去掉手抄时容易看混的 I / L / O / U，店员照着念也不容易出错。 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8
const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 5

type MemberRow = {
  id: number
  store_id: number
  user_id: number
  status: string
}

type BindingCodeRow = {
  id: number
  member_id: number
  store_id: number
  status: string
  attempt_count: number
  max_attempts: number
  expires_at_ms: number
  consumed_by_openid: string | null
}

function randomCode(): string {
  // 256 % 32 === 0，取模无偏，每个字符等概率
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  let out = ''
  for (const byte of bytes) out += CODE_ALPHABET[byte % 32]
  return out
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function nowMs(fixed?: number): number {
  return fixed ?? Date.now()
}

/**
 * A02 · 生成绑定码。
 *
 * 返回体里的 plaintext code 是**唯一一次**出现明文的时机，调用方必须原样给到生成者（老板），
 * 不得写日志、不得入库、不得回显第二次。
 * 同一成员若已有 pending 码，会把旧的作废（revoked）再发新的 —— 老板重复点也没关系。
 */
export async function createBindingCode(
  db: D1Database,
  input: {
    appid: string
    storeId: number
    memberId: number
    actorUserId: number
    ttlMs?: number
    maxAttempts?: number
    at?: number
  },
): Promise<{ codeId: number; code: string; expiresAtMs: number; expiresAt: string }> {
  const appid = String(input.appid ?? '').trim()
  if (!appid) throw new IdentityFailure('VALIDATION_ERROR', '缺少 appid')
  if (!Number.isInteger(input.memberId) || input.memberId <= 0) {
    throw new IdentityFailure('VALIDATION_ERROR', 'memberId 必须是正整数')
  }

  const member = await db
    .prepare('SELECT id, store_id, user_id, status FROM store_members WHERE id = ?')
    .bind(input.memberId)
    .first<MemberRow>()

  // 成员不存在、或不属于本店：一律 404，不区分 —— 否则能拿这个接口跨店探测哪些 memberId 存在
  if (!member || member.store_id !== input.storeId) {
    throw new IdentityFailure('ENTITY_NOT_FOUND', '成员不存在或不属于当前门店')
  }
  if (member.status !== 'active') {
    throw new IdentityFailure('PERMISSION_DENIED', '成员已停用，不能生成绑定码')
  }

  const issuedAt = nowMs(input.at)
  const expiresAtMs = issuedAt + (input.ttlMs ?? DEFAULT_TTL_MS)
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const code = randomCode()
  const codeHash = await sha256Hex(code)

  // 先作废该成员的旧 pending 码：唯一索引只认 pending 行，先改左
  // 状态再插入，避免「上次发的码还挂着，这次生成不了」。
  await db
    .prepare(`UPDATE wechat_binding_codes SET status = 'revoked' WHERE member_id = ? AND status = 'pending'`)
    .bind(member.id)
    .run()

  const insert = db
    .prepare(
      `INSERT INTO wechat_binding_codes
         (appid, store_id, member_id, code_hash, status, attempt_count, max_attempts, expires_at_ms, expires_at, created_by)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, datetime(?, 'unixepoch'), ?)`,
    )
    .bind(appid, member.store_id, member.id, codeHash, maxAttempts, expiresAtMs, Math.floor(expiresAtMs / 1000), input.actorUserId)
  await insert.run()

  // 不用 RETURNING（避开 D1 版本差异）：code_hash 本来就唯一，插完按它回读 id 同样确定。
  const created = await db
    .prepare('SELECT id FROM wechat_binding_codes WHERE code_hash = ?')
    .bind(codeHash)
    .first<{ id: number }>()

  if (!created?.id) throw new IdentityFailure('VALIDATION_ERROR', '绑定码写入失败')

  return {
    codeId: created.id,
    code,
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
  }
}

/**
 * A01 · 用绑定码把 openid 绑到门店成员。
 *
 * 失败时：码不存在 / 已用过 / 已过期 / 尝试次数用完，对外一律返回同一个 404 ——
 * 404：**不告诉对方到底是哪一种**，否则这接口就成了绑定码枚举器。
 */
export async function bindWechatIdentity(
  db: D1Database,
  input: { appid: string; openid: string; code: string; at?: number },
): Promise<{ memberId: number; storeId: number; userId: number }> {
  const openid = String(input.openid ?? '').trim()
  const code = String(input.code ?? '').trim()
  if (!openid) throw new IdentityFailure('VALIDATION_ERROR', '缺少 openid')
  if (!code) throw new IdentityFailure('VALIDATION_ERROR', '缺少绑定码')

  const codeHash = await sha256Hex(code)
  const row = await db
    .prepare(
      `SELECT id, member_id, store_id, status, attempt_count, max_attempts, expires_at_ms, consumed_by_openid
         FROM wechat_binding_codes
        WHERE appid = ? AND code_hash = ?`,
    )
    .bind(input.appid, codeHash)
    .first<BindingCodeRow>()

  const usable =
    row &&
    row.status === 'pending' &&
    row.expires_at_ms > nowMs(input.at) &&
    row.attempt_count < row.max_attempts

  if (!usable || !row) {
    // ⚠️ 已知局限：因为库里只有摘要，**猜错的码查不到任何行**，也就没法给它计数。
    // 所以这里的 attempt_count 只能覆盖「定位得到这条码」的重复提交，挡不住枚举式瞎猜；
    // 枚举防护必须在网关层按来源限流（契约错误码 RATE_LIMITED 就是给这层的）——已登记 OPEN-ITEMS G-19。
    if (row && row.status === 'pending' && row.expires_at_ms > nowMs(input.at)) {
      await db
        .prepare('UPDATE wechat_binding_codes SET attempt_count = attempt_count + 1 WHERE id = ? AND attempt_count < max_attempts')
        .bind(row.id)
        .run()
    }
    throw new IdentityFailure('ENTITY_NOT_FOUND', '绑定码无效、已使用或已过期')
  }

  const member = await db
    .prepare('SELECT id, store_id, user_id, status FROM store_members WHERE id = ?')
    .bind(row.member_id)
    .first<MemberRow>()

  if (!member || member.store_id !== row.store_id) {
    throw new IdentityFailure('ENTITY_NOT_FOUND', '成员不存在或已变更门店')
  }
  if (member.status !== 'active') {
    throw new IdentityFailure('PERMISSION_DENIED', '成员已停用，不能绑定微信')
  }

  const consumeAtMs = nowMs(input.at)

  // 一个 batch = 一个事务。两条唯一索引就是我们的断言：
  //   · UNIQUE(appid, openid)            —— 同一个微信不可能绑两次；
  //   · UNIQUE(member_id) WHERE active   —— 一个成员只可能有一张有效工牌。
  // 抢不到时整批回滚，不会出现「码消耗了但没绑上」的半截账。
  const statements = [
    db
      .prepare(
        `UPDATE wechat_binding_codes
            SET status = 'consumed', consumed_at = datetime(?, 'unixepoch'), consumed_by_openid = ?
          WHERE id = ? AND status = 'pending' AND expires_at_ms > ? AND attempt_count < max_attempts`,
      )
      .bind(Math.floor(consumeAtMs / 1000), openid, row.id, consumeAtMs),
    db
      .prepare(
        `INSERT INTO wechat_identity_bindings (appid, openid, member_id, store_id, user_id, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
      )
      .bind(input.appid, openid, member.id, member.store_id, member.user_id),
  ]

  try {
    await db.batch(statements)
  } catch (error) {
    const message = String((error as Error)?.message ?? error)
    if (message.includes('UNIQUE') && message.includes('openid')) {
      throw new IdentityFailure('ENTITY_NOT_FOUND', '该微信已在店内绑定过成员')
    }
    if (message.includes('UNIQUE')) {
      throw new IdentityFailure('PERMISSION_DENIED', '成员已绑定其他微信')
    }
    throw error
  }

  // UPDATE 之后再读一次确认是**自己**拿下的：并发的另一个请求可能先把这行改了，
  // 那时 consumed_by_openid 不是自己，必须判失败（不靠 changes()，靠数据本身）。
  const consumed = await db
    .prepare('SELECT id, status, consumed_by_openid FROM wechat_binding_codes WHERE id = ?')
    .bind(row.id)
    .first<{ id: number; status: string; consumed_by_openid: string | null }>()

  if (!consumed || consumed.status !== 'consumed' || consumed.consumed_by_openid !== openid) {
    throw new IdentityFailure('ENTITY_NOT_FOUND', '绑定码已被使用')
  }

  return { memberId: member.id, storeId: member.store_id, userId: member.user_id }
}

/** A01（已绑定分支）· 查 openid 对应的身份。返回 null = 这个微信还没绑过任何门店成员。 */
export async function resolveBoundIdentity(
  db: D1Database,
  input: { appid: string; openid: string },
): Promise<{
  memberId: number
  storeId: number
  userId: number
  memberStatus: string
  userStatus: string
  sessionVersion: number
} | null> {
  const row = await db
    .prepare(
      `SELECT b.member_id, b.store_id, b.user_id, m.status AS member_status,
              u.status AS user_status, u.token_version AS session_version
         FROM wechat_identity_bindings b
         JOIN store_members m ON m.id = b.member_id
         JOIN users u ON u.id = b.user_id
        WHERE b.appid = ? AND b.openid = ? AND b.status = 'active'`,
    )
    .bind(input.appid, input.openid)
    .first<{
      member_id: number
      store_id: number
      user_id: number
      member_status: string
      user_status: string
      session_version: number
    }>()

  if (!row) return null

  return {
    memberId: row.member_id,
    storeId: row.store_id,
    userId: row.user_id,
    memberStatus: row.member_status,
    userStatus: row.user_status,
    sessionVersion: row.session_version,
  }
}

/**
 * A03 · 登出 / 撤权：把 users.token_version 往前推一格。
 * 所有仍在外的旧凭证从此失效（loadAuthContext 会拿 token 里的 tv 跟表里比对）。
 */
export async function rotateSessionVersion(db: D1Database, userId: number): Promise<number> {
  await db
    .prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?')
    .bind(userId)
    .run()

  const row = await db
    .prepare('SELECT token_version FROM users WHERE id = ?')
    .bind(userId)
    .first<{ token_version: number }>()

  if (!row) throw new IdentityFailure('AUTH_REQUIRED', '账号不存在')
  return row.token_version
}

/**
 * 为已绑定的身份签发会话凭证。
 * 载荷与旧后台完全一致（uid / email / sid / tv），所以新旧入口签出的凭证可以互认。
 */
export async function issueIdentityToken(
  secret: string,
  identity: { userId: number; storeId: number; email: string; sessionVersion: number },
): Promise<string> {
  return signJWT({ uid: identity.userId, email: identity.email, sid: identity.storeId, tv: identity.sessionVersion }, secret)
}
