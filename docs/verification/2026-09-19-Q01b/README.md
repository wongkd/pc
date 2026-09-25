# Q01b · 报价单数据模型落库（版本序列 / 逐行来源 / 分享凭证 / 定金与预算不建列）

日期：2026-09-19。状态：**本地通过**（迁移在真实 workerd + 真实 D1 上跑通，17 条新用例全过，全套 87 条 0 失败）。

前置：[Q01 第一刀](../2026-09-19-Q01/README.md)（顾客报价原型，179 项断言）。
任务卡：Q01 第二刀 · 后端数据模型（栋哥 2026-09-19 裁定「先做后端数据模型」）。
同批：[T04](../2026-09-17-T04/README.md)（约束即断言的写法来源）、[T05a](../2026-09-18-T05a/README.md)（期初/物化模式参考）。

---

## 1 · 这张卡做了什么

Q01 原型把「顾客看自己专属配置单并付款」的界面行为走通了，但线上后端里**没有报价单这个东西**：

- 契约 v1 早就定义了 `Quote` / `QuoteVersion`，而线上 `orders` 表比契约落后一整代（有 `total_amount_cents`，没有 `quote_version_id` / `discount_cents` / `trade_state` / `balance_cents`）。
- 旧的 `quotes` 表（0000）是 `title TEXT + data TEXT` 的**单份工作副本**，没有任何版本序列概念，装不下「改价必须出新版本、顾客付款前必须核验最新版」这两条已确认的业务规则。

**一句话：把「报价单有版本、行有来源、分享有凭证」这三件事从原型里的界面行为，变成库里拦得住的约束。**

---

## 2 · 实际改动

| 文件 | 状态 | 职责 |
|---|---|---|
| `backend/migrations/0009_quote_core.sql` | 新增 | 4 张表 + 1 个唯一索引 + 1 个部分唯一索引 + 2 个触发器 |
| `backend/tests/lib/quote.mjs` | 新增 | 报价单夹具：建环境、清表、播种 header / version / line |
| `backend/tests/q01-quote-core.test.mjs` | 新增 | 17 条用例 |

**未改**：`contracts/v1/**`（一个字没动，本卡不新增契约字段）、`backend/src/index.ts`（本卡只做数据模型，没有接路由）、0000–0008 任何迁移文件、两端前端。

### 2.1 四张表

| 表 | 主键 | 承载什么 |
|---|---|---|
| `quote_headers` | `id`（服务端生成的 TEXT） | 单号主体、`current_revision`、`version`（乐观锁） |
| `quote_versions` | `(quote_id, revision)` | 每版的价格快照、`status`、`discount_cents`、`terms_snapshot`、`issued_at` |
| `quote_lines` | `id` | 逐行 `source` / `qty` / `unit_price_cents` / `stock_item_id` / `warranty_snapshot` |
| `quote_shares` | `id` | 分享凭证的**摘要**、状态、有效期、撤销留痕 |

### 2.2 六条硬约束（都有对应用例）

| # | 约束 | 手段 |
|---|---|---|
| 1 | 同一 `(quote_id, revision)` 不可覆盖 | 主键 |
| 2 | `total = subtotal − discount`，且 `discount ≤ subtotal` | 两条 CHECK |
| 3 | `status` 与 `issued_at` 必须自洽（draft 无、非 draft 必有） | CHECK |
| 4 | 行小计恒等于单价 × 数量 | CHECK **+** 触发器（两层，各自独立有效） |
| 5 | 客供件单价必须为 0，且必须指出来源设备 | CHECK |
| 6 | 同一版本同时只能有一个有效分享凭证 | 部分唯一索引 `WHERE status = 'active'` |

---

## 3 · 关键判断（后续卡必须遵守）

### 3.1 定金比例与顾客预算进 `terms_snapshot`，不建列

栋哥 2026-09-19 裁定「先当门店参数，不进库」。执行前已按 `conventions.forbiddenInventing`（禁止发明契约外字段）逐项核验：

