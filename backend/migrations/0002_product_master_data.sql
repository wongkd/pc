-- ERP Phase 3: Product master data — categories, brands and legacy hardware migration
-- Applied: 2026-07-22
-- Converts the existing hardware table to the ERP product model while keeping legacy fields intact.
-- WARNING: This migration is idempotent for columns that may already exist.

-- 1) Product categories and brands -------------------------------------------

CREATE TABLE product_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by INTEGER,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(store_id, code),
  UNIQUE(store_id, name),
  FOREIGN KEY (store_id) REFERENCES stores(id)
);

CREATE TABLE product_brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by INTEGER,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(store_id, normalized_name),
  FOREIGN KEY (store_id) REFERENCES stores(id)
);

-- 2) Extend legacy hardware table into ERP product model ----------------------

ALTER TABLE hardware ADD COLUMN category_id INTEGER REFERENCES product_categories(id);
ALTER TABLE hardware ADD COLUMN brand_id INTEGER REFERENCES product_brands(id);
ALTER TABLE hardware ADD COLUMN sku TEXT;
ALTER TABLE hardware ADD COLUMN item_type TEXT NOT NULL DEFAULT 'product' CHECK (item_type IN ('product', 'service'));
ALTER TABLE hardware ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'));
ALTER TABLE hardware ADD COLUMN is_serialized INTEGER NOT NULL DEFAULT 0 CHECK (is_serialized IN (0, 1));
ALTER TABLE hardware ADD COLUMN is_salable INTEGER NOT NULL DEFAULT 1 CHECK (is_salable IN (0, 1));
ALTER TABLE hardware ADD COLUMN is_purchasable INTEGER NOT NULL DEFAULT 1 CHECK (is_purchasable IN (0, 1));
ALTER TABLE hardware ADD COLUMN reference_price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hardware ADD COLUMN default_price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hardware ADD COLUMN min_price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hardware ADD COLUMN purchase_price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hardware ADD COLUMN average_cost_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hardware ADD COLUMN safety_stock_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hardware ADD COLUMN updated_at TEXT;

-- Service rows are non-inventory: they cannot be serialized, purchased, or stocked.
-- CHECK constraint is enforced at app level; D1 may not support table-level CHECK via ALTER.

-- Migrate legacy category names into product_categories and backfill hardware.category_id
-- Run as a best-effort seeding step.
INSERT OR IGNORE INTO product_categories (store_id, code, name, created_by, updated_by)
SELECT 1, 'LEGACY-' || LOWER(HEX(RANDOMBLOB(8))), category, 1, 1
FROM (SELECT DISTINCT category FROM hardware WHERE category IS NOT NULL AND category <> '' AND store_id = 1);

UPDATE hardware SET category_id = (SELECT id FROM product_categories WHERE store_id = hardware.store_id AND name = hardware.category)
WHERE category_id IS NULL AND store_id = 1 AND category IS NOT NULL AND category <> '';

-- Derive SKU from legacy id so product CRUD has a unique code.
UPDATE hardware SET sku = 'LEGACY-' || id WHERE sku IS NULL;

-- Correct service items (e.g. labour rows): they cannot be serialized or purchased.
UPDATE hardware SET item_type = 'service', is_serialized = 0, is_purchasable = 0, safety_stock_qty = 0
WHERE category IN ('其他') AND (name LIKE '%运费%' OR name LIKE '%工费%' OR name LIKE '%质保%');
