# E06/E07 补洞 · 报价行商品引用 + 数量件预留

日期：2026-09-21。状态：**已完成并验收**。

上一轮 E06（收款与预留）与 E07（采购到货）验收全绿，但顺着「一个装机店老板真的会怎么点」走了一遍，
发现两条链路在**真实业务主流场景**下走不满。本卡就是补这两个洞，外加过程中撞出来的一个 E06 遗留缺陷。

---

## 1. 两个洞是什么、根因在哪

### 洞①：报价行没有商品引用 ⇒「订单缺件 → 建采购」这条线是断的

**症状**：E06 转销售单时新品行解析不出商品，`sale_lines.product_id` 记 NULL 并丢进「缺口」。
订单上写着「缺 1 件显卡」，可采购页要你填商品引用 —— 而报价行从头到尾没有存过这个引用。

**根因不是设计缺失，是写入那一刻就把数据丢了**：

- `backend/src/domains/quote.ts` 的 `QuoteLineInput`（E05 写的）**早就有 `productRef` 字段**，
  注释还写着「报价阶段允许为空 —— 临时行在成交前才必须映射」；
- 但 `insertLineStatement` 的 `INSERT` **没有这一列**，`quote_lines` 表也没有 ⇒ 接口收了、库里没落。

**契约依据（所以不用改契约）**：`objects.json` 的 `QuoteVersion.rules` 第 1 条写着
「草稿中的临时实物行可未建档；**成交前必须映射到商品**」。
也就是说「报价行要能携带商品引用」原本就是契约要求，E06 把映射不出来降级成「缺口」其实**违反了这条规则**
—— 缺口的本义是「有商品但货不够」，不是「不知道卖的是什么」。

### 洞②：数量件没有预留 ⇒ 硬边界③「付定金即锁库存」对数量件失效

**症状**：内存条、硬盘、风扇这类按数量卖的新品，付了定金也锁不住库存，随时可能被别的单卖掉。

**根因**：0007 建 `stock_reservations` 时 `stock_item_id` 是 `NOT NULL`、`qty` 写死 `CHECK (qty = 1)`，
唯一索引也按 `stock_item_id` 建 —— **只支持逐件实物**。
逐件实物靠 `stock_items.availability = 'reserved'` 锁，而数量件**没有 stock_items 行可改**，
于是既不进 `stock_reservations` 也不动 `stock_balances`。

**契约同样早就写好了**（也不用改契约）：

- `objects.json` 的 `Reservation.fields.quantityBucketRef`：「数量件占用时必填」；
- `enums.json` 的 `ReservationStatus`：「同一逐件实物同一时刻最多一条 active；**数量件累计不得超过可用量**」。

**这是硬边界漏洞，不是小缺口** —— 装机店卖数量件是常态。

---

## 2. 改了什么

### 契约（4 个源文件，改完已重新生成）

| 文件 | 改动 |
|---|---|
| `objects.json` | `QuoteVersion.fields.lines` 补 `desc`：写明报价行元素结构与 `productRef` 语义（草稿可空、成交前必有）；`StockBalance.tables` 由 `[]` 改为 `["stock_balances"]`（0007 已建实表，此前误挂在未建表清单里 —— T05a 加表登记时漏删，校验器「有表**或**有缺口登记」的宽松判定掩盖了它） |
| `actions.json` | B03 的 `inputs` 补 `lineProductMap`；`result` 措辞改准（**本动作不写预留**，R07「未付款不预留」优先于旧措辞「现货预留」）；`notes` 补两条说明 |
| `legacy-mapping.json` | `StockBalance` 移出 `objectsWithoutLegacyTable`；登记 `stock_reservations__v15`（重建过渡表）与 0015 到 `sources`；`revisionNote` 记录本次 |

### 迁移

`backend/migrations/0015_quote_line_ref_and_quantity_reservation.sql`

1. `quote_lines` 加 `product_ref TEXT` + 索引（引用 `hardware.entity_id`，与 E04b 库存、E07 采购同一口径）；
2. 重建 `stock_reservations`：`stock_item_id` 改可空、新增 `quantity_bucket_ref`，
   `CHECK` 要求二者**恰有其一**（逐件行 qty 必须为 1）；
   `qty` 保留 `DEFAULT 1`（逐件既有写法不给 qty，去掉默认值会打断既有代码 —— 实测踩到过）；
   唯一索引改为只约束逐件行：`WHERE status='active' AND stock_item_id IS NOT NULL`。

