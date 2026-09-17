-- Baseline D1 schema for pc-quote
-- Applied: 2026-06-05 (initial deploy)

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE hardware (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  store_id INTEGER,
  created_by INTEGER,
  updated_by INTEGER,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL DEFAULT 0,
  image TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  refreshed_at TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_hardware_user ON hardware(user_id);
CREATE INDEX idx_hardware_category ON hardware(user_id, category);
CREATE INDEX idx_hardware_store ON hardware(store_id);

CREATE TABLE library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  store_id INTEGER,
  created_by INTEGER,
  updated_by INTEGER,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL DEFAULT 0,
  image TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  refreshed_at TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);
CREATE INDEX idx_library_user ON library(user_id);
CREATE INDEX idx_library_store ON library(store_id);
CREATE INDEX idx_library_store_category ON library(store_id, category);

CREATE TABLE quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  store_id INTEGER,
  created_by INTEGER,
  updated_by INTEGER,
  title TEXT DEFAULT '未命名方案',
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_quotes_user ON quotes(user_id);
CREATE INDEX idx_quotes_store ON quotes(store_id);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  store_id INTEGER,
  created_by INTEGER,
  updated_by INTEGER,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_templates_user ON templates(user_id);
CREATE INDEX idx_templates_store ON templates(store_id);
