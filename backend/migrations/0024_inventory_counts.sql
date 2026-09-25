-- ─────────────────────────────────────────────────────────────────────────────
-- 0024_inventory_counts.sql · B16 盘点录入与差异批准
--
-- 契约依据（contracts/v1/actions.json B16「盘点录入与差异批准」）：
--   POST /inventory/counts              权限 inventory/count         （旧 library/edit 等价，grantPolicy=default）
--   POST /inventory/counts/:id/approve  权限 inventory/count-approve （legacySource=null，owner_only 老板专属）
--   inputs   范围与截止序号:CountScope! / 实盘:CountLine[] / 批准差异理由:string
--   effects  InventoryMovement / StockBalance / AuditEvent
--   errors   VERSION_CONFLICT / PERMISSION_DENIED / VALIDATION_ERROR
--
-- ── 为什么要建这两张表 ──
-- 契约 B16 的 effects 只有 InventoryMovement / StockBalance / AuditEvent，**没有独立「盘点单」实体**；
-- legacy-mapping.json 的 objectsWithoutLegacyTable 里一直挂着「盘点单（T06c 定义，枚举待补）」。
-- 但 B16 的语义要求「保存实盘结果不直接改库存，批准后才生成差异调整事件」——
-- 也就是实盘事实必须**持久化留到批准那一刻**，不能只在一次请求里算完。
-- 因此这两张表作为 InventoryMovement 的**支撑事件表**登记（与 purchase_cancellations 挂 Purchase、
-- sale_credit_approvals 挂 SaleOrder 是同一处理），**不新增契约对象**。
--
-- ── 三条硬口径（02 §5 / 03 §7）──
--   ① 保存实盘**不直接改库存**：录入只写本表，一条 inventory_movements 都不写。
--   ② 批准才生成差异调整事件：按行 diff = counted_qty - book_qty 写 source='count_adjustment'
--      的流水，余额由 0007 的 inventory_movements_apply_balance 触发器结算到 stock_balances。
--   ③ 并发以截止时点对齐：book_qty 是**录入那一刻锁存的账面**，不是批准时重算的。
--      批准时若该商品账面已偏离锁存值（截止点后有新变动），报 VERSION_CONFLICT 要求重盘，
--      而不是拿旧账面硬调 —— 硬调会静默吞掉截止点之后的正常出入库。
--
-- ── 为什么 count_lines 不存 diff 列 ──
-- diff 完全由 book_qty 与 counted_qty 派生。存下来就多出一个「可以与事实不符」的列
-- （约束即断言的原则：能派生的事实不要落库，落库的每一个字段都得有约束证明它不撒谎）。
-- 差异在批准时按 (counted_qty - book_qty) 现算，并由写出的 count_adjustment 流水留痕。
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. inventory_counts · 一次盘点的表头（草稿 → 批准）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_counts (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved')),
  -- 截止时点（CountScope.asOf）：账面快照的时间锚点，溯源用。
  as_of TEXT NOT NULL,
  -- 盘点范围说明（人读）：如「全店」「A 货架」。契约 CountScope 的「范围」部分。
  scope_note TEXT,
  note TEXT,
  -- 批准差异理由（契约必填输入「批准差异理由」）：只有批准态才允许为空以外的值。
  approved_reason TEXT,
  approved_by INTEGER,
  approved_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- 录入动作的 requestId（幂等与溯源）；批准动作另记一行。
  request_id TEXT NOT NULL,
  approve_request_id TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 单向蕴含，不写双向等价：批准态必须同时有理由、批准人与批准时间；
  -- 草稿态对这三个字段不做要求（草稿本来就没有批准事实）。
  CHECK (status <> 'approved' OR (approved_reason IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (approved_by) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_inventory_counts_store ON inventory_counts(store_id, created_at DESC);
CREATE INDEX idx_inventory_counts_status ON inventory_counts(store_id, status);
CREATE INDEX idx_inventory_counts_request ON inventory_counts(store_id, request_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. inventory_count_lines · 盘点行（锁存账面 + 实盘结果）
--    同一次盘点对同一商品只允许一行：UNIQUE(count_id, product_id)。
--    否则同一商品的两次实盘会写出两条互相冲突的差异流水。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_count_lines (
  id TEXT PRIMARY KEY,
  count_id TEXT NOT NULL,
  store_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  -- 录入那一刻锁存的账面可卖数量（stock_balances.available_qty，无余额行时为 0）。
  book_qty INTEGER NOT NULL CHECK (book_qty >= 0),
  -- 人工实盘数量。
  counted_qty INTEGER NOT NULL CHECK (counted_qty >= 0),
  note TEXT,
  -- 批准后写出的 count_adjustment 流水 id；差异为 0 时为 NULL（无调整即无流水）。
  adjustment_movement_id TEXT,
  FOREIGN KEY (count_id) REFERENCES inventory_counts(id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (adjustment_movement_id) REFERENCES inventory_movements(id)
);

CREATE UNIQUE INDEX idx_inventory_count_lines_unique ON inventory_count_lines(count_id, product_id);
CREATE INDEX idx_inventory_count_lines_count ON inventory_count_lines(count_id);
