-- E07 · 采购到货核心：缺件采购单、快捷供应商、分批到货验收与退供。
--
-- Prerequisite: apply 0000 -> 0013 first.
-- Additive only: this migration only adds new tables and indexes. It touches no existing table.
--
-- 契约依据（contracts/v1）：
--   objects.json  Purchase —— supplierRef / supplierNote / purchaseLines / orderedQty /
--                              receivedQty / cancelledQty / expectedAt（后三者是派生量）
--   objects.json  Receipt  —— purchaseId / quickPurchaseNote / receiptLines / unitCostCents /
--                              inspectionDisposition / receivedAt
--   objects.json  InventoryMovement —— 每个库存副作用的唯一来源标识
--   enums.json    InspectionDisposition / StockCondition
--   actions.json  B14 创建采购与到货计划 / B15 登记实际到货与入库 /
--                 B38 退供（2026-09-21 由 supplementaryActions 提升为正式动作）
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 设计要点
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. purchase_orders 刻意没有 status 列。
--    objects.json Purchase.notStored 已把这件事写死为**有意设计**：「采购进度由
--    orderedQty / receivedQty / cancelledQty 三个计数器派生，存储状态会与计数器产生第二
--    真相来源，允许两者漂移」。所以本迁移不反驳契约、也不擅自加一列「反正方便」。
--    采购的进度口径永远是 pendingQty = orderedQty - receivedQty - cancelledQty。
--
-- 2. 「5 件只到 3 件，在途剩 2」是派生结果，不是记上去的状态。
--    订购量在 purchase_lines.qty_ordered；实收与拒收在 purchase_receipt_lines；
--    取消在 purchase_lines 的取消记录里（本轮未开放取消采购，B37 仍为 reserved）。
--    因此「在途」永远等于订购减已处置，不可能出现「状态说已到齐、行说还差 2 件」。
--
-- 3. 「拒收不进可用」由 inspection_disposition 决定，不由调用方口头保证。
--    只有 available 这一种去向写入 available 流水；return_to_supplier / scrapped 写入的是
--    retired（离店），quarantine 写入 quarantine（待处理）。三者都不增加可卖量。
--
-- 4. 快捷采购不等于没有来源。
--    purchase_id 为空时必须填 quick_purchase_note（CHECK 强制），并且照样要有商品、
--    数量、单件成本与成本是否已知 —— 「现买现入」丢掉的只是采购单，不是溯源。
--    成本未知必须为 NULL，不得写 0（与 inventory_opening_lines 同一口径）。
--
-- 5. 退供是自有在库减少，只从 available / quarantine 出发。
--    不允许从 reserved 退供：那会拆掉某张已成交订单的占用，而订单那一侧毫不知情。
--    退供与「到货时当场拒收」是两件事：前者处理已经进过账的货，后者实物从未进入自有在库。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与 0004–0013 一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. purchase_orders · 采购单头
--    无 status 列（见设计要点 1）。供应商两种形态：建档（supplier_ref）或快捷（supplier_name）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  purchase_no TEXT NOT NULL,
  -- 缺件来源订单。散采不挂单，故可空。
  sale_order_id TEXT,
  supplier_ref TEXT,
  supplier_name TEXT NOT NULL DEFAULT '',
  supplier_note TEXT,
  expected_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(purchase_no)) > 0),
  -- 供应商至少要有一个身份：建档案号，或快捷供应商名称。
  CHECK (supplier_ref IS NOT NULL OR length(trim(supplier_name)) > 0),
  UNIQUE (store_id, purchase_no),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_purchase_orders_store_created ON purchase_orders(store_id, created_at DESC);
CREATE INDEX idx_purchase_orders_sale ON purchase_orders(store_id, sale_order_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. purchase_lines · 采购行
--    订购量在此；实收 / 拒收量在到货明细，取消量另记。三处不再互相改写。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE purchase_lines (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  purchase_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  product_id INTEGER NOT NULL,
  product_ref TEXT,
  name_snapshot TEXT NOT NULL,
  spec_snapshot TEXT,
  qty_ordered INTEGER NOT NULL CHECK (qty_ordered > 0),
  unit_cost_cents INTEGER,
  cost_known INTEGER NOT NULL CHECK (cost_known IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(name_snapshot)) > 0),
  -- 成本未知必须是「没给金额」；给 0 是「这件是零成本」，两者不能混。
  CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  CHECK (cost_known = 1 OR unit_cost_cents IS NULL),
  CHECK (cost_known = 0 OR unit_cost_cents IS NOT NULL),
  UNIQUE (purchase_id, position),
  FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id)
);

