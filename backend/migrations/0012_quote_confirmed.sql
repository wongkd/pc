-- E05b · 报价版本补「顾客已确认」态（契约修订：enums.json QuoteStatus 新增 confirmed，
-- 动作 B42「记录顾客确认」，objects.json QuoteVersion 新增 confirmedAt / confirmedSource）。
--
-- Prerequisite: apply 0000 -> 0011 first.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. 为什么必须重建表，而不是 ALTER
-- ─────────────────────────────────────────────────────────────────────────────
-- SQLite（含 D1）不支持 ALTER TABLE 修改 CHECK 约束。0009 把 status 的取值写死在
-- CHECK (status IN ('draft','issued','converted','expired','closed')) 里，要补
-- 'confirmed' 只能「建新表 → 拷数据 → 换名」，与 0011 重建 quote_headers 同一流程。
-- 同时新增两列：confirmed_at（确认时间）与 confirmed_source（确认来源）。
--
-- 前置条件（本迁移成立的前提，写在这里以免将来被当成通用做法）：
--   · 0009–0011 至今**没有应用到任何远端环境**（见 docs/OPEN-ITEMS.md T-06）；
--   · 因此 quote_versions 在所有环境里都是空表（迁移先于演示数据执行），
--     DROP 父表时子表 quote_lines / quote_shares 无行可违反外键检查。
--   若这两条不再成立，就必须改用 12 步重建流程（PRAGMA foreign_keys=OFF + 事务包裹）。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. 语义边界（契约 enums.json QuoteStatus / actions.json B42）
-- ─────────────────────────────────────────────────────────────────────────────
--   · confirmed 由 issued 经 B42 到达：只允许「已发出」的版本被确认；
--   · 确认 ≠ 付款、确认不锁库存（R12）——本迁移不建任何预留/资金结构；
--   · 确认后本版本不可再改（0009「发出后不可覆盖」的主键设计同样覆盖 confirmed）；
--     要改必须保存出新版本（新 revision）重新发出并重新确认；
--   · confirmed_at / confirmed_source 只在 status='confirmed' 时允许有值，
--     用 CHECK 拦住「状态与事实不一致」的半截记录（与 0009 的 issued_at 同一手法）。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与其他迁移一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ── 1. 新表：与 0009 的 quote_versions 同构，status 补 'confirmed'，新增确认两列 ──
CREATE TABLE quote_versions__v12 (
  quote_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  store_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'confirmed', 'converted', 'expired', 'closed')),
  valid_until TEXT,
  -- 门店优惠总额（分）。契约 discountCents，nullable:false，所以 NOT NULL DEFAULT 0。
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  -- 条款快照。契约 type=object。定金比例、顾客预算、质保与送货条款都在这里，不建独立列。
  terms_snapshot TEXT NOT NULL DEFAULT '{}',
  issued_at TEXT,
  -- 顾客确认（B42）：确认时间与确认来源（miniprogram / wechat / offline）。
  -- 只在 status='confirmed' 时有值，由表末 CHECK 强制。
  confirmed_at TEXT,
  confirmed_source TEXT,
  -- 服务端重算后的金额快照。写成列是为了「同一版本两次读取金额一致」。
  subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  -- 幂等与追溯：这一版是被哪个 requestId 发出来的。
  issued_request_id TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (quote_id, revision),
  -- 发出过就必须有发出时间；草稿不允许有发出时间。
  CHECK ((status = 'draft' AND issued_at IS NULL) OR (status <> 'draft' AND issued_at IS NOT NULL)),
  -- 确认事实与状态必须成对出现：confirmed 必须记了谁在什么时候确认的；
  -- 非 confirmed 不允许残留确认字段。
  CHECK ((status = 'confirmed' AND confirmed_at IS NOT NULL AND confirmed_source IS NOT NULL)
      OR (status <> 'confirmed' AND confirmed_at IS NULL AND confirmed_source IS NULL)),
  -- 确认来源只能是三个登记渠道（R10：反馈/确认来源口径）。
  CHECK (confirmed_source IS NULL OR confirmed_source IN ('miniprogram', 'wechat', 'offline')),
  -- 金额守恒：应付 = 小计 − 优惠，且不得为负。
  CHECK (discount_cents <= subtotal_cents),
  CHECK (total_cents = subtotal_cents - discount_cents),
  -- 期限只对发出过的版本有意义。
  CHECK (valid_until IS NULL OR issued_at IS NOT NULL),
  FOREIGN KEY (quote_id) REFERENCES quote_headers(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ── 2. 搬运数据（当前为空，语句仍写全，供已建库的环境自查） ──
INSERT INTO quote_versions__v12
  (quote_id, revision, store_id, status, valid_until, discount_cents, terms_snapshot,
   issued_at, subtotal_cents, total_cents, issued_request_id, created_by, created_at)
SELECT quote_id, revision, store_id, status, valid_until, discount_cents, terms_snapshot,
       issued_at, subtotal_cents, total_cents, issued_request_id, created_by, created_at
FROM quote_versions;

-- ── 3. 换名 ──
DROP TABLE quote_versions;

ALTER TABLE quote_versions__v12 RENAME TO quote_versions;

-- ── 4. 重建 0009 原有的两个索引（随 DROP TABLE 一并消失） ──
CREATE INDEX idx_quote_versions_store_status
  ON quote_versions(store_id, status, created_at DESC);
-- 「门店还有哪些已发出但没被转化成订单的报价」——看板要用。
CREATE INDEX idx_quote_versions_effective
  ON quote_versions(store_id, valid_until) WHERE status = 'issued';
