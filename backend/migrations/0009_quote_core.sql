-- Q01 第二刀 · 报价单核心：报价聚合头、发出后不可覆盖的版本、逐行明细、分享凭证。
--
-- Prerequisite: apply 0000 -> 0008 first.
-- Additive only: this migration only adds new tables, indexes and triggers. It does not alter,
-- drop or rewrite any existing table, column, row, trigger or index. In particular the legacy
-- quotes (0000) and orders / order_items / order_payments (0003) tables are untouched: they
-- stay live for the existing 报价编辑器 / 订单 pages, which are NOT part of this card.
--
-- 契约依据（contracts/v1，frozen at 2026-09-17 by T01a）：
--   objects.json  Quote        —— 聚合头：customerId / title / currentRevision
--   objects.json  QuoteVersion —— quoteId / revision / status / validUntil / lines /
--                                 discountCents / termsSnapshot / issuedAt
--   enums.json    QuoteStatus  —— draft / issued / converted / expired / closed
--   enums.json    LineSource   —— new / used / customer / service
--   conventions.json money     —— 金额只有整数分；floatForbidden；服务端重算为准
--   conventions.json version   —— 写动作携带 expectedVersion；不匹配返回 409 VERSION_CONFLICT
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 设计要点
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. 「发出后不可覆盖」由主键表达，不靠应用层自觉。
--    quote_versions 的主键是 (quote_id, revision)：同一份报价的同一个版本号只能存在一行。
--    要改价就插下一个 revision，永远不 UPDATE 旧版本行。因此台账上不存在「v2 的价格被悄悄
--    改成了别的数」这种状态 —— 不是禁止，是没有地方可写。
--
-- 2. 「未付款不锁库存、不触发采购」在建表层面就成立。
--    本迁移不创建任何预留、预占、扣减或采购语句，也不写 stock_reservations。
--    报价单只是一张「我说过什么价」的记录，它没有任何能力动库存。
--    stockItemId / customerDeviceRef 只是引用（用于显示「这件二手件还在不在」），
--    不是占用。占用发生在收款之后，属于另一张卡。
--
-- 3. 定金比例与顾客预算进 terms_snapshot，不建独立列。
--    理由：contracts/v1 没有定义这两个字段（grep 全仓确认：objects.json / actions.json 里
--    的「预算」指的是图片体积，"定金" 只出现在置换样本里且是已收金额而非比例）。
--    conventions.forbiddenInventing 明令不得发明契约外字段，T05c 已因同类问题把
--    acquiredAt 改成登记缺口 G-18。因此它们按 object 类型存放在 terms_snapshot 内，
--    shape 由门店侧定义，不参与任何金额计算，服务端也不据其校验。
--    ⚠️ 将来若要按预算做统计，必须先走契约修订（新增 v1.x / v2 目录），不能直接加列。
--
-- 4. 金额一律整数分，且由服务端重算。
--    line_total_cents 有 CHECK 强制等于 unit_price_cents * qty（由触发器维护），
--    因此「行小计」不可能是客户端送来的数。总额同理由服务端累加后写入。
--
-- 5. 分享凭证只存摘要，明文只在生成的那一次响应里出现。
--    与 0008 wechat_binding_codes.code_hash 同一手法：库被读走也不等于链接被读走。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与 0004–0008 一样，本文件在明确授权前不得 apply 到任何远端环境。
--    远端迁移状态见 docs/OPEN-ITEMS.md（0004/0005 未核实，0006/0007/0008 确认未应用）。

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. quotes · 报价聚合头
--    契约 Quote 只有三个业务字段（customerId / title / currentRevision），
--    其余是每个聚合都需要的记账列。currentRevision 是冗余列，便于列表页读取；
--    版本历史的唯一来源是 quote_versions。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE quote_headers (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  -- ⚠️ 顾客归属缺口（G-Q01-CUSTOMER）
  -- 契约 Quote.customerId 的 type 是 id 且 nullable:true，但 objects.json 里
  -- Customer.tables = []（空），全仓也没有 customers 表：顾客资料怎么落库，
  -- 契约层面尚未定义，属于「顾客身份与归属授权」那张卡。
  -- 因此这里只留一个不带头键的普通列，不带 FOREIGN KEY —— 指向一张不存在的表会让
  -- 整个迁移失败，而擅自新建 customers 表等于替另一张卡发明数据模型。
  -- 本列当前只能存门店自己维护的编号；接上顾客表之前，它不参与任何授权判断。
  customer_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  -- 当前版本号。0 表示尚未发出任何版本（只有草稿，或刚建未填）。
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(trim(title)) > 0),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX idx_quote_headers_store_created ON quote_headers(store_id, created_at DESC);
CREATE INDEX idx_quote_headers_customer ON quote_headers(store_id, customer_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. quote_versions · 发出后不可覆盖的版本
--    主键 (quote_id, revision) 就是「版本号不能重复」这条断言本身。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE quote_versions (
  quote_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  store_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'converted', 'expired', 'closed')),
  valid_until TEXT,
  -- 门店优惠总额（分）。契约 discountCents，nullable:false，所以 NOT NULL DEFAULT 0。
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  -- 条款快照。契约 type=object。定金比例、顾客预算、质保与送货条款都在这里，
  -- 不建独立列（见设计要点 3）。必须是合法 JSON 对象，不接受数组或裸标量。
  terms_snapshot TEXT NOT NULL DEFAULT '{}',
  issued_at TEXT,
  -- 服务端重算后的金额快照。写成列是为了「同一版本两次读取金额一致」，
  -- 而不是每次读都要把 lines 重新累加一遍（累加逻辑一旦改动，历史版本金额就会漂）。
  subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  -- 幂等与追溯：这一版是被哪个 requestId 发出来的。
  issued_request_id TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (quote_id, revision),
  -- 发出过就必须有发出时间；草稿不允许有发出时间。防止「状态是 issued 但没有 issued_at」
  -- 这种只能靠人工解释的半截记录。
  CHECK ((status = 'draft' AND issued_at IS NULL) OR (status <> 'draft' AND issued_at IS NOT NULL)),
  -- 金额守恒：应付 = 小计 − 优惠，且不得为负。门店优惠不能超过小计。
  CHECK (discount_cents <= subtotal_cents),
  CHECK (total_cents = subtotal_cents - discount_cents),
  -- 期限只对发出过的版本有意义。
  CHECK (valid_until IS NULL OR issued_at IS NOT NULL),
  FOREIGN KEY (quote_id) REFERENCES quote_headers(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_quote_versions_store_status
  ON quote_versions(store_id, status, created_at DESC);
-- 「门店还有哪些已发出但没被转化成订单的报价」——看板要用。
CREATE INDEX idx_quote_versions_effective
  ON quote_versions(store_id, valid_until) WHERE status = 'issued';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. quote_lines · 逐行明细
--    行归属到 (quote_id, revision)，所以「改了价的版本」和「原版本」天然是两份行数据，
--    不需要在行上再挂一个「这是第几版」的标记。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE quote_lines (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  -- 行序。报价单是给人看的，顺序必须稳定且由门店决定，不能靠插入顺序。
  position INTEGER NOT NULL CHECK (position >= 0),
  source TEXT NOT NULL CHECK (source IN ('new', 'used', 'customer', 'service')),
  name_snapshot TEXT NOT NULL,
  spec_snapshot TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
  -- 引用，不是占用：只用于显示「这件还在不在」，不锁库存。
  stock_item_id TEXT,
  -- 客供件的来源设备。契约 SaleLine.customerDeviceRef / CustomerDevice 同源，
  -- 但 CustomerDevice.tables 同样是空数组（见 quote_headers.customer_id 的说明），
  -- 所以这里是一个不带头键的普通列。
  customer_device_ref TEXT,
  -- 质保快照。契约 SaleLine.warrantySnapshot 是 object；报价阶段同样要能说清
  -- 「这一件保多久」，因为顾客是在报价单上看到它的。
  warranty_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 行小计必须等于单价乘数量。客户端送来的 line_total 不予采信。
  CHECK (line_total_cents = unit_price_cents * qty),
  -- 客供件按契约 R06：售价为 0，另列装机服务费。不允许客供件带价。
  CHECK (source <> 'customer' OR unit_price_cents = 0),
  -- 客供件必须指出来源设备；非客供件不该有设备引用。
  CHECK ((source = 'customer' AND customer_device_ref IS NOT NULL)
      OR (source <> 'customer' AND customer_device_ref IS NULL)),
  -- 逐件跟踪的来源（used / customer 是具体实物）数量只能是 1。
  -- 契约 QuoteVersion.rules：「每个序列化 / 二手实物行数量为 1」。
  CHECK (source NOT IN ('used', 'customer') OR qty = 1),
  FOREIGN KEY (quote_id, revision) REFERENCES quote_versions(quote_id, revision) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
);

-- 同一版本的同一行序不可重复。没有这条，「第 3 行」就可能有两行，
-- 打印出来的清单顺序每次都可能不同。
CREATE UNIQUE INDEX uq_quote_lines_position
  ON quote_lines(quote_id, revision, position);
CREATE INDEX idx_quote_lines_version ON quote_lines(quote_id, revision);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. quote_shares · 顾客专属入口的分享凭证
--    凭证只存摘要。明文（URL 里的 t=...）只在生成的那一次响应里出现，
--    库被读走不等于链接被读走。与 0008 wechat_binding_codes 同一手法。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE quote_shares (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  quote_id TEXT NOT NULL,
  -- 锁定到具体版本：顾客点开看到的必须是「门店当时发的那一版」，
  -- 而不是「此刻的最新版」——否则顾客刚看完价格，门店改价，他再刷新就不是同一张单了。
  revision INTEGER NOT NULL CHECK (revision > 0),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  -- 失效时间。与版本有效期是两件事：版本过期是「价格不作数」，
  -- 凭证失效是「这个链接打不开」。两者都要能独立控制。
  expires_at TEXT,
  revoked_at TEXT,
  revoked_by INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 撤销必须留痕：谁撤的、什么时候撤的。
  CHECK ((status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
      OR (status <> 'revoked' AND revoked_at IS NULL AND revoked_by IS NULL)),
  FOREIGN KEY (quote_id, revision) REFERENCES quote_versions(quote_id, revision) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (revoked_by) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_quote_shares_quote ON quote_shares(quote_id, revision, created_at DESC);
-- 每个版本同时只允许一个有效凭证。同一版本发两个有效链接，将来
-- 「撤回这个链接」就会变成「撤回哪个链接」的扯皮。
CREATE UNIQUE INDEX uq_quote_shares_active_version
  ON quote_shares(quote_id, revision) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. quote_line_total 由触发器维护
--    行的 line_total_cents 有 CHECK 要求它等于 unit_price*qty。如果门店改了单价，
--    旧行的小计就会与 CHECK 冲突 —— 那是「不允许改已发出的版本」在起作用，
--    是正确行为，不是 bug。草稿阶段改行属于另一个动作，必须走 UPDATE 语句，
--    因此这里用 BEFORE UPDATE 触发器保证改价时小计同步重算，避免出现
--    「单价改了、小计没改」这种在明细表上肉眼可见的错账。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER quote_lines_recompute_total_insert
BEFORE INSERT ON quote_lines
FOR EACH ROW
WHEN NEW.line_total_cents <> NEW.unit_price_cents * NEW.qty
BEGIN
  SELECT RAISE(ABORT, 'VALIDATION_ERROR');
END;

CREATE TRIGGER quote_lines_recompute_total_update
BEFORE UPDATE OF unit_price_cents, qty ON quote_lines
FOR EACH ROW
WHEN NEW.line_total_cents <> NEW.unit_price_cents * NEW.qty
BEGIN
  SELECT RAISE(ABORT, 'VALIDATION_ERROR');
END;
