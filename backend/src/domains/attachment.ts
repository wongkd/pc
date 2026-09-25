/**
 * F1 · 附件基础（B35）领域：签发上传意图、接收文件字节、完成关联、孤立上传清理。
 *
 * 契约依据（contracts/v1）：
 *   actions.json  B35 附件上传（status=frozen，entity=Attachment，stateMachine=AttachmentUploadState）
 *                     POST /attachments/upload-intents            权限 attachment/upload
 *                     PUT  /attachments/upload-intents/:id/blob   权限 attachment/upload（F1 修订补入）
 *                     POST /attachments/upload-intents/:id/complete 权限 attachment/upload
 *   objects.json  Attachment（ownerEntityRef / purpose / objectKey / contentType / byteSize /
 *                 width / height / sha256 / uploadState / visibility）
 *   enums.json    AttachmentPurpose（product_reference / service_intake / recovery_evidence / delivery_evidence）
 *                 AttachmentUploadState（pending / uploaded / attached / failed / orphaned）
 *                 AttachmentVisibility（internal / customer_shared）
 *   actions.json  B35 inputs：ownerEntityRef / purpose / mime / byteSize / 文件完整性 sha256
 *                 B35 errors：VALIDATION_ERROR / RATE_LIMITED / PERMISSION_DENIED
 *
 * ── 硬边界（务必照做）──
 * 1. 对象存储与 D1 不构成同一事务（04 §7 第 9 条）。本模块的顺序**固定**为
 *    「先写对象存储，再更新 D1」：失败时留下的是可被保留期回收的孤儿对象，
 *    而不是「记录说已上传、存储里却没有」的假成功。反过来做无法补救。
 * 2. 业务记录只能引用 upload_state='attached' 的行。pending / uploaded 都不算已关联。
 * 3. 完整性由**服务端实算**：sha256、真实 mime（魔数）、实际字节数三项都自己算，
 *    客户端声明只用于比对与审计留痕。契约要求「校验类型、大小、归属」，只信声明等于没校验。
 * 4. 归属校验必须带 store_id：owner 实体既要存在，又要属于当前门店
 *    （04 §2「不能只检查父单」，泛化引用尤其容易被跨店挂靠）。
 * 5. 金额、库存、资金与本模块无关：不写 cash_entries，不动 stock_*，不产生任何账务副作用。
 * 6. ⚠️ visibility=customer_shared 的对外读取依赖**已备案域名**；R2 域名备不了案，
 *    所以顾客端（小程序）读取目前不可用。本模块先如实落库与标记，不假装对外可读。
 *
 * 本模块不做鉴权：storeId / actorUserId 由调用方从会话派生。权限码见路由层。
 */

import {
  bumpVersionStatement,
  guardStatement,
  hashPayload,
  queryOperation,
  runIdempotent,
  type OperationContext,
  type OperationPlan,
  type OperationsDb,
  type RunResult,
} from './operations'
import {
  ALLOWED_MIME,
  MAX_ATTACHMENT_BYTES,
  UPLOAD_INTENT_TTL_MS,
  sha256Hex,
  sniffMime,
  type StorageAdapter,
} from './storage'

// ─────────────────────────────────────────────────────────────────────────────
// 枚举常量：取值必须与 contracts/v1/enums.json 逐字一致。
// ─────────────────────────────────────────────────────────────────────────────

const ATTACHMENT_PURPOSES = [
  'product_reference',
  'service_intake',
  'recovery_evidence',
  'delivery_evidence',
  'document_export',
] as const
export type AttachmentPurpose = (typeof ATTACHMENT_PURPOSES)[number]

const ATTACHMENT_VISIBILITIES = ['internal', 'customer_shared'] as const
export type AttachmentVisibility = (typeof ATTACHMENT_VISIBILITIES)[number]

/**
 * 允许挂附件的业务对象类型 → 落点表。
 *
 * 契约的 ownerEntityRef 是**泛化引用**（04 §2），不写死成维修单：B35 的 uiRefs 是
 * 「接修」与「回收」，但 B19（隔离件待检判定）与交付证据同样要挂附件。
 * 表名在此集中登记，校验归属时一律带 store_id。
 */
