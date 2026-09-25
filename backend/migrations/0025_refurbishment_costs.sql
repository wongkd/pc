-- B30 · 整备与上架：逐件记录整备成本明细，并把「上架门槛」缺的几项事实落到实物上。
--
-- 栋哥 2026-09-22 拍板口径：
--   ① 只对「来自回收单、未拆件、回收单处于 acquired」的实物生效（与 B44 拆件天然互斥）；
--   ② 成色用五档 ConditionGrade；③ 披露 = 自由文本 + 客户数据处置勾选；
--   ④ 质保用月数 WarrantyTerm；⑤ 逐件标价落 stock_items.sale_price_cents。
--
-- 成本口径（03 §7 / fixtures 的 880 = 800 收购 + 80 可归属整备）：
--   整备成本计入该件可归属成本，交付时只确认一次成本快照，
--   **不因此新增一笔「采购」现金** —— 所以本表只记成本明细，不写 cash_entries。
--   capitalizable（费用归属）与 payment_entry_ref（实际付款）分开，防止同一笔钱被计两次成本。
--
-- ⚠️ 与其他迁移一样，本文件在明确授权前不得 apply 到任何远端环境。

CREATE TABLE refurbishment_costs (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  stock_item_id TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  -- 是否计入该件可归属成本：0 = 只作费用记录，不进件成本（fixtures 里那笔 3000 分）。
  capitalizable INTEGER NOT NULL CHECK (capitalizable IN (0, 1)),
  -- 费用归属与实际付款不是同一字段：付款可能还没发生，或一次付款覆盖多笔整备。
  payment_entry_ref TEXT,
  evidence_ref TEXT,
  occurred_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(category)) > 0),
  -- 幂等：同一 requestId 对同一件只落一行，重放不重复计成本。
  UNIQUE (store_id, request_id, stock_item_id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_refurbishment_costs_item
  ON refurbishment_costs(store_id, stock_item_id, occurred_at DESC);

-- ── 上架门槛七项里此前无处可落的 5 项 ─────────────────────────────────────
-- 已有的三项：逐件编号 asset_code、成本 acquisition_cost_cents + refurbishment_cost_cents、检测 inspection_ref。
--
-- ⚠️ 五列一律允许 NULL：未经整备上架的件（新品、期初件、B44 拆件产出待检件）本来就没有这些事实，
--    用默认值冒充「已填」会让上架门槛形同虚设 —— 门槛检查就是查「这五项是否都非空」。
--    因此这里刻意不写 DEFAULT，也不写 NOT NULL。
--
-- 说明：SQLite 的 ALTER TABLE ADD COLUMN 不支持带表级约束；取值合法性由领域层校验
-- （condition_grade ∈ ConditionGrade、data_disposed ∈ {0,1}、sale_price_cents > 0）。

ALTER TABLE stock_items ADD COLUMN condition_grade TEXT;
ALTER TABLE stock_items ADD COLUMN sale_price_cents INTEGER;
ALTER TABLE stock_items ADD COLUMN disclosure_note TEXT;
ALTER TABLE stock_items ADD COLUMN data_disposed INTEGER;
ALTER TABLE stock_items ADD COLUMN warranty_term TEXT;
