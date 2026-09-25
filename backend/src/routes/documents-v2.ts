import { DOCUMENT_PERMISSIONS, grants, type PermissionHolder } from '../domains/access'
import { hashPayload, runIdempotent, type OperationContext, type OperationsDb, type RunResult } from '../domains/operations'
import { resolveStorage, type StorageEnv } from '../domains/storage'
import { warrantyPolicyFromTermsSnapshot } from '../domains/warranty'

export interface DocumentsRouteEnv extends StorageEnv { DB: D1Database }
export interface DocumentsRouteContext extends PermissionHolder { userId: number; storeId: number }
const PATH = '/api/v2/documents'
const meta = (requestId: string | null) => ({ requestId, serverTime: new Date().toISOString(), contractVersion: 'v1' })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const fail = (code: string, message: string, status: number, requestId: string | null = null) => response({ error: { code, message, retryable: code === 'SERVICE_UNAVAILABLE' }, meta: meta(requestId) }, status)
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

function requestIdOf(body: Record<string, unknown>, req: Request): string | null {
  const bodyId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
  const headerId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  return bodyId && headerId && bodyId !== headerId ? null : bodyId || headerId || null
}

interface CustomerQuote { quoteId: string; title: string; revision: number; validUntil: string | null; totalCents: number; warrantyPolicyLines: string[] | null; lines: { name: string; qty: number; unitPriceCents: number; lineTotalCents: number; warranty: string | null }[] }
function customerWarranty(raw: string | null): string | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const safe: string[] = []
    if (Number.isInteger(value.months) && Number(value.months) >= 0 && Number(value.months) <= 240) safe.push(`${value.months} 个月`)
    if (typeof value.note === 'string' && value.note.trim()) safe.push(value.note.trim().slice(0, 200))
    return safe.length ? safe.join('；') : null
  } catch { return null }
}
async function customerQuote(db: OperationsDb, storeId: number, quoteId: string, revision: number): Promise<CustomerQuote | null> {
  const head = await db.prepare(`SELECT h.id, h.title, v.revision, v.valid_until, v.total_cents, v.terms_snapshot FROM quote_headers h JOIN quote_versions v ON v.quote_id=h.id AND v.store_id=h.store_id WHERE h.store_id=? AND h.id=? AND v.revision=?`).bind(storeId, quoteId, revision).first<{ id: string; title: string; revision: number; valid_until: string | null; total_cents: number; terms_snapshot: string | null }>()
  if (!head) return null
  const rows = await db.prepare(`SELECT name_snapshot, qty, unit_price_cents, line_total_cents, warranty_snapshot FROM quote_lines WHERE store_id=? AND quote_id=? AND revision=? ORDER BY position`).bind(storeId, quoteId, revision).all<{ name_snapshot: string; qty: number; unit_price_cents: number; line_total_cents: number; warranty_snapshot: string | null }>()
  return { quoteId: head.id, title: head.title, revision: head.revision, validUntil: head.valid_until, totalCents: head.total_cents, warrantyPolicyLines: warrantyPolicyFromTermsSnapshot(head.terms_snapshot), lines: (rows.results ?? []).map((r) => ({ name: r.name_snapshot, qty: r.qty, unitPriceCents: r.unit_price_cents, lineTotalCents: r.line_total_cents, warranty: customerWarranty(r.warranty_snapshot) })) }
}
function renderQuote(doc: CustomerQuote): string {
  const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`
  const policyLines = doc.warrantyPolicyLines ?? []
  const policy = policyLines.length
    ? policyLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
    : `<p>${escapeHtml('该历史报价未留存完整保修条款快照，请以原始报价或订单书面承诺为准，并联系门店核对。')}</p>`
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title><body><h1>${escapeHtml(doc.title)}</h1><p>报价单 ${escapeHtml(doc.quoteId)} · 版本 ${doc.revision}</p><table><thead><tr><th>项目</th><th>数量</th><th>单价</th><th>小计</th><th>质保</th></tr></thead><tbody>${doc.lines.map((line) => `<tr><td>${escapeHtml(line.name)}</td><td>${line.qty}</td><td>${money(line.unitPriceCents)}</td><td>${money(line.lineTotalCents)}</td><td>${escapeHtml(line.warranty ?? '')}</td></tr>`).join('')}</tbody></table><p>合计：${money(doc.totalCents)}</p><section><h2>质保与售后服务说明</h2>${policy}</section>${doc.validUntil ? `<p>有效期至：${escapeHtml(doc.validUntil)}</p>` : ''}</body></html>`
}

