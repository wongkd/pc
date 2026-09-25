-- D10：正式期初库存窗口与四类成本证据。
-- 旧格式行保留 NULL cost_basis；不能仅凭旧 cost_known / 金额推断实际、估值或真实零成本。

ALTER TABLE inventory_openings ADD COLUMN window_opened_at TEXT;
ALTER TABLE inventory_openings ADD COLUMN window_closes_at TEXT;

ALTER TABLE inventory_opening_lines ADD COLUMN cost_basis TEXT
  CHECK (cost_basis IS NULL OR cost_basis IN ('known_actual', 'assessed_estimate', 'unknown', 'zero_cost'));
ALTER TABLE inventory_opening_lines ADD COLUMN approved_count_ref TEXT;
ALTER TABLE inventory_opening_lines ADD COLUMN approved_count_line_ref TEXT;
ALTER TABLE inventory_opening_lines ADD COLUMN cost_evidence_ref TEXT;
ALTER TABLE inventory_opening_lines ADD COLUMN cost_assessed_at TEXT;
ALTER TABLE inventory_opening_lines ADD COLUMN estimated_unit_cost_cents INTEGER
  CHECK (estimated_unit_cost_cents IS NULL OR estimated_unit_cost_cents >= 0);

CREATE UNIQUE INDEX uq_inventory_opening_lines_approved_ref
  ON inventory_opening_lines(store_id, approved_count_ref, approved_count_line_ref)
  WHERE approved_count_line_ref IS NOT NULL;

ALTER TABLE stock_items ADD COLUMN cost_basis TEXT
  CHECK (cost_basis IS NULL OR cost_basis IN ('known_actual', 'assessed_estimate', 'unknown', 'zero_cost'));
ALTER TABLE stock_items ADD COLUMN cost_evidence_ref TEXT;
ALTER TABLE stock_items ADD COLUMN cost_assessed_at TEXT;
ALTER TABLE stock_items ADD COLUMN estimated_acquisition_cost_cents INTEGER
  CHECK (estimated_acquisition_cost_cents IS NULL OR estimated_acquisition_cost_cents >= 0);

ALTER TABLE stock_batches ADD COLUMN cost_basis TEXT
  CHECK (cost_basis IS NULL OR cost_basis IN ('known_actual', 'assessed_estimate', 'unknown', 'zero_cost'));
ALTER TABLE stock_batches ADD COLUMN unit_cost_cents INTEGER
  CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0);
ALTER TABLE stock_batches ADD COLUMN cost_evidence_ref TEXT;
ALTER TABLE stock_batches ADD COLUMN cost_assessed_at TEXT;
ALTER TABLE stock_batches ADD COLUMN estimated_unit_cost_cents INTEGER
  CHECK (estimated_unit_cost_cents IS NULL OR estimated_unit_cost_cents >= 0);

ALTER TABLE inventory_movements ADD COLUMN cost_basis TEXT
  CHECK (cost_basis IS NULL OR cost_basis IN ('known_actual', 'assessed_estimate', 'unknown', 'zero_cost'));
ALTER TABLE inventory_movements ADD COLUMN estimated_unit_cost_cents INTEGER
  CHECK (estimated_unit_cost_cents IS NULL OR estimated_unit_cost_cents >= 0);

CREATE TABLE inventory_opening_windows (
  store_id INTEGER PRIMARY KEY,
  opened_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK (close_reason IS NULL OR close_reason = 'first_business_movement'),
  actor_user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (closed_at IS NULL OR close_reason IS NOT NULL),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE TRIGGER close_opening_window_after_business_movement
AFTER INSERT ON inventory_movements
WHEN NEW.source <> 'opening_balance'
BEGIN
  UPDATE inventory_opening_windows
     SET closed_at = datetime('now'), close_reason = 'first_business_movement'
   WHERE store_id = NEW.store_id AND closed_at IS NULL;
END;