### 后端

| 文件 | 改动 |
|---|---|
| `domains/quote.ts` | `insertLineStatement` 补 `product_ref` 列并 bind（**这一句就是洞①的修复**）；详情读取带 `productRef`；`QuoteDetailLine` 补字段 |
| `domains/sale.ts` | `resolveLineProducts` 重写（new 行按 `product_ref` → `hardware.entity_id` 解析，并取回 `tracking_mode` / 商品名）；转单**必须映射**：解析不出就整次拒绝（不再静默降级成缺口），支持 `lineProductMap` 补映射且只写 `sale_lines`、不回头改已发出的报价版本；`loadQuantityCandidates` + `planReserveOrder` 数量件占用分支；缺口改为「行数量 − 已锁数量」；`orderNoFor` 改用全串稳定哈希（见下） |
| `routes/sales-v2.ts` | `parseLineProductMap` + 接进 `parseConvertInput` |

**数量件占用的关键设计**：写一条 `available → reserved` 的库存流水（`stock_item_id = NULL`），
由 0007 的触发器落到 `stock_balances`，`CHECK (available_qty >= 0)` 兜底超卖；
再写一条带 `quantity_bucket_ref` 的占用记录（条件化 SQL：流水真的插进去了才有这条）。
**与逐件的关键差别在抢不到时怎么办**：

- 逐件实物是「那一台没了」⇒ 整批失败，必须让用户知道（`STOCK_CONFLICT`）；
- 数量件同型号可替换 ⇒ 少占、差额进缺口去采购，**不该把整单卡住**。

### 前端

| 文件 | 改动 |
|---|---|
| `WorkbenchQuotePage.tsx` | 新品行补「关联商品」输入（`datalist` 带现货数量，值即 `hardware.entity_id`）；行草稿与载荷带 `productRef`；详情回填 |
| `WorkbenchSalesPage.tsx` | 缺口文案改为「待补 N 项，共 M 件」（含解释：数字是行数量 − 已锁住的）；补分配下拉显示待补件数；实物列区分「按数量已锁 N 件」与「未指定实物（缺件）」 |
| `quote-api.ts` | 新增 `fetchProductOptions()`；`QuoteLineView` 补 `productRef`；re-export `InventoryProductRow` |
| `sales-api.ts` | 详情类型同步（`reservations` 的 `lineRef` / `quantityBucketRef` / `qty`，`shortage` 的 `qty` / `reservedQty` / `shortageQty`） |

---

## 3. 顺手撞出来的 E06 遗留缺陷（本卡一并修了）

写「两单抢同一批数量件」的验收用例时，第二单转单失败并报「报价没有通过转单校验」。
查 `operation_failures.diagnostic` 才看到真因：

```
UNIQUE constraint failed: sale_orders.store_id, sale_orders.order_no
```

**订单号派生撞号**。原实现：

```ts
const suffix = requestId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()
```

只取 requestId 去掉非字母数字后的**前 8 个字符** ⇒ 任何「公共前缀 + 顺序编号」的 requestId
（真实业务里的 `req-20260921-001` / `-002`，或测试里的 `...-a-conv` / `...-b-conv`）前 8 位完全相同，
**订单号必然相撞**，撞上 `UNIQUE (store_id, order_no)` 就整单失败。

**更糟的是提示**：这个约束错误被 `constraintCodes` 映射成 `VALIDATION_ERROR`，
而路由的 `guidanceFor` 又把 `VALIDATION_ERROR` 换成通用话术 —— 用户看到的是
「报价没有通过转单校验」，被引去查报价状态，方向完全错。

**修法**：`orderNoFor` 改为对**整个** requestId 求 32 位稳定哈希（FNV-1a + 雪崩混合）再取 8 位 hex：

- 无状态：同一 requestId 永远同一单号，幂等重放不换号；
- 覆盖全串：前缀相同的 requestId 散到不同单号；
- 仍由 `UNIQUE (store_id, order_no)` 兜底 —— 哈希只是把碰撞概率降下来，不是取消约束。

