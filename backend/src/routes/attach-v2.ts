/**
 * /api/v2 附件路由（F1 · B35）。
 *
 * 与 routes/tradein-v2.ts 同一理由单独成文件：新契约权限码（attachment/upload）
 * 写进入口会被 validate-contracts 第 10.6 节当成旧权限码判红，
 * 所以整条链路留在本文件，入口只保留分发行。
 *
 * 承接的契约条目（前缀 /api/v2 由 conventions.api 声明）：
 *   · B35 POST /attachments/upload-intents            权限 attachment/upload —— 签发上传意图
 *   · B35 PUT  /attachments/upload-intents/:id/blob   权限 attachment/upload —— 写入文件字节（F1 补入）
 *   · B35 POST /attachments/upload-intents/:id/complete 权限 attachment/upload —— 校验并关联业务对象
 *
 * 本模块不新增契约外的读路径：附件列表由接修 / 回收 / 库存实物详情读模型带出。
 */

import { ATTACHMENT_PERMISSIONS, grants, type PermissionHolder } from '../domains/access'
import { appendReadableDiagnostic } from '../domains/operations'
import {
  completeUpload,
  createUploadIntent,
  deriveUploadToken,
  putAttachmentBlob,
  type BlobResult,
  type CompleteInput,
  type UploadIntentInput,
} from '../domains/attachment'
import { MAX_ATTACHMENT_BYTES, resolveStorage, type StorageEnv } from '../domains/storage'

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface AttachRouteEnv extends StorageEnv {
  DB: D1Database
  /** 上传凭证的派生密钥。空值也不阻断：dev / 测试用默认值。 */
  JWT_SECRET?: string
}

/** 与入口的 AuthContext 结构一致；本模块只读，不重新判定会话。 */
export interface AttachRouteContext extends PermissionHolder {
  userId: number
  storeId: number
}

const CONTRACT_VERSION = 'v1'
const PREFIX = '/api/v2'

// ────────────────────────────── 契约信封 ──────────────────────────────

function meta(requestId: string | null) {
  return { requestId, serverTime: new Date().toISOString(), contractVersion: CONTRACT_VERSION }
}

