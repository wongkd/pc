import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { applySqlFile, backendRoot, createTestEnv, seedStore } from './lib/env.mjs'
import { seedProduct, scalar } from './lib/inventory.mjs'

test('0032 重建库存流水时保留盘点行与反向流水的既有关联', async () => {
  const env = await createTestEnv({ demo: false, throughMigration: '0031_workbench_reservation_line_index.sql' })
  try {
    const { storeId, userId } = await seedStore(env.db)
    const product = await seedProduct(env.db, { entityId: 'u03-migration-product' })
    await env.db.prepare(`INSERT INTO inventory_counts
      (id, store_id, status, as_of, request_id, created_by)
      VALUES ('u03-count', ?, 'draft', '2026-09-27T00:00:00.000Z', 'u03-count-request', ?)`)
      .bind(storeId, userId).run()
    await env.db.prepare(`INSERT INTO inventory_movements
      (id, store_id, product_id, qty, from_bucket, to_bucket, source, occurred_at, actor_user_id, request_id)
      VALUES ('u03-adjustment', ?, ?, 1, NULL, 'available', 'count_adjustment', '2026-09-27T00:00:00.000Z', ?, 'u03-adjustment-request')`)
      .bind(storeId, product.hardwareId, userId).run()
    await env.db.prepare(`INSERT INTO inventory_movements
      (id, store_id, product_id, qty, from_bucket, to_bucket, source, reversal_of, occurred_at, actor_user_id, request_id)
      VALUES ('u03-reversal', ?, ?, 1, 'available', 'retired', 'count_adjustment', 'u03-adjustment', '2026-09-27T00:01:00.000Z', ?, 'u03-reversal-request')`)
      .bind(storeId, product.hardwareId, userId).run()
    await env.db.prepare(`INSERT INTO inventory_count_lines
      (id, count_id, store_id, product_id, book_qty, counted_qty, adjustment_movement_id)
      VALUES ('u03-count-line', 'u03-count', ?, ?, 0, 1, 'u03-adjustment')`)
      .bind(storeId, product.hardwareId).run()

    await applySqlFile(env.db, join(backendRoot, 'migrations', '0032_stock_inspection_and_backfills.sql'))

    assert.equal(await scalar(env.db, `SELECT adjustment_movement_id FROM inventory_count_lines WHERE id='u03-count-line'`), 'u03-adjustment')
    assert.equal(await scalar(env.db, `SELECT reversal_of FROM inventory_movements WHERE id='u03-reversal'`), 'u03-adjustment')
    assert.equal(await scalar(env.db, `SELECT COUNT(*) FROM inventory_movements`), 2)
    assert.equal(await scalar(env.db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='inventory_count_movement_links__0032'`), 0)
    assert.equal(await scalar(env.db, `SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='inventory_movements_apply_balance'`), 1)
    assert.equal(await scalar(env.db, `SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='close_opening_window_after_business_movement'`), 1)
    const foreignKeyViolations = await env.db.prepare('PRAGMA foreign_key_check').all()
    assert.deepEqual(foreignKeyViolations.results ?? [], [])
  } finally {
    await env.dispose()
  }
})
