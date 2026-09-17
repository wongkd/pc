-- ERP orders: quote snapshots, order items and payment records.
-- Prerequisite: apply 0001_erp2_stores_members_permissions.sql and 0002_product_master_data.sql first.
-- Validation: after applying through the versioned D1 migration runner, verify the three order tables,
-- their indexes, and both order_payments triggers in sqlite_master. Do not run this migration twice.
-- Rollback: retain the schema and roll back the Worker where possible; structural rollback requires
-- restoring a verified pre-migration D1 export. Do not drop order data in production.

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  order_no TEXT NOT NULL,
  quote_snapshot TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_address TEXT NOT NULL DEFAULT '',
  project_title TEXT NOT NULL DEFAULT '',
  total_amount_cents INTEGER NOT NULL CHECK (total_amount_cents >= 0),
  received_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (received_amount_cents >= 0),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partial', 'paid')),
  fulfillment_status TEXT NOT NULL DEFAULT 'pending_purchase' CHECK (fulfillment_status IN ('pending_purchase', 'preparing', 'pending_delivery', 'delivered', 'cancelled')),
  remark TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(store_id, order_no),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
  source_item_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (source_item_id) REFERENCES hardware(id)
);

CREATE TABLE order_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  payment_method TEXT NOT NULL,
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  remark TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Payment aggregation is enforced in SQLite so concurrent collection requests cannot over-collect.
CREATE TRIGGER order_payments_before_insert
BEFORE INSERT ON order_payments
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM orders
  WHERE id = NEW.order_id
    AND store_id = NEW.store_id
    AND fulfillment_status <> 'cancelled'
    AND NEW.amount_cents <= total_amount_cents - received_amount_cents
)
BEGIN
  SELECT RAISE(ABORT, 'payment exceeds remaining receivable or order is unavailable');
END;

CREATE TRIGGER order_payments_after_insert
AFTER INSERT ON order_payments
FOR EACH ROW
BEGIN
  UPDATE orders
  SET received_amount_cents = received_amount_cents + NEW.amount_cents,
      payment_status = CASE
        WHEN received_amount_cents + NEW.amount_cents >= total_amount_cents THEN 'paid'
        WHEN received_amount_cents + NEW.amount_cents > 0 THEN 'partial'
        ELSE 'unpaid'
      END,
      updated_by = NEW.created_by,
      updated_at = datetime('now')
  WHERE id = NEW.order_id AND store_id = NEW.store_id;
END;

CREATE INDEX idx_orders_store_created ON orders(store_id, created_at DESC);
CREATE INDEX idx_orders_store_fulfillment ON orders(store_id, fulfillment_status, created_at DESC);
CREATE INDEX idx_orders_store_payment ON orders(store_id, payment_status, created_at DESC);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_payments_order_created ON order_payments(order_id, created_at DESC);
CREATE INDEX idx_order_payments_store_paid ON order_payments(store_id, paid_at DESC);
