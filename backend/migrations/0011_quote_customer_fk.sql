-- E05 · 把报价单的顾客归属接回客户主数据（G-Q01-CUSTOMER）。
--
-- Prerequisite: apply 0000 -> 0010 first（customers 表由 0010 建立）。
-- 契约依据：objects.json Quote.customerId（type=id, nullable=true）。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. 为什么必须重建表，而不是 ALTER
-- ─────────────────────────────────────────────────────────────────────────────
-- SQLite（含 D1）不支持 `ALTER TABLE ... ADD CONSTRAINT`。给已有的 quote_headers
-- 补一条外键，只能是「建新表 → 拷数据 → 换名」这套动作。本迁移只碰 quote_headers
-- 一张表，0009 的另外三张（quote_versions / quote_lines / quote_shares）一个字段都不动。
--
-- 前置条件（本迁移成立的前提，写在这里以免将来被当成通用做法）：
--   · 0009 与 0010 至今**没有应用到任何远端环境**（见 docs/OPEN-ITEMS.md T-06）；
--   · 因此 quote_headers 在所有环境里都是空表，重建没有数据搬运代价，
--     也不存在「DROP 父表时子表仍引用其行」导致外键检查失败的情形。
--   若这两条不再成立，就必须改用 12 步重建流程（PRAGMA foreign_keys=OFF + 事务包裹）。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. 为什么是「同店复合外键」，不是普通的 customer_id 外键
-- ─────────────────────────────────────────────────────────────────────────────
-- `FOREIGN KEY (customer_id) REFERENCES customers(id)` 只能证明「这个客户 id 存在」。
-- 它拦不住 A 店的报价单挂到 B 店的客户身上 —— 而本系统每一条读路径都按 store_id 过滤，
-- 于是那条数据在 A 店界面上会显示成「客户不存在」，在 B 店出现「不属于我的报价单」。
--
-- 复合外键 (store_id, customer_id) -> customers(store_id, id) 把「客户属于本店」
-- 表达成数据库约束，而不是指望每个写入口都记得再查一次 store_id。这与 T04
-- 「约束即断言」同一条思路：能由数据库拦住的，不靠调用方的自觉。
--
-- SQLite 要求父键一侧有唯一索引，所以先给 customers 补 UNIQUE(store_id, id)。
-- (store_id, id) 本身已经是唯一的（id 是主键），这条索引不会拒绝任何现有行。
--
-- customer_id 为 NULL 时不校验（MATCH SIMPLE）：无客户的草稿仍然允许，
-- 与契约 Quote.customerId「nullable:true」一致。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与其他迁移一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ── 1. 父键一侧的唯一索引（复合外键的必要条件） ──
CREATE UNIQUE INDEX uq_customers_store_id ON customers(store_id, id);

-- ── 2. 新表：与 0009 的 quote_headers 同构，只多一条复合外键 ──
CREATE TABLE quote_headers__v11 (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  -- 顾客归属：nullable 表示「还没选客户」的草稿。非空时必须是本店客户，
  -- 由表末的复合外键保证。
  customer_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(trim(title)) > 0),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id),
  -- 同店客户：store_id 与 customer_id 必须共同命中 customers 的一行。
  FOREIGN KEY (store_id, customer_id) REFERENCES customers(store_id, id)
);

-- ── 3. 搬运数据（当前为空，语句仍写全，供已建库的环境自查） ──
INSERT INTO quote_headers__v11
  (id, store_id, customer_id, title, current_revision, version, created_by, updated_by, created_at, updated_at)
SELECT id, store_id, customer_id, title, current_revision, version, created_by, updated_by, created_at, updated_at
FROM quote_headers;

-- ── 4. 换名 ──
DROP TABLE quote_headers;

ALTER TABLE quote_headers__v11 RENAME TO quote_headers;

-- ── 5. 重建 0009 原有的两个索引（随 DROP TABLE 一并消失） ──
CREATE INDEX idx_quote_headers_store_created ON quote_headers(store_id, created_at DESC);
CREATE INDEX idx_quote_headers_customer ON quote_headers(store_id, customer_id, created_at DESC);
