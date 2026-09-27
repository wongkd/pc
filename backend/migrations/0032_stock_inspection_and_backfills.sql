-- 0032 · U02 检测状态与同型号库存分批补录
--
-- Prerequisite: apply 0000 -> 0031 first.
--
-- 历史实物新增 inspection_status，默认 unrecorded，不根据 availability / inspection_ref 推断。
-- inventory_movements.source 增加 stock_backfill。SQLite 不能 ALTER CHECK，只能重建表；
-- 重建时逐列保留旧流水、三个索引及余额触发器。
--
-- 范围：扩展 stock_items 检测状态；重建 inventory_movements；增加追加式检测事件与补录批次表。
--
-- ⚠️ 重建会连带删掉挂在它上面的触发器 inventory_movements_apply_balance
--    （SQLite DROP TABLE 会删该表的触发器）。那是 stock_balances 的唯一写入者，
--    本迁移末尾必须原样重建，漏了库存余额就再也不更新。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与其他迁移一样，本文件在明确授权前不得 apply 到任何远端环境。

-- B16 盘点行可能指向已有 count_adjustment 流水。重建父表前先在迁移内暂存
-- 引用并置空；迁移收尾再恢复，避免 DROP TABLE 触发 inventory_count_lines 的 FK 拒绝。
-- 该暂存表只在本迁移期间存在，失败时由 D1 回滚，成功时立即删除。
CREATE TABLE inventory_count_movement_links__0032 (
  line_id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL
);
INSERT INTO inventory_count_movement_links__0032 (line_id, movement_id)
SELECT id, adjustment_movement_id
FROM inventory_count_lines
WHERE adjustment_movement_id IS NOT NULL;
UPDATE inventory_count_lines SET adjustment_movement_id = NULL
WHERE adjustment_movement_id IS NOT NULL;

ALTER TABLE stock_items
  ADD COLUMN inspection_status TEXT NOT NULL DEFAULT 'unrecorded'
  CHECK (inspection_status IN ('unrecorded', 'pending', 'passed', 'failed'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. 新表：保留 0007 + 0030 的结构，source 增补 stock_backfill
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
  cost_basis TEXT CHECK (cost_basis IS NULL OR cost_basis IN ('known_actual', 'assessed_estimate', 'unknown', 'zero_cost')),
  estimated_unit_cost_cents INTEGER CHECK (estimated_unit_cost_cents IS NULL OR estimated_unit_cost_cents >= 0),
  source TEXT NOT NULL CHECK (source IN (
    'purchase_receipt', 'quick_purchase', 'opening_balance', 'recovery_acquisition',
    'reservation', 'unreservation', 'assembly_pick', 'delivery', 'return_receipt',
    'service_part_consumption', 'scrap', 'supplier_return', 'count_adjustment',
    'conversion', 'inspection_quarantine', 'inspection_release', 'stock_backfill')),
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
  FOREIGN KEY (reversal_of) REFERENCES inventory_movements__new(id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. 搬迁：逐列搬运，避免依赖列顺序
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO inventory_movements__new (
  id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
  cost_basis, estimated_unit_cost_cents, source, reversal_of, occurred_at, recorded_at, actor_user_id, request_id
)
SELECT
  id, store_id, product_id, stock_item_id, qty, from_bucket, to_bucket, cost_cents,
  cost_basis, estimated_unit_cost_cents, source, reversal_of, occurred_at, recorded_at, actor_user_id, request_id
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

-- Rebuilding inventory_movements drops every trigger attached to the old table.
-- Restore the one-time D10 close guard alongside the balance trigger above.
CREATE TRIGGER close_opening_window_after_business_movement
AFTER INSERT ON inventory_movements
WHEN NEW.source <> 'opening_balance'
BEGIN
  UPDATE inventory_opening_windows
     SET closed_at = datetime('now'), close_reason = 'first_business_movement'
   WHERE store_id = NEW.store_id AND closed_at IS NULL;
END;

-- 恢复盘点行对调整流水的关系。ID 逐列保留，目标现为新表中的原流水行。
UPDATE inventory_count_lines
SET adjustment_movement_id = (
  SELECT movement_id FROM inventory_count_movement_links__0032 refs
  WHERE refs.line_id = inventory_count_lines.id
)
WHERE id IN (SELECT line_id FROM inventory_count_movement_links__0032);
DROP TABLE inventory_count_movement_links__0032;

-- 检测与返修均以追加事件表达；更新/删除由数据库层拒绝。
CREATE TABLE stock_inspection_events (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  stock_item_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('inspection', 'rework')),
  from_status TEXT NOT NULL CHECK (from_status IN ('unrecorded', 'pending', 'passed', 'failed')),
  to_status TEXT NOT NULL CHECK (to_status IN ('unrecorded', 'pending', 'passed', 'failed')),
  result TEXT CHECK (result IS NULL OR result IN ('pass', 'fail')),
  findings TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  stock_item_version INTEGER NOT NULL CHECK (stock_item_version >= 1),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id),
  UNIQUE (store_id, request_id)
);
CREATE INDEX idx_stock_inspection_events_item
  ON stock_inspection_events(store_id, stock_item_id, recorded_at DESC, id DESC);
CREATE TRIGGER stock_inspection_events_no_update
BEFORE UPDATE ON stock_inspection_events
BEGIN
  SELECT RAISE(ABORT, 'stock_inspection_events are append-only');
END;
CREATE TRIGGER stock_inspection_events_no_delete
BEFORE DELETE ON stock_inspection_events
BEGIN
  SELECT RAISE(ABORT, 'stock_inspection_events are append-only');
END;

-- 一个 batchRef 代表一批用户明确整理出的既有库存；换 requestId 不可重加库存。
CREATE TABLE inventory_stock_backfills (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  batch_ref TEXT NOT NULL,
  note TEXT,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id),
  UNIQUE (store_id, batch_ref),
  UNIQUE (store_id, request_id)
);

CREATE TABLE inventory_stock_backfill_lines (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  backfill_id TEXT NOT NULL,
  line_ref TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  tracking_mode TEXT NOT NULL CHECK (tracking_mode IN ('quantity', 'item')),
  qty INTEGER NOT NULL CHECK (qty >= 1),
  stock_item_id TEXT,
  stock_batch_id TEXT,
  condition TEXT CHECK (condition IS NULL OR condition IN ('new', 'used')),
  asset_code TEXT,
  sn_raw TEXT,
  remark TEXT,
  cost_basis TEXT NOT NULL CHECK (cost_basis IN ('known_actual', 'assessed_estimate', 'unknown', 'zero_cost')),
  unit_cost_cents INTEGER CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  estimated_unit_cost_cents INTEGER CHECK (estimated_unit_cost_cents IS NULL OR estimated_unit_cost_cents > 0),
  cost_evidence_ref TEXT,
  cost_assessed_at TEXT,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (backfill_id) REFERENCES inventory_stock_backfills(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
  FOREIGN KEY (stock_batch_id) REFERENCES stock_batches(id),
  UNIQUE (store_id, backfill_id, line_ref),
  CHECK (
    (tracking_mode = 'item' AND qty = 1 AND stock_item_id IS NOT NULL AND stock_batch_id IS NULL)
    OR (tracking_mode = 'quantity' AND stock_item_id IS NULL AND stock_batch_id IS NOT NULL)
  )
);
CREATE INDEX idx_inventory_stock_backfill_lines_product
  ON inventory_stock_backfill_lines(store_id, product_id, backfill_id);
