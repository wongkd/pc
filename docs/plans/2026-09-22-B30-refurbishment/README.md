# B30 整备与上架 · 实施记录

日期：2026-09-22 ｜ 状态：**后端领域 / 路由 / 本地 HTTP 验收已完成；网页入口与浏览器验收未做**

> 本卡分两段：① 补齐契约与建表（**已完成**）；② 实现领域逻辑与路由 + 测试验收（**未做**）。
> 之所以先做①，是因为它是单点区里风险最高、最需要独占的部分；②不碰单点区，可以随时接续。

## 一、为什么这张卡一直没落地（先看这个）

B30 早就是 `status: frozen` 的**正式动作**（不是 reserved），契约里路径、权限、inputs、effects、errors 全都齐备 ——
看起来"只差写代码"。但真正核对后发现**契约自己不一致**：

| B30 的 inputs 要求 | 契约当时的状态 |
|---|---|
| `成色:ConditionGrade!` | ❌ 枚举**不存在**，且**未登记在 pendingEnums** |
| `披露:Disclosure!` | ❌ 不存在、未登记 |
| `质保:WarrantyTerm!` | ❌ 枚举不存在、未登记 |
| `标价:cents!` | ❌ `StockItem` 对象**完全没有标价字段** |

即：**B30 引用了三个从未被定义的契约元素**。规格文档（03 §118）只写「上架前必须补齐：逐件编号、成色、检测结果、
必要整备、可归属成本、已知缺陷披露、销售价格、本店质保约定」，但**没给任何取值**。

⇒ 若直接开工，只能由实现方"编"出成色分档与标价字段 —— 而契约明说「不得由两端自行取名」。
**所以本卡必须先拍板语义，再动代码。**

## 二、栋哥拍板（2026-09-22）

| # | 事项 | 决定 |
|---|---|---|
| ① | 落地口径 | 只对「来自回收单、未拆件、回收单处于 `acquired`」的实物生效；整备时把回收单推到 `refurbishing`，门槛齐备后推到 `ready_for_sale`（**与 B44 拆件天然互斥**） |
| ② | 成色 `ConditionGrade` | **五档**：`brand_new` 全新 / `like_new` 95新 / `excellent` 9成新 / `good` 8成新 / `fair` 7成新及以下 |
| ③ | 披露 `Disclosure` | **自由文本 + 客户数据处置勾选**（缺陷用文本写；存储设备数据处置是法规要求，用显式布尔固定下来） |
| ④ | 质保 `WarrantyTerm` | **月数**：`3` / `6` / `12` / `24`（可校验、可算到期日） |
| ⑤ | 逐件标价 | **给 `stock_items` 加 `sale_price_cents` 列**（二手件一机一价，不能挂在商品上） |

> ⚠️ **一处措辞冲突已核实并记录**：enums.json 里 `acquired→refurbishing` 的 guard 原文写「需要整备（**仅对拆出的单件**）」，
> 与拍板口径的「**未拆件**」字面矛盾。判定：该 guard 里的「拆出的单件」指的是**件（stock_item）这一粒度**
> （因为 B30 的路径就是 `POST /inventory/items/:id/...`，作用对象是件），不是 B44「拆机产出件」那条路 ——
> 后者是 `acquired→disassembled`，与 B30 是两条互斥转换。规格 03 §120 的成本例（U-017 收购 800 + 整备 80 = 880）
> 与 fixtures 的「回收 → 整备 → 再装机」也支持整机口径。**若栋哥的理解与此不同，只需改 `enums.json` 那句 guard 文案，不影响表结构。**

## 三、已完成的改动（全部门禁已过）

### 3.1 契约（`contracts/v1`）

| 文件 | 改动 |
|---|---|
| `enums.json` | 新增 `ConditionGrade`（五档）与 `WarrantyTerm`（月数）两个枚举；枚举数 41→43、取值 208→217 |
| `objects.json` | `StockItem` 补 5 个上架门槛字段（`conditionGrade` / `salePriceCents` / `disclosureNote` / `dataDisposed` / `warrantyTerm`，**全部 nullable**）；`RefurbishmentCost.tables` 由 `[]` 改为 `["refurbishment_costs"]`；`revisions` 追加 `B30-rev1` 修订痕迹（`contractVersion` 保持 v1，按 F3/T01-rev1 先例） |
| `legacy-mapping.json` | `tables` 末尾追加 `refurbishment_costs` 登记（`targetObjects: ["RefurbishmentCost"]`、`action: keep`）；`sources` 补入 0025；`RefurbishmentCost` **移出** `objectsWithoutLegacyTable`；`revisionNote` 记录本次变更 |
| `actions.json` | **未改** —— B30 本就是 frozen，路径/权限/inputs/effects/errors 原样可用 |

### 3.2 迁移（`backend/migrations/0025_refurbishment_costs.sql`）

