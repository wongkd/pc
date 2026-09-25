-- E08 · 装机、检测与交付：装机检测单与交付记录两张表的落点。
--
-- Prerequisite: apply 0000 -> 0015 first.
-- Additive only: 只新增两张表与索引，不改动、不重写任何既有表、列、行、触发器或索引。
-- 与 0013（E06）同样的分界：旧的 orders / order_items / order_payments 一行不碰，
-- 旧订单页继续跑在旧链路上。
--
-- 契约依据（contracts/v1）：
--   objects.json  Checklist  —— entityRef / templateVersion / configurationVersion /
--                               items / result / performedAt / performedBy
--   objects.json  TestRecord —— 同上形状（entityRef / templateVersion / configurationVersion /
--                               items / result / performedAt / performedBy）
--   objects.json  Delivery   —— orderId / configurationSnapshotId / deliveredAt /
--                               receivedByNote / financialDisposition / creditApprovalId
--   enums.json    ChecklistResult（incomplete / passed / failed）
--                 ChecklistItemState（pending / pass / fail）
--                 FinancialDisposition（settled_in_full / credit_approved）
--                 SaleFulfillmentState（waiting_stock → preparing → testing → ready_delivery → delivered）
--   actions.json  B04 创建零售与直接销售单 / B06 开始备料与装机 / B07 保存装机检测结果 / B10 确认交付
--   conventions.json money —— 金额只有整数分，服务端重算为准
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 设计要点
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. Checklist 与 TestRecord 由同一张表承载，这不是「省一张表」，是「本来就是一件事」。
--    两个对象在契约里的字段形状**逐字相同**：entityRef / templateVersion /
--    configurationVersion / items / result / performedAt / performedBy，
--    rules 也只是同一件事的两句补充（前者说改配置要失效，后者说不通过要隔离故障件）。
--    实体店的现实也是一张单：装机检查单上既有「外观 / 打包」这类核对项，也有
--    「点亮 / 烤机」这类检测项，一起签名。拆成两张同构表只会让「这次装机到底做了哪些项」
--    变成两次查询，且总有一张会先写成功。
--    items_json 里每项带 kind（check / test），两种项在同一份记录里可分辨、可分别统计。
--    ⚠️ items 的元素形状契约本身没有定义（Checklist.fields.items 只有一个 array 类型），
--    所以这不是绕过契约另立协议；真要拆成两张表属契约修订，已登记为本卡底座缺口。
--
-- 2. 检查单按 checklist_version 递增，不按「配置版本唯一」。
--    装机不通过 → 回到 waiting_stock → 重新备料 → 再检测，这一轮**可能没有换件**，
--    configuration_version 不会变。若把 UNIQUE 压成 (store_id, sale_order_id, configuration_version)，
--    第二次提交就会撞唯一约束 —— 而那恰恰是「没通过、再测一次」的正常路径。
--    所以唯一键是 (store_id, sale_order_id, checklist_version)，
--    并发重复提交由 sale_orders.version 的条件更新与 T04 的版本日志兜底。
--
-- 3. 交付一行定生死：UNIQUE (store_id, sale_order_id)。
--    objects.json Delivery.rules 第 1 条「一张首版订单最多一条有效整体交付」——
--    这条断言写在索引上，而不是写在应用层 if 里。
--    ⚠️ 退货后重新交付（E09）需要在这张表上补状态列，那属 E09 的范围，本迁移不预埋。
--
-- 4. cost_snapshot_json 存**交付当时的逐件成本**，不存售价、不存毛利。
--    未知成本留 null（R01：未知成本不填 0），所以快照里每行带 costKnown 布尔。
--    售价与毛利口径归账本卡（E13），本表不掺和，免得两个地方各算一套。
--
-- 5. configurationSnapshotId（契约 Delivery 字段）首版没有落地结构：
--    objects.json 的 DeviceConfiguration 至今 objectsWithoutLegacyTable（设备配置版本表未建）。
--    本表用 sale_orders.configuration_version 对齐「交付的是哪一版配置」，
--    并在 cost_snapshot_json 的 configurationVersion 里留下同一个值。
--    建 DeviceConfiguration 表属设备卡（E10），已登记为底座缺口 —— 这里不假装它存在。
--
-- 6. 本迁移不建任何库存副作用结构。交付的「扣库一次」由 B10 在同一个 batch 里
--    写 inventory_movements（reserved → sold）+ 改 stock_items.availability='sold'，
--    由 0007 的触发器同步 stock_balances。余额被扣穿时 CHECK (available_qty >= 0) 会整批回滚，
--    所以「扣库一次」不是靠应用层数一遍，是靠约束。
--
-- Rollback: structural rollback requires restoring a verified pre-migration D1 export.
-- ⚠️ 与 0004–0015 一样，本文件在明确授权前不得 apply 到任何远端环境。

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. sale_checklists · 装机检测单（Checklist + TestRecord）
--    performed_at / performed_by 是「谁在什么时候做的」这条事实本身，不派生、不默认当前时间。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sale_checklists (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  sale_order_id TEXT NOT NULL,
  -- 同一张单的第几次提交。不按配置版本唯一（见设计要点 2）。
  checklist_version INTEGER NOT NULL CHECK (checklist_version > 0),
  -- 模板版本随检查单固化（Checklist.rules 第 1 条）。改模板不改历史单。
  template_version TEXT NOT NULL,
  -- 这份检查单核对的是哪一版配置。交付时前后端都要拿它对齐。
  configuration_version INTEGER NOT NULL CHECK (configuration_version >= 0),
  -- 检查项数组。元素形状：{ key, label, kind('check'|'test'), state('pending'|'pass'|'fail'),
  -- note, performedAt, performedBy }。kind 区分装配核对项与检测项（见设计要点 1）。
  items_json TEXT NOT NULL,
  -- 整单结论，由检查项派生（enums.json ChecklistResult.desc）。
  result TEXT NOT NULL CHECK (result IN ('incomplete', 'passed', 'failed')),
  performed_at TEXT NOT NULL,
  performed_by INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(template_version)) > 0),
  CHECK (length(trim(items_json)) > 0),
  UNIQUE (store_id, sale_order_id, checklist_version),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (performed_by) REFERENCES users(id)
);

