# B39 报损 / B40 普通价格调整 · 提升方案（拍板后待落地）

日期：2026-09-22；更新：2026-09-25 ｜ 状态：**首发仍暂缓；B39/B40 保持 reserved。** [D01/D02经营规则已冻结](../2026-09-23-owner-decisions/README.md)，原因/权限不再等待老板填写；后续按单点区规则实现及验收。
用途：把契约里两条 `reserved` 动作提升为正式动作。**本卡只定语义与方案，未改任何代码**。

> 依据来源：`contracts/v1/*.json`（2026-09-22 15:50 实测）、`docs/plans/2026-09-17-web-wechat-plan/03-domain-rules.md`、
> `04-data-and-api.md`、`05-reference-analysis.md`、`backend/migrations/0007_inventory_core.sql`。

---

## 0. 当前范围

截至2026-09-25，首发不包含报损与普通改价，契约保持 `reserved`，页面/API不能当作已启用。经营规则已冻结，后续实施直接按R1，不重复要求老板拍板。以下旧勘察中的未定原因/权限及当时并发状态仅供追溯，以R1和开工时实际文件为准。盘点差异走B16，拆件损耗走既有 `scrap`；不能用这些动作、伪造采购或通用商品编辑绕过B39/B40。

## 1. 先读这一段：为什么现在不能落地

**单点区（`contracts/v1` + `backend/migrations` + `backend/src/index.ts`）在 2026-09-22 15:35–15:47 期间持续被另外两个会话写入**：

| 文件 | 最后修改 | 谁在动 |
|---|---|---|
| `backend/migrations/0024_inventory_counts.sql` | 15:35 | BK-02（B16 盘点） |
| `backend/src/routes/inventory-v2.ts`、`domains/inventory.ts` | 15:3x | BK-02 |
| `backend/src/routes/workbench-v2.ts`、`domains/workbench.ts` | 15:42+ | BK-01（R02 工作台） |
| `backend/tests/r02-workbench.test.mjs` | 15:42+ | BK-01 |
| `backend/src/index.ts` | 15:41 | 两边都在改 |
| `contracts/v1/actions.json` / `legacy-mapping.json` | 15:41 / 15:38 | 契约源 |
| 四处生成物（contracts / frontend / miniprogram / error-codes） | 15:42+ | 每次契约变更重生成 |

**风险不是「冲突」，是「静默失效」**：`validate-contracts.mjs` 反向读 `index.ts` 权限映射的**绝对行号**证据。
B16 会话已在 15:41 改过 `index.ts` 并留下 `docs/verification/2026-09-22-R02-workbench/shift-index-lines.mjs`
（行号平移脚本）。此时第三方再改 `index.ts`，两边各按自己的增量平移行号，**校验器不报错、只让行号悄悄指错**。

⇒ **落地前置条件：确认 `docs/verification/progress/` 下 BK-01 / BK-02 已各自收工刷完 `updatedAt`，且 15 分钟内 `contracts/v1`、`backend/migrations`、`index.ts` 无新写入。**

---

## 1. 事实核查（只读，全部可复现）

### 1.1 两条动作的契约现状

| | B39 报损 | B40 普通价格调整 |
|---|---|---|
| 位置 | `supplementaryActions` | `supplementaryActions` |
| status | `reserved` | `reserved` |
| domain | `inventory` | `inventory` |
| owner | **`T06c`** | **`null`（未指定）** |
| path | `null` | `null` |
| permission | **`inventory/damage`（已定）** | **`null`（未定）** |
| 阻塞 | 报损原因枚举未冻结 | **`blockedBy: Q07`，state=「阻塞」** |
| 契约原话 | "不得复用采购入库伪造差异（05 T06c）；老板权限（03 §8）。" | "未指定归属任务卡，也未说明作用于商品售价还是报价行。归属与权限码待定，**不得由两端自行取名**。" |

