-- T04 测试专用表 —— 只为验证一致性机制，不属于生产迁移，不进入生产库。
-- 形状刻意模仿将来业务表的样子：余额列带非负 CHECK，version 列独立于版本日志。

DROP TABLE IF EXISTS demo_reservations;
DROP TABLE IF EXISTS demo_flows;
DROP TABLE IF EXISTS demo_balances;

CREATE TABLE demo_balances (
  id INTEGER PRIMARY KEY,
  available_qty INTEGER NOT NULL CHECK (available_qty >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE demo_flows (
  id TEXT PRIMARY KEY,
  balance_id INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (balance_id) REFERENCES demo_balances(id)
);

-- 逐件预留：同一实物同时只能有一条 active 占用。
-- 这是 04 §7 第 4 条「有效逐件预留」的唯一约束落地方式，
-- 也是「不同 requestId 的重复动作仍必须被拒绝」的答案。
CREATE TABLE demo_reservations (
  id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')) DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX ux_demo_reservations_active_item
  ON demo_reservations (item_id) WHERE status = 'active';

