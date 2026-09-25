-- E06 · 销售单核心：报价成交固化、交易 / 履约状态、销售行与资金流水。
--
-- Prerequisite: apply 0000 -> 0012 first.
-- Additive only: this migration only adds new tables and indexes. It does not alter, drop or
-- rewrite any existing table, column, row, trigger or index. In particular the legacy
-- orders / order_items / order_payments (0003) tables are untouched: the old 订单 pages keep
-- running on them, exactly as 0009 left the legacy 报价编辑器 on quotes alive.
--
-- 契约依据（contracts/v1）：
--   objects.json  SaleOrder    —— orderNo / customerSnapshot / quoteVersionId / kind /
--                                 tradeState / fulfillmentState / dueAt / configurationVersion /
--                                 totalCents / adjustmentCents / cashNetCents / offsetNetCents /
--                                 balanceCents / balanceDirection
--   objects.json  SaleLine     —— productId / source / nameSnapshot / qty / unitPriceCents /
--                                 discountAllocationCents / netLineCents / warrantySnapshot /
--                                 customerDeviceRef
--   objects.json  CashEntry    —— direction / amountCents / method / counterpartyRef /
--                                 counterpartyKind / allocation / purpose / occurredAt /
--                                 verifiedAt / verificationState / reversalOf
--   objects.json  Reservation  —— 落在 0007 的 stock_reservations（E06 只补对象侧 tables 声明，
--                                 不改该表结构；见本文件设计要点 4）
--   enums.json    SaleKind / SaleTradeState / SaleFulfillmentState / LineSource /
--                 BalanceDirection / CashDirection / CashMethod / CashVerificationState /
--                 PaymentPurpose / CounterpartyKind
--   actions.json  B03 报价转为销售单 / B05 确认成交与补分配 / B08 登记销售收款
--   conventions.json money —— 金额只有整数分，服务端重算为准
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 设计要点
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. 新表与旧 orders 并存，不是替换。
--    legacy-mapping.json 的 orders 条目已写明：「旧 orders 没有 version 列，故旧单不能直接
--    充当新版本模型」「fulfillment_status 取值集与新枚举不是同一套，需逐值映射」。硬把新
--    模型塞进旧表，要么改历史行，要么让两套状态语义挤在同一列 —— 两者都不能接受。
--    因此旧表原样保留给旧页，新链路的单据进 sale_orders。历史单默认只读。
--
-- 2. 「未付款不预留、不采购」在建表层面成立。
--    本迁移不创建任何库存副作用语句，也不在 sale_orders 上放「已预留」标记。
--    预留写在 0007 的 stock_reservations，且只由 B05 在收到定金 / 全款之后写。
--    sale_orders.quote_id 只是「这张单从哪份报价来」的引用，不是占用。
--
-- 3. 抢最后一件只有一单能成功，靠 0007 已有的部分唯一索引，不靠应用层判断。
--    uq_stock_reservations_active_item (stock_item_id) WHERE status='active'
--    就是「同一逐件实物同一时刻最多一条有效占用」这条断言本身。B05 并发时，
--    后到的那批 INSERT 撞唯一索引 → 整批回滚 → STOCK_CONFLICT。
--    这条路不查「还剩几件」再决定，因此不存在检查与写入之间的窗口。
--
-- 4. 「预留失败不吞掉已收的钱」是两张表 + 两次 batch 的结果，不需要补偿逻辑。
--    B08 收款与 B05 预留是两个独立的 runIdempotent 调用（各自 requestId、各自 batch）。
--    预留失败只回滚它自己那一批；先前那一笔 cash_entries 与 orders 余额变动照旧成立。
--    契约 B03 要求的「指定二手实物冲突则整次失败，不部分成功」指的是**转单这一批**内部
--    不留半截，与「已经收过的款」无关。
--
-- 5. 金额恒等式写成 CHECK，不靠应用层自觉。
--    total = subtotal - discount + adjustment；balance = total - cashNet - offsetNet；
--    net_line = unitPrice × qty - discountAllocation；
--    balance_direction 必须与 balance 的符号一致（否则「负尾款」会以 store_due 之外的形式漏出去）。
--    B08 的「不超收」不写成 CHECK，而是写成 assertion guard 并带 BALANCE_EXCEEDED ——
--    契约允许 balanceDirection = store_due（门店待退），用 CHECK 一刀切会把该枚举值变成死值。
--
-- 6. 资金流水的幂等靠 operations 表，不在本表加 request_id 唯一索引。
--    operations 的 UNIQUE(store_id, request_id) 已经保证「同一 requestId 只执行一次」。
--    在 cash_entries 上再压一条会误伤将来一笔请求里合法产生多条分录的动作（如置换双方
--    同时挂账），而那种场景恰恰需要多条。request_id 列保留用于追溯，不做唯一约束。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与 0004–0012 一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. sale_orders · 销售单头
--    报价成交时固化：客户快照、来源报价版本、金额与余额方向。
--    customer_snapshot 是快照而非外键：客户改名不改历史单据（与旧 orders 的
--    customer_name / customer_phone / customer_address 三列同义，但新单以 JSON 对象承载，
--    以便承载契约 CustomerSnapshot 的完整形状）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sale_orders (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  order_no TEXT NOT NULL,
  -- 来源报价。可在 B03 之外为空（例如 B04 的零售单），故 nullable。
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
  -- 配置版本。改配 / 换件让检测结果失效，靠它对齐（E08 用）。
  configuration_version INTEGER NOT NULL DEFAULT 0 CHECK (configuration_version >= 0),
  subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  adjustment_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  cash_net_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_net_cents >= 0),
  offset_net_cents INTEGER NOT NULL DEFAULT 0 CHECK (offset_net_cents >= 0),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  balance_direction TEXT NOT NULL DEFAULT 'settled'
    CHECK (balance_direction IN ('client_due', 'settled', 'store_due')),
  note TEXT NOT NULL DEFAULT '',
  -- 条款快照：从成交的报价版本原样复制（定金比例 / 配送 / 质保）。
  -- B05「收到定金才预留」的门槛从这里读 depositPercent；读不到时退回门店参数。
  -- 契约 SaleOrder 没有 termsSnapshot 字段，因此它不进任何 DTO，只作服务端判定依据 ——
  -- 这是记账列，不是给契约偷偷加字段。
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
  CHECK (balance_cents = total_cents - cash_net_cents - offset_net_cents),
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

