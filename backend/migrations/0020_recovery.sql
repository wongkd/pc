-- E10 · 回收拆件：回收单、实物行、拆件记录三张表（B26/B27/B28/B29/B44 + B33 付款 + R10 读）。
--
-- Prerequisite: apply 0000 -> 0019 first.
-- Additive only: 本迁移只新增三张表，不重建任何既有表、不碰 0018 的 inventory_movements 重建。
-- 拆件产出的零件写 stock_items（acquisition_ref 指向回收单）+ inventory_movements（source='conversion'），
-- 由 0007/0018 的余额触发器维护 stock_balances；产出件进 quarantine，交由 B19（0018）判定后上架。
--
-- 契约依据（contracts/v1）：
--   objects.json  Recovery        —— sellerRef / items / initialEstimateCents / offerVersion /
--                                    finalAcquisitionCents / state（RecoveryState）
--   objects.json  RecoveryTeardown —— 拆件入库：源件退役、产出件新建待检、损耗单列报废
--   enums.json    RecoveryState（draft → received_for_inspection → inspecting → offered →
--                                    acquired → disassembled → … → returned）
--                 InventoryMovementSource.conversion（B44 拆件，2026-09-21 起启用）
--   actions.json  B26 回收登记 / B27 验机估价 / B28 取得所有权 / B29 归还 / B44 拆件 / B33 付款 / R10 读
--   money-rules.json recoveryPayableRemainingCents（最终价 + 调整 − 有效折抵 − 现金净付）
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 设计要点
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. 所有权边界（03 §4 / objects.json Recovery.rules）：
--    B26 登记的实物是「客户暂存」：ownership='customer'、availability='customer_custody'，
--    不进自有在库、不计成本。只有 B28 取得所有权后才 ownership='store'、availability='quarantine'
--    （待检，不自动可卖），逐件成本落到 stock_items.acquisition_cost_cents。
--
-- 2. 应付模型：payable_cents = final_acquisition_cents − paid_cents（恒等式写成 CHECK）。
--    B28 取得所有权时 payable 置为最终价、paid 为 0；B33 付款时 paid 增加、payable 同步减少。
--    抵用（tradein）属刀二，不在本迁移；本表只承载「现金付款」路径。
--
-- 3. 拆件守恒（栋哥 2026-09-21 拍板「损耗单列报废」）：
--    recovery_teardowns 用 CHECK (output_cost_cents + scrap_cost_cents = source_cost_cents) 强制
--    产出件成本 + 损耗 = 源整机成本，差额不为零整批回滚。损耗走 scrap 流水，不摊进产出件。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与其他迁移一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. recovery_orders · 回收单头
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE recovery_orders (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  order_no TEXT NOT NULL,
  -- 卖方：已有客户挂 customers(id)，散客为 NULL、信息落 seller_snapshot。
  seller_customer_id INTEGER,
  seller_snapshot TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'received_for_inspection', 'inspecting', 'offered',
                     'acquired', 'disassembled', 'refurbishing', 'ready_for_sale',
                     'return_pending', 'returned')),
  initial_estimate_cents INTEGER,
  offer_version INTEGER NOT NULL DEFAULT 0 CHECK (offer_version >= 0),
  final_acquisition_cents INTEGER,
  -- 应付 = 最终收购价 − 已付现金；抵用属刀二，不在此列。
  payable_cents INTEGER NOT NULL DEFAULT 0 CHECK (payable_cents >= 0),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  received_at TEXT,
  accepted_at TEXT,
  confirmation_evidence_ref TEXT,
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(order_no)) > 0),
  CHECK (initial_estimate_cents IS NULL OR initial_estimate_cents >= 0),
  CHECK (final_acquisition_cents IS NULL OR final_acquisition_cents >= 0),
  -- 应付恒等式：最终价未定（acquire 前）不约束；定了之后 payable = final − paid。
  CHECK (final_acquisition_cents IS NULL OR payable_cents = final_acquisition_cents - paid_cents),
  UNIQUE (store_id, order_no),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (seller_customer_id) REFERENCES customers(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX idx_recovery_orders_store_created ON recovery_orders(store_id, created_at DESC);
CREATE INDEX idx_recovery_orders_store_state ON recovery_orders(store_id, state, created_at DESC);
CREATE INDEX idx_recovery_orders_seller ON recovery_orders(store_id, seller_customer_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. recovery_items · 回收单实物行（暂存物 + 逐件估价/成本）
--    实物本身是 stock_items（B26 建 customer_custody，B28 转 store/quarantine），
--    本表承载「回收单对每个实物的估价与取得成本」，stock_item_id 关联同一件实物。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE recovery_items (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  recovery_order_id TEXT NOT NULL,
  -- B26 登记时暂存物尚未关联商品，本列为 NULL；B28 收购时填新建的 store 实物 id。
  stock_item_id TEXT,
  description TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'used' CHECK (condition IN ('new', 'used')),
  sn_raw TEXT,
  -- 逐件估价（B27）；取得所有权后为逐件成本（B28）。
  estimated_cents INTEGER,
  acquired_cost_cents INTEGER,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(description)) > 0),
  CHECK (estimated_cents IS NULL OR estimated_cents >= 0),
  CHECK (acquired_cost_cents IS NULL OR acquired_cost_cents >= 0),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (recovery_order_id) REFERENCES recovery_orders(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
);

CREATE INDEX idx_recovery_items_order ON recovery_items(store_id, recovery_order_id);
CREATE INDEX idx_recovery_items_stock ON recovery_items(store_id, stock_item_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. recovery_teardowns · 拆件记录（B44）
--    源整机退役，产出件新建进待检，损耗单列报废。守恒约束见 CHECK。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE recovery_teardowns (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  recovery_order_id TEXT NOT NULL,
  source_stock_item_id TEXT NOT NULL,
  -- 产出件数组（productRef / condition / assetCode / snRaw / costCents / stockItemId）。
  outputs_json TEXT NOT NULL,
  -- 损耗件数组（description / costCents），单列报废不摊进产出件。
  scrap_json TEXT,
  source_cost_cents INTEGER NOT NULL CHECK (source_cost_cents >= 0),
  output_cost_cents INTEGER NOT NULL CHECK (output_cost_cents >= 0),
  scrap_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (scrap_cost_cents >= 0),
  occurred_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(outputs_json)) > 0),
  -- 守恒：产出件成本 + 损耗 = 源整机成本，差额不为零整批回滚。
  CHECK (output_cost_cents + scrap_cost_cents = source_cost_cents),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (recovery_order_id) REFERENCES recovery_orders(id),
  FOREIGN KEY (source_stock_item_id) REFERENCES stock_items(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_recovery_teardowns_order ON recovery_teardowns(store_id, recovery_order_id, created_at DESC);
CREATE INDEX idx_recovery_teardowns_source ON recovery_teardowns(store_id, source_stock_item_id);