- 建 `refurbishment_costs`：`stock_item_id` / `category` / `amount_cents` / **`capitalizable`** /
  `payment_entry_ref` / `evidence_ref` + 幂等键 `UNIQUE (store_id, request_id, stock_item_id)`。
- 给 `stock_items` **ALTER 加 5 列**：`condition_grade` / `sale_price_cents` / `disclosure_note` /
  `data_disposed` / `warranty_term`，**一律允许 NULL**（未经整备的件本就没有这些事实，
  用默认值冒充"已填"会让门槛形同虚设 —— 门槛检查就是查这五项是否都非空）。
- 刻意**不建 CHECK**：SQLite 的 `ALTER TABLE ADD COLUMN` 不支持表级约束，取值合法性由领域层校验。
- **不建任何现金流水**：整备成本计入件可归属成本，交付只确认一次成本快照，不新增「采购」现金。

### 3.3 本轮实跑

| 门禁 | 结果 |
|---|---|
| `validate-contracts.mjs` | **3506 通过 / 0 失败**（B16 基线 3476 → +30） |
| 旧表映射 vs 迁移实际表 | **71 张 / 71 张**（平衡） |
| 四处生成物 | `generate-dto` / `frontend sync-contracts` / `miniprogram sync-contracts` / `sync-error-codes` 全部重新生成并一致 |
| `check:migrations` | 0000–**0025** 连续、无缺号（26 文件），下一个 **0026** |
| 迁移 SQL 可应用性 | 实跑 `backend/tests/r02-workbench.test.mjs`（会全量重放迁移）→ **17/17 通过** |

## 四、已完成与剩余工作

不碰单点区，可随时开工。**照 F2（B19）/ B16 的做法，本卡大概率不需要改 `backend/src/index.ts`** ——
两条路径都在 `/api/v2/inventory` 前缀下，由既有的 `routes/inventory-v2.ts` 认领。

- [x] **领域**：`backend/src/domains/inventory.ts` 新增
      `recordRefurbishment()`（记整备事件）与 `makeItemAvailable()`（上架门槛达成）。
      要点：
      - 幂等用 `runIdempotent`，**幂等检查必须排在任何状态检查之前**（B19 的注释解释了原因：否则合法的同 ID 重放会被误判成重复提交）；
      - `capitalizable=true` 的金额累加进 `stock_items.refurbishment_cost_cents`（汇总），**不写 `cash_entries`**；
      - 上架门槛逐项校验「编号 / 成色 / 检测 / 成本 / 披露 / 标价 / 质保」，缺项回 `INSPECTION_REQUIRED`；
      - 状态推进：`acquired → refurbishing`（记整备时）/ `acquired|refurbishing → ready_for_sale`（门槛齐备）；
      - 与 B44 拆件互斥：回收单已 `disassembled` 时不得再走整备（反之亦然）。
- [x] **路由**：`routes/inventory-v2.ts` 已加两条精确路径正则，
      **必须排在 `ITEM_PATH`（`/^\/api\/v2\/inventory\/items\/(.+)$/`）之前** ——
      那个 `(.+)` 是贪婪的，会吃掉 `/items/xxx/refurbishments`（B19 的 `INSPECTION_PATH` 就是这么处理的）。
- [x] **权限**：复用已有的 `inventory/refurbish`（`legacySource=library/edit`、`grantPolicy=default`），
      **不要新增权限码**；在 `routes/inventory-v2.ts` 的 `LEGACY_EQUIVALENT` 表里确认已登记。
- [x] **测试**：`backend/tests/b30-refurbishment.test.mjs` 已覆盖：
      缺项被 `INSPECTION_REQUIRED` 拦；`capitalizable=false` 的金额**不进** `refurbishment_cost_cents`；
      成本守恒（可归属之和 = 件成本增量）；**同一 `requestId` 重放返回原结果**（幂等用例必须复用同一 requestId 字符串 —— F3 踩过）；
      已 `disassembled` 的回收单不能整备；门槛未齐备不能 `ready_for_sale`。
- [x] **端到端验收**：专项测试运行真实 Worker 入口 + 内存 D1，结果见
      [B30/B36 回执](../../verification/2026-09-22-B30-B36/README.md)。未运行独立 dev-server 脚本或远端环境。
- [x] **回执**：见 [B30/B36 回执](../../verification/2026-09-22-B30-B36/README.md)。
- [ ] **前端**：整备与上架入口（`uiRefs: 整备 / 上架、库存`）及浏览器验收仍待做。

## 五、复现命令

```bash
node contracts/tools/validate-contracts.mjs          # 期望 3506 通过 / 0 失败
npm --prefix backend run check:migrations            # 期望 0000–0025 连续，下个 0026
node -e "const e=require('./contracts/v1/enums.json');console.log(e.enums.ConditionGrade.values, e.enums.WarrantyTerm.values)"
node -e "const o=require('./contracts/v1/objects.json');console.log(Object.keys(o.objects.StockItem.fields))"
```
