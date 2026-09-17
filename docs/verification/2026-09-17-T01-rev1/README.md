# T01-rev1 · 更正状态机缺口登记（Purchase / ReturnRecord）

日期：2026-09-17
状态：**本地通过**
依据：[04 §2 数据对象与最低字段](../../plans/2026-09-17-web-wechat-plan/04-data-and-api.md)、[04 §3 读取接口](../../plans/2026-09-17-web-wechat-plan/04-data-and-api.md)、[03 §4 库存与采购](../../plans/2026-09-17-web-wechat-plan/03-domain-rules.md)、[03 §7 资金与毛利](../../plans/2026-09-17-web-wechat-plan/03-domain-rules.md)、[05 T06b](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md)、[06 A11](../../plans/2026-09-17-web-wechat-plan/06-acceptance-and-handoff.md)

本次修订只更新 `contracts/` 内容，未修改业务代码、未新增迁移、未部署、**未接触生产数据**。

---

## 0. 起因：上一轮的一个误判

T01b 结束时，我向项目负责人报告「`Purchase` 和 `ReturnRecord` 连状态字段都没有 —— **T01a 对象层的遗漏**」，并询问是否单独补一次修订。负责人授权由我判断并执行。

**复核后结论：那两条登记的理由不成立，是我的误判。** 逐条给证据。

### 0.1 Purchase —— 不需要存储状态，在途是派生值

原登记的断言是「没有状态就无法表达在途与部分到货」。这句话经不起核对：

| 证据 | 原文 |
|---|---|
| 03 §4 | 采购单数量 = 已合格入库 + 已拒收 / 取消数量 + **尚待到货**数量 |
| 04 §3 | `GET /inventory/purchases` 返回「采购、实到、**在途**、拒收 / 取消」 |
| 05 T06b | 「采购 5 到 3 **显示在途 2**，不能整单勾完」 |
| 06 A11 | 「采购 5 实到 3，重试本次入库，在库只增 3，**在途余 2**」 |

即在途 = `orderedQty − receivedQty − cancelledQty`，**由三个计数器派生**，05 与 06 的验收口径本身就是这么算的。

更关键的是 04 §2 的「最低业务字段」列**本来就没有状态字段**（该行字段为 supplierRef、purchaseLines、orderedQty、receivedQty、cancelledQty、receiptLines、unitCostCents、inspectionDisposition、expectedAt）。设计意图清楚：**用计数器 + 恒等式表达进度，而不是再存一个可能与计数器漂移的状态**。

顺带证伪另一个我先前的怀疑：`receiptLines` / `unitCostCents` / `inspectionDisposition` 三个字段**没有丢**。04 §2 把 `Purchase / Receipt` 列为一行，T01a 把它拆成两个对象、字段分置，这三个字段落在 `Receipt` 上（见 `objects.json` 的 `Receipt.fields`）。字段覆盖检查（本次新增的校验）逐行证实：**缺失字段 0 个**。

### 0.2 ReturnRecord —— 不是转录遗漏，是规格留白

04 §2 该行的原文是：

| 最低业务字段 | 约束 / 关系 |
|---|---|
| originalOrderId、lineAllocations、stockItemIds、reason、acceptedQty、creditCents、refundEntryRef | 实物接收 / 贷项 / 现金退款**各有状态与引用** |

「约束 / 关系」列说了「各有状态与引用」，但**同一行的「最低业务字段」列没有任何状态字段**。所以这不是「T01a 漏抄」，而是规格只写了结论、没写承载方式。

已核实的承载：

| 事实 | 状态承载 | 引用字段 | 依据 |
|---|---|---|---|
| 实物接收 | `StockItem.availability` 与库存桶（收货后进待检，不自动可卖） | `stockItemIds` | 03 §4、03 §7 |
| 现金退款 | `Refund` 单据（独立对象） | `refundEntryRef` | 字段存在 + 03 §7「现金退款可稍后」 |
| 贷项 | **未定义** | `creditCents` / `lineAllocations` | 03 §7 只给计算口径，未给状态取值 |

**贷项这一问仍然答不了**，本次不编造取值，留为未决项交 T11a。

