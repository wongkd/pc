-- E10 · 售后维修与收款闭环：维修工单、客户设备保管、设备配置版本、换件记录四张表。
--
-- Prerequisite: apply 0000 -> 0018 first（0018 为 B19 的 inventory_inspection，先于本迁移）。
-- Additive only: 本迁移新增四张表，不重建任何既有表，不碰旧 orders / sale_orders / cash_entries。
-- 维修收款（B41）复用 0013 建好的 cash_entries（purpose='service_order' 已在白名单内），
-- 本迁移不新增资金表。
--
-- 契约依据（contracts/v1）：
--   objects.json  ServiceOrder        —— customerId / deviceId / symptom / intakeSnapshot / state /
--                                        proposalVersion / confirmedChargeCents / warrantyDecision / dueAt
--   objects.json  CustomerDevice      —— ownerCustomerId / deviceCode / originalOrderId /
--                                        currentConfigurationId / custodyLocation / stockItemRef
--   objects.json  DeviceConfiguration —— deviceId / revision / components / effectiveAt / changeRef
--   objects.json  DeviceChange        —— deviceId / fromRevision / toRevision / components / effectiveAt / changeRef
--   enums.json    ServiceState（received→diagnosing→awaiting_approval→repairing/outsourced→retesting→ready_return→returned）
--                 LocationKind（store/customer/external/supplier）
--                 WarrantyDecision（in_warranty/out_of_warranty/undetermined）
--                 ConfirmationMethod（phone/wechat/in_person/other，B22 用）
--   actions.json  B20 接修 / B21 检测方案 / B22 方案确认 / B23 换件 / B24 外送 / B25 复测归还 / B41 售后收款
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 设计要点
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. 客户设备（customer_device_custody）与 0010 的 customer_devices 是两张表：
--    后者是「这个客户带过哪些机器」的轻量登记（label/serial_number/remark），
--    本表才是契约 CustomerDevice 的落点，表达客户财产的保管归属（custodyLocation），
--    接修（B20）时落 store，外送返厂（B24）时切 external。客户财产不计自有库存（R03）。
--
-- 2. service_orders 的余额模型对齐 sale_orders，但更简单：维修没有退货贷项与折抵，
--    恒等式为 balance = COALESCE(confirmed_charge_cents, 0) - cash_net_cents。
--    未确认方案前 confirmed_charge_cents 为 NULL，balance 恒为 0（未确认费用不进入应收，objects.json）。
--    收款（B41）只允许在 confirmed_charge_cents 已确认后发生（B41 守卫）。
--
-- 3. 换件（B23）扣自有备件：换件明细（旧件去向 / 新件 / 成本 / 收费原因）落在 device_changes.components_json，
--    备件扣库由 stock_items（availability）+ 库存流水承载（复用 inventory 域），不另建表。
--
-- 4. 归还闸门：B25 在 retesting→ready_return 时校验 balance_cents = 0（费用结清）才放行；
--    首版不做欠款归还，returned 即终态（closed 流转与 QuoteStatus 的 closed 一致，暂不实现）。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与 0004–0017 一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. customer_device_custody · 客户设备保管（契约 CustomerDevice）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE customer_device_custody (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  owner_customer_id INTEGER,
  device_code TEXT NOT NULL,
  original_order_id TEXT,
  current_configuration_id TEXT,
  custody_location TEXT NOT NULL
    CHECK (custody_location IN ('store', 'customer', 'external', 'supplier')),
  stock_item_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(device_code)) > 0),
  UNIQUE (store_id, device_code),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (owner_customer_id) REFERENCES customers(id),
  FOREIGN KEY (original_order_id) REFERENCES sale_orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_customer_device_custody_owner ON customer_device_custody(store_id, owner_customer_id);
CREATE INDEX idx_customer_device_custody_code ON customer_device_custody(store_id, device_code);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. service_orders · 维修工单（契约 ServiceOrder）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE service_orders (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  order_no TEXT NOT NULL,
  customer_id INTEGER,
  device_id TEXT NOT NULL,
  symptom TEXT NOT NULL,
  intake_snapshot TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received'
    CHECK (state IN ('received','diagnosing','awaiting_approval','repairing','outsourced','retesting','ready_return','returned','closed')),
  proposal_version INTEGER,
  confirmed_charge_cents INTEGER,
  warranty_decision TEXT
    CHECK (warranty_decision IS NULL OR warranty_decision IN ('in_warranty','out_of_warranty','undetermined')),
  due_at TEXT,
  cash_net_cents INTEGER NOT NULL DEFAULT 0 CHECK (cash_net_cents >= 0),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  balance_direction TEXT NOT NULL DEFAULT 'settled'
    CHECK (balance_direction IN ('client_due','settled','store_due')),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(order_no)) > 0),
  CHECK (length(trim(symptom)) > 0),
  CHECK (confirmed_charge_cents IS NULL OR confirmed_charge_cents >= 0),
  -- 余额恒等式：待收 = 已确认收费 − 净收现金。
  CHECK (balance_cents = COALESCE(confirmed_charge_cents, 0) - cash_net_cents),
  CHECK (
    (balance_cents > 0 AND balance_direction = 'client_due')
    OR (balance_cents = 0 AND balance_direction = 'settled')
    OR (balance_cents < 0 AND balance_direction = 'store_due')
  ),
  -- 确认收费必然建立在方案版本之上：有收费必有方案；有方案时收费可尚未确认（B21b 先于 B22）。
  CHECK (confirmed_charge_cents IS NULL OR proposal_version IS NOT NULL),
  UNIQUE (store_id, order_no),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (device_id) REFERENCES customer_device_custody(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX idx_service_orders_store_created ON service_orders(store_id, created_at DESC);
CREATE INDEX idx_service_orders_store_state ON service_orders(store_id, state, created_at DESC);
CREATE INDEX idx_service_orders_device ON service_orders(store_id, device_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. device_changes · 换件 / 改配置事件（契约 DeviceChange）
--    先于 device_configurations 建：后者的 change_ref 指向本表。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE device_changes (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  service_order_id TEXT NOT NULL,
  from_revision INTEGER NOT NULL CHECK (from_revision >= 0),
  to_revision INTEGER NOT NULL CHECK (to_revision > from_revision),
  components_json TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  change_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(components_json)) > 0),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (device_id) REFERENCES customer_device_custody(id),
  FOREIGN KEY (service_order_id) REFERENCES service_orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_device_changes_device ON device_changes(store_id, device_id, created_at DESC);
CREATE INDEX idx_device_changes_order ON device_changes(store_id, service_order_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. device_configurations · 设备配置版本（契约 DeviceConfiguration）
--    换件后生成新版本，原配置快照保留不覆盖（objects.json DeviceConfiguration.rules）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE device_configurations (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  components_json TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  change_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (store_id, device_id, revision),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (device_id) REFERENCES customer_device_custody(id),
  FOREIGN KEY (change_ref) REFERENCES device_changes(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_device_configurations_device ON device_configurations(store_id, device_id, revision);
