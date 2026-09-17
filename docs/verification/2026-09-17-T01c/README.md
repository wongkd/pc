# T01c · 虚构样本、金额算例与 DTO 生成

日期：2026-09-17
状态：**本地通过** —— T01 的三张子卡（T01a / T01b / T01c）至此全部完成，可汇总判定
提交：`a2b88f7`（本卡全部产出）
依据：[05-implementation-tasks.md · T01c](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md#t01--冻结契约与样本)、[06 §2 固定虚构样本](../../plans/2026-09-17-web-wechat-plan/06-acceptance-and-handoff.md)、[03 §7 金额与折返](../../plans/2026-09-17-web-wechat-plan/03-domain-rules.md)、[04 §3/§4/§9](../../plans/2026-09-17-web-wechat-plan/04-data-and-api.md)

本卡只新增与更新 `contracts/` 目录内容与本文档。未修改任何业务代码、未新增迁移、未部署、**未接触生产数据**、未建立小程序项目。

---

## 0. 本卡开始前的三个决定

### 0.1 为什么不做「共享 TypeScript 包」

T01c 要求「明确 DTO 如何让网页和原生小程序消费同一版本」。最省事的做法是建一个共享 TS 包，两端都依赖它。**本卡否决了这个做法**：

- 网页是 React + Vite，小程序是原生 TS 编译，两者的模块解析、基础库与构建链不同。
- 让小程序去消费一个为 Vite 优化的包，要么被构建链拒绝，要么得在小程序里再塞一层构建 —— 这正是 AGENTS.md 禁止的「为小改动引入整套依赖」。
- 共享包还会制造第二个「谁改了什么」的真相来源。

改为**单向生成**：`contracts/v1` 是唯一来源，`node contracts/tools/generate-dto.mjs` 把枚举与类型编译到 `contracts/generated/`，两端在各自任务卡里引用同一份产物。同一版本、同一取值、零手写副本。

### 0.2 生成物落地在哪

`frontend/src/` 与尚未建立的小程序目录都**不在本卡范围内**（05 T01c 限定范围为 `contracts/`、相关 README、方案勘误）。因此本卡只产出中立生成物到 `contracts/generated/`，端内目录（`frontend/src/contracts/generated`、`miniprogram/contracts/generated`）由 T02a / T02b 建立后接入。这是 `openItems` F04。

### 0.3 「能逐项核算」怎么变成证据

05 T01c 的通过条件写的是「所有 7 个首页样本和资金算例能逐项核算」。在文档里声称「已核对」不是证据 —— T01-rev1 已经吃过一次亏（凭印象登记缺口，引文对不上原文）。

所以本卡把两个要求都做成**机械重算**：

| 要求 | 落地方式 |
|---|---|
| 7 个首页样本能逐项核算 | 校验脚本按样本字段重算 metrics（交付 2 / 缺货 2 / 维修 2 / 待收 12,800 元 / 总数 7）与每条样本的金额恒等式 |
| 资金算例能逐项核算 | 校验脚本按 `money-rules.json` 的 9 条公式重算 12 组算例的 15 个阶段，`null` 结果必须附原因 |
| 生成文件不手改 | 校验脚本调用生成器重建产物、逐字节比对，并核验清单里的源文件 sha256 |

---

## 1. 本卡文件范围

| 类型 | 路径 | 说明 |
|---|---|---|
| 新增 | `contracts/v1/fixtures.json` | V1–V4 样本、边界输入、12 组金额算例、4 个行为算例、子结构定义、DTO 生成配置、5 项未决项 |
| 新增 | `contracts/tools/generate-dto.mjs` | 端内 DTO 生成器；导出 `buildArtifacts()` 供校验脚本复用，带 `--check` |
| 新增 | `contracts/generated/*` | 生成物：`enums.ts` / `objects.ts` / `actions.ts` / `errors.ts` / `money.ts` / `manifest.json` |
| 更新 | `contracts/tools/validate-contracts.mjs` | 新增第 12 节 |
| 更新 | `contracts/README.md` | 收录 fixtures、生成流程、第 12 节的检查与负向测试记录 |
| 新增 | `docs/verification/2026-09-17-T01c/README.md` | 本文件 |
| 只读 | `docs/plans/.../02、03、04、05、06`、`contracts/v1/*.json` | 事实核对依据 |

未递归扫描 `node_modules/`、`backups/`、历史截图。**未运行前端 test / build / lint** —— 本卡不涉及任何前端或后端代码。

---

## 2. 交付内容

### 2.1 V1 · 视觉与工作台读取样本

7 条任务严格覆盖 `objects.json` 的 `TaskReadModel` 全部 16 个字段（由脚本双向比对，多一个少一个都失败）：

| entityId | category | entityType | 关键事实 |
|---|---|---|---|
| DEMO-SO-003 陈先生 | delivery | sale_order | 检查 2/3、附件未打包 → 主动作 B10 **禁用**并给阻断码 |
| DEMO-SO-002 林女士 | stock_shortage | sale_order | 缺 SSD 1 件 |
| DEMO-RE-008 周先生 | service | service_order | 未定收费 → 金额字段全 null，不得用 0 冒充 |
| DEMO-SO-011 赵先生 | delivery | sale_order | 已结清 → 余额 0、方向 settled |
| DEMO-RE-006 刘女士 | service | service_order | 初估 480 元，**不计确定应收** |
| DEMO-SO-009 吴先生 | stock_shortage | sale_order | 显示器在途 |
| DEMO-TR-001 刘先生 | recovery | recovery_order | 客户所有，不计库存 / 折抵 |

脚本重算结果与 06 §2 的期望值逐项一致：

```
待交机 2 / 缺货订单 2 / 维修待办 2 / 待办总数 7
待收款 = 4280 + 6280 + 2240 = 12,800 元 = 1280000 分
维修初估 480、回收初估 1,500 均不计入待收（脚本逐条核对 countsTowardReceivable=false）
```

**修复编码任务卡**：06 §2 写「回收 · DEMO-TR-001」，但 `EntityType` 枚举里没有「回收」之外的独立类；本卡定为 `recovery_order`（`trade_in` 是置换单），并据此写 `detailTarget: /recovery/DEMO-TR-001`。同时 `TaskCategory` 里 recovery 只有一个取值，与 06 的「回收 1」对上。

### 2.2 V2 · 二手循环

U-017 的收购 800 元 + 可归属整备 80 元 = **880 元**，由脚本重算：

```
assetCostCents = acquisitionCostCents(80000) + Σ capitalizable(8000) = 88000
不可归属的 3000 分只作为费用记录，不进成本（capitalizable=false 被单独核掉）
```

另外把两处容易漏的规则做成了机械检查：`source: "used"` 的行**必须**带 `stockItemId`；`source: "customer"` 的行售价**必须**为 0。

### 2.3 12 组金额算例（15 个阶段）

覆盖 03 §7 的五个置换算例、后段退货算例，以及 06 §2 V3 要求的新增边界：

| 算例 | 口径 | 核算结果 |
|---|---|---|
| TC-01 置换·正常 | `offsetAmountCents` | 折抵 1,500；收 4,500 |
| TC-02 置换·已付定金 500 | 同上 | 折抵 1,500；再收 4,000 |
| TC-03 置换·旧机更贵 | 同上 | 折抵 6,000；付客户 1,000 |
| TC-04 置换·定金后旧机更贵 | 同上 | 折抵 5,500；付客户 1,500 |
| TC-05 置换·未验机 | null 传播 | 剩余应付 **null**（不是 0）；折抵不允许结清 |
| TC-06 成交 1,000 / 已收 1,000 / 贷项 300 | 两阶段 | 余额 −300 → 退款 300 → 余额 0；库存进 quarantine 且 `autoSellable=false` |
| TC-07 有预收取消未交付单 | 两阶段 | 占用 released、应退 500、**不自动现金退款**；净应计口径登记为未决项 |
| TC-08 U-017 成本 | 实物成本 | 880 元 |
| TC-09 优惠 300 分 / 3 行 | 整除 | 50 / 100 / 150 |
| TC-10 优惠 100 分 / 3 行 | 余 2 分 | 17 / 33 / 50，余分顺序 L3 → L1 |
| TC-11 优惠 1 分 / 3 行 | 余 1 分 | 0 / 0 / 1 |
| TC-12 原行 100 元 3 件部分退货 | 按件分摊 | 退 1 件 3,333；退 3 件 10,000 = 原行净额上限 |

**优惠分摊改为整数运算**。规格原文写「按各行折前金额占比分配到分，先向下取整，余分按最大余数、再按稳定行 ID 分配」。直接写浮点会踩精度（`100 × 299999 / 599999` 这类结果在小数第 6 位才分得出余数大小）。本卡改成整数形式：行分子 = `discountCents × grossCents`，分母 = `ΣgrossCents`，`floor` = 整数商，`remainder` = 取模。TC-10 的余数因此精确可验：400016 / 200033 / **599949**，顺序唯一确定。

**null 不是 0**。TC-05 的 `finalAcquisitionCents` 为 null（未取得所有权、最终价未定），依赖它的 `recoveryPayableRemainingCents` 与 `offsetAmountCents` 必须也是 null 且写明原因 —— 这三条由脚本强制。TC-07 取消后的净应计口径规格没写，本卡**不编**：只冻结可核实部分（现金未变、应退 500、占用释放），其余取 null 并登记 `openItems` F01。

### 2.4 4 个行为算例 + 17 条边界输入

行为算例：同 `requestId` 同载荷重发 3 次、同 ID 改载荷、两端同时收最后 100 元、条件 UPDATE 影响 0 行。每条都带 `specBasis`（文件 + 行号 + 逐字引文），由脚本按 T01-rev1 的同一套规则核验引文确实存在于该行 —— 拿不出原文的登记一律失败。

边界输入 17 条覆盖 06 §2 V4 的全部项目：长客户名 / 40 字设备名 / 30 行配置 / 长 SN / 空照片 / 图片失效 / 未知成本 / 金额 128,000.50 / 零价服务 / 320px 屏 / 字体放大 / 店员无成本权限 / 跨店 ID / 登录过期 / 两端同时改同一单 / 离线 / 写成功后丢响应。每条都钉了规格原文行号（例如未知成本钉 `03-domain-rules.md:181`「存在未知成本的批次用待核实标志，不能估成零。」）。

### 2.5 DTO 生成与「不手改」的强制方式

`contracts/tools/generate-dto.mjs` 从 `contracts/v1` 的 6 个 JSON 生成：

| 生成物 | 来源 | 内容 |
|---|---|---|
| `enums.ts` | `enums.json` | 39 个枚举的 `as const` 对象与联合类型、5 个状态机转换表、库存桶规则、待补枚举名 |
| `objects.ts` | `objects.json` | 31 个对象的 interface、`CommonFields` / `EventFields`；`nullable` 字段加 `| null` |
| `actions.ts` | `actions.json` | 动作码 → 路径 / 权限、页面 → 动作、49 个权限码、字段级权限单列 |
| `errors.ts` | `errors.json` | 16 个错误码常量与 HTTP 状态 |
| `money.ts` | `money-rules.json`、`conventions.json` | 9 条公式编号与单位口径（**不含计算实现**） |
| `manifest.json` | 全部 6 个源文件 | contractVersion、源文件 sha256、生成物 sha256、目标端目录 |

「不手改」不靠约定，靠两条机械防线：每个文件首行是 `// AUTO-GENERATED FROM contracts/v1 — DO NOT EDIT`；校验脚本第 12.9 节**调用生成器重新生成一遍**，与磁盘文件逐字节比对，并核验 `manifest.json` 里记的源文件 sha256 是否还等于源文件实际内容。改一个字就失败。

生成是确定性的（无时间戳、键序固定），`--check` 复跑幂等。

### 2.6 5 项未决项（不当成已完成）

| ID | 问题 | 归属 |
|---|---|---|
| F01 | 取消未交付单时原确认成交额经哪个口径退出销售净应计 | T08a |
| F02 | 回收未取得所有权时 `recoveryPayableRemainingCents` 的表示（null 还是另有约定） | T14a |
| F03 | `amountSummary` / `primaryAction` 子结构是否升为 `objects.json` 的规范性定义 | 项目负责人 |
| F04 | 生成物落地到端内目录的方式 | T02a / T02b |
| F05 | V1 样本的列表排序是否在本卡冻结 | T18 |

其中 F03 需要单独说明：`objects.json` 把 `TaskReadModel.amountSummary` 与 `primaryAction` 声明为 `object` 类型、**结构未由契约固定**。生成 DTO 必须知道结构，所以本卡在 `fixtures.json` 的 `shapeDefinitions` 里首次给出了定义。这是**新增的规范性内容**，本卡不敢擅自往已冻结文件里写，故留在自己的文件里并登记待裁定。

---

## 3. 验证证据

### 3.1 命令与结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 契约自洽性 | `node contracts/tools/validate-contracts.mjs` | ✅ **退出码 0，通过 3047 项，0 失败** |
| 生成物幂等 | `node contracts/tools/generate-dto.mjs --check` | ✅ 退出码 0，6 个文件一致 |
| 闸门负向测试 | 注入 4 类错误后重跑 | ✅ **4 项均被精确报出，退出码 1**；注入已回滚并复验 |

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
缺口依据核验 15 条 / 规格 §2 字段覆盖 24 行
虚构样本 7 条 / 金额算例 12 个（15 阶段）/ 行为算例 4 个 / 边界输入 17 条
DTO 生成物 6 个（已逐字节比对，哈希一致）
────────────────────────────────────────────────────────────────
通过 3047 项

提示 7 项（不阻断）：
  · 状态机 QuoteStatus 的 issued → expired 未绑定动作编号：超过 validUntil
  · 状态机 QuoteStatus 的 draft → closed 未绑定动作编号：未在本方案中明确，实现前须补
  · 状态机 QuoteStatus 的 issued → closed 未绑定动作编号：未在本方案中明确，实现前须补
  · 状态机 SaleTradeState 的 confirmed → closed 未绑定动作编号：03 未明确 closed 进入条件，实现前须补契约
  · 状态机 ServiceState 的 returned → closed 未绑定动作编号：未在本方案中明确，实现前须补
  · 新增老板专属权限码 13 个，T03 装配默认角色时不得自动授予：sales/order-credit-approval、sales/refund、inventory/opening、inventory/count-approve、inventory/damage、recovery/acquire、tradein/offset、tradein/reverse、finance/ledger-view、finance/payment、finance/reverse、document/export、auth/binding-code
  · 已登记状态机缺口 8 项（不影响本次校验结论，须由对应任务卡补全）

✓ 全部检查通过：契约文件彼此自洽，且与迁移文件中的实际表结构一致。
```

通过项从 T01-rev1 的 2005 增至 3047（新增 1042 项，全部来自第 12 节）。

### 3.2 新增的检查项（脚本第 12 节）

| 检查 | 抓什么 |
|---|---|
| V1 每条样本的字段集合与 `TaskReadModel` **双向**一致 | 样本缺字段或多出契约里没有的字段 |
| V1 的 `entityType` / `category` / `photoKind` / `balanceDirection` 合法性 | 样本里写了枚举里没有的取值 |
| `balanceCents = totalCents − receivedCents − offsetCents` | 样本金额自己算不平 |
| metrics 逐项重算（交付 / 缺货 / 维修 / 待收 / 总数，含类别计数之和） | **汇总数字与样本对不上** |
| `countsTowardReceivable=false` 时余额字段必须为 null | 用初估冒充确定应收 |
| 12 组算例按 `money-rules.json` 公式逐阶段重算 | 文档里的金额与公式结果不一致 |
| 结果为 null 时必须附原因 | 用 null 掩盖没想清楚的口径 |
| 优惠分摊用整数运算复算余分顺序与合计 | 浮点精度导致的余分分配不稳 |
| 部分退货贷项累计不超原行净额 | 超退 |
| 置换算例不得同时「收」与「付」 | 折抵取 min，两端不可能同时为正 |
| 行为算例与边界输入的 `specBasis` 逐条核验引文 | 编造或过期的依据（复用 T01-rev1 的同一套规则） |
| 生成物与重新生成的结果逐字节一致 + 源文件 sha256 核验 | **手工编辑生成物** |
| `moneyFormulaContract` 的口径项对应到真实公式 | 自造一个不在 `money-rules.json` 里的口径项 |

### 3.3 闸门有效性的负向测试

脚本通过不等于闸门有效。本卡注入四类错误复验（注入过程未提交）：

**注入 1 · 手改生成物**（把 `enums.ts` 里 `ACTIVE: "active"` 改成 `"activeX"`）

```
失败 1 项：
  ✗ 生成物 enums.ts 与契约一致（未手改） —— 内容与重新生成的结果不同 —— 生成物禁止手工编辑，请改契约源文件后重新生成
退出码 1
```

**注入 2 · 改一个算例的期望金额**（TC-01 本次现金 450000 → 450001）

```
失败 1 项：
  ✗ TC-01-TRADEIN-NORMAL/s1 本次现金收可重算 —— 450001 ≠ 450000
退出码 1
```

**注入 3 · 抽掉一条 V1 样本**（删掉 DEMO-SO-011，metrics 不动）

```
失败 6 项：
  ✗ V1 任务数为 7 —— 实际 6
  ✗ V1 待交机数可重算 —— 声明 2 / 重算 1
  ✗ V1 类别 delivery 计数可重算 —— 声明 2 / 重算 1
  ✗ V1 类别计数之和等于待办总数 —— 7 ≠ 6
  …
退出码 1
```

**注入 4 · 删掉算例的空值原因**（去掉 TC-05 的 `nullReasons`）

```
失败 4 项：
  ✗ TC-05-TRADEIN-UNINSPECTED/s1 的 recoveryPayableRemainingCents 为 null 时必须写明原因 —— 缺 nullReasons
  ✗ TC-05-TRADEIN-UNINSPECTED/s1 的 offsetAmountCents 为 null 时必须写明原因 —— 缺 nullReasons
  …
退出码 1
```

四次注入后均从备份恢复，重跑确认回到 3047 项通过、退出码 0。**临时备份目录已删除**，注入未提交。

### 3.4 本卡的实现过程本身也暴露过自己的错

写脚本时犯了一个真实的口径 bug：`salesBalanceCents` 的依赖检查误把「公式结果」当「输入项」判断，导致三个阶段的余额全部被算成 null。第 12 节把它全报了出来（12 项连锁失败）。这恰好说明重算不是走过场 —— 如果只靠肉眼核对，这个错会被当成「算例写错了」。

另有一处必须留痕：本卡在改 `fixtures.json` 时**又犯了一次并行 Edit 同一文件的错**（工作记忆里已记录过两次），导致 TC-10 的修改被同一批次的另一处编辑覆盖，多花了一轮排查。已在编辑流程上改为同文件严格串行。

### 3.5 通过的判定

| 卡片条件（05 T01c） | 状态 |
|---|---|
| 建立 06 的虚构样本、边界输入和预期结果 | ✅ V1 七条样本 + 17 条边界输入 + 12 组金额算例 + 4 个行为算例 |
| 明确 DTO 如何让网页和原生小程序消费同一版本，生成文件不手改 | ✅ 单向生成 + `manifest.json` 源文件哈希 + 脚本逐字节比对强制 |
| 前后端字段、金额单位一致 | ✅ 样本字段由脚本与 `objects.json` 双向比对；金额单位由脚本核验后缀与整数性 |
| `used` / `customer` / `service` 来源一致 | ✅ V2 逐行核验：`used` 必带实物 ID、`customer` 售价必须为 0 |
| 所有 7 个首页样本和资金算例能逐项核算 | ✅ 7 条样本与 12 组算例全部由脚本重算，与写法逐项一致 |

**T01c 判定为「本地通过」。**

---

## 4. 未完成 / 阻断

| 项 | 原因 | 影响 |
|---|---|---|
| 生成物接入端内目录 | 本卡范围限定 `contracts/`，小程序项目未建立 | F04，由 T02a / T02b 承接 |
| `amountSummary` / `primaryAction` 是否为规范性定义 | 需改已冻结的 `objects.json` | F03 待负责人裁定；不影响 T02 开工 |
| 取消未交付单的净应计口径 | 规格未定义 | F01 → T08a |
| 回收未取得所有权时的剩余应付表示 | 规格未定义，本卡按 `conventions.nullable` 取 null 属推断 | F02 → T14a |
| V1 样本的列表排序 | 06 §2 的表格顺序不是排序结果 | F05 → T18 |
| **8 项状态机缺口** | T01-rev1 已登记，本卡未动 | 对应任务卡实现前必须补 |

**未验证的部分要说清楚**：本卡验证的是**契约与样本的算术自洽性**。它不能证明任何业务逻辑在真实 D1 上行为正确 —— 幂等、并发、权限装配、交付闸门一律未验证，属 T03 / T04 及后续业务卡范围。

---

## 5. T01 整卡汇总判定

| 子卡 | 内容 | 判定 |
|---|---|---|
| T01a | 约定、枚举、对象、错误码、金额规则、旧表映射 + 校验脚本 | 本地通过 |
| T01b | 动作目录 B01–B36、49 个权限码、旧权限映射、缺口登记 | 本地通过 |
| T01-rev1 | 更正缺口登记，全部条目钉规格原文 | 本地通过 |
| T01c | V1–V4 样本、金额算例、边界输入、DTO 生成 | 本地通过 |

**T01 整卡判定为「本地通过」**：05 T01 的四条通过条件（冻结契约、按钮都能找到动作、旧权限映射、样本与算例逐项核算）全部满足，由 `node contracts/tools/validate-contracts.mjs` 退出码 0 支撑。

⚠️ 仍待负责人裁定的治理项（都不阻塞 T02）：

1. T01-rev1 是否该提版（结论是「未变更规范性表面」，未提版）；
2. T01c 的 `shapeDefinitions` 是否该进 `objects.json` 的规范性表面（F03）。

---

## 6. 下一步

按 05 的执行顺序，T01 之后是 **T02（双端壳与共享视觉）**：

- T02a 建立网页端目录与接入点，把 `contracts/generated/` 接进 `frontend/src/contracts/generated`；T02b 建立小程序项目后接同一份产物。
- 两者都必须引用生成物，**不得在端内另写一份枚举或类型**。

T03（身份与绑定）与 T04（一致性与幂等）可并行启动，依赖均已就绪：T03 可直接用 `actions.json` 的 13 个 `owner_only` 权限码（校验脚本每次运行都会提示不得默认授予）；T04 可用本卡的 4 个行为算例作为测试用例来源。

**在此之前建议先做一次修订决定**：`objects.json` 是否为 `amountSummary` / `primaryAction` 补上结构定义（F03）、以及是否把 T01-rev1 与 T01c 的非规范性追加提为 `v2`。两项都不阻塞 T02 的壳与视觉，但会影响后续生成物的稳定性。