const OWNER_ENTITY_TABLES: Record<string, string> = {
  service_order: 'service_orders',
  recovery_order: 'recovery_orders',
  stock_item: 'stock_items',
  sale_order: 'sale_orders',
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
}

// ─────────────────────────────────────────────────────────────────────────────
// 入参 / 出参
// ─────────────────────────────────────────────────────────────────────────────

export interface UploadIntentInput {
  ownerEntityType: string
  ownerEntityId: string
  purpose: string
  mime: string
  byteSize: number
  sha256?: string | null
  visibility?: string | null
}

export interface UploadIntentOutcome {
  attachmentId: string
  objectKey: string
  uploadPath: string
  expiresAt: string
  storageKind: string
  storagePersistent: boolean
  /** ⚠️ 顾客端对外读取依赖已备案域名；当前恒为 false，如实标注不假装可用。 */
  customerShareable: boolean
}

export interface CompleteInput {
  /** 完成确认时可重复声明归属；与签发时不一致则拒绝（防偷换目标）。 */
  ownerEntityType?: string | null
  ownerEntityId?: string | null
  width?: number | null
  height?: number | null
}

export interface BlobSuccess {
  ok: true
  attachmentId: string
  objectKey: string
  uploadState: string
  contentType: string
  byteSize: number
  sha256: string
}

export interface BlobFailure {
  ok: false
  code: 'VALIDATION_ERROR' | 'ENTITY_NOT_FOUND' | 'PERMISSION_DENIED' | 'VERSION_CONFLICT' | 'SERVICE_UNAVAILABLE'
  message: string
  httpStatus: number
}

export type BlobResult = BlobSuccess | BlobFailure