/** B36 第一版：只生成可追溯的 HTML 快照，且客户视角从这里的白名单 DTO 生成。 */
export async function routeDocumentsV2(req: Request, env: DocumentsRouteEnv, context: DocumentsRouteContext): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (path !== PATH && !path.startsWith(`${PATH}/`)) return null
  if (path.startsWith(`${PATH}/`)) {
    if (req.method !== 'GET') return fail('VALIDATION_ERROR', '该方法不支持', 405)
    if (!grants(context, DOCUMENT_PERMISSIONS.export)) return fail('PERMISSION_DENIED', '无该动作权限', 403)
    let attachmentId = ''
    try { attachmentId = decodeURIComponent(path.slice(`${PATH}/`.length)) } catch { return fail('ENTITY_NOT_FOUND', '单据附件不存在', 404) }
    if (!/^doc-[a-f0-9]{32}$/.test(attachmentId)) return fail('ENTITY_NOT_FOUND', '单据附件不存在', 404)
    const row = await env.DB.prepare(`SELECT object_key, content_type, version FROM attachments WHERE store_id=? AND id=? AND purpose='document_export' AND upload_state='attached'`).bind(context.storeId, attachmentId).first<{ object_key: string; content_type: string; version: number }>()
    if (!row) return fail('ENTITY_NOT_FOUND', '单据附件不存在', 404)
    let object
    try { object = await resolveStorage(env).get(row.object_key) }
    catch { return fail('SERVICE_UNAVAILABLE', '正式附件存储未配置，当前无法读取单据', 503) }
    if (!object) return fail('SERVICE_UNAVAILABLE', '单据文件暂时不可读取', 503)
    return new Response(object.bytes, { headers: {
      'Content-Type': row.content_type ?? 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="document-${attachmentId}.html"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    } })
  }
  if (req.method !== 'POST') return fail('VALIDATION_ERROR', '该方法不支持', 405)
  if (!grants(context, DOCUMENT_PERMISSIONS.export)) return fail('PERMISSION_DENIED', '无该动作权限', 403)
  let body: Record<string, unknown>; try { body = await req.json() as Record<string, unknown> } catch { return fail('VALIDATION_ERROR', '请求体不是合法 JSON', 400) }
  const requestId = requestIdOf(body, req); if (!requestId) return fail('VALIDATION_ERROR', '缺少 requestId，或与 Idempotency-Key 头不一致', 400)
  const entityRef = typeof body.entityRef === 'string' ? body.entityRef.trim() : ''
  const snapshotVersion = body.snapshotVersion
  if (!entityRef || !Number.isInteger(snapshotVersion) || (body.audience !== 'customer' && body.audience !== 'internal')) return fail('VALIDATION_ERROR', 'entityRef、snapshotVersion、audience 无效', 400, requestId)
  if (body.format !== 'html') return fail('VALIDATION_ERROR', '当前仅支持 html 快照；pdf/image 尚未接入，未生成任何文件', 400, requestId)
  const match = /^quote:(.+)$/.exec(entityRef); if (!match) return fail('VALIDATION_ERROR', '当前仅支持 quote:<id> 单据', 400, requestId)
  const quote = await customerQuote(env.DB, context.storeId, match[1], snapshotVersion); if (!quote) return fail('VALIDATION_ERROR', '报价版本不存在或不属于当前门店', 400, requestId)
  const input = { entityRef, snapshotVersion, audience: body.audience, format: body.format }
  const html = renderQuote(quote)
  const bytes = new TextEncoder().encode(html)
  const payloadHash = await hashPayload(input)
  // 当前所有请求都使用同一份 customer-safe 白名单模板；同一单据版本必须引用同一个文件。
  const stableHash = await hashPayload({ entityRef, snapshotVersion })
  const attachmentId = `doc-${stableHash.slice(0, 32)}`
  const tokenHash = await hashPayload({ attachmentId })
  const objectKey = `attachments/store-${context.storeId}/${attachmentId}.html`
  let storage
  try { storage = resolveStorage(env) }
  catch { return fail('SERVICE_UNAVAILABLE', '正式附件存储未配置，当前无法保存单据', 503, requestId) }
  let stored
  try { stored = await storage.put(objectKey, bytes, 'text/html; charset=utf-8') }
  catch { return fail('SERVICE_UNAVAILABLE', '单据文件保存失败，请重试', 503, requestId) }
  const result = await runIdempotent(env.DB, { storeId: context.storeId, actorUserId: context.userId, requestId, action: 'B36', payloadHash }, () => ({
    statements: [env.DB.prepare(`INSERT OR IGNORE INTO attachments
      (id, store_id, upload_state, purpose, visibility, object_key, declared_mime, declared_byte_size,
       declared_sha256, content_type, byte_size, sha256, owner_entity_type, owner_entity_id,
       upload_token_hash, expires_at, version, request_id, created_by)
      VALUES (?, ?, 'attached', 'document_export', 'internal', ?, 'text/html', ?, ?, 'text/html; charset=utf-8', ?, ?, 'quote', ?, ?, datetime('now', '+1 day'), ?, ?, ?)`)
      .bind(attachmentId, context.storeId, objectKey, stored.byteSize, stored.sha256, stored.byteSize, stored.sha256,
        quote.quoteId, tokenHash, snapshotVersion, requestId, context.userId)],
    outcome: { entityType: 'Attachment', entityId: attachmentId, version: snapshotVersion,
      summary: '已生成并保存 HTML 单据快照（未自动外发）',
      effects: { attachmentId, format: 'html', audience: body.audience, delivery: 'none', storagePersistent: storage.persistent } },
    constraintCodes: {},
  })) as RunResult
  const outcome = result.outcome as Record<string, unknown>
  return response({ data: { operationId: result.requestId, entityRef, snapshotVersion, audience: body.audience, format: 'html', html,
    attachmentId: outcome.effects && (outcome.effects as Record<string, unknown>).attachmentId || attachmentId,
    downloadPath: `${PATH}/${attachmentId}`, storagePersistent: storage.persistent,
    summary: outcome.summary, effects: outcome.effects }, meta: meta(result.requestId) })
}
