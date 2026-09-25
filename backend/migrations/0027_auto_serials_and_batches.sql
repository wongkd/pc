-- 自动生成内部实物编号、数量批次编号，并保留用户备注。
-- 仅扩展结构；不从旧 SN 台账或当前数量余额推造历史实物/批次。

ALTER TABLE stock_items ADD COLUMN remark TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_device_custody ADD COLUMN manufacturer_sn TEXT;

CREATE TABLE stock_batches (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  batch_code TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_line_ref TEXT,
  received_qty INTEGER NOT NULL CHECK (received_qty > 0),
  occurred_at TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  actor_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, batch_code),
  UNIQUE (store_id, source_line_ref),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX idx_stock_batches_store_product ON stock_batches(store_id, product_id, occurred_at DESC);
CREATE INDEX idx_stock_batches_store_source ON stock_batches(store_id, source_ref);
CREATE INDEX idx_customer_device_custody_manufacturer_sn ON customer_device_custody(store_id, manufacturer_sn);
