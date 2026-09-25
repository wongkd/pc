-- E09 · 取消、退货、退款、欠款交付与账本：欠款批准、退货、退款三张表 + 重建 sale_orders 扩展余额。
--
-- Prerequisite: apply 0000 -> 0016 first.
-- Additive only: 本迁移新增三张表，并重建 sale_orders 一张既有表（加列 + 改 CHECK）。
-- 与 0013 / 0016 同样的分界：旧的 orders / order_items / order_payments 一行不碰，
-- 旧订单页继续跑在旧链路上。sale_lines / cash_entries / sale_checklists / sale_deliveries
-- 四张子表一行不碰，它们对 sale_orders 的外键在重建后自然指向同名新表。
--
-- 契约依据（contracts/v1）：
--   objects.json  ReturnRecord —— originalOrderId / lineAllocations / stockItemIds / reason /
--                                 acceptedQty / creditCents / creditState / refundEntryRef
--   objects.json  Refund       —— originalOrderId / returnRef / adjustmentRef / amountCents /
--                                 method / occurredAt / reason
--   enums.json    CreditState（pending / approved）
--                 FinancialDisposition（settled_in_full / credit_approved）
--                 InventoryMovementSource（return_receipt 退货入库）
--   actions.json  B09 批准欠款交付 / B11 取消销售单 / B17 登记退货 / B18 登记现金退款 / B43 批准退货贷项
--   money-rules.json refundableCashCents / partialReturn / reversalPolicy / cashNetReceivedCents
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 设计要点
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. 余额模型扩展：balance 由「正向销售」补上「反向冲减」。
--    E06 建 sale_orders 时只有正向：balance = total - cash_net - offset，cash_net 只增不减。
--    退货 / 退款 / 取消要把钱退给客户、把货退回来，需要两个新事实：
--      · return_credit_cents —— 累计已批准退货贷项（B43 批准时增加；B11 取消时全额冲销）；
--      · cash_net_cents      —— 落实为「净收现金」：收款（B08）增加、退款（B18）减少、
--                              反冲（B34）按被冲笔方向反向调整。
--    新恒等式（对齐 money-rules salesBalanceCents）：
--      balance = total - return_credit - cash_net - offset
--    cash_net 语义从「累计收」改成「净收」不破坏存量：本迁移应用时还没有任何退款/退货，
--    旧行的 cash_net 就是净收。列名本就有 net 字样，这是落实而非改名。
--
-- 2. 重建 sale_orders 是必要的：SQLite / D1 不支持 ALTER TABLE 改 CHECK，
--    改 balance 的恒等式只能「建新表 → 拷数据 → 换名」（0011 / 0012 / 0015 同一流程）。
--    前置条件：0013 至今没有应用到任何远端环境（docs/OPEN-ITEMS.md T-06），
--    sale_orders 在所有环境里都是空表或本地测试行，重建无数据搬运代价。
--    搬运语句仍写全，供已建库的本地环境自查。return_credit_cents 恒写 0（尚无退货）。
--
-- 3. 三张新表各司其职，不互相冒充：
--    · sale_credit_approvals —— 欠款批准（B09）：老板批准时固化「当时的欠款余额 + 到期日 + 原因」；
--      是快照，不改写不删除。B10 交付时以 credit_approval_id 引用并校验。
--    · sale_returns —— 退货单（B17/B43）：贷项状态 credit_state（pending → approved）落在这里，
--      栋哥 2026-09-21 拍板「退货贷项要老板审批才生效」；实物收货由 stock_items + 流水承载，不设在此表。
--    · sale_refunds —— 现金退款单（B18）：退款本身不触发入库（objects.json Refund.rules）。
--
-- 4. 资金与库存动作的可追溯：退款写 direction='out' 的 cash_entries（reversal_of 留空——
--    那是真退款不是纠错）；退货收货写 inventory_movements（sold → quarantine，source='return_receipt'），
--    由 0007 的触发器同步 stock_balances，quarantine_qty 增加。sold → quarantine 这条桶转换
--    已在 enums.json inventoryBucketRules 补登记（退货接收 B17）。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与 0004–0016 一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. 重建 sale_orders：加 return_credit_cents，改 balance 恒等式
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sale_orders__v17 (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  order_no TEXT NOT NULL,
  quote_id TEXT,
  quote_revision INTEGER,
  customer_id INTEGER,
  customer_snapshot TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assembly', 'retail')),
  trade_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (trade_state IN ('draft', 'confirmed', 'cancelled', 'closed')),
  fulfillment_state TEXT NOT NULL DEFAULT 'waiting_stock'
    CHECK (fulfillment_state IN ('waiting_stock', 'preparing', 'testing', 'ready_delivery', 'delivered')),
  due_at TEXT,
  configuration_version INTEGER NOT NULL DEFAULT 0 CHECK (configuration_version >= 0),
  subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  adjustment_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  -- 净收现金 = 累计收款 - 累计退款 ± 反冲。B08 加、B18 减、B34 按方向反向调整。
  cash_net_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_net_cents >= 0),
  offset_net_cents INTEGER NOT NULL DEFAULT 0 CHECK (offset_net_cents >= 0),
  -- 累计已批准退货贷项；B11 取消时置为 total_cents（账务上取消=全额冲销应计，实物不收货）。
  return_credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (return_credit_cents >= 0),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  balance_direction TEXT NOT NULL DEFAULT 'settled'
    CHECK (balance_direction IN ('client_due', 'settled', 'store_due')),
  note TEXT NOT NULL DEFAULT '',
  terms_snapshot TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(order_no)) > 0),
  CHECK (discount_cents <= subtotal_cents),
  CHECK (total_cents = subtotal_cents - discount_cents + adjustment_cents),
  -- 余额恒等式：净应计（含退货贷项冲减）− 净收现金 − 折抵。
  CHECK (balance_cents = total_cents - return_credit_cents - cash_net_cents - offset_net_cents),
  -- 余额方向不是可编辑下拉框，而是余额的另一种写法（objects.json SaleOrder.rules 第 3 条）。
  CHECK (
    (balance_cents > 0 AND balance_direction = 'client_due')
    OR (balance_cents = 0 AND balance_direction = 'settled')
    OR (balance_cents < 0 AND balance_direction = 'store_due')
  ),
  UNIQUE (store_id, order_no),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (quote_id) REFERENCES quote_headers(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

-- 搬运：return_credit_cents 恒为 0（应用本迁移时还没有退货/取消冲销）。
INSERT INTO sale_orders__v17
  (id, store_id, order_no, quote_id, quote_revision, customer_id, customer_snapshot, kind,
   trade_state, fulfillment_state, due_at, configuration_version,
   subtotal_cents, discount_cents, adjustment_cents, total_cents,
   cash_net_cents, offset_net_cents, return_credit_cents, balance_cents, balance_direction,
   note, terms_snapshot, version, request_id, created_by, updated_by, created_at, updated_at)
SELECT id, store_id, order_no, quote_id, quote_revision, customer_id, customer_snapshot, kind,
       trade_state, fulfillment_state, due_at, configuration_version,
       subtotal_cents, discount_cents, adjustment_cents, total_cents,
       cash_net_cents, offset_net_cents, 0, balance_cents, balance_direction,
       note, terms_snapshot, version, request_id, created_by, updated_by, created_at, updated_at
FROM sale_orders;

DROP TABLE sale_orders;

ALTER TABLE sale_orders__v17 RENAME TO sale_orders;

-- 重建 0013 原有的索引（随 DROP TABLE 一并消失）。
CREATE INDEX idx_sale_orders_store_created ON sale_orders(store_id, created_at DESC);
CREATE INDEX idx_sale_orders_store_trade ON sale_orders(store_id, trade_state, created_at DESC);
CREATE INDEX idx_sale_orders_quote ON sale_orders(store_id, quote_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. sale_credit_approvals · 欠款交付批准（B09）
--    老板批准欠款时固化「当时的欠款余额 + 到期日 + 原因 + 审批人」。是快照，不改写。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sale_credit_approvals (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  sale_order_id TEXT NOT NULL,
  -- 批准当时的欠款余额（必须为正：欠款交付才有意义）。
  balance_cents INTEGER NOT NULL CHECK (balance_cents > 0),
  -- 到期日：仅作提醒线索，系统不据此自动扣款或自动取消（03 §8）。
  due_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  approved_by INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(due_date)) > 0),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id),
  FOREIGN KEY (approved_by) REFERENCES users(id)
);

