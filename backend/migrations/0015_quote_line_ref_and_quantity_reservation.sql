-- E06/E07 补洞（2026-09-21）· 让已经做好的销售/采购两条链路在真实业务里走满。
--
-- Prerequisite: apply 0000 -> 0014 first.
--
-- 本迁移修两个东西，性质完全不同，分开说明：
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. quote_lines.product_ref —— 补上一列，让「成交前必须映射到商品」能做到
-- ─────────────────────────────────────────────────────────────────────────────
-- 症状：E06 转销售单时，新品行解析不出商品，只能把 sale_lines.product_id 记成 NULL
-- 并丢进「缺口」，于是「订单缺件 → 建采购补货」这条线在界面上是断的。
--
-- 根因不在设计，在**写入时就丢了数据**：E05 的 QuoteLineInput 早就有 productRef 字段
-- （注释写着「报价阶段允许为空 —— 临时行在成交前才必须映射」），但 insertLineStatement
-- 的 INSERT 没有这一列，表也没有 —— 接口收了、库里没落。E06 拿不到引用是必然结果。
--
-- 契约依据（不需要改契约）：objects.json QuoteVersion.rules 第 1 条已经写着
--   「草稿中的临时实物行可未建档；成交前必须映射到商品。」
-- 所以「报价行要能携带商品引用」原本就是契约要求，只是实现漏了。本次补列即补齐实现，
-- 并把行的字段名写进 QuoteVersion.fields.lines.desc，让两端有共同定义。
--
-- 列语义：
--   product_ref 存 hardware.entity_id（字符串），与 E04b 的库存引用、E07 采购的
--   productRef 同一口径，不另起一套主键形式。
--   允许为空 —— 报价阶段允许临时行（契约）。是否允许成交，由成交动作判定，不由表拦。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. stock_reservations 支持数量件 —— 让硬边界③对「按数量卖的新品」也生效
-- ─────────────────────────────────────────────────────────────────────────────
-- 症状：内存条 / 硬盘 / 风扇这类按数量卖的新品，付了定金也锁不住库存。
-- 0007 建表时 stock_item_id 是 NOT NULL、qty 写死 CHECK (qty = 1)，
-- 唯一索引也按 stock_item_id 建 —— 只支持逐件实物。
--
-- 但契约早就要求了两条，只是实现没跟上（同样不用改契约）：
--   · objects.json Reservation.fields.quantityBucketRef：「数量件占用时必填」；
--   · enums.json ReservationStatus：「数量件累计不得超过可用量」。
--
-- 重建后：stock_item_id 与 quantity_bucket_ref 恰有其一。
--   · 逐件占用：stock_item_id 有值、qty = 1（沿用 0007 的逐件唯一断言）；
--   · 数量件占用：quantity_bucket_ref 有值（当前只有 'store' 一个位置），qty > 0。
-- 「不得超过可用量」不靠这张表守，靠 0007 的库存流水与余额：
--   占用写一条 inventory_movements（available → reserved, qty = N），
--   0007 的触发器把它落到 stock_balances，而
--   CHECK (available_qty >= 0) 是最后的兜底 —— 超量占用让该 CHECK 失败、整批回滚。
--   这是「约束即断言」的同一手法：不查影响行数，让越界这件事根本写不进去。
--
-- 前置条件：0007–0014 至今**没有应用到任何远端环境**（见 docs/OPEN-ITEMS.md T-06）。
-- 搬运语句仍写全，供已建库的本地环境自查。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与其他迁移一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ── 1. 报价行补商品引用（ALTER 加列：不影响既有行，历史行该列为 NULL） ──
ALTER TABLE quote_lines ADD COLUMN product_ref TEXT;

-- 「这个型号被哪些报价引用过」——报报价时要用；也为成交映射提供走索引的路径。
CREATE INDEX idx_quote_lines_product_ref ON quote_lines(store_id, product_ref);

-- ── 2. 新表：与 0007 的 stock_reservations 同构，补数量件占用 ──
CREATE TABLE stock_reservations__v15 (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  -- 逐件占用的实物。数量件占用时为 NULL。
  stock_item_id TEXT,
  -- 数量件占用的位置桶（本店自有库位为 'store'）。逐件占用时为 NULL。
  quantity_bucket_ref TEXT,
  order_ref TEXT NOT NULL,
  line_ref TEXT NOT NULL,
  -- 逐件恒为 1；数量件为实际占用量。不再写死 CHECK (qty = 1)（那是只支持逐件的旧约束），
  -- 但保留 DEFAULT 1：逐件占用的既有写法不给 qty，默认就是 1；数量件必须显式写出数量。
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'consumed')),
  reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  -- 逐件与数量件恰有其一：两个都空 = 不知道占了什么；两个都有 = 一笔占了两样东西。
  -- 逐件行 qty 必须为 1（契约 QuoteVersion.rules「每个序列化 / 二手实物行数量为 1」）。
  CHECK ((stock_item_id IS NOT NULL AND quantity_bucket_ref IS NULL AND qty = 1)
      OR (stock_item_id IS NULL AND quantity_bucket_ref IS NOT NULL)),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
);

-- ── 3. 搬运数据（本地库可能有 E06 建的逐件占用行） ──
INSERT INTO stock_reservations__v15
  (id, store_id, stock_item_id, quantity_bucket_ref, order_ref, line_ref, qty,
   status, reason, version, request_id, created_at, closed_at)
SELECT id, store_id, stock_item_id, NULL, order_ref, line_ref, qty,
       status, reason, version, request_id, created_at, closed_at
FROM stock_reservations;

-- ── 4. 换名 ──
DROP TABLE stock_reservations;

ALTER TABLE stock_reservations__v15 RENAME TO stock_reservations;

-- ── 5. 重建索引（随 DROP TABLE 一并消失） ──
CREATE INDEX idx_stock_reservations_item ON stock_reservations(stock_item_id, created_at DESC);
CREATE INDEX idx_stock_reservations_order ON stock_reservations(store_id, order_ref);
-- 「这个型号在某个位置被占了多少」——数量件释放与对账要按桶查。
CREATE INDEX idx_stock_reservations_bucket
  ON stock_reservations(store_id, quantity_bucket_ref, created_at DESC)
  WHERE quantity_bucket_ref IS NOT NULL;

-- 逐件唯一性断言（契约 Reservation.rules「同一 stockItemId 同一时刻最多一条 active」）。
-- 只在逐件行上成立：数量件行没有 stock_item_id，不能被这条索引约束到同一行上去。
CREATE UNIQUE INDEX uq_stock_reservations_active_item
  ON stock_reservations(stock_item_id)
  WHERE status = 'active' AND stock_item_id IS NOT NULL;
