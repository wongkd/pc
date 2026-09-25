-- F3 · B37 取消采购：逐采购行记录取消事件，不改写订购量。
-- 采购进度由 purchase_lines.qty_ordered、到货明细与本表派生；取消不删除历史。

CREATE TABLE purchase_cancellations (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  purchase_id TEXT NOT NULL,
  purchase_line_id TEXT NOT NULL,
  qty_cancelled INTEGER NOT NULL CHECK (qty_cancelled > 0),
  reason TEXT NOT NULL CHECK (reason IN (
    'supplier_unavailable',
    'supplier_delay',
    'customer_cancelled',
    'duplicate_purchase',
    'price_changed',
    'other'
  )),
  note TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(note)) >= 0),
  UNIQUE (store_id, request_id, purchase_line_id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (purchase_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (purchase_line_id) REFERENCES purchase_lines(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_purchase_cancellations_purchase
  ON purchase_cancellations(store_id, purchase_id, occurred_at DESC);
CREATE INDEX idx_purchase_cancellations_line
  ON purchase_cancellations(store_id, purchase_line_id);