CREATE INDEX idx_sale_credit_approvals_order
  ON sale_credit_approvals(store_id, sale_order_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. sale_returns · 退货单（B17 / B43）
--    贷项状态 credit_state（pending → approved）落在此表；实物收货由 stock_items + 流水承载。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sale_returns (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  sale_order_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  -- 本次接收的退货数量（契约 ReturnRecord.acceptedQty）。
  accepted_qty INTEGER NOT NULL CHECK (accepted_qty > 0),
  -- 本次退货的贷项金额（分）。累计退货贷项不得超过原行净额（money-rules partialReturn.cap）。
  credit_cents INTEGER NOT NULL CHECK (credit_cents >= 0),
  -- 贷项审批状态：B17 登记为 pending，B43 批准转 approved 才计入应退。
  credit_state TEXT NOT NULL DEFAULT 'pending' CHECK (credit_state IN ('pending', 'approved')),
  -- 原行 / 数量 / 实物分配（契约 ReturnRecord.lineAllocations 数组）。
  line_allocations_json TEXT NOT NULL,
  -- 接收的实物（契约 ReturnRecord.stockItemIds 数组）。
  stock_item_ids_json TEXT NOT NULL,
  refund_entry_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  approved_by INTEGER,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(line_allocations_json)) > 0),
  CHECK (length(trim(stock_item_ids_json)) > 0),
  -- 审批事实的一致性：approved 必须有审批人与时间，pending 二者为空。
  CHECK ((credit_state = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
      OR (credit_state = 'pending' AND approved_by IS NULL AND approved_at IS NULL)),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id)
);

CREATE INDEX idx_sale_returns_order ON sale_returns(store_id, sale_order_id, created_at DESC);
CREATE INDEX idx_sale_returns_state ON sale_returns(store_id, credit_state, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. sale_refunds · 现金退款单（B18）
--    退款本身不触发入库；退多少钱由 B18 校验上限（money-rules refundableCashCents）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sale_refunds (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  sale_order_id TEXT NOT NULL,
  return_ref TEXT,
  adjustment_ref TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'bank', 'other')),
  occurred_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (return_ref IS NOT NULL OR adjustment_ref IS NOT NULL),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id),
  FOREIGN KEY (return_ref) REFERENCES sale_returns(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_sale_refunds_order ON sale_refunds(store_id, sale_order_id, occurred_at DESC);
