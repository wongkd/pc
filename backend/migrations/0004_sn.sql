-- ERP SN (serial number) management — minimum viable version
-- Prerequisite: 0001, 0002, 0003 must be applied.
-- This is a forward-port of Phase 6 (SN management) before Phase 5 (inventory ledger).
-- Warranty calculation: delivered_at + warranty_months = warranty_expires_on (stored as computed).
-- Rollback: drop serial_numbers, sn_events, order_item_sn; remove warranty_months from hardware.

-- 1) Add default warranty months to products (hardware table) -----------------

ALTER TABLE hardware ADD COLUMN warranty_months INTEGER NOT NULL DEFAULT 36;

-- 2) SN ledger — one row per physical item tracked by serial number -----------

CREATE TABLE serial_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  sn_code TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN (
    'in_stock', 'reserved', 'picked', 'delivered', 'in_service', 'returned_to_supplier', 'scrapped'
  )),
  purchase_ref TEXT NOT NULL DEFAULT '',
  purchase_cost_cents INTEGER NOT NULL DEFAULT 0,
  inbound_at TEXT,
  current_customer_name TEXT NOT NULL DEFAULT '',
  current_customer_phone TEXT NOT NULL DEFAULT '',
  current_order_id INTEGER,
  delivered_at TEXT,
  warranty_months INTEGER NOT NULL DEFAULT 36,
  warranty_expires_on TEXT,
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(store_id, sn_code),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (current_order_id) REFERENCES orders(id)
);

CREATE INDEX idx_serial_numbers_store_product ON serial_numbers(store_id, product_id);
CREATE INDEX idx_serial_numbers_store_status ON serial_numbers(store_id, status);
CREATE INDEX idx_serial_numbers_customer_phone ON serial_numbers(store_id, current_customer_phone);
CREATE INDEX idx_serial_numbers_warranty ON serial_numbers(store_id, warranty_expires_on);

-- 3) SN event log — append-only timeline of every state change ---------------

CREATE TABLE sn_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sn_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'inbound', 'reserved', 'unreserved', 'picked', 'delivered',
    'returned', 'replaced', 'returned_to_supplier', 'scrapped', 'manual_entry'
  )),
  source_type TEXT NOT NULL DEFAULT '',
  source_id INTEGER,
  customer_name TEXT NOT NULL DEFAULT '',
  operator_id INTEGER,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sn_id) REFERENCES serial_numbers(id)
);

CREATE INDEX idx_sn_events_sn ON sn_events(sn_id, occurred_at DESC);

-- 4) Order item ↔ SN binding (current effective binding, soft-deleted by unbound_at) --

CREATE TABLE order_item_sn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_item_id INTEGER NOT NULL,
  sn_id INTEGER NOT NULL,
  bound_at TEXT NOT NULL DEFAULT (datetime('now')),
  unbound_at TEXT,
  FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
  FOREIGN KEY (sn_id) REFERENCES serial_numbers(id)
);

CREATE INDEX idx_order_item_sn_item ON order_item_sn(order_item_id);
CREATE INDEX idx_order_item_sn_sn ON order_item_sn(sn_id);