关键补充（`04-data-and-api.md` L124）：
> 未明确的补充动作（如采购取消、报损、退供、普通价格调整）在对应任务先补入契约表和样本再实现，
> 不允许用通用 PUT status 绕过业务。**T01 冻结路径，不能由两端独立取名。**

### 1.2 现成件（省掉造轮子 —— 这一节的结论是「大部分已就绪」）

| 需要的件 | 现状 | 结论 |
|---|---|---|
| 权限码 `inventory/damage` | **已存在**：`{level: action, grantPolicy: owner_only, legacySource: null}`，且已列入旧宽权限的 `noWideningGuard.doesNotGrant` | ✅ 不改 |
| 审计与幂等基座 | `operations` / `assertion_guards` / `audit_logs` 均在 | ✅ 复用 |
| 库存流水表 | `inventory_movements`（0007 建，0018 重建） | ✅ 复用 |
| 余额结算 | **触发器** `inventory_movements_apply_balance`（AFTER INSERT，只对 `available/reserved/quarantine` 三个桶生效） | ✅ 复用，**不得手写 UPDATE** |
| 流水来源 `scrap` | 已存在，但**已被回收拆件损耗占用**（`backend/src/domains/recovery.ts:863`） | ⚠️ 见待确认① |
| 错误码 | `STOCK_CONFLICT`(409) = "无足量库存，或指定实物已被占用"；`VALIDATION_ERROR`(400) | ✅ 够用，**不新增** |
| 报损原因枚举 `StockAdjustmentReason` | **不存在**，登记在 `pendingEnums`：forObject="InventoryMovement / 报损 / 盘差" | ❌ 待冻结 |
| 桶转换 `available → retired` | **不存在**（`inventoryBucketRules.transitions` 只有 `quarantine→retired`） | ❌ **必修** |

**→ 换句话说：报损的权限、幂等、流水、余额、错误码五件套全都是现成的，缺的主要是「原因枚举」和「一条桶转换」。**

### 1.3 `InventoryMovement` 已经支持数量件与逐件两种形态

```json
{ "productId": "id!(必填)", "stockItemId": "id?(可空)", "qty": "int!(增量,可正可负)",
  "fromBucket": "StockBucket?", "toBucket": "StockBucket?", "source": "InventoryMovementSource!",
  "costCents": "cents?", "reversalOf": "id?" }
```

⇒ **「数量件 + 逐件」不需要拆成两个动作**，靠 `stockItemId` 是否为空判别即可。这是契约本来就设计好的。

### 1.4 ⚠️ 关键发现：「价格调整」在契约里对应四个不同的东西

`03 §7`（`03-domain-rules.md` L146）原话：

> **销售净应计金额 = 原确认成交额 ＋ 已批准加价调整 － 已批准减价 / 退货贷项。**

`money-rules.json` L21：
> 加价与减价调整**必须是已批准记录**；未批准的调整不进入净应计。

`fixtures.json` L964：
> 取消未交付单后，原确认成交额如何冲销（走已批准减价调整，还是另一种冲销口径）**规格未定义**，故本算例不假定其数值。

⇒ 把「普通价格调整」这个词摊开，它可能指四件不同的事：

| # | 语义 | 作用对象 | 契约现状 | 判断 |
|---|---|---|---|---|
| ① | **商品挂牌价** | `Product.defaultSalePriceCents`（表 `hardware`） | **无任何预留**；`PriceAdjustmentReason.forObject` 写的是 "SaleOrder / Quote"，**不是** Product | B40 的 `domain=inventory` 与之相符 |
| ② | **报价行价格** | `quote_lines.unit_price_cents` | **已有完整机制**：草稿可改 → 发出后「改＝回草稿版本+1」→ **确认后不能改** | **不需要新动作**；硬加会绕过「确认后不能改」 |
| ③ | **销售单加价/减价** | 销售净应计金额 | `03 §7` 承认它存在且**必须已批准**，但**动作编号缺失、实体未实现**；即 P-01 的「调整」实体 | **不是 B40**，属 P-01 |
| ④ | 回收最终收购价变价 | 回收应付 | `money-rules`："最终收购以后的变价走调整，不覆盖原价"；G-27 已裁定走 B29 归还重开单 | 暂不动 |