### 0.3 这次误判暴露的流程问题

T01b 登记缺口时，我**凭印象写了结论，没有把规格原文行号钉下来**。这正是栋哥的规则里「区分事实、推断和假设，不把未验证的判断当结论」要防的。本次加了两道机器检查堵这个口子 —— 见第 4 节。

---

## 1. 文件范围

| 类型 | 路径 | 说明 |
|---|---|---|
| 更新 | `contracts/v1/actions.json` | 重写 `stateMachineGaps`：Purchase 移出 gaps；ReturnRecord 重述；全部条目补 `specBasis` 与 `origin`；新增 `originValues`；`notAGap` 改为结构化；补 `revisions` |
| 更新 | `contracts/v1/objects.json` | `Purchase` 增 `derivedFields` / `notStored` / `revision`；`ReturnRecord` 增 `factMapping` / `notStored` / `revision`；补 `revisions` |
| 更新 | `contracts/tools/validate-contracts.mjs` | 新增第 11 节：缺口依据核验 + 04 §2 字段覆盖 |
| 更新 | `contracts/README.md` | 修订历史与已知缺口表 |
| 新增 | `docs/verification/2026-09-17-T01-rev1/README.md` | 本文件 |
| 只读 | `docs/plans/.../02、03、04、05、06`、`backend/src/index.ts` | 事实核对依据 |

**改动范围受控**：diff 为 145 行增量（actions.json 138 / objects.json 55），全部落在 `stateMachineGaps` 段、两个对象条目与文件尾 `revisions`，未溢出到其他字段或动作。

---

## 2. 契约内容变更

### 2.1 Purchase 增派生态（`objects.json`）

```json
"derivedFields": [
  { "name": "pendingQty", "label": "在途 / 尚待到货",
    "formula": "orderedQty - receivedQty - cancelledQty", "basis": "03 §4；04 §3" },
  { "name": "receiptProgress", "label": "部分到货判定",
    "formula": "receivedQty > 0 且 pendingQty > 0 → 部分到货；…", "basis": "05 T06b；06 A11" }
]
```

并附 `notStored` 说明：**本对象不设 status / state 字段是规格的有意设计**，存储状态会与计数器形成第二真相来源并允许漂移。这条写进契约，是为了让接手 T06a 的人不会再生造一个状态字段。

### 2.2 ReturnRecord 增事实映射（`objects.json`）

`factMapping` 把三条独立事实分别映射到承载对象与引用字段，其中「贷项」明确标注 `verdict: 未决`。`notStored` 说明为何不合并为单一总状态（03 §7「退货实物可待检，现金退款可稍后；二者独立」）。

### 2.3 `stateMachineGaps` 重写（`actions.json`）

| 变更 | 内容 |
|---|---|
| gaps 数量 | 9 → **8**（Purchase 移出） |
| Purchase | 移入 `notAGap`，附 `reclassifiedFrom` 说明与 4 条 `specBasis` |
| ReturnRecord | `severity` high → medium；`missing` 改为「单一条 status 字段（规格表述待澄清，非转录遗漏）」；`origin` 改为 `spec-undefined` |
| `origin` 分类 | 新增 `originValues`：`spec-undefined`（方案没写）/ `spec-partial`（已给取值、未给转换）。8 条中 6 条 `spec-undefined`、2 条 `spec-partial`（Reservation、Operation） |
| `specBasis` | 每条缺口 1–2 条，`notAGap` 各条 0–4 条，**合计 15 条**，全部为「文件 + 行号 + 原文字符串」 |
| `notAGap` | 由字符串数组改为结构化对象（`claim` / `reason` / `specBasis`） |

**更正后的分类结论**：8 条缺口**全部是「规格未定义」，没有一条是「T01a 转录遗漏」**。Reservation 与 Operation 的取值规格已给（`active/released/consumed`、`pending/succeeded/failed`），仅缺转换守卫。

---

## 3. 版本处置

`conventions.compatibility.versioning` 规定「契约变更必须提升 contractVersion 并新增版本目录；已冻结文件不原地改写」。本次的实际处置与理由：

