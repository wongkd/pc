-- T05a · Inventory core: product attributes, per-item stock, quantity balances, movements,
-- reservations and controlled opening balances.
--
-- Prerequisite: apply 0000 -> 0006 first.
-- Additive only: this migration extends hardware and creates new tables. It does not drop or
-- rewrite any existing table, column, row, trigger or index.
--
-- Legacy serial_numbers / sn_events rows are deliberately NOT copied into the new tables.
-- Opening stock may only come from a confirmed physical count (B13). Counting legacy rows and
-- calling the result "stock" would invent inventory that nobody has ever verified.
--
-- Rules implemented here:
--   03-domain-rules.md  §1 L13  R03  inventory must separate store-owned from customer-owned
--   03-domain-rules.md  §4 L84       own on-hand = available + reserved + quarantine, mutually
--                                   exclusive; in transit is not on hand; customer custody is
--                                   listed separately (also enums.json inventoryBucketRules)
--   03-domain-rules.md  §4 L86       per-item tracking is a product attribute; used items are
--                                   always per-item and always carry an internal code
--   04-data-and-api.md  §2 L19-L21   Product / StockBalance / StockItem minimum fields
--   04-data-and-api.md  §7 L153-L154 assertions must live in SQL conditions and constraints
--
-- Design notes (measured on real workerd + D1, see docs/verification/2026-09-17-T04):
--   · Balances are written ONLY by the movement trigger. Application code never updates the
--     three bucket columns directly, so "a balance is the sum of its movements" has exactly one
--     way to change and can always be recomputed. The columns carry CHECK (>= 0), so an action
--     that would drive a bucket negative aborts the whole batch instead of silently truncating.
--   · stock_balances has columns for the three on-hand buckets ONLY. In-transit and customer
--     custody have nowhere to land, so "in transit is not on hand" and "customer custody is
--     listed separately" hold structurally, not by convention.
--   · Unknown cost is NULL, never 0 (R01, 03 §7 L181). Paired CHECKs keep cost_known honest.
--   · IDs are TEXT values the server generates before the batch is built. D1 does not expose
--     AUTOINCREMENT ids inside a batch, and an action result must not depend on them.
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- Do not run this migration against production until T20 has verified the migration tracker.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Product attributes, kept on the existing hardware table (legacy-mapping: action extend)
--    tracking_mode is the new contract field; is_serialized stays for the legacy code path and
--    is written together with it so the two can never drift.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE hardware ADD COLUMN tracking_mode TEXT NOT NULL DEFAULT 'quantity'
  CHECK (tracking_mode IN ('quantity', 'item'));
ALTER TABLE hardware ADD COLUMN requires_sn INTEGER NOT NULL DEFAULT 0
  CHECK (requires_sn IN (0, 1));
ALTER TABLE hardware ADD COLUMN specs TEXT;
ALTER TABLE hardware ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE hardware ADD COLUMN entity_id TEXT;

-- Deterministic mapping of existing rows. is_serialized has always meant "tracked per item",
-- so it maps straight onto the new attribute; nothing is guessed.
UPDATE hardware SET tracking_mode = 'item', requires_sn = 1 WHERE is_serialized = 1 AND tracking_mode = 'quantity';

-- Stable opaque identifier for the new action layer. hardware.id stays the legacy primary key.
-- This backfill only assigns an identifier; it changes no business meaning and creates no stock.
UPDATE hardware SET entity_id = 'legacy-' || id WHERE entity_id IS NULL;

CREATE UNIQUE INDEX uq_hardware_store_entity_id
  ON hardware(store_id, entity_id) WHERE entity_id IS NOT NULL;