---

## 2. 栋哥拍板结果（2026-09-22 15:50 首轮 + 16:0x 二次拍板）

| 项 | 决定 |
|---|---|
| 落地时点 | **等 BK-01 / BK-02 收工再落地**（本卡先出方案） |
| B39 报损对象 | **数量件 + 逐件，两者都要** |
| B39 是否两步审批 | **一步，录入即生效** |
| B39 流水来源 | **新增 `damage_writeoff`**（🔁 二次拍板，否掉「复用 `scrap`」） |
| B40 作用对象 | **商品挂牌价（分支 A）**（🔁 二次拍板，**覆盖**首轮的「两者都要」） |

> **二次拍板补记（2026-09-22，BK-01 / BK-02 收工后）**
>
> - **B39 流水来源 → 新增 `damage_writeoff`**。理由：`scrap` 已被回收拆件损耗占用（`recovery.ts:863`），
>   复用会让「本月报损多少」这类统计分不出来；而契约明说「未列出的来源必须先补契约再实现」，
>   **现在正是改契约的时机**，增量成本最低，拖到以后再改要再做一次契约变更 + 重生成四处生成物。
> - **B40 作用对象 → 商品挂牌价（分支 A）**，否掉首轮的「两者都要」。理由见 §4.2：
>   「报价行价格」已被「草稿可改 → 发出后改＝回版本+1 → 确认后不能改」这条铁律完整覆盖，
>   硬加一个独立动作等于给铁律开口子 —— 那是业务规则变更，不是实现问题。
> - **仍待确认 2 项**：②`StockAdjustmentReason` 取值清单、④`inventory/price-adjust` 的 `grantPolicy`（见 §5）。
> - 「两者都要」的首轮结论与 §1.4 的证据冲突，**以本轮为准**。

---

## 3. B39 报损 · 完整方案（可直接落地）

### 3.1 契约改动清单（4 处，全部在单点区）

| 文件 | 改什么 |
|---|---|
| `enums.json` | ① `ActionCode.values` 补 `B39`，desc 记明提升来源；② **新增 `enums.StockAdjustmentReason`**（取值见待确认②）；③ **`inventoryBucketRules.transitions` 新增一条 `available → retired`**，reason 写「在库可卖件主动报损（B39）；在库减少且不离店转售」；④ **`InventoryMovementSource.values` 新增 `damage_writeoff`**（①已定：新增值，不复用 `scrap`）；⑤ `pendingEnums` 移除 `StockAdjustmentReason` |
| `actions.json` | `supplementaryActions` 删除 B39 → 主 `actions` 数组新增（`status: frozen`），含 `operations`(path/method/permission)、`inputs`、`effects`、`errors`、`specBasis`、`stateMachine` |
| `objects.json` | **无需改动**（`InventoryMovement` 已覆盖两种形态） |
| `legacy-mapping.json` | 登记新 source `damage_writeoff`；复用 `inventory_movements`，**不新建表** |

> ⚠️ `permissionModel.codes` 里 `inventory/damage` 已存在且 `grantPolicy=owner_only`，**不要新增权限码、不要动 `noWideningGuard`**。
> ⚠️ 按 F0 锁规则：改完必须「重新生成 → 同步两端 → 跑门禁」，四个生成物位置一个都不能漏
> （`contracts/generated`、`frontend/src/contracts/generated`、`miniprogram/contracts/generated`、`backend/src/generated/error-codes.ts`）。

### 3.2 动作定义（建议形态）

