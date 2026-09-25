/**
 * T05a 测试夹具：库存领域的环境、清库、播种与断言辅助。
 * 仅测试使用，不属于生产代码。
 */

import { createTestEnv, seedStore } from './env.mjs'
import { bundleModule } from './build.mjs'

export const STORE = 1
export const ACTOR = 1

/** 起一个装了库存领域模块的环境。 */
export async function createInventoryEnv() {
  const env = await createTestEnv({ demo: false })
  await seedStore(env.db, { storeId: STORE, userId: ACTOR })
  const inventory = await bundleModule('src/domains/inventory.ts', 'inventory')
  return { ...env, inventory }
}

/** 动作上下文。载荷摘要由被测入口自己算，这里留空。 */
export function ctx(requestId, action) {
  return { storeId: STORE, actorUserId: ACTOR, requestId, action, payloadHash: '' }
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
  // B16 盘点（0024）：先删行再删表头，两张都引用 inventory_movements / hardware。
  'inventory_count_lines',
  'inventory_counts',
  'stock_reservations',
  'inventory_opening_lines',
  'inventory_openings',
  // 0027 批次表引用 hardware / stores / users，必须在 hardware 之前清，
  // 否则清库会在删 hardware 时撞外键（AS02 加表后首次全量实测到的失败）。
  'stock_batches',
  'inventory_movements',
  'stock_balances',
  'stock_items',
  'operations',
  'entity_version_log',
  'operation_failures',
  'assertion_guards',
  'hardware',
]

/** 清空本卡相关的全部表；按引用顺序删，避免撞外键。 */
export async function resetInventory(db) {
  for (const table of CLEAN_ORDER) {
    await db.prepare(`DELETE FROM ${table}`).run()
  }
}

/** 直接播一个商品（不动 B12，用于给其他用例铺底）。
 *  options: { entityId, name?, sku?, trackingMode?, requiresSn?, status?, category?, defaultPriceCents? }
 */
export async function seedProduct(db, options) {
  const mode = options.trackingMode ?? 'quantity'
  await db
    .prepare(
      `INSERT INTO hardware
         (user_id, store_id, category, name, entity_id, sku, tracking_mode, requires_sn,
          is_serialized, status, default_price_cents, item_type, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'product', 1)`,
    )
    .bind(
      ACTOR,
      STORE,
      options.category ?? '测试分类',
      options.name ?? options.entityId,
      options.entityId,
      options.sku ?? null,
      mode,
      options.requiresSn ?? (mode === 'item' ? 1 : 0),
      mode === 'item' ? 1 : 0,
      options.status ?? 'active',
      options.defaultPriceCents ?? 0,
    )
    .run()
  const id = await scalar(db, 'SELECT id FROM hardware WHERE store_id = ? AND entity_id = ?', STORE, options.entityId)
  return { entityId: options.entityId, hardwareId: id }
}