CREATE INDEX idx_sale_checklists_order
  ON sale_checklists(store_id, sale_order_id, checklist_version DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. sale_deliveries · 交付记录
--    交付 = 实物交出这件事本身。资金是否结清由 financial_disposition 记，
--    不在本表存金额（金额在 sale_orders 与 cash_entries，口径只有一个）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sale_deliveries (
  id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL,
  sale_order_id TEXT NOT NULL,
  -- 交付的配置版本。必须等于交付当时的 sale_orders.configuration_version（B10 的守卫）。
  configuration_version INTEGER NOT NULL CHECK (configuration_version >= 0),
  -- 交付所依赖的检查单版本。零售单跳过装机与检测，可以为空。
  checklist_version INTEGER,
  -- 交付备注 / 收货人备注（「本人签收」「代收：某某」）。
  delivery_note TEXT NOT NULL DEFAULT '',
  received_by_note TEXT NOT NULL DEFAULT '',
  -- 交付时的资金处置：结清，或老板批准欠款。
  -- 「缺陷单」不能拿第三个值绕过（enums.json FinancialDisposition.desc）。
  financial_disposition TEXT NOT NULL
    CHECK (financial_disposition IN ('settled_in_full', 'credit_approved')),
  -- 欠款交付的批准凭证。B09（批准欠款交付）尚未实现，因此本卡不会写出 credit_approved 行；
  -- 约束先立在这里，等 B09 落地时它自然生效，不需要再改表。
  credit_approval_id TEXT,
  -- 交付当时的逐件成本快照（数组 JSON）。未知成本写 null + costKnown=false，不写 0。
  cost_snapshot_json TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  delivered_by INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (length(trim(cost_snapshot_json)) > 0),
  -- 欠款交付必须有批准凭证，不能只改一个枚举值。
  CHECK (financial_disposition <> 'credit_approved' OR credit_approval_id IS NOT NULL),
  -- 「一张首版订单最多一条有效整体交付」（objects.json Delivery.rules 第 1 条）。
  UNIQUE (store_id, sale_order_id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (delivered_by) REFERENCES users(id)
);

CREATE INDEX idx_sale_deliveries_order
  ON sale_deliveries(store_id, sale_order_id);