⚠️ 哈希必须 `>>> 0` 转无符号：`^=` 的结果是有符号 32 位，为负时 `toString(16)` 会带 `-`，
订单号变成 `SO-20260921--7687B199`（实测踩到）。

---

## 4. 证据

### 后端用例（208 通过 / 0 失败；上一版基线 201）

E06 新增 7 条（文件内 16 → 23）：

| 用例 | 断言什么 |
|---|---|
| 新品行没选商品 → 明确拒绝 | 400 + `VALIDATION_ERROR` + 提示含「还没选商品」；**不留下半张销售单** |
| 新品行选了商品 → `product_id` 落地 | `sale_lines.product_id` = 商品主键；缺口按「有商品但没实物」算 |
| 转单时用 `lineProductMap` 补映射 | 成功；且**报价版本不被回头改写**（`product_ref` 仍为 NULL） |
| 数量件：付定金后锁住库存 | 未付款时 `reserved_qty = 0`；付款后 `available 5→3`、`reserved 2`、占用记录带 `quantity_bucket_ref='store'` |
| 数量件：库存不够只锁能锁的 | 要 3 件、库里 1 件 ⇒ 锁 1 件、`shortageQty = 2`（采购别买多） |
| 数量件：确认后再补分配不重复占用 | 再确认被拒（状态非草稿）；走补分配 `reservedQty = 0`，余额不变 |
| 放行证据：两单抢同一批数量件 | A 锁 2、B 锁 1，**两单都 confirmed**；3 件全锁走、可用归零 |
| 回归：公共前缀顺序 requestId 不撞订单号 | 两个订单号不同且匹配 `^SO-\d{8}-[0-9A-F]{8}$` |

E07 13 条未动、全部通过。

### 其它检查

- 前端 13 文件 **152** 用例通过；`build` 通过；lint **39 项既有失败、本轮新增 0**。
- 契约：`validate-contracts.mjs` **3309 通过 / 0 失败**；`generate-dto --check`、`sync-contracts --check`、
  `check-client-parity`、`sync-error-codes --check`、`check-doc-links` 全绿。
- 浏览器验收（截图均已实际查看）：**E06 32 项 / E07 14 项，0 失败**。
  见 [E06 报告](../2026-09-21-E06/README.md) 与 [E07 报告](../2026-09-21-E07/README.md)。

### 界面上实际看到的

订单详情顶部：「确认成交 SO-20260921-00626DD4，占用 1 件实物、**2 件数量库存**」；
数量件行的实物列：「**按数量已锁 2 件**」；缺口条：「待补 1 项，**共 1 件**：验收用新品散热器 ×1」。

---

## 5. 未完成 / 未验证

1. **未验证**：未跑微信开发者工具、未访问生产、未部署、**未应用任何远端迁移**（0004–0015 远端状态仍未核实）。
2. **未验证**：数量件的并发只测了「同进程顺序提交」（A 先 B 后），未做跨实例压测。
   设计上并发是安全的（条件化 SQL + `CHECK (available_qty >= 0)` 兜底），但没有实测证据。
3. **未做**：`tracking_mode = 'item'` 的新品行如果没指定实物，确认成交时**不占数量、也不失败**，进缺口等补分配。
   这是有意的（逐件型号必须逐台指），但没有在界面上引导用户「这行要补分配具体实物」。
4. **未做**：数量件占用的**释放**（取消订单 / 退定金）属 E09，本卡不涉及。
5. **遗留**：`actions.json` B03 的 `effects` 仍列着 `Reservation`（已加 `notes` 说明它只表示「占用意向」，实际写入在 B05）。
   要彻底改掉这个字段属契约语义变更，留待后续与栋哥确认。
6. **遗留**：`guidanceFor` 会把 `VALIDATION_ERROR` 换成通用话术，**具体原因被吃掉**（本卡就是靠
   `operation_failures.diagnostic` 才查出订单号撞号的）。用户侧看不到真因，排查要靠查表。

## 6. 下一动作

- 候选：E08 装机交付与零售（B04/B06/B07/B10）—— E06 的 `sale_lines.stock_item_id` 与
  E07 到货建出的 `stock_items.acquisition_ref` 正好是它的输入。
- 备选：E09 取消退款与销售账本（到账款的正确性由它兜底）。
- 亦可将本条 §5.6（错误提示吞掉真因）单独开一小卡收拾。