| 项 | 值 |
|---|---|
| 路由 | `POST /inventory/damages`（对齐 B38 先例 `/inventory/supplier-returns`；**路径必须在契约里冻结，不得由两端自取**） |
| 权限 | `inventory/damage`（owner_only，已有） |
| inputs | `productId:id!` ／ `stockItemId:id?` ／ `qty:int!` ／ `reason:StockAdjustmentReason!` ／ `note:string?` ／ `requestId:string!` |
| effects | `InventoryMovement` ／ `StockBalance`（数量件）／ `StockItem`（逐件）／ `AuditEvent` |
| stateMachine | 无新对象状态机；**引用 `inventoryBucketRules`** |

### 3.3 两种形态的落法

| 形态 | 判别 | `qty` | `fromBucket` | `toBucket` | 余额效果 |
|---|---|---|---|---|---|
| **数量件** | `stockItemId` 缺失 | > 0 | `available` | `retired` | `stock_balances.availableQty -= qty`（由触发器结算） |
| **逐件** | `stockItemId` 有值 | **必须 = 1** | `available` | `retired` | `availableQty -= 1` 且该件桶态转 `retired` |

**三条必须守住的约束**：

1. **`retired` 不是在库桶**。`stock_balances` 只有 `available / reserved / quarantine` 三个在库列，
   触发器也只对这三个桶生效 ⇒ `to_bucket='retired'` 不写余额，这是**正确**的，不要额外补列。
2. **逐件报损走 `available → retired`，不是 B19 的 `quarantine → retired`**。B19 管待检件，B39 管在库可卖件，
   两条路径不同，**不要合并**（`quarantine→retired` 的 reason 里那句「后续补入的报损动作」指的是同一批动作码，
   但转换起点不同）。
3. **一步生效 ⇒ 不可改、只能冲销**。契约 `InventoryMovement.rules`：
   > 已完成的库存记录不直接改写或删除，使用关联冲销 / 调整记录。

   ⇒ 误报损只能写一条 `reversalOf` 指向原笔的反向流水，**禁止 UPDATE/DELETE**。

### 3.4 错误码（全部复用现有，不新增）

| HTTP | code | 触发 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `qty <= 0`；`stockItemId` 有值但 `qty ≠ 1`；`reason` 缺失 |
| 404 | `ENTITY_NOT_FOUND` | 商品 / 实物不存在，或不属于本店（不泄露跨店实体是否存在） |
| 409 | `STOCK_CONFLICT` | 数量件超 `availableQty`；逐件当前不在 `available` |
| 409 | `IDEMPOTENCY_MISMATCH` | 同一 `requestId` 不同载荷 |
| 403 | `PERMISSION_DENIED` | 非老板 |

### 3.5 后端落点

| 文件 | 动作 |
|---|---|
| `backend/src/routes/inventory-v2.ts` | 新增路由（**该文件已存在**，BK-02 刚动过 ⇒ 落地前先看 mtime） |
| `backend/src/domains/inventory.ts` | 新增 `recordDamage()`；同步检查 `MOVEMENT_SOURCES` 常量是否与契约枚举一致（**F2 踩过：代码里 14 值 vs 契约 16 值**） |
| `backend/src/index.ts` | 接线（**单点区，改动 ⇒ `actions.json` 里 `legacyPermissionMap` 的绝对行号证据整体平移，必须逐行复验落点确实是 `requirePermission(...)`**） |
| `backend/src/domains/access.ts` | 核查 `inventory/damage` 是否已登记（P-49：新权限码写这里，不写 `index.ts`） |
| 迁移 | **不需要新迁移**（报损无独立实体，纯流水事件） |

### 3.6 验收要求

- 后端测试：数量件超可用被 `STOCK_CONFLICT` 拦；逐件 `qty≠1` 被 `VALIDATION_ERROR` 拦；
  一步生效后余额确实减少；**同 `requestId` 重放返回原结果（幂等用例必须复用同一 `requestId` 字符串 —— F3 踩过）**；
  误报损冲销后余额回到原值。