-- SKU is the human-facing product code. 0002 generated 'LEGACY-' || id for existing rows, so the
-- index is safe to add, and nullable SKUs are excluded rather than being treated as duplicates.
CREATE UNIQUE INDEX uq_hardware_store_sku
  ON hardware(store_id, sku) WHERE sku IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. stock_items · one row per physical item
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_items (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  asset_code TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('new', 'used')),
  sn_raw TEXT,
  sn_normalized TEXT,
  ownership TEXT NOT NULL CHECK (ownership IN ('store', 'customer', 'vendor')),
  availability TEXT NOT NULL CHECK (availability IN
    ('available', 'reserved', 'quarantine', 'in_transit', 'customer_custody', 'sold', 'retired')),
  location TEXT NOT NULL CHECK (location IN ('store', 'customer', 'external', 'supplier')),
  acquisition_ref TEXT,
  acquisition_cost_cents INTEGER,
  refurbishment_cost_cents INTEGER,
  cost_known INTEGER NOT NULL DEFAULT 0 CHECK (cost_known IN (0, 1)),
  inspection_ref TEXT,
  warranty_snapshot TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, asset_code),
  CHECK (length(trim(asset_code)) > 0),
  CHECK (acquisition_cost_cents IS NULL OR acquisition_cost_cents >= 0),
  CHECK (refurbishment_cost_cents IS NULL OR refurbishment_cost_cents >= 0),
  -- Unknown cost stays NULL. Writing 0 would read as "this item was free".
  CHECK (cost_known = 1 OR acquisition_cost_cents IS NULL),
  CHECK (cost_known = 0 OR acquisition_cost_cents IS NOT NULL),
  -- R03: the three on-hand buckets and the sold bucket are store property only.
  CHECK (availability NOT IN ('available', 'reserved', 'quarantine', 'sold') OR ownership = 'store'),
  -- R03: customer custody is somebody else's property and is never store-owned.
  CHECK (availability <> 'customer_custody' OR ownership <> 'store'),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id)
);

CREATE INDEX idx_stock_items_store_product ON stock_items(store_id, product_id);
CREATE INDEX idx_stock_items_store_availability ON stock_items(store_id, availability);
CREATE INDEX idx_stock_items_sn_normalized ON stock_items(store_id, sn_normalized);

-- A repeat of a store-owned SN still inside the shop is rejected so a human resolves it; the
-- rows are never merged automatically. A customer-owned item may legitimately carry the same
-- value, because that is a different owner record (03 §4 L86).
CREATE UNIQUE INDEX uq_stock_items_store_owned_sn
  ON stock_items(store_id, sn_normalized)
  WHERE sn_normalized IS NOT NULL AND ownership = 'store' AND availability <> 'retired';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. stock_balances · quantity balances for the three on-hand buckets
