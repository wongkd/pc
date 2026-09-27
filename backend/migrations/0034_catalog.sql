-- 商城展示层独立存储；不改动库存、报价或其价格。
CREATE TABLE catalog_images (
  id TEXT NOT NULL,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  object_key TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (store_id, id)
);
CREATE TABLE catalog_products (
  id TEXT NOT NULL,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('整机', '配件')),
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK(price_cents BETWEEN 0 AND 100000000),
  cover_image_id TEXT,
  hero_image_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'unpublished')),
  version INTEGER NOT NULL DEFAULT 1,
  mutation_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, id),
  FOREIGN KEY (store_id, cover_image_id) REFERENCES catalog_images(store_id, id),
  FOREIGN KEY (store_id, hero_image_id) REFERENCES catalog_images(store_id, id)
);
CREATE INDEX catalog_public_list ON catalog_products(store_id, status, category, id);
CREATE TABLE catalog_events (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL,
  product_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER catalog_created AFTER INSERT ON catalog_products BEGIN
  INSERT INTO catalog_events(store_id, product_id, version, payload, actor_id)
  VALUES(NEW.store_id, NEW.id, NEW.version, NEW.payload, NEW.updated_by);
END;
CREATE TRIGGER catalog_updated AFTER UPDATE ON catalog_products BEGIN
  INSERT INTO catalog_events(store_id, product_id, version, payload, actor_id)
  VALUES(NEW.store_id, NEW.id, NEW.version, NEW.payload, NEW.updated_by);
END;