interface AttachmentRow {
  id: string
  object_key: string
  upload_state: string
  purpose: string
  visibility: string
  declared_mime: string
  declared_byte_size: number
  declared_sha256: string | null
  content_type: string | null
  byte_size: number | null
  sha256: string | null
  owner_entity_type: string | null
  owner_entity_id: string | null
  upload_token_hash: string
  expires_at: string
  version: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 上传凭证 = HMAC(secret, attachmentId)。
 *
 * 为什么不落库明文：附件 id 与 requestId 一一对应，凭证由附件 id 确定性派生，
 * 服务端随时可重算，因此 operations 的 result_json 里不必存凭证原文。
 * 表里另存一份 sha256 摘要，用于比对（也让密钥轮换后的旧意图自然失效）。
 */
export async function deriveUploadToken(secret: string, attachmentId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`attachment-upload:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(attachmentId))
  return base64url(new Uint8Array(signature))
}

/** 常数时间比较，避免用字符串提前返回泄露匹配长度。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function buildObjectKey(storeId: number, attachmentId: string, mime: string): string {
  const ext = MIME_EXTENSIONS[mime] ?? 'bin'
  // objectKey 由服务端拼接，带门店前缀；客户端不参与命名（契约 rules：外链不能随意由客户端指定）。
  return `attachments/store-${storeId}/${attachmentId}.${ext}`
}

function validateIntentInput(input: UploadIntentInput): string | null {
  if (!OWNER_ENTITY_TABLES[input.ownerEntityType]) {
    return `归属对象类型不合法（可用：${Object.keys(OWNER_ENTITY_TABLES).join(' / ')}）`
  }
  if (!input.ownerEntityId || !input.ownerEntityId.trim()) return '缺少归属对象编号'
  if (!ATTACHMENT_PURPOSES.includes(input.purpose as AttachmentPurpose)) {
    return `用途不合法（可用：${ATTACHMENT_PURPOSES.join(' / ')}）`
  }
  if (!ALLOWED_MIME.includes(input.mime)) {
    return `文件类型不允许（可用：${ALLOWED_MIME.join(' / ')}）`
  }
  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0) return 'byteSize 必须是正整数'
  if (input.byteSize > MAX_ATTACHMENT_BYTES) {
    return `单张不得超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB`
  }
  if (input.sha256 != null && !/^[0-9a-f]{64}$/.test(input.sha256)) {
    return 'sha256 必须是 64 位小写十六进制'
  }
  if (input.visibility != null && !ATTACHMENT_VISIBILITIES.includes(input.visibility as AttachmentVisibility)) {
    return `可见范围不合法（可用：${ATTACHMENT_VISIBILITIES.join(' / ')}）`
  }
  return null
}

/** 归属实体必须存在且属于同一门店。 */
async function ownerEntityExists(
  db: OperationsDb,
  storeId: number,
  ownerEntityType: string,
  ownerEntityId: string,
): Promise<boolean> {
  const table = OWNER_ENTITY_TABLES[ownerEntityType]
  if (!table) return false
  // table 只来自上面的白名单常量，不接受外部输入。
  const row = await db
    .prepare(`SELECT 1 AS present FROM ${table} WHERE id = ? AND store_id = ?`)
    .bind(ownerEntityId, storeId)
    .first<{ present: number }>()
  return Boolean(row)
}

async function readAttachment(
  db: OperationsDb,
  storeId: number,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const row = await db
    .prepare(
      `SELECT id, object_key, upload_state, purpose, visibility, declared_mime, declared_byte_size,
              declared_sha256, content_type, byte_size, sha256, owner_entity_type, owner_entity_id,
              upload_token_hash, expires_at, version
       FROM attachments WHERE store_id = ? AND id = ?`,
    )
    .bind(storeId, attachmentId)
    .first<AttachmentRow>()
  return row ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// 孤立上传清理（04 §7 第 9 条：明确保留期 + 引用检查）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 回收本店已过保留期、仍未关联业务实体的上传。
 *
 * 不需要定时任务也能工作：签发新意图时顺带扫一批（惰性清理）。
 * 要精确排程再加 CF Cron，不是本卡的前置。
 *
 * 引用检查：只有 upload_state 仍是 pending / uploaded 的行才回收；
 * 已 attached 的行永远不动，哪怕 expires_at 早已过去。
 */
export async function sweepOrphanedUploads(
  db: OperationsDb,
  storage: StorageAdapter,
  storeId: number,
  limit = 50,
): Promise<{ reclaimed: number }> {
  const rows = await db
    .prepare(
      `SELECT id, object_key FROM attachments
       WHERE store_id = ? AND upload_state IN ('pending', 'uploaded') AND expires_at < datetime('now')
       ORDER BY expires_at LIMIT ?`,
    )
    .bind(storeId, limit)
    .all<{ id: string; object_key: string }>()

  const candidates = rows.results ?? []
  let reclaimed = 0
  for (const candidate of candidates) {
    try {
      // 先删对象再标状态：中途失败时留下的是「存储已空、行还没标」，
      // 下一次扫描会再试一次；反过来会留下永远回收不到的孤儿对象。
      await storage.delete(candidate.object_key)
      await db
        .prepare(
          `UPDATE attachments
           SET upload_state = 'orphaned', owner_entity_type = NULL, owner_entity_id = NULL,
               failure_reason = '超过保留期未关联业务实体，已回收', version = version + 1,
               updated_at = datetime('now')
           WHERE store_id = ? AND id = ? AND upload_state IN ('pending', 'uploaded')`,
        )
        .bind(storeId, candidate.id)
        .run()
      reclaimed++
    } catch {
      // 单个回收失败不影响签发主流程；下一轮扫描会重试。
    }
  }
  return { reclaimed }
}

// ─────────────────────────────────────────────────────────────────────────────
// B35 · 签发上传意图（POST /attachments/upload-intents）
// ─────────────────────────────────────────────────────────────────────────────

function planCreateIntent(
  db: OperationsDb,
  ctx: OperationContext,
  attachmentId: string,
  objectKey: string,
  tokenHash: string,
  input: UploadIntentInput,
  ttlHours: number,
): OperationPlan {
  const visibility = (input.visibility ?? 'internal') as AttachmentVisibility
  return {
    statements: [
      db
        .prepare(
          `INSERT INTO attachments
             (id, store_id, upload_state, purpose, visibility, object_key,
              declared_mime, declared_byte_size, declared_sha256,
              owner_entity_type, owner_entity_id, upload_token_hash, expires_at,
              version, request_id, created_by)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), 1, ?, ?)`,
        )
        .bind(
          attachmentId,
          ctx.storeId,
          input.purpose,
          visibility,
          objectKey,
          input.mime,
          input.byteSize,
          input.sha256 ?? null,
          input.ownerEntityType,
          input.ownerEntityId,
          tokenHash,
          `+${ttlHours} hours`,
          ctx.requestId,
          ctx.actorUserId,
        ),
    ],
    outcome: {
      entityType: 'Attachment',
      entityId: attachmentId,
      version: 1,
      summary: '已签发上传意图，等待写入文件字节',
      effects: {
        attachmentId,
        objectKey,
        // 凭证不落库：由 attachmentId 确定性派生，路由层重算后返回给客户端。
        uploadPath: `/api/v2/attachments/upload-intents/${encodeURIComponent(attachmentId)}/blob`,
        ownerEntityType: input.ownerEntityType,
        ownerEntityId: input.ownerEntityId,
        purpose: input.purpose,
        visibility,
      },
    },
  }
}

/**
 * 签发上传意图。返回的 outcome 里**不含凭证明文**（凭证可重算），
 * 路由层用 deriveUploadToken 生成后返回给客户端。
 */
export async function createUploadIntent(
  db: OperationsDb,
  storage: StorageAdapter,
  ctx: OperationContext,
  input: UploadIntentInput,
  secret: string,
): Promise<RunResult> {
  const action = 'B35'
  const invalid = validateIntentInput(input)
  if (invalid) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: invalid, retryable: false, httpStatus: 400 }
  }

  // 提前读用于友好提示；权威校验仍在 SQL 守卫与完成确认里。
  // 04 §2：必须校验归属对象确实属于同店，不能只检查父单是否存在。
  const ownerOk = await ownerEntityExists(db, ctx.storeId, input.ownerEntityType, input.ownerEntityId)
  if (!ownerOk) {
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VALIDATION_ERROR',
      message: '归属的业务对象不存在或不属于当前门店',
      retryable: false,
      httpStatus: 400,
    }
  }

  const payloadHash = await hashPayload({
    ownerEntityType: input.ownerEntityType,
    ownerEntityId: input.ownerEntityId,
    purpose: input.purpose,
    mime: input.mime,
    byteSize: input.byteSize,
    sha256: input.sha256 ?? null,
    visibility: input.visibility ?? 'internal',
  })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  // 惰性回收本店过期未关联的上传。放在签发前，天然按需触发。
  await sweepOrphanedUploads(db, storage, ctx.storeId)

  // 附件 id 由 requestId 派生：同一请求重放必然落到同一行，天然防止重复签发。
  const attachmentId = `${ctx.requestId}::att`
  const objectKey = buildObjectKey(ctx.storeId, attachmentId, input.mime)
  const token = await deriveUploadToken(secret, attachmentId)
  const tokenHash = await sha256Hex(new TextEncoder().encode(token))
  const ttlHours = Math.round(UPLOAD_INTENT_TTL_MS / (60 * 60 * 1000))

  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) =>
    planCreateIntent(db, context, attachmentId, objectKey, tokenHash, input, ttlHours),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// B35 · 写入文件字节（PUT /attachments/upload-intents/:id/blob）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 接收字节并校验。
 *
 * 不走 runIdempotent：字节 IO 无法与 SQL 放进同一个 D1 batch，
 * 假装同一事务只会制造「事务成功但对象没写进去」的假象。
 * 幂等性改由状态与条件更新保证：pending / uploaded 允许写入（重传即覆盖），
 * 已 attached / failed / orphaned 一律拒绝，条件 UPDATE 影响 0 行即视为并发冲突。
 */
export async function putAttachmentBlob(
  db: OperationsDb,
  storage: StorageAdapter,
  storeId: number,
  attachmentId: string,
  providedToken: string,
  secret: string,
  bytes: Uint8Array,
  headerContentType: string | null,
): Promise<BlobResult> {
  const row = await readAttachment(db, storeId, attachmentId)
  if (!row) {
    return { ok: false, code: 'ENTITY_NOT_FOUND', message: '上传意图不存在或不属于当前门店', httpStatus: 404 }
  }

  // 凭证校验：服务端重算后与请求携带值做常数时间比较。
  const expectedToken = await deriveUploadToken(secret, attachmentId)
  if (!providedToken || !timingSafeEqual(providedToken, expectedToken)) {
    return { ok: false, code: 'PERMISSION_DENIED', message: '上传凭证无效', httpStatus: 403 }
  }

  if (!(row.upload_state === 'pending' || row.upload_state === 'uploaded')) {
    const reason =
      row.upload_state === 'attached'
        ? '该附件已完成关联，不能再覆盖内容'
        : '该上传已失效（失败或已回收），请重新签发上传意图'
    return { ok: false, code: 'VERSION_CONFLICT', message: reason, httpStatus: 409 }
  }

  // 过期判断与保留期同一口径（两侧都用 SQLite datetime 文本格式，字符串比较有效）。
  const expired = await db
    .prepare(`SELECT 1 AS past FROM attachments WHERE store_id = ? AND id = ? AND expires_at < datetime('now')`)
    .bind(storeId, attachmentId)
    .first<{ past: number }>()
  if (expired) {
    await markFailed(db, storeId, attachmentId, '超过保留期')
    return { ok: false, code: 'VERSION_CONFLICT', message: '上传意图已超过保留期，请重新签发', httpStatus: 409 }
  }

  if (bytes.byteLength === 0) {
    return { ok: false, code: 'VALIDATION_ERROR', message: '上传内容为空', httpStatus: 400 }
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    await markFailed(db, storeId, attachmentId, '实际大小超过上限')
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `文件超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限`,
      httpStatus: 400,
    }
  }

  // 服务端实算：字节数 / 真实类型 / 完整性。三项都是自己算的，不是客户端报的。
  const actualSize = bytes.byteLength
  const actualSha = await sha256Hex(bytes)
  const sniffed = sniffMime(bytes)

  if (!sniffed || !ALLOWED_MIME.includes(sniffed)) {
    await markFailed(db, storeId, attachmentId, '文件头无法识别为允许的类型')
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: '文件内容与允许的类型不符（按文件头判断，改扩展名无效）',
      httpStatus: 400,
    }
  }
  if (sniffed !== row.declared_mime) {
    await markFailed(db, storeId, attachmentId, `声明类型与实际不符（声明 ${row.declared_mime}，实际 ${sniffed}）`)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `文件实际类型（${sniffed}）与签发时声明（${row.declared_mime}）不一致`,
      httpStatus: 400,
    }
  }
  if (headerContentType && headerContentType.split(';')[0].trim() !== sniffed) {
    await markFailed(db, storeId, attachmentId, '请求头类型与文件内容不符')
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: '请求头的 Content-Type 与文件内容不一致',
      httpStatus: 400,
    }
  }
  if (actualSize !== row.declared_byte_size) {
    await markFailed(db, storeId, attachmentId, `实际大小与声明不符（声明 ${row.declared_byte_size}，实际 ${actualSize}）`)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `实际大小 ${actualSize} 与签发时声明 ${row.declared_byte_size} 不一致`,
      httpStatus: 400,
    }
  }
  if (row.declared_sha256 && row.declared_sha256 !== actualSha) {
    await markFailed(db, storeId, attachmentId, '完整性校验不通过')
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: '文件完整性校验不通过（sha256 与签发时声明不一致）',
      httpStatus: 400,
    }
  }

  // 先写对象存储，再更新 D1（见文件头硬边界 1）。
  try {
    await storage.put(row.object_key, bytes, sniffed)
  } catch {
    return { ok: false, code: 'SERVICE_UNAVAILABLE', message: '对象存储写入失败，请重试', httpStatus: 503 }
  }

  const updated = await db
    .prepare(
      `UPDATE attachments
       SET upload_state = 'uploaded', content_type = ?, byte_size = ?, sha256 = ?,
           failure_reason = NULL, version = version + 1, updated_at = datetime('now')
       WHERE store_id = ? AND id = ? AND upload_state IN ('pending', 'uploaded')`,
    )
    .bind(sniffed, actualSize, actualSha, storeId, attachmentId)
    .run()

  if (!updated.meta.changes) {
    // 期间被别的请求改了状态；对象已经写进去了，留给保留期回收。
    return {
      ok: false,
      code: 'VERSION_CONFLICT',
      message: '该附件的状态已被其他操作改变，请刷新后重试',
      httpStatus: 409,
    }
  }

  return {
    ok: true,
    attachmentId,
    objectKey: row.object_key,
    uploadState: 'uploaded',
    contentType: sniffed,
    byteSize: actualSize,
    sha256: actualSha,
  }
}

async function markFailed(db: OperationsDb, storeId: number, attachmentId: string, reason: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE attachments
         SET upload_state = 'failed', failure_reason = ?, owner_entity_type = NULL, owner_entity_id = NULL,
             version = version + 1, updated_at = datetime('now')
         WHERE store_id = ? AND id = ? AND upload_state IN ('pending', 'uploaded')`,
      )
      .bind(reason.slice(0, 200), storeId, attachmentId)
      .run()
  } catch {
    // 标记失败不得掩盖真正的校验错误。
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B35 · 完成确认（POST /attachments/upload-intents/:id/complete）
// ─────────────────────────────────────────────────────────────────────────────

function planComplete(
  db: OperationsDb,
  ctx: OperationContext,
  row: AttachmentRow,
  input: CompleteInput,
): OperationPlan {
  const nextVersion = row.version + 1
  const ownerType = input.ownerEntityType ?? row.owner_entity_type!
  const ownerId = input.ownerEntityId ?? row.owner_entity_id!

  const statements = [
    // 必须已经写入过字节：pending 行不能直接跳到 attached（两段式不可绕过）。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      "NOT EXISTS (SELECT 1 FROM attachments WHERE store_id = ? AND id = ? AND upload_state = 'uploaded')",
      ctx.storeId,
      row.id,
    ),
    // 归属对象必须仍然存在且属于同店（签发之后可能被删除或被挂到别的店）。
    guardStatement(
      db,
      'VALIDATION_ERROR',
      `NOT EXISTS (SELECT 1 FROM ${OWNER_ENTITY_TABLES[ownerType]} WHERE id = ? AND store_id = ?)`,
      ownerId,
      ctx.storeId,
    ),
    db
      .prepare(
        `UPDATE attachments
         SET upload_state = 'attached', owner_entity_type = ?, owner_entity_id = ?,
             width = COALESCE(?, width), height = COALESCE(?, height),
             version = version + 1, updated_at = datetime('now')
         WHERE store_id = ? AND id = ? AND upload_state = 'uploaded'`,
      )
      .bind(ownerType, ownerId, input.width ?? null, input.height ?? null, ctx.storeId, row.id),
    assertAttachedStatement(db, ctx.storeId, row.id, nextVersion),
    bumpVersionStatement(db, ctx, 'Attachment', row.id, nextVersion),
  ]

  return {
    statements,
    outcome: {
      entityType: 'Attachment',
      entityId: row.id,
      version: nextVersion,
      summary: '附件已关联到业务对象',
      effects: {
        attachmentId: row.id,
        objectKey: row.object_key,
        ownerEntityType: ownerType,
        ownerEntityId: ownerId,
        contentType: row.content_type,
        byteSize: row.byte_size,
      },
    },
    constraintCodes: {},
  }
}