- `定金` 在契约里**只出现在置换样本中，且是已收金额，不是比例**；
- `预算` 在契约里**只出现在图片体积说明的注释中**，与顾客心理预算无关；
- `objects.json` 的 `QuoteVersion` 字段表里没有这两者。

⇒ 若直接加 `deposit_percent` / `budget_cents` 列，就是**用实现给契约加字段**，与 T05c 自我纠正过的 `acquiredAt` 是同一类错误。故落进 `terms_snapshot`，并用一条用例钉死「表里没有这些列，且改预算不动 `total_cents`」。

**将来若真要做按预算/定金的统计，必须先走契约修订（新增 `v1.x` / `v2` 目录），不能直接加列。**

### 3.2 顾客归属缺口：`customer_id` 不带外键（G-Q01-CUSTOMER）

`Quote.customerId` 在契约里有，但**契约与迁移里都没有 `customers` 表**（`Customer.tables = []`、`CustomerDevice.tables = []` 均为空）。初稿写了 `REFERENCES customers(id)`，核实后已删除并改为注释说明 —— 补一张顾客表属于另一个卡的数据建模范围，本卡无权代它决定。

同理，`quote_lines.customer_device_ref` 也只是 `TEXT`，不带外键。

### 3.3 「行小计恒等」是两层防护，不是一层

变异测试时把 CHECK 去掉，用例**仍然失败**。一度以为是断言失效，复查后确认是**触发器先拦下了**：

| 保留的层 | 结果 |
|---|---|
| 两层都在 | 被拦，`RAISE(ABORT, 'VALIDATION_ERROR')` |
| 只去掉触发器 | 被拦，`CHECK constraint failed: line_total_cents = unit_price_cents` |
| 只去掉 CHECK | 被拦，`VALIDATION_ERROR` |

```text
两层都在 · 错行被拦      -> 被拦: D1_ERROR: VALIDATION_ERROR: SQLITE_CONSTRAINT
两层都在 · 对行放行      -> 放行（插入成功）
只留触发器 · 错行被拦     -> 被拦: D1_ERROR: VALIDATION_ERROR: SQLITE_CONSTRAINT
只留CHECK · 错行被拦    -> 被拦: CHECK constraint failed: line_total_cents = unit_price_cents
只留CHECK · 对行放行    -> 放行（插入成功）
```

用例里已加断言 `triggers.length === 2`，将来删掉任一层都会直接报红 —— 否则这层防护被删了也没人知道。

### 4.1 变异测试：其余四条约束逐个开口验一遍

```text
PASS  客供件不得带价        | 原迁移拦截: 是 | 去掉该约束: 放行  -> 约束有效
PASS  同版本单一有效凭证      | 原迁移拦截: 是 | 去掉该约束: 放行  -> 约束有效
PASS  金额守恒             | 原迁移拦截: 是 | 去掉该约束: 放行  -> 约束有效
PASS  二手件数量为 1         | 原迁移拦截: 是 | 去掉该约束: 放行  -> 约束有效
```

做法：把每条约束单独从迁移里删掉再跑对应用例。**「放行」才说明约束真的在拦** —— 若删掉后仍被拦，说明这条断言其实靠别的机制兜着，属于「断言没受此约束保护」。
（`行小计恒等` 一栏初判为 FAIL，查实后确认是两层防护，见 §3.3。）

---

## 4 · 验证证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 迁移可应用 | 真实 workerd + 真实 D1 跑 0009 | ✅ **14 条语句**执行成功，4 张表、索引、2 个触发器全部建立 |
| 新用例 | `npm --prefix backend test` | ✅ 17/17 通过，退出码 0 |
| 全套回归 | `npm --prefix backend test` | ✅ **87/87 通过，0 失败**，退出码 0，耗时 154s |
| 旧表未被动 | 用例 2 | ✅ `quotes`(0000) / `orders`(0003) 仍在，且 `orders` 不含 `trade_state` 等新字段 |
| 约束真的会拦 | 变异测试（5 处） | ✅ 4 处开口后立刻被拦，1 处为两层防护（见 §3.3） |
| 页面取数不受影响 | — | 本卡未接路由，前端调用面未变 |

### 4.1 用例清单（17 条）

