-- 0018 · 库存流水来源枚举补齐（recovery_acquisition / inspection_release）
--
-- Prerequisite: apply 0000 -> 0017 first.
--
-- 为什么需要它（这是本迁移存在的唯一理由，别删）：
--   0007 建 inventory_movements 时，source 的 CHECK 只列了 14 个值；
--   契约 enums.json InventoryMovementSource 有 16 个值，缺的是
--     · recovery_acquisition —— B28 取得回收物所有权时入库（0020 回收单链路）
--     · inspection_release   —— B19 待检件判定通过放回可卖（隔离件出 quarantine）
--   SQLite 不能 ALTER 一个 CHECK，只能重建表。0019/0020 头注释里引用的「0018 重建
--   inventory_movements」就是这个文件；它在仓库里曾缺失，导致回收链路一写流水就
--   撞 CHECK 失败（E11 收尾时实测发现）。
--
-- 范围：只重建 inventory_movements 这一张表，枚举补齐到契约的 16 个值，
--       结构（列、约束、索引）与 0007 保持一致，不新增也不删除任何列。
--
-- ⚠️ 重建会连带删掉挂在它上面的触发器 inventory_movements_apply_balance
--    （SQLite DROP TABLE 会删该表的触发器）。那是 stock_balances 的唯一写入者，
--    本迁移末尾必须原样重建，漏了库存余额就再也不更新。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与其他迁移一样，本文件在明确授权前不得 apply 到任何远端环境。

PRAGMA defer_foreign_keys = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. 新表：与 0007 同构，source 枚举补齐到契约 16 值
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_movements__new (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  stock_item_id TEXT,
  qty INTEGER NOT NULL,
  from_bucket TEXT CHECK (from_bucket IN
    ('available', 'reserved', 'quarantine', 'in_transit', 'customer_custody', 'sold', 'retired')),
  to_bucket TEXT CHECK (to_bucket IN
    ('available', 'reserved', 'quarantine', 'in_transit', 'customer_custody', 'sold', 'retired')),
  cost_cents INTEGER,
  source TEXT NOT NULL CHECK (source IN (
    'purchase_receipt', 'quick_purchase', 'opening_balance', 'recovery_acquisition',
    'reservation', 'unreservation', 'assembly_pick', 'delivery', 'return_receipt',
    'service_part_consumption', 'scrap', 'supplier_return', 'count_adjustment',
    'conversion', 'inspection_quarantine', 'inspection_release')),
  reversal_of TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  CHECK (qty <> 0),
  CHECK (from_bucket IS NOT NULL OR to_bucket IS NOT NULL),
  CHECK (from_bucket IS NULL OR to_bucket IS NULL OR from_bucket <> to_bucket),
  CHECK (cost_cents IS NULL OR cost_cents >= 0),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
  FOREIGN KEY (reversal_of) REFERENCES inventory_movements(id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. 搬迁：逐列搬运，避免依赖列顺序
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO inventory_movements__new (
  id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
  source, reversal_of, occurred_at, recorded_at, actor_user_id, request_id
)
SELECT
  id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
  source, reversal_of, occurred_at, recorded_at, actor_user_id, request_id
FROM inventory_movements;

DROP TABLE inventory_movements;

ALTER TABLE inventory_movements__new RENAME TO inventory_movements;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. 索引：与 0007 同名同构（DROP TABLE 会一并删掉旧索引）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_inventory_movements_store_product
  ON inventory_movements(store_id, product_id, recorded_at DESC);
CREATE INDEX idx_inventory_movements_item ON inventory_movements(stock_item_id, recorded_at DESC);
CREATE INDEX idx_inventory_movements_request ON inventory_movements(store_id, request_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. 余额触发器：原样重建（stock_balances 的唯一写入者）
--    —— 先插空行再更新，不能把算术折叠进 UPSERT 的 INSERT 分支：SQLite 在检测到
--       唯一冲突之前就先算 CHECK，桶间移动（available -> reserved）的负增量会被
--       误拒。实测见 docs/verification/2026-09-18-T05a。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER inventory_movements_apply_balance
AFTER INSERT ON inventory_movements
WHEN NEW.from_bucket IN ('available', 'reserved', 'quarantine')
  OR NEW.to_bucket IN ('available', 'reserved', 'quarantine')
BEGIN
  INSERT OR IGNORE INTO stock_balances (store_id, product_id, location_id)
  VALUES (NEW.store_id, NEW.product_id, 'store');

  UPDATE stock_balances SET
    available_qty = available_qty
      + COALESCE(CASE WHEN NEW.to_bucket = 'available' THEN NEW.qty END, 0)
      + COALESCE(CASE WHEN NEW.from_bucket = 'available' THEN -NEW.qty END, 0),
    reserved_qty = reserved_qty
      + COALESCE(CASE WHEN NEW.to_bucket = 'reserved' THEN NEW.qty END, 0)
      + COALESCE(CASE WHEN NEW.from_bucket = 'reserved' THEN -NEW.qty END, 0),
    quarantine_qty = quarantine_qty
      + COALESCE(CASE WHEN NEW.to_bucket = 'quarantine' THEN NEW.qty END, 0)
      + COALESCE(CASE WHEN NEW.from_bucket = 'quarantine' THEN -NEW.qty END, 0),
    version = version + 1,
    updated_at = datetime('now')
  WHERE store_id = NEW.store_id AND product_id = NEW.product_id AND location_id = 'store';
END;