CREATE INDEX idx_sale_orders_store_created ON sale_orders(store_id, created_at DESC);
CREATE INDEX idx_sale_orders_store_trade ON sale_orders(store_id, trade_state, created_at DESC);
CREATE INDEX idx_sale_orders_quote ON sale_orders(store_id, quote_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. sale_lines · 销售行
--    source 是四类来源的唯一落点（旧 order_items 没有该列）。
--    三条来源约束与报价侧 validateQuoteDraft 的判定逐条对齐，避免「报价能建、成交就爆」：
--      · 二手件必须指定具体实物，且数量为 1
--      · 客供件本身不带价（售价 0），数量为 1
--    另有 net_line_cents 恒等式与 position 唯一。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  sale_order_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  product_id INTEGER,
  source TEXT NOT NULL CHECK (source IN ('new', 'used', 'customer', 'service')),
  name_snapshot TEXT NOT NULL,
  spec_snapshot TEXT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  discount_allocation_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_allocation_cents >= 0),
  net_line_cents INTEGER NOT NULL CHECK (net_line_cents >= 0),
  warranty_snapshot TEXT,
  stock_item_id TEXT,
  customer_device_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(name_snapshot)) > 0),
  CHECK (net_line_cents = unit_price_cents * qty - discount_allocation_cents),
  CHECK (source <> 'used' OR (stock_item_id IS NOT NULL AND qty = 1)),
  CHECK (source <> 'customer' OR (unit_price_cents = 0 AND qty = 1)),
  UNIQUE (sale_order_id, position),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
);

CREATE INDEX idx_sale_lines_order ON sale_lines(sale_order_id, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. cash_entries · 资金流水
--    一笔实际资金一条记录（objects.json CashEntry.rules 第 1 条）。
--    direction 是新增能力：旧 order_payments 只有收款方向、无参考冲销（legacy-mapping.json
--    已登记该缺口），新表把方向与 reversal_of 补上。
--    verification_state 只表示人工对账，不代表支付平台确认到账（enums.json 明写）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE cash_entries (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'bank', 'other')),
  verification_state TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_state IN ('unverified', 'verified')),
  verified_at TEXT,
  counterparty_kind TEXT NOT NULL CHECK (counterparty_kind IN ('customer', 'supplier', 'staff', 'other')),
  counterparty_ref TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('sale_order', 'service_order', 'purchase', 'recovery')),
  -- 契约 allocation（订单 / 采购 / 回收 / 维修分摊）拆成三个可查列 + 类型标签：
  -- 分摊是「这笔钱挂在哪张单上」，不是自由文本。
  allocation_type TEXT NOT NULL,
  allocation_id TEXT,
  sale_order_id TEXT,
  occurred_at TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  reversal_of TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- 幂等由 operations 保证（见设计要点 6）；本列只用于追溯与失败诊断。
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (verified_at IS NULL OR verification_state = 'verified'),
  CHECK (purpose <> 'sale_order' OR sale_order_id IS NOT NULL),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id),
  FOREIGN KEY (reversal_of) REFERENCES cash_entries(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_cash_entries_store_occurred ON cash_entries(store_id, occurred_at DESC);
CREATE INDEX idx_cash_entries_order ON cash_entries(store_id, sale_order_id, occurred_at DESC);
CREATE INDEX idx_cash_entries_request ON cash_entries(store_id, request_id);
