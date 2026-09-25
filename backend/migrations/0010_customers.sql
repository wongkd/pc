-- E02/E04：门店隔离的客户主数据与设备归属。
--
-- 为什么 phone 用「部分唯一索引」而不是表级 UNIQUE(store_id, phone)：
--   契约 objects.json 的 Customer 规则写着「散客允许最少信息」，phone 可以为空。
--   表级 UNIQUE 会把「同店两条空串」判成重复 —— 第二个不留电话的散客直接插不进去，
--   而「顾客只报个名字先留档」恰恰是门店最常见的入口。
--   WHERE phone <> '' 之后，只有真填了电话的客户才受同店唯一约束。
--
-- 本迁移尚未应用到任何远端环境（0006–0009 亦未应用），因此就地修正而不另开迁移。

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);
CREATE INDEX idx_customers_store_name ON customers(store_id, name);
CREATE UNIQUE INDEX idx_customers_store_phone ON customers(store_id, phone) WHERE phone <> '';

CREATE TABLE customer_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  serial_number TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
CREATE INDEX idx_customer_devices_customer ON customer_devices(store_id, customer_id);