function ok(data: unknown, requestId: string | null = null, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: meta(requestId) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fail(
  code: string,
  message: string,
  status: number,
  options: { requestId?: string | null; currentVersion?: number } = {},
): Response {
  const error: Record<string, unknown> = { code, message, retryable: isRetryable(code) }
  if (options.currentVersion !== undefined) error.currentVersion = options.currentVersion
  return new Response(JSON.stringify({ error, meta: meta(options.requestId ?? null) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isRetryable(code: string): boolean {
  return code === 'AUTH_REQUIRED' || code === 'SESSION_REVOKED' || code === 'RATE_LIMITED' || code === 'SERVICE_UNAVAILABLE'
}

function requireGrant(context: AttachRouteContext, code: string): Response | null {
  return grants(context, code) ? null : fail('PERMISSION_DENIED', '无该动作权限', 403)
}

async function readJson(req: Request): Promise<{ body: Record<string, unknown> | null; response: Response | null }> {
  try {
    const parsed = (await req.json()) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body: null, response: fail('VALIDATION_ERROR', '请求体必须是 JSON 对象', 400) }
    }
    return { body: parsed as Record<string, unknown>, response: null }
  } catch {
    return { body: null, response: fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400) }
  }
}

function requireRequestId(body: Record<string, unknown>, req: Request): string | null {
  const fromBody = typeof body.requestId === 'string' ? body.requestId.trim() : ''
  const headerValue = req.headers.get('Idempotency-Key')
  const fromHeader = headerValue ? headerValue.trim() : ''
  if (fromBody && fromHeader && fromBody !== fromHeader) return null
  return fromBody || fromHeader || null
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asOptionalInt(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

/** 凭证派生密钥；缺省值只用于本地与测试，生产由 wrangler secret 注入。 */
function tokenSecret(env: AttachRouteEnv): string {
  return env.JWT_SECRET || 'local-preview-secret-not-a-real-secret'
}

function storageMeta(env: AttachRouteEnv) {
  let storage
  try { storage = resolveStorage(env) }
  catch { return null }
  return { storage, storageKind: storage.kind, storagePersistent: storage.persistent }
}

function decodeId(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

// ────────────────────────────── handler ──────────────────────────────

/**
 * 统一把领域结果翻成契约信封。
 *
 * state 必须由调用方给出：签发意图落在 pending，完成确认落在 attached。
 * 写成固定值会让「完成确认」的响应谎报状态 —— 客户端会据此以为还没关联上。
 */
function finish(result: Awaited<ReturnType<typeof createUploadIntent>>, state: string): Response {
  if (result.ok) {
    return ok(
      {
        operationId: result.requestId,
        entityId: result.outcome.entityId ?? null,
        entityVersion: result.outcome.version ?? null,
        state,
        // 幂等重放要显式告诉客户端「这次没有再次执行副作用」，不能靠猜。
        reused: result.reused,
        effects: result.outcome.effects ?? {},
        summary: result.outcome.summary ?? '',
      },
      result.requestId,
    )
  }
  return fail(result.code, appendReadableDiagnostic(result.message, result.diagnostic), result.httpStatus, {
    requestId: result.requestId,
    currentVersion: result.currentVersion,
  })
}

async function handleCreateIntent(
  req: Request,
  env: AttachRouteEnv,
  context: AttachRouteContext,
): Promise<Response> {
  const denied = requireGrant(context, ATTACHMENT_PERMISSIONS.upload)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const ownerEntityType = asText(body.ownerEntityType)
  const ownerEntityId = asText(body.ownerEntityId)
  const purpose = asText(body.purpose)
  const mime = asText(body.mime)
  if (!ownerEntityType || !ownerEntityId || !purpose || !mime) {
    return fail('VALIDATION_ERROR', '缺少 ownerEntityType / ownerEntityId / purpose / mime', 400, { requestId })
  }
  const byteSize = body.byteSize
  if (typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize <= 0) {
    return fail('VALIDATION_ERROR', 'byteSize 必须是正整数', 400, { requestId })
  }

  const resolved = storageMeta(env)
  if (!resolved) return fail('SERVICE_UNAVAILABLE', '正式附件存储未配置，当前无法创建上传', 503, { requestId })
  const { storage } = resolved
  const input: UploadIntentInput = {
    ownerEntityType,
    ownerEntityId,
    purpose,
    mime,
    byteSize,
    sha256: asText(body.sha256),
    visibility: asText(body.visibility),
  }
  const result = await createUploadIntent(
    env.DB,
    storage,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B35', payloadHash: '' },
    input,
    tokenSecret(env),
  )

  if (!result.ok) return finish(result, 'pending')

  // 凭证不落库（见 attachment.ts 的 deriveUploadToken）：由附件 id 确定性重算后返回。
  const attachmentId = String(result.outcome.entityId ?? '')
  const effects = (result.outcome.effects ?? {}) as Record<string, unknown>
  const uploadToken = attachmentId ? await deriveUploadToken(tokenSecret(env), attachmentId) : ''
  const expiresRow = await env.DB
    .prepare(`SELECT expires_at FROM attachments WHERE store_id = ? AND id = ?`)
    .bind(context.storeId, attachmentId)
    .first<{ expires_at: string }>()

  return ok(
    {
      operationId: result.requestId,
      entityId: attachmentId,
      entityVersion: result.outcome.version ?? null,
      state: 'pending',
      reused: result.reused,
      uploadPath: effects.uploadPath ?? null,
      uploadToken,
      objectKey: effects.objectKey ?? null,
      expiresAt: expiresRow?.expires_at ?? null,
      // 如实透出存储实现：内存实现代表「非持久」，让这件事在验收里可见。
      storageKind: storage.kind,
      storagePersistent: storage.persistent,
      // ⚠️ 顾客端对外读取依赖已备案域名；R2 域名备不了案，当前恒为 false，不假装可用。
      customerShareable: false,
      summary: result.outcome.summary ?? '',
    },
    result.requestId,
  )
}

function blobFailure(result: BlobResult): Response {
  if (result.ok) throw new Error('unreachable')
  return fail(result.code, result.message, result.httpStatus)
}

async function handlePutBlob(
  req: Request,
  env: AttachRouteEnv,
  context: AttachRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, ATTACHMENT_PERMISSIONS.upload)
  if (denied) return denied

  const attachmentId = decodeId(rawId)
  if (!attachmentId) return fail('VALIDATION_ERROR', '附件编号无法解析', 400)

  const token = req.headers.get('X-Upload-Token')?.trim() ?? ''
  if (!token) return fail('PERMISSION_DENIED', '缺少上传凭证', 403)

  // 请求体上限先挡一层，避免把超大请求整个读进内存。
  const declaredLength = Number(req.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
    return fail('VALIDATION_ERROR', `文件超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限`, 400)
  }

  const buffer = await req.arrayBuffer()
  let storage
  try { storage = resolveStorage(env) }
  catch { return fail('SERVICE_UNAVAILABLE', '正式附件存储未配置，当前无法写入文件', 503) }
  const result = await putAttachmentBlob(
    env.DB,
    storage,
    context.storeId,
    attachmentId,
    token,
    tokenSecret(env),
    new Uint8Array(buffer),
    req.headers.get('Content-Type'),
  )

  if (!result.ok) return blobFailure(result)
  return ok({
    entityId: result.attachmentId,
    state: result.uploadState,
    objectKey: result.objectKey,
    contentType: result.contentType,
    byteSize: result.byteSize,
    sha256: result.sha256,
    storageKind: storage.kind,
    storagePersistent: storage.persistent,
  })
}

async function handleComplete(
  req: Request,
  env: AttachRouteEnv,
  context: AttachRouteContext,
  rawId: string,
): Promise<Response> {
  const denied = requireGrant(context, ATTACHMENT_PERMISSIONS.upload)
  if (denied) return denied
  const { body, response } = await readJson(req)
  if (!body) return response!
  const requestId = requireRequestId(body, req)
  if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)

  const attachmentId = decodeId(rawId)
  if (!attachmentId) return fail('VALIDATION_ERROR', '附件编号无法解析', 400, { requestId })

  const width = asOptionalInt(body.width)
  const height = asOptionalInt(body.height)
  if (width === undefined || height === undefined) {
    return fail('VALIDATION_ERROR', 'width / height 必须是正整数或省略', 400, { requestId })
  }

  const input: CompleteInput = {
    ownerEntityType: asText(body.ownerEntityType),
    ownerEntityId: asText(body.ownerEntityId),
    width,
    height,
  }
  const result = await completeUpload(
    env.DB,
    { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B35', payloadHash: '' },
    attachmentId,
    input,
  )
  return finish(result, 'attached')
}

// ────────────────────────────── 分发 ──────────────────────────────

const INTENTS_PATH = `${PREFIX}/attachments/upload-intents`
const BLOB_PATH = /^\/api\/v2\/attachments\/upload-intents\/([^/]+)\/blob$/
const COMPLETE_PATH = /^\/api\/v2\/attachments\/upload-intents\/([^/]+)\/complete$/

export async function routeAttachV2(
  req: Request,
  env: AttachRouteEnv,
  context: AttachRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (!path.startsWith(`${PREFIX}/attachments`)) return null

  if (path === INTENTS_PATH) {
    if (req.method === 'POST') return handleCreateIntent(req, env, context)
    return fail('VALIDATION_ERROR', '该方法不支持', 405)
  }

  const blobMatch = BLOB_PATH.exec(path)
  if (blobMatch) {
    if (req.method !== 'PUT') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handlePutBlob(req, env, context, blobMatch[1])
  }

  const completeMatch = COMPLETE_PATH.exec(path)
  if (completeMatch) {
    if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    return handleComplete(req, env, context, completeMatch[1])
  }

  if (path.startsWith(`${PREFIX}/attachments`)) {
    return fail('ENTITY_NOT_FOUND', '接口不存在', 404)
  }
  return null
}
