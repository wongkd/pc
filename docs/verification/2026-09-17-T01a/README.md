# T01a · 冻结协议、字段与旧表映射

日期：2026-09-17
状态：**本地通过**（T01b、T01c 未开始；T01 整卡尚未通过）
依据：[05-implementation-tasks.md · T01](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md#t01--冻结契约与样本)、[03 业务规则](../../plans/2026-09-17-web-wechat-plan/03-domain-rules.md)、[04 数据与接口](../../plans/2026-09-17-web-wechat-plan/04-data-and-api.md)

本卡只新增 `contracts/` 目录与契约文件，未修改任何业务代码、未新增迁移、未部署、未接触生产数据。

---

## 1. 本卡文件范围

| 类型 | 路径 | 说明 |
|---|---|---|
| 新增 | `contracts/README.md` | 目录职责、校验方式、变更流程、已知缺口 |
| 新增 | `contracts/v1/conventions.json` | ID / 金额 / 数量 / 时间 / nullable / 分页 / 信封 / 写入 / 兼容 |
| 新增 | `contracts/v1/enums.json` | 39 个枚举、5 个状态机、库存桶转换、待补枚举清单 |
| 新增 | `contracts/v1/objects.json` | 31 个对象、243 个字段、待办读模型、工作台指标口径 |
| 新增 | `contracts/v1/errors.json` | 16 个错误码与结果未知处理流程 |
| 新增 | `contracts/v1/money-rules.json` | 9 条金额公式、冲销策略、分摊与成本规则 |
| 新增 | `contracts/v1/legacy-mapping.json` | 21 张旧表映射、保留的数据库机制、单位换算、未决问题 |
| 新增 | `contracts/tools/validate-contracts.mjs` | 静态自洽性校验脚本 |
| 新增 | `docs/verification/2026-09-17-T01a/README.md` | 本文件 |
| 只读 | `backend/migrations/0000`–`0005`、`backend/src/index.ts`、`frontend/src/erpNavigation.ts` | 现状核对依据 |

未递归扫描 `node_modules/`、`backups/`、历史截图。

---

## 2. 交付内容

### 2.1 约定层（`conventions.json`）

冻结了 04 §1、§3 要求的通用规则，并在三处做了收紧而非照抄：

| 项 | 冻结结果 |
|---|---|
| ID | 协议层一律 string 且不透明；客户端不得解析主键或假设递增 |
| 金额 | 整数分、禁止浮点；未知成本必须 `null` + `costKnown=false`，不得用 0 代替 |
| 时间 | 瞬时存 UTC（带 Z），业务日固定 Asia/Shanghai 00:00–24:00；禁止 `datetime('now','localtime')` 参与业务判定 |
| nullable | 每个字段显式声明；空字符串与 unknown 区分 |
| 分页 | cursor，默认 20 上限 100；响应回显 filters；工作台读数须在同一快照形成 |
| 兼容 | 旧元→分由专用适配器处理；旧 `duration` 类旁路入口对 v2 单据必须禁止 |
| 禁止清单 | 负库存、自动质保、自动超收、把人工登记称为平台到账、用前端状态伪装成功 |

### 2.2 枚举与状态机（`enums.json`）

39 个枚举、191 个取值。五个状态机（报价、销售交易、销售履约、回收、维修）共 37 条转换，每条标注守卫条件与动作编号；另有库存桶的 9 条转换，把 03 §4 的「可卖 / 已订 / 待处理互斥」等规则写成机器可读形式。

**未自创枚举**：盘点状态、报损原因、采购取消原因、价格调整原因、置换单状态在 04 §2 中没有对象承载，未凭猜测定义，改为登记在 `pendingEnums`，由 T06c / T01b / T14 补齐。

### 2.3 对象层（`objects.json`）

依据 04 §2，把原本合并书写的 `Quote / QuoteVersion`、`Purchase / Receipt`、`Checklist / TestRecord`、`DeviceConfiguration / Change`、`Return / Refund`、`WechatIdentity / Session` 拆为独立对象，合计 31 个（含 `TaskReadModel`）。`TaskReadModel` 额外冻结了 03 §2 的排序规则与「卡点优先」约束，`workbenchMetrics` 冻结了五项指标的官方口径与点击目标。

### 2.4 旧表映射（`legacy-mapping.json`）

21 张表全部映射，两处核对结果改变了后续任务的假设：

**发现 1 · `library` 表在代码中零引用。** `backend/src/index.ts` 全文没有任何 SQL 读写 `library` 表；`library` 只作为权限码（`library/view`、`library/edit`）和路由名（`/api/library`）出现，实际读写目标是 `hardware`。两张表在 0000 中结构几乎完全重复。本卡标记为 `deprecated` + `unverified`，**未删除**，是否有历史数据留待 T20 核实。

**发现 2 · `quotes` 表是单行工作副本，没有版本序列。** `handleQuote` 始终执行 `SELECT ... ORDER BY updated_at DESC LIMIT 1`，随后 `UPDATE` 同一行。这意味着现有报价只保留最新一份，**历史客户版本可能已经不存在**。因此不能把旧行直接当作 `QuoteVersion` 序列，T07 的版本模型必须先核实 `data` blob 的实际结构。

**发现 3 · 权限码与实际守卫资源不一致。** `library/*` 守卫的是 hardware 商品接口，`quote/*` 同时守卫报价与订单。T01b 做旧权限 → 新 action 映射时必须以实际守卫资源为准，不能按权限码字面名推断。

其余高风险项均已具名登记：`orders` 无 version 列、`order_items` 无 source 列（新品/二手/客供/服务无法区分）、`order_payments` 无 requestId 与 reversalOf（幂等缺口）、`serial_numbers.purchase_cost_cents` 默认 0 无法区分「免费」与「未知」。

同时登记了 5 个保留的数据库机制（2 个订单触发器、3 个唯一索引/硬化触发器）及其**局限**：防超收触发器不等于幂等，同载荷重复提交仍可能形成两笔。

---

## 3. 验证证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 契约自洽性 | `node contracts/tools/validate-contracts.mjs` | ✅ **退出码 0，通过 1423 项，0 失败** |

执行环境：本机 Node v22.22.2（managed），工作目录 `C:\Users\wuerl\Documents\工作同步\pc-quote`。

原始输出：

```
契约自洽性校验 · contractVersion v1
────────────────────────────────────────────────────────────────
枚举 39 个 / 取值 191 项
对象 31 个 / 字段 243 个（其中枚举引用 39 个）
状态机 5 个 / 转换 37 条
库存桶转换 9 条
错误码 16 个
金额公式 9 条
旧表映射 21 张 / 迁移实际表 21 张
────────────────────────────────────────────────────────────────
通过 1423 项

提示 5 项（不阻断）：
  · 状态机 QuoteStatus 的 issued → expired 未绑定动作编号：超过 validUntil
  · 状态机 QuoteStatus 的 draft → closed 未绑定动作编号：未在本方案中明确，实现前须补
  · 状态机 QuoteStatus 的 issued → closed 未绑定动作编号：未在本方案中明确，实现前须补
  · 状态机 SaleTradeState 的 confirmed → closed 未绑定动作编号：03 未明确 closed 进入条件，实现前须补契约
  · 状态机 ServiceState 的 returned → closed 未绑定动作编号：未在本方案中明确，实现前须补

✓ 全部检查通过：契约文件彼此自洽，且与迁移文件中的实际表结构一致。
```

校验的有效性说明：脚本不是只做 JSON 语法检查。它反向解析 `backend/migrations/*.sql` 提取真实表名（21 张），与 `legacy-mapping.json` 的映射清单**双向比对**；并把金额公式引用的每个 `对象.字段` 回查 `objects.json`。因此「映射漏表」「公式引用不存在的字段」「枚举引用拼错」都会被判失败。

### 3.1 通过的判定

| 卡片条件 | 状态 |
|---|---|
| 03 的枚举 / 状态 / 金额规则、04 的最低字段与错误码整理为机器可校验的协议 | ✅ 六份 JSON + 校验脚本，1423 项通过 |
| 确定 ID、nullable、日期、分页和兼容策略 | ✅ 见 `conventions.json` |
| 完成旧表 → 新模型映射 | ✅ 21 张表逐张映射，含单位换算与风险标记 |
| 前后端字段、金额单位、used / customer / service 来源一致 | ✅ 三来源在 `LineSource` 单一定义，金额字段全部 `Cents` 结尾且类型受校验 |

**T01a 判定为「本地通过」。** T01 整卡不通过——T01b（动作与权限）与 T01c（样本与 DTO）尚未开始，因此 7 个首页样本与资金算例的逐项核算**未执行**。

---

## 4. 未完成 / 阻断

| 项 | 原因 | 影响 |
|---|---|---|
| 动作目录与请求响应（T01b） | 本卡按规格只领一张子卡 | 两端暂时无法引用具体路径；T02 依赖此项 |
| 旧权限 → 新 action 映射（T01b） | 同上；另需先核实 `permissions` 表实际内容（Q04） | T03 权限实现受阻 |
| 虚构样本与 DTO 生成（T01c） | 同上 | 06 §2 的 7 个样本与资金算例尚未逐项核算 |
| `closed` / `expired` 进入条件 | 03 与 04 均未定义 | 校验脚本列为提示；对应业务卡实现前必须补 |
| 5 个待补枚举 | 04 §2 无承载对象 | 登记在 `pendingEnums`，不阻塞 T02 |
| 生产迁移实际状态（0004 / 0005） | 本机无 D1 访问权限 | 见 `openQuestions` Q01，T20 核实 |
| `library` 表数据与 `quotes.data` 结构 | 需要数据访问 | Q02 / Q03，分别由 T20 / T07 核实 |

---

## 5. 下一步

**T01b（动作目录、请求响应、旧权限映射）** 可以立即开始：依据 04 §5 的 B01–B36，产出 `contracts/v1/actions.json`，并完成 11 个旧权限码 → 新 action 的映射。前置已满足（本卡已冻结枚举与字段名）。

T01b 开工前建议先解决 Q04：核实 `permissions` 表的实际行内容，否则权限映射可能基于不存在的权限码。

T01c 在 T01b 之后执行，届时补齐 06 §2 的 V1–V4 样本、资金算例核算与 DTO 生成流程，T01 整卡才能汇总判定。