/** attached 与版本推进都必须真的落地，否则整批回滚。 */
function assertAttachedStatement(
  db: OperationsDb,
  storeId: number,
  attachmentId: string,
  expectedVersion: number,
): D1PreparedStatement {
  return guardStatement(
    db,
    'VERSION_CONFLICT',
    `NOT EXISTS (SELECT 1 FROM attachments WHERE store_id = ? AND id = ? AND upload_state = 'attached' AND version = ?)`,
    storeId,
    attachmentId,
    expectedVersion,
  )
}

/**
 * 完成确认：uploaded → attached。
 *
 * 重复完成保护分两层：
 *   ① 同 requestId 同载荷 → operations 幂等记录直接复用原结果（不重复写）。
 *   ② 不同 requestId 但该附件已 attached → 若请求的归属与已关联一致则按幂等返回，
 *      不一致则 VERSION_CONFLICT 拒绝（防止把别人已关联的附件改挂到别处）。
 */
export async function completeUpload(
  db: OperationsDb,
  ctx: OperationContext,
  attachmentId: string,
  input: CompleteInput,
): Promise<RunResult> {
  const action = 'B35'
  const row = await readAttachment(db, ctx.storeId, attachmentId)
  if (!row) {
    return { ok: false, requestId: ctx.requestId, code: 'ENTITY_NOT_FOUND', message: '上传意图不存在或不属于当前门店', retryable: false, httpStatus: 404 }
  }

  const payloadHash = await hashPayload({
    attachmentId,
    ownerEntityType: input.ownerEntityType ?? null,
    ownerEntityId: input.ownerEntityId ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
  })
  const existing = await queryOperation(db, ctx.storeId, ctx.requestId, { action, payloadHash })
  if (existing.found && existing.status === 'succeeded' && !existing.mismatch) {
    return { ok: true, reused: true, requestId: ctx.requestId, outcome: existing.outcome ?? {} }
  }

  if (row.upload_state === 'attached') {
    const sameOwner =
      input.ownerEntityType == null ||
      (input.ownerEntityType === row.owner_entity_type && input.ownerEntityId === row.owner_entity_id)
    if (sameOwner) {
      // 重复完成但目标一致：按当前状态幂等返回，不报错也不重复写。
      return {
        ok: true,
        reused: true,
        requestId: ctx.requestId,
        outcome: {
          entityType: 'Attachment',
          entityId: row.id,
          version: row.version,
          summary: '附件此前已关联到该业务对象',
          effects: {
            attachmentId: row.id,
            objectKey: row.object_key,
            ownerEntityType: row.owner_entity_type,
            ownerEntityId: row.owner_entity_id,
            contentType: row.content_type,
            byteSize: row.byte_size,
          },
        },
      }
    }
    return {
      ok: false,
      requestId: ctx.requestId,
      code: 'VERSION_CONFLICT',
      message: '该附件已关联到其他业务对象，不能改挂',
      retryable: false,
      httpStatus: 409,
    }
  }

  if (row.upload_state !== 'uploaded') {
    const message =
      row.upload_state === 'pending'
        ? '附件尚未写入文件内容，请先上传字节'
        : '该上传已失效（失败或已回收），请重新签发上传意图'
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message, retryable: false, httpStatus: 400 }
  }

  // 完成确认时若重复声明归属，必须与签发时一致（防偷换目标）。
  if (input.ownerEntityType != null && input.ownerEntityType !== row.owner_entity_type) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '归属对象类型与签发时不一致', retryable: false, httpStatus: 400 }
  }
  if (input.ownerEntityId != null && input.ownerEntityId !== row.owner_entity_id) {
    return { ok: false, requestId: ctx.requestId, code: 'VALIDATION_ERROR', message: '归属对象编号与签发时不一致', retryable: false, httpStatus: 400 }
  }

  const resolved: OperationContext = { ...ctx, action, payloadHash }
  return runIdempotent(db, resolved, (context) => planComplete(db, context, row, input))
}