- HTTP 验收脚本（起 dev-server 走真实 HTTP，产出 `report.json`），样板参考
  `docs/verification/2026-09-22-F3-purchase-cancel-payment/verify-f3.cjs`。
- 回执 `docs/verification/progress/B39.json`，`status=verified` 时**必须同时**有一条源码路径与一条 `docs/verification/*.md`。

---

## 4. B40 普通价格调整 · 两个分支（落地前必须二选一）

### 4.1 分支 A —— B40 = 商品挂牌价调整（推荐）

**为什么推荐**：B40 的 `domain` 契约已定为 `inventory`，而商品主数据正属该域；
且「**普通**价格调整」的「普通」恰好与 §1.4 ③ 那种「进入结算净额、必须已批准」的加价/减价调整形成对照。

| 项 | 值 |
|---|---|
| 路由 | `PATCH /inventory/products/:id/price` |
| 权限 | **新码** `inventory/price-adjust`（建议 `owner_only`；也可先 `default` + 全量审计，由栋哥定） |
| inputs | `newPriceCents:cents!` ／ `reason:PriceAdjustmentReason!` ／ `note:string?` ／ `expectedVersion:int!`（乐观锁） |
| effects | `Product`（改 `defaultSalePriceCents`）／ `AuditEvent` |
| 错误 | `VALIDATION_ERROR` 400 ／ `VERSION_CONFLICT` 409 ／ `ENTITY_NOT_FOUND` 404 ／ `PERMISSION_DENIED` 403 |

契约需连带改：

1. `PriceAdjustmentReason` 的 `forObject` 由 `"SaleOrder / Quote"` 改为 **`Product`**
   （或保留原枚举给 ③，另建 `ProductPriceAdjustmentReason`）。**这一条属契约语义变更，必须登记 `revisions`。**
2. `pendingEnums` 移除 `PriceAdjustmentReason`。

**硬约束**（`Product.rules` 原话）：
> 关键属性已发生业务后修改需专门规则，**不静默改写历史单据**。

⇒ 改挂牌价**只影响此后新开的报价行**；`quote_lines` / `sale_lines` 已有 `nameSnapshot` / `unitPriceCents` 快照，
历史单据一律不动。**这一点必须写进卡并在测试里断言。**

⚠️ 另：`Product` 在 `stateMachineGaps` 里出现（P-05），改价是否触发 `Product` 状态机转换需一并判定。

### 4.2 分支 B —— 若「报价行价格」也必须有独立动作

**先说结论：我不建议，而且需要你重新拍一次。** 理由：

- 报价的既有规则是**草稿可改 → 发出后「改＝回草稿版本+1」→ 确认后不能改**（硬铁律）。
- 「调整报价行价格」这个需求已被上述流程完整覆盖：要改价就改版。
- 若要求「**发出之后**单独调某一行价格」，那等于要开一个绕过「确认后不能改」的口子 ——
  这**不是实现问题，是业务规则变更**，会同时影响报价有效期、定金锁定、已确认快照的可信度。
- 因此若你确实要这个能力，请明确回答：**是「发出后允许单独调行价」，还是「就是改版流程」**？
  前者需要单独拍板并说明对定金/快照的影响；后者**不需要任何代码**。

### 4.3 顺带排除：③ 销售单加价/减价调整不属于 B40

`03 §7` 与 `money-rules` 描述的「已批准加价/减价调整」是**进入销售净应计金额**的结算级调整，
它需要一个「调整实体」（P-01 明说未实现），并牵动 `adjustmentRef`（B18 退款用它做冲抵凭据）。
**这是一个比 B40 大得多的缺口，归 P-01 独立拍板，不要塞进 B40。**

---

## 5. 待确认（状态：4 项已定 2 项，剩 2 项）