CREATE INDEX idx_purchase_lines_purchase ON purchase_lines(purchase_id, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. purchase_receipts · 到货验收单头（一次到货一条）
--    部分到货分次建单，每次各有 requestId（objects.json Receipt.rules 第 1 条）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE purchase_receipts (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  purchase_id TEXT,
  quick_purchase_note TEXT,
  note TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- 契约 B15：purchaseId 与 quickPurchase 至少给一个，二者同时缺失为 VALIDATION_ERROR。
  CHECK (purchase_id IS NOT NULL OR (quick_purchase_note IS NOT NULL AND length(trim(quick_purchase_note)) > 0)),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_purchase_receipts_store_occurred ON purchase_receipts(store_id, occurred_at DESC);
CREATE INDEX idx_purchase_receipts_purchase ON purchase_receipts(purchase_id, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. purchase_receipt_lines · 到货明细
--    实收与拒收分列：拒收件计入采购恒等式的「已拒收」一侧，因此不留下在途假象。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE purchase_receipt_lines (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  receipt_id TEXT NOT NULL,
  purchase_line_id TEXT,
  position INTEGER NOT NULL CHECK (position >= 0),
  product_id INTEGER NOT NULL,
  qty_received INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_rejected INTEGER NOT NULL DEFAULT 0 CHECK (qty_rejected >= 0),
  inspection_disposition TEXT NOT NULL
    CHECK (inspection_disposition IN ('available', 'quarantine', 'return_to_supplier', 'return_to_customer', 'scrapped')),
  unit_cost_cents INTEGER,
  cost_known INTEGER NOT NULL CHECK (cost_known IN (0, 1)),
  -- 只有进过自有在库的去向才允许携带实物 ID（available 与 quarantine 都是自有待售 / 待检）。
  stock_item_id TEXT,
  asset_code TEXT,
  sn_raw TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- 一行到货至少要带来一次实收或一次拒收，否则这条明细没有事实。
  CHECK (qty_received > 0 OR qty_rejected > 0),
  CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  CHECK (cost_known = 1 OR unit_cost_cents IS NULL),
  CHECK (cost_known = 0 OR unit_cost_cents IS NOT NULL),
  CHECK (inspection_disposition IN ('available', 'quarantine') OR stock_item_id IS NULL),
  UNIQUE (receipt_id, position),
  FOREIGN KEY (receipt_id) REFERENCES purchase_receipts(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (purchase_line_id) REFERENCES purchase_lines(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
);

CREATE INDEX idx_purchase_receipt_lines_receipt ON purchase_receipt_lines(receipt_id, position);
CREATE INDEX idx_purchase_receipt_lines_line ON purchase_receipt_lines(purchase_line_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. supplier_returns · 退供事件（B38）
--    契约没有独立的退供单对象，本表作为 InventoryMovement 的来源事件载体登记。
--    只从 available / quarantine 出发（见设计要点 5）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE supplier_returns (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  return_no TEXT NOT NULL,
  purchase_id TEXT,
  supplier_name TEXT NOT NULL DEFAULT '',
  product_id INTEGER NOT NULL,
  stock_item_id TEXT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  from_bucket TEXT NOT NULL CHECK (from_bucket IN ('available', 'quarantine')),
  reason TEXT NOT NULL,
  unit_cost_cents INTEGER,
  cost_known INTEGER NOT NULL CHECK (cost_known IN (0, 1)),
  occurred_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(return_no)) > 0),
  CHECK (length(trim(reason)) > 0),
  CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  CHECK (cost_known = 1 OR unit_cost_cents IS NULL),
  CHECK (cost_known = 0 OR unit_cost_cents IS NOT NULL),
  UNIQUE (store_id, return_no),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_supplier_returns_store_occurred ON supplier_returns(store_id, occurred_at DESC);
CREATE INDEX idx_supplier_returns_purchase ON supplier_returns(purchase_id);