// ─────────────────────────────────────────────────────────────────────────────
// 读模型（供接修 / 回收详情读取已关联附件）
// ─────────────────────────────────────────────────────────────────────────────

export interface AttachmentView {
  id: string
  purpose: string
  visibility: string
  contentType: string
  byteSize: number
  width: number | null
  height: number | null
  sha256: string | null
  uploadState: string
  createdAt: string
}

/** 只返回 attached 行 —— 业务记录只能引用上传完成的文件（契约 rules）。 */
export async function listAttachedForOwner(
  db: OperationsDb,
  storeId: number,
  ownerEntityType: string,
  ownerEntityId: string,
): Promise<AttachmentView[]> {
  if (!OWNER_ENTITY_TABLES[ownerEntityType]) return []
  const rows = await db
    .prepare(
      `SELECT id, purpose, visibility, content_type, byte_size, width, height, sha256, upload_state, created_at
       FROM attachments
       WHERE store_id = ? AND owner_entity_type = ? AND owner_entity_id = ? AND upload_state = 'attached'
       ORDER BY created_at`,
    )
    .bind(storeId, ownerEntityType, ownerEntityId)
    .all<{
      id: string
      purpose: string
      visibility: string
      content_type: string | null
      byte_size: number | null
      width: number | null
      height: number | null
      sha256: string | null
      upload_state: string
      created_at: string
    }>()

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    purpose: row.purpose,
    visibility: row.visibility,
    contentType: row.content_type ?? '',
    byteSize: row.byte_size ?? 0,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    uploadState: row.upload_state,
    createdAt: row.created_at,
  }))
}