| # | 事项 | 状态 |
|---|---|---|
| ① | 报损的流水来源 | ✅ **已定（二次拍板）：新增 `damage_writeoff`**，不复用 `scrap` |
| ② | `StockAdjustmentReason` 的取值清单 | ⏳ **待定**：报损原因有哪些？（如：破损 / 丢失 / 老化失效 / 拆机损耗 / 其他）直填写几个词即可，我据此冻结枚举 |
| ③ | B40 走分支 A 还是分支 B | ✅ **已定（二次拍板）：分支 A（商品挂牌价）** |
| ④ | `inventory/price-adjust` 的 `grantPolicy` | ⏳ **待定**：`owner_only`（只有老板能改挂牌价）还是 `default`（店员可改、全部审计）？ |

---

## 6. 落地清单（单点区空闲后按序执行）

- [ ] **0. 前置核查**：`stat` 确认 `contracts/v1/*`、`backend/migrations/*`、`backend/src/index.ts` 15 分钟内无新写入；
      `docs/verification/progress/` 下 BK-01 / BK-02 已收工。**看到对方仍在写就停手，不要抢。**
- [ ] **1. 契约源**（`enums.json` → `actions.json` → `objects.json` → `legacy-mapping.json`）按 §3.1 / §4.1 改
- [ ] **2. 重新生成四处生成物**：`generate-dto` → `contracts/generated`；`frontend/scripts/sync-contracts.mjs`；
      `miniprogram/scripts/sync-contracts.mjs`（**收工清单曾漏这条**）；`backend/scripts/sync-error-codes.mjs`
- [ ] **3. 后端实现**：`recordDamage()` + 路由 + `index.ts` 接线
- [ ] **4. 平移行号证据**：`index.ts` 改动后，按新增行数整体平移 `actions.json` 的 `legacyPermissionMap` 绝对行号
      （`specBasis` 是 `file`+`line` **分开**格式；`actions.json` 里 `index.ts:NNN` 形态的引用含 `wildcardNote` 也要平移），
      **改完逐行复验落点**
- [ ] **5. 测试**：后端测试 + HTTP 验收脚本 + 浏览器验收（**UI 必须实际看图**，只跑通过数不算）
- [ ] **6. 门禁全绿**：
      `npm --prefix backend test`｜`node contracts/tools/validate-contracts.mjs`｜`generate-dto --check`｜
      两端 `sync-contracts --check`｜`check-client-parity`｜`sync-error-codes --check`｜
      `npm --prefix backend run check:migrations`｜`npm --prefix frontend test` / `build` / `lint`（**lint 基线 39 项既有失败，新增必须为 0**）｜
      `node scripts/check-doc-links.mjs`
- [ ] **7. 回执与文档**：`docs/verification/2026-09-22-B39-B40/README.md` + `docs/verification/progress/B39.json`；
      更新 `docs/STATUS.md`、`docs/NEXT-SESSION-PROMPT.md`、`docs/OPEN-ITEMS.md`（P-04 / Q07 销案）
- [ ] **8. 复跑覆盖率审计**：`node docs/plans/2026-09-22-erp-remaining-tasks/audit-action-coverage.mjs`
      （预期主动作由 **39/42 → 40/42**）

---

## 7. 复现命令

```bash
# 契约现状（两条动作的完整定义）
node -e "const a=require('./contracts/v1/actions.json');console.log(JSON.stringify(a.supplementaryActions,null,1))"

# 桶转换规则（看 available→retired 是否已存在）
node -e "const e=require('./contracts/v1/enums.json');console.log(JSON.stringify(e.inventoryBucketRules.transitions,null,1))"

# 报损权限码
node -e "const a=require('./contracts/v1/actions.json');console.log(JSON.stringify(a.permissionModel.codes.find(c=>c.code==='inventory/damage'),null,1))"

# 待冻结枚举
node -e "const e=require('./contracts/v1/enums.json');console.log(JSON.stringify(e.pendingEnums,null,1))"

# 单点区占用检查（落地前必跑）
find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -newermt "-15 minutes" -print
```