| # | 用例 |
|---|---|
| 1 | 迁移与结构：0009 的 4 张表、索引与触发器都已建立 |
| 2 | 旧表未被触碰：quotes(0000) 与 orders(0003) 仍在，且结构未变 |
| 3 | 版本不可覆盖：同一 (quote_id, revision) 不能插入两次 |
| 4 | 改价必须走新版本：revision 递增后两份版本各自保存当时的金额 |
| 5 | 金额守恒：total 必须等于 subtotal 减 discount |
| 6 | 状态与发出时间必须自洽 |
| 7 | 行小计不可能不等于单价×数量（CHECK + 触发器两层） |
| 8 | 客供件不允许带价，且必须指出来源设备 |
| 9 | 逐件跟踪的来源数量只能是 1 |
| 10 | 同一版本的同一行序不可重复 |
| 11 | 同一版本同时只能有一个有效分享凭证 |
| 12 | 撤销凭证必须留痕 |
| 13 | 凭证只存摘要：表里没有明文 token 列 |
| 14 | 报价单动产不了库存：插入版本与明细后预占表不变 |
| 15 | 定金比例与顾客预算在 terms_snapshot 里，不是独立列 |
| 16 | 可复现 Q01 原型那张样单：配件+服务−优惠=应付 |
| 17 | 服务端生成的 TEXT 主键：动作结果不依赖自增主键 |

### 4.2 测试计数口径（本次核实，避免以后再误判）

`npm test` 汇总行报 `# tests 87`，但 TAP 计划行是 `1..76`、`# Subtest:` 也是 76。**差的 11 条不是隐藏用例**：`t03a-identity.test.mjs` 用 `describe()` 把 12 条用例裹成一组，顶层计划项因此只算 1 —— 87 − 12 + 1 = 76。

**逐个测试文件的真实用例数（grep `test(` 得来）：**

| 文件 | 用例 |
|---|---|
| `q01-quote-core`（本卡新增） | 17 |
| `t03a-identity` | 12 |
| `t04a-consistency` | 8 |
| `t04b-zero-row-assertion` | 6 |
| `t04c-concurrency` | 7 |
| `t05a-inventory-query` | 9 |
| `t05a-inventory-schema` | 8 |
| `t05a-opening` | 11 |
| `t05a-product-write` | 9 |
| **合计** | **87** |

⚠️ **历史文档里「后端 58 用例」这个基线对不上任何一次实测**（T05b 引用过它、T05c §5 也引用过）。本卡是第一次逐个文件把数目点清，**以本表的 87 为准**；引用旧基线时要标注存疑。

---

## 5 · 未完成 / 阻断

| 项 | 说明 |
|---|---|
| **没有 HTTP 路由** | 0009 只是数据模型。`src/index.ts` 未接线，报价单现在**跑不到界面上**，也没有真实请求能触发它 |
| **G-Q01-CUSTOMER 未补** | 顾客表不存在，`customer_id` 无外键约束。补表属另一张卡，需裁定 |
| **分享凭证的签发与核验未实现** | 表只管存储与唯一性；token 怎么生成、怎么校验、过期怎么判定，属于服务端授权逻辑，依赖 T03a 的顾客身份 |
| **定金比例没有落点** | 现在只在 `terms_snapshot` 里；小程序端和小票上怎么显示、谁负责写入，「收款」那张卡才有答案 |
| **未部署** | 迁移**没有应用到任何远端**。生产 D1 的 0004/0005 是否已应用本身仍未核实（T-06） |
| **约定未确认** | `quote_versions.status` 的 `'converted'`（已转订单）在契约里没有对应的转移说明，属 G-01～G-10 范畴 |

---

## 6 · 下一步

1. **接路由**：把报价单的读写接到 `src/index.ts`，走 T04 的幂等 + 版本推进写法（这是 T03b 那套 `createWebApiClient` 能用的前提）。
2. **补 G-Q01-CUSTOMER**：顾客表怎么建、报价单归属怎么定，需负责人裁定后再动。
3. **分享凭证的服务端授权**：依赖 T03a 顾客身份。
