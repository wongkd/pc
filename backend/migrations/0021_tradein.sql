-- E12 · 抵用额度（置换折抵）：trade_ins（置换关联）+ offsets（折抵凭据）两张表。
--
-- Prerequisite: apply 0000 -> 0020 first.
-- Additive only: 本迁移只新增两张表，不重建任何既有表、不碰 0020 的 recovery_orders。
--
-- 契约依据（contracts/v1）：
--   objects.json  Offset        —— tradeInId / saleOrderId / recoveryId / amountCents /
--                                  state（OffsetState: applied / reversed）/ reversalOf
--   enums.json    OffsetState（applied / reversed；撤销折抵不自动归还实物）
--   actions.json  B31 建立置换关联与应用折抵（POST /trade-ins + /trade-ins/:id/apply-offset）
--                 B32 撤销折抵（POST /trade-ins/:id/reverse-offset）
--                 R11 读（GET /trade-ins/:id）
--   money-rules.json offsetNetCents / salesBalanceCents / recoveryPayableRemainingCents /
--                     offsetAmountCents = min(max(salesBalance,0), max(recoveryPayableRemaining,0))
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 设计要点
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. 折抵是「非现金事件」（money-rules.json offsetNetCents note）：
--    一次折抵同时冲减销售单应收与回收单应付，**不写 cash_entries**（不生成虚构现金收 / 付）。
--    销售侧落在 sale_orders.offset_net_cents（净额，0017 已建列，此前恒为 0）；
--    回收侧**不落列**——0020 的 recovery_orders 注释明确「抵用属刀二，本表只承载现金付款路径」，
--    折抵额由 offsets 表聚合：有效折抵 = SUM(applied) − SUM(reversed)。
--
-- 2. 首版折抵金额（money-rules offsetAmountCents）：
--    min(max(销售正余额, 0), max(回收剩余应付, 0))
--    · 销售正余额 = sale_orders.balance_cents（恒等式已含 offset_net，见 0017）；
--    · 回收剩余应付 = payable_cents − 有效折抵（payable_cents = final_acquisition_cents − paid_cents）。
--    同一回收应付可部分折抵但累计不得超额（OFFSET_EXCEEDED）。
--
-- 3. 双方交易主体须相同（money-rules offsetAmountCents note）：销售单 customer_id 与
--    回收单 seller_customer_id 必须同为非空且相等，否则 OWNERSHIP_INVALID（不同主体代付首版不支持）。
--
-- 4. 撤销折抵（B32）不搬动实物：原 offset 保留在净和中，新增一条 state='reversed' 的
--    offset（reversal_of 指向原笔）。部分唯一索引保证同一 offset 至多被撤销一次，
--    避免「减两次」（money-rules reversalPolicy.forbidden）。
--
-- 5. 「找零」（Q-04，栋哥 2026-09-22 拍板「两者都支持，默认保留」）**不新增契约动作**：
--    折抵后剩余额度默认保留在回收单应付里（无有效期，下次置换继续折抵）；
--    客户要求退现金时，复用 B33（POST /finance/payments，sourceDocument=recovery:<单号>），
--    其超付守卫已联动为「付款 ≤ 回收剩余应付（已扣有效折抵）」。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与其他迁移一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. trade_ins · 置换关联（一个销售单 ↔ 一个回收单的抵用关系）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE trade_ins (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  sale_order_id TEXT NOT NULL,
  recovery_id TEXT NOT NULL,
  -- 首版只用 active；closed 预留给「销售单取消导致关联关闭」等后续语义。
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'closed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- 同一对（销售单，回收单）只允许一条置换关联。
  UNIQUE (store_id, sale_order_id, recovery_id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id),
  FOREIGN KEY (recovery_id) REFERENCES recovery_orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_trade_ins_store_sale ON trade_ins(store_id, sale_order_id);
CREATE INDEX idx_trade_ins_store_recovery ON trade_ins(store_id, recovery_id);
CREATE INDEX idx_trade_ins_store_created ON trade_ins(store_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. offsets · 折抵凭据（一次折抵一条 applied；撤销时新增 reversed 笔指向原笔）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE offsets (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  trade_in_id TEXT NOT NULL,
  sale_order_id TEXT NOT NULL,
  recovery_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  state TEXT NOT NULL DEFAULT 'applied' CHECK (state IN ('applied', 'reversed')),
  -- reversed 笔指向被撤销的原 offset；applied 笔恒为 NULL。
  reversal_of TEXT,
  reversed_reason TEXT,
  reversed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (trade_in_id) REFERENCES trade_ins(id),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id),
  FOREIGN KEY (recovery_id) REFERENCES recovery_orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- 部分唯一索引：每条 applied 折抵至多被撤销一次（一条 reversed 笔指向它）。
CREATE UNIQUE INDEX idx_offsets_reversal_unique ON offsets(reversal_of) WHERE reversal_of IS NOT NULL;

CREATE INDEX idx_offsets_trade_in ON offsets(store_id, trade_in_id, created_at DESC);
-- 回收侧「有效折抵」聚合与 B33 付款守卫都要按 recovery_id 求和。
CREATE INDEX idx_offsets_recovery ON offsets(store_id, recovery_id, state);
CREATE INDEX idx_offsets_sale ON offsets(store_id, sale_order_id, state);