- 本次**未变更任何规范性表面** —— 字段名、类型、枚举取值、动作编号、错误码全部不变，新增的 `derivedFields` / `factMapping` / `notStored` / `specBasis` / `originValues` 均为非规范性注解。
- 因此**不提升 contractVersion**，改为在原文件内留 `revisions` 记录 + 本验证记录 + `contracts/README.md` 修订历史（与 T01b 处理 `legacy-mapping.json` 的方式一致）。
- ⚠️ **此判断属治理决策，须项目负责人裁定。** 若要求严格按字面执行，应改建 `contracts/v2/` 并同步校验脚本中的 `contractVersion` 断言。

---

## 4. 验证

### 4.1 命令与结果

```
node contracts/tools/validate-contracts.mjs
```

| 项 | 结果 |
|---|---|
| 通过 | **2005 项**（T01b 为 1911；新增 94 项） |
| 缺口依据核验 | 15 条 |
| 规格 §2 字段覆盖 | 24 行 |
| 退出码 | 0 |

### 4.2 新增的两道防线（校验脚本第 11 节）

**11.1 缺口依据核验** —— 每条 `stateMachineGaps` 条目与 `notAGap` 条目的 `specBasis` 必须：文件存在、行号在文件范围内、**引文字符串逐字出现在该行**。凡不能给出可核对原文者，不得登记为缺口。

**11.2 规格字段覆盖** —— 逐行解析 04 §2 的「数据对象与最低字段」表格，与本契约对象字段做双向核对；复合行（`Purchase / Receipt` 等 6 行）按两对象的**并集**比对。

这两项正是本次误判的根因防线：**如果 T01b 当时就有 11.1，那条「没有状态就无法表达在途」的断言会因为在 04 §2 找不到支撑原文而无法登记。**

### 4.3 负向测试（证明闸门有效）

全绿不等于闸门有效，故注入三类错误验证：

| 注入 | 预期 | 实测 |
|---|---|---|
| 把 Reservation 的 `specBasis` 引文改成不存在的文字 | 报错 | ✗ `引文出现在该行 —— 该行未找到「这段引文不存在于原文」` |
| 把 `origin` 改成 `bogus-origin` | 报错 | ✗ `origin 在取值表内 —— origin=bogus-origin` |
| 从 `Purchase` 删掉 `orderedQty` | 报错 | ✗ `04 §2「Purchase / Receipt」最低字段已全部落到 objects.json —— 缺 orderedqty` |

三项全部被精确报出，退出码 1。随后从备份恢复并复验为 2005 项通过、退出码 0。

### 4.4 一次执行事故与处置

改造脚本首次运行时输出了 `SyntaxError`（末尾多一个逗号产生 `],}`），且**在报错前已写坏 `actions.json`**。处置：从运行前备份 `cp` 还原，修正脚本后重跑。

另有一次操作失误：对 `validate-contracts.mjs` 的两处修改**并行提交导致后写覆盖先写**（统计输出行丢失）。已串行补回并复验。**教训：同一文件的编辑必须串行。**

---

## 5. 未做与未验证

- **未运行前端 test / build / lint** —— 本卡不涉及前端代码。
- **未核实生产 D1** —— `permissions` 表行内容（Q04）、0004/0005 是否已应用（Q01）仍未核实，仍挂在 T20。
- **未补任何转换守卫** —— 8 条缺口的取值与转换仍未定义，本次只补齐分类与依据，不编造。
- **ReturnRecord 的「贷项状态」仍未决** —— 须 T11a 实现 B17 / B18 前确认。
- **T01c（样本 + DTO 生成）未开始**，T01 整卡仍未通过；06 文档的 7 个样本与资金算例尚未逐项核算。

---

## 6. 下一步

1. **T01c** —— 契约范围最后一张子卡（虚构样本、边界输入、预期结果、DTO 生成配置）。
2. 项目负责人裁定：本次是否按「原地修订」处置，或须提升 `contractVersion` 并改建 `v2/`。
3. T11a 开工前确认「贷项」是否需要独立状态。
4. Q01 / Q04（生产 D1 现状）随 T20 一次性核实。
