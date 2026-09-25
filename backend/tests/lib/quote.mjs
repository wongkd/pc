/**
 * Q01 测试夹具：报价单领域的环境、清库与播种辅助。
 * 仅测试使用，不属于生产代码。
 */

import { createTestEnv, seedStore } from './env.mjs'

export const STORE = 1
export const ACTOR = 1

/** 起一个装好迁移的环境（0009 已包含在 migrations 里）。 */
export async function createQuoteEnv() {
  const env = await createTestEnv({ demo: false })
  await seedStore(env.db, { storeId: STORE, userId: ACTOR })
  return env
}

export async function scalar(db, sql, ...params) {
  const row = await db.prepare(sql).bind(...params).first()
  return row ? Object.values(row)[0] : null
}

export async function rows(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all()
  return result.results ?? []
}

const CLEAN_ORDER = [
  'quote_shares',
  'quote_lines',
  'quote_versions',
  'quote_headers',
  'operations',
  'entity_version_log',
  'operation_failures',
  'assertion_guards',
]

/** 清空本卡相关的全部表；按引用顺序删，避免撞外键。 */
export async function resetQuotes(db) {
  for (const table of CLEAN_ORDER) {
    await db.prepare(`DELETE FROM ${table}`).run()
  }
}

/**
 * 播一份报价头。
 * 契约 Quote 的业务字段只有 customerId / title / currentRevision。
 */
export async function seedQuoteHeader(db, { id = 'q-1', title = '测试装机方案', customerId = null } = {}) {
  await db
    .prepare(
      `INSERT INTO quote_headers (id, store_id, customer_id, title, current_revision, version, created_by, updated_by)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
    )
    .bind(id, STORE, customerId, title, ACTOR, ACTOR)
    .run()
  return id
}

/**
 * 播一个报价版本。
 * 金额守恒由 CHECK 强制：total = subtotal − discount，且 discount <= subtotal。
 * termsSnapshot 放定金比例与顾客预算 —— 它们不是独立列（见 0009 设计要点 3）。
 */
export async function seedQuoteVersion(db, {
  quoteId = 'q-1',
  revision = 1,
  status = 'draft',
  subtotalCents = 0,
  discountCents = 0,
  validUntil = null,
  termsSnapshot = {},
  issuedAt = null,
} = {}) {
  const totalCents = subtotalCents - discountCents
  // 非 draft 状态必须有 issued_at，否则 CHECK 会拦下。
  const issued = issuedAt ?? (status === 'draft' ? null : '2026-09-19T04:00:00.000Z')
  await db
    .prepare(
      `INSERT INTO quote_versions
         (quote_id, revision, store_id, status, valid_until, discount_cents, terms_snapshot,
          issued_at, subtotal_cents, total_cents, issued_request_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      quoteId, revision, STORE, status, validUntil, discountCents,
      JSON.stringify(termsSnapshot), issued, subtotalCents, totalCents, ACTOR,
    )
    .run()
  return { quoteId, revision }
}

/** 播一行报价明细。line_total_cents 必须等于 unitPrice * qty。 */
export async function seedQuoteLine(db, {
  id = 'ql-1',
  quoteId = 'q-1',
  revision = 1,
  position = 0,
  source = 'new',
  nameSnapshot = '测试配件',
  specSnapshot = '',
  qty = 1,
  unitPriceCents = 0,
  stockItemId = null,
  customerDeviceRef = null,
  warrantySnapshot = {},
} = {}) {
  await db
    .prepare(
      `INSERT INTO quote_lines
         (id, quote_id, revision, store_id, position, source, name_snapshot, spec_snapshot,
          qty, unit_price_cents, line_total_cents, stock_item_id, customer_device_ref, warranty_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, quoteId, revision, STORE, position, source, nameSnapshot, specSnapshot,
      qty, unitPriceCents, unitPriceCents * qty, stockItemId, customerDeviceRef,
      JSON.stringify(warrantySnapshot),
    )
    .run()
  return id
}

/** 统一捕获 SQL 失败的助手：返回错误消息，成功返回 null。 */
export async function attempt(db, sql, ...params) {
  try {
    await db.prepare(sql).bind(...params).run()
    return null
  } catch (error) {
    return String(error?.message ?? error)
  }
}