--    Key is (store, product, location). In-transit and customer custody are not represented
--    here at all, which is what keeps them out of the on-hand total.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_balances (
  store_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  location_id TEXT NOT NULL DEFAULT 'store',
  available_qty INTEGER NOT NULL DEFAULT 0 CHECK (available_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  quarantine_qty INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_qty >= 0),
  total_cost_cents INTEGER,
  cost_known INTEGER NOT NULL DEFAULT 0 CHECK (cost_known IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, product_id, location_id),
  CHECK (total_cost_cents IS NULL OR total_cost_cents >= 0),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. inventory_movements · every movement of stock, quantity or per item
--    Reading of qty (04 §2 L29 declares the column and allows both signs; the pairing with
--    from_bucket / to_bucket is not specified there, so T05a fixes it):
--      to_bucket   bucket gains qty
--      from_bucket bucket loses qty
--    Both may be present on one row (a bucket-to-bucket move), exactly one may be present
--    (entering or leaving the shop). A byte-for-byte recomputation of any bucket is therefore
--    sum(qty where to_bucket = B) - sum(qty where from_bucket = B).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_movements (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  stock_item_id TEXT,
  qty INTEGER NOT NULL,
  from_bucket TEXT CHECK (from_bucket IN
    ('available', 'reserved', 'quarantine', 'in_transit', 'customer_custody', 'sold', 'retired')),
  to_bucket TEXT CHECK (to_bucket IN
    ('available', 'reserved', 'quarantine', 'in_transit', 'customer_custody', 'sold', 'retired')),
  cost_cents INTEGER,
  source TEXT NOT NULL CHECK (source IN (
    'purchase_receipt', 'quick_purchase', 'opening_balance', 'reservation', 'unreservation',
    'assembly_pick', 'delivery', 'return_receipt', 'service_part_consumption', 'scrap',
    'supplier_return', 'count_adjustment', 'conversion', 'inspection_quarantine')),
  reversal_of TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  CHECK (qty <> 0),
  CHECK (from_bucket IS NOT NULL OR to_bucket IS NOT NULL),
  CHECK (from_bucket IS NULL OR to_bucket IS NULL OR from_bucket <> to_bucket),
  CHECK (cost_cents IS NULL OR cost_cents >= 0),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
  FOREIGN KEY (reversal_of) REFERENCES inventory_movements(id)
);

CREATE INDEX idx_inventory_movements_store_product
  ON inventory_movements(store_id, product_id, recorded_at DESC);
CREATE INDEX idx_inventory_movements_item ON inventory_movements(stock_item_id, recorded_at DESC);
CREATE INDEX idx_inventory_movements_request ON inventory_movements(store_id, request_id);

-- The single writer of the balance table. Any movement that touches an on-hand bucket adjusts
-- the matching column; a bucket driven below zero fails the CHECK and aborts the whole batch.
--
-- The row is created empty first and adjusted afterwards, on purpose. Folding the arithmetic
-- into the INSERT branch of an UPSERT does not work: SQLite evaluates the CHECK constraints of
-- the row it is about to insert BEFORE it detects the uniqueness conflict, so a bucket-to-bucket
-- move whose delta is negative (available -> reserved) is rejected even though the resulting
-- balance would be perfectly valid. Measured on real D1, see docs/verification/2026-09-18-T05a.
-- With the empty-row-first form, a negative delta against a missing balance still fails the
-- CHECK after the update, which is the correct outcome: you cannot take stock out of nothing.
CREATE TRIGGER inventory_movements_apply_balance
AFTER INSERT ON inventory_movements
WHEN NEW.from_bucket IN ('available', 'reserved', 'quarantine')
  OR NEW.to_bucket IN ('available', 'reserved', 'quarantine')
BEGIN
  INSERT OR IGNORE INTO stock_balances (store_id, product_id, location_id)
  VALUES (NEW.store_id, NEW.product_id, 'store');

  UPDATE stock_balances SET
    available_qty = available_qty
      + COALESCE(CASE WHEN NEW.to_bucket = 'available' THEN NEW.qty END, 0)
      + COALESCE(CASE WHEN NEW.from_bucket = 'available' THEN -NEW.qty END, 0),
    reserved_qty = reserved_qty
      + COALESCE(CASE WHEN NEW.to_bucket = 'reserved' THEN NEW.qty END, 0)
      + COALESCE(CASE WHEN NEW.from_bucket = 'reserved' THEN -NEW.qty END, 0),
    quarantine_qty = quarantine_qty
      + COALESCE(CASE WHEN NEW.to_bucket = 'quarantine' THEN NEW.qty END, 0)
      + COALESCE(CASE WHEN NEW.from_bucket = 'quarantine' THEN -NEW.qty END, 0),
    version = version + 1,
    updated_at = datetime('now')
  WHERE store_id = NEW.store_id AND product_id = NEW.product_id AND location_id = 'store';
END;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. stock_reservations · per-item occupancy
--    A physical item may be held by at most one active reservation at a time; the partial
--    unique index is that assertion (04 §7 L154, objects.json Reservation.rules).
--    Writing reservations belongs to the sales card (B05 / T08). T05a creates the shape and
--    the constraint so that StockItem.availability = 'reserved' is never an unsupported number.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_reservations (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  stock_item_id TEXT NOT NULL,
  order_ref TEXT NOT NULL,
  line_ref TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty = 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'consumed')),
  reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
);

CREATE INDEX idx_stock_reservations_item ON stock_reservations(stock_item_id, created_at DESC);
CREATE INDEX idx_stock_reservations_order ON stock_reservations(store_id, order_ref);

CREATE UNIQUE INDEX uq_stock_reservations_active_item
  ON stock_reservations(stock_item_id) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Controlled opening balances (B13)
--    An opening is accepted only against an explicit human-confirmed count reference. This is
--    NOT the stock-take document of B16 (its state enum is still undefined and belongs to
--    T06c): it is the audit carrier that makes "someone counted this" a stored fact instead of
--    a claim in a request body.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_openings (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  approved_count_ref TEXT NOT NULL,
  cost_basis_note TEXT,
  note TEXT,
  actor_user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(trim(approved_count_ref)) > 0),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX idx_inventory_openings_store ON inventory_openings(store_id, created_at DESC);

CREATE TABLE inventory_opening_lines (
  id TEXT PRIMARY KEY,
  opening_id TEXT NOT NULL,
  store_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  stock_item_id TEXT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  condition TEXT CHECK (condition IN ('new', 'used')),
  asset_code TEXT,
  sn_raw TEXT,
  unit_cost_cents INTEGER,
  cost_known INTEGER NOT NULL CHECK (cost_known IN (0, 1)),
  CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  CHECK (cost_known = 1 OR unit_cost_cents IS NULL),
  CHECK (cost_known = 0 OR unit_cost_cents IS NOT NULL),
  FOREIGN KEY (opening_id) REFERENCES inventory_openings(id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (product_id) REFERENCES hardware(id),
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)
);

CREATE INDEX idx_inventory_opening_lines_opening ON inventory_opening_lines(opening_id);
