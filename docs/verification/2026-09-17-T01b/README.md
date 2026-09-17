# T01b · 冻结动作目录、请求响应与旧权限映射

日期：2026-09-17
状态：**本地通过**（T01c 未开始；T01 整卡尚未通过）
依据：[05-implementation-tasks.md · T01](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md#t01--冻结契约与样本)、[04 §3–§5、§8](../../plans/2026-09-17-web-wechat-plan/04-data-and-api.md)、[03 §8 权限默认表](../../plans/2026-09-17-web-wechat-plan/03-domain-rules.md)、[02 §5 各业务页动作](../../plans/2026-09-17-web-wechat-plan/02-ui-specification.md)

本卡只新增与更新 `contracts/` 目录内容，未修改任何业务代码、未新增迁移、未部署、**未接触生产数据**。

---

## 0. 本卡开始前的一个决定

T01a 的验证记录建议「T01b 开工前先核实 `permissions` 表的实际行内容（Q04）」。本卡**决定不核实、不接触生产 D1**，理由：

1. 权限映射的依据应该是**代码实际守卫了什么资源**，这个依据已经可用且可复核（`requirePermission` 的调用点与参数）。
2. 生产表行内容只影响「旧门店实际授予了谁」，不影响「新系统需要哪些权限码」这个目标态设计。
3. 核实生产 D1 需要凭据与明确授权，是外部依赖；为它卡住主线不划算。

处置：把 Q04 的 owner 从 T01b 改为 T20，用途缩小为「迁移时确认旧门店授权现状」，并在 `legacy-mapping.json` 中以 `revisionNote` 留下修订痕迹。**该决定不等于风险消失** —— 见第 4 节。

---

## 1. 本卡文件范围

| 类型 | 路径 | 说明 |
|---|---|---|
| 新增 | `contracts/v1/actions.json` | 动作目录、权限模型、旧权限映射、状态机缺口登记 |
| 更新 | `contracts/tools/validate-contracts.mjs` | 新增第 10 节，覆盖动作、权限与按钮映射 |
| 更新 | `contracts/README.md` | 收录 `actions.json`，补权限模型要点与已知缺口 |
| 更新 | `contracts/v1/legacy-mapping.json` | 仅更新 Q04 的 owner 与 resolution，并加 `revisionNote` |
| 新增 | `docs/verification/2026-09-17-T01b/README.md` | 本文件 |
| 只读 | `backend/src/index.ts`、`docs/plans/.../02、03、04、05` | 事实核对依据 |

未递归扫描 `node_modules/`、`backups/`、历史截图。未运行前端 test / build / lint —— 本卡不涉及前端代码。

---

## 2. 交付内容

### 2.1 动作目录（B01–B36）

36 个动作编号全部冻结，每个含方法、业务路径、必填业务输入、服务端结果、关联对象、状态机、权限码、可能错误码与 UI 来源。

**一个编号多条路径的处理**：04 §5 里 B02、B05、B16、B21、B24、B25、B27、B30、B31、B35 都带两个路径，且**部分两路径的权限不同**。本卡把每个动作统一写成 `operations[]` 数组，每项独立声明 `method` / `path` / `permission`。最典型的是 B16 盘点：录入归 `inventory/count`（店员可做），批准差异归 `inventory/count-approve`（老板专属）。若按「一个编号一个权限」处理，这里必然出错。

路径统一规则已固化：业务路径 + `conventions.api.prefix`（`/api/v2`）。

### 2.2 权限模型（49 个权限码）

| 项 | 结果 |
|---|---|
| 规模 | 49 个码，分 sales / inventory / service / recovery / tradein / finance / platform 七域 |
| 命名 | `域/动作`，沿用旧 `resource/verb` 形态 |
| 语义一致的旧码 | `store/manage`、`member/manage`、`role/view` **不改名**，避免制造无意义的迁移工作 |
| `grantPolicy` | `default` 默认可授予；`explicit` 须老板单独勾选（对应 03 §8「登记收款、入库、交付…单独授权」）；`owner_only` 仅老板 |
| 字段级权限 | `inventory/cost-view`、`inventory/margin-view` 标记 `level: "field"`，**不守卫动作** |

关于最后一条：核对 `backend/src/index.ts` 第 159、505 行确认，`cost/view` 与 `margin/view` 从不作为路由守卫出现，只决定响应里是否返回成本 / 毛利字段。若把字段权限当成按钮权限，会把「能看成本」误判为「能改库存」。本卡显式区分了 `level: action | field`。

### 2.3 旧权限 → 新 action 映射

11 个旧权限码全部映射，**依据是实际守卫资源，不是权限码字面名**。每条映射都带 `evidence`（`backend/src/index.ts` 的行号）与 `doesNotGrant` 清单。

四条关键核对结果：

| 旧权限 | 字面含义 | 实际守卫 | 映射结果 |
|---|---|---|---|
| `library/view` | 硬件库查看 | **商品主数据、分类品牌、hardware、SN** | 4 个 inventory 读码 |
| `library/edit` | 硬件库编辑 | 上述四处的写接口 | 10 个 inventory 写码，**排除**期初、盘差批准、报损 |
| `quote/view` | 报价查看 | **报价 + 订单 + 待办** | 6 个跨域读码，**排除**完整账本 |
| `quote/edit` | 报价编辑 | 报价与订单的全部写接口 | 8 个具名码，**排除**退款、折抵、最终价、付款、冲销、收款、交付 |

**`noWidening` 是本卡最重要的约束**：03 §8 明确「不让旧宽权限自动获得退款能力」。`quote/edit` 是旧系统最大宽权限，本卡把它拆成 8 个具名权限，退款（`sales/refund`）、欠款放行、回收最终价、折抵、付款、冲销一律不给，全部标 `grantPolicy: owner_only` 且 `legacySource: null`。

映射覆盖度由脚本**反向**保证：脚本从 `backend/src/index.ts` 提取所有 `'resource/verb'` 字面量（11 个），要求每一个都在映射表里；反向也要求映射表不含源码中不存在的权限码。

### 2.4 补充动作、auth 与读接口

| 分区 | 内容 | 状态 |
|---|---|---|
| `supplementaryActions` | B37 采购取消、B38 退供、B39 报损、B40 价格调整、B41 售后收款 | B37–B39 `reserved`（路径留空，由 T06a / T06c 补）；B40 **阻塞**（归属任务未指定）；B41 路径已由 04 §5 给出，标 `specified` |
| `authActions` | A01 微信登录/绑定、A02 生成绑定码、A03 登出、A04 读取身份 | 路径来自 04 §8 拟定接口，标 `specified`，owner T03a，须现场复核官方参数 |
| `readActions` | R01–R14，覆盖 04 §3 全部读接口 | 含 `/workbench`、`/search` 等 03 §8 行 1 的基础能力 |

保留动作一律 `path: null`，并由脚本强制；这防止「先写个通用 PUT status 凑合」的做法。

### 2.5 发现：9 项状态机缺口（含 T01a 的两处对象遗漏）

这是本卡核对时**意外挖出的问题，比动作本身更值得注意**。

做法：对 36 个动作做反向检查 —— 统计哪些动作的编号未被 `enums.json` 任何状态机转换引用，再逐个对象的 `status` / `state` / `uploadState` 字段核对是否有对应状态机。结果 9 项缺口：

| 对象 | 缺口 | 影响动作 | 归属 |
|---|---|---|---|
| `Purchase` | **连 status 字段都没有** | B14 / B15 / B37 / B38 | T06a |
| `ReturnRecord` | **连 status 字段都没有** | B17 / B18 | T11a |
| `Reservation` | 有 status，无状态机 | B03 / B05 / B10 / B11 | T08a |
| `Offset` | 有 state，无状态机 | B31 / B32 | T14a |
| `Attachment` | 有 uploadState，无状态机 | B35 | T16a |
| `Operation` | 取值已定（pending/succeeded/failed），转换未定 | B36 / B08 / B10 / B15 | T04a |
| `CashEntry` | 有 verificationState，无状态机 | B08 / B18 / B33 / B34 | T09a |
| `Product` | 有 status，无状态机 | B12 | T05a |
| `QuoteVersion` | 有 status，无状态机 | B02 / B03 | T07a |

前两项是 **T01a 对象层的遗漏**：04 §2 明确要求退货的「实物接收 / 贷项 / 现金退款各有状态与引用」，`ReturnRecord` 却没有任何状态字段；采购同理，03 §7 已经写了采购数量恒等式（采购量 = 已合格入库 + 已拒收/取消 + 尚待到货），没有状态就无法表达在途与部分到货。

**本卡不自行补这些状态机**：03 §3–§7 没有对应原文，硬编转换守卫会污染契约，并让后续任务把假设当地基。改为在 `actions.json` 的 `stateMachineGaps` 中逐项登记（含影响动作、归属任务、`origin: T01a 对象层遗漏 / 状态机遗漏`），校验脚本只报告数量、不计入失败项 —— 避免把「已登记的已知缺口」误判成「契约不一致」。

---

## 3. 验证证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 契约自洽性 | `node contracts/tools/validate-contracts.mjs` | ✅ **退出码 0，通过 1911 项，0 失败** |
| 闸门负向测试 | 注入 2 个错误后重跑 | ✅ **2 项失败均被精确报出，退出码 1**；注入已回滚并复验 |

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
通过 1911 项

提示 7 项（不阻断）：
  · 状态机 QuoteStatus 的 issued → expired 未绑定动作编号：超过 validUntil
  · 状态机 QuoteStatus 的 draft → closed 未绑定动作编号：未在本方案中明确，实现前须补
  · 状态机 QuoteStatus 的 issued → closed 未绑定动作编号：未在本方案中明确，实现前须补
  · 状态机 SaleTradeState 的 confirmed → closed 未绑定动作编号：03 未明确 closed 进入条件，实现前须补契约
  · 状态机 ServiceState 的 returned → closed 未绑定动作编号：未在本方案中明确，实现前须补
  · 新增老板专属权限码 13 个，T03 装配默认角色时不得自动授予：sales/order-credit-approval、sales/refund、inventory/opening、inventory/count-approve、inventory/damage、recovery/acquire、tradein/offset、tradein/reverse、finance/ledger-view、finance/payment、finance/reverse、document/export、auth/binding-code
  · 已登记状态机缺口 9 项（不影响本次校验结论，须由对应任务卡补全）

✓ 全部检查通过：契约文件彼此自洽，且与迁移文件中的实际表结构一致。
```

通过项从 T01a 的 1423 增至 1911（新增 488 项，全部来自第 10 节）。

### 3.1 新增的检查项（脚本第 10 节）

| 检查 | 抓什么 |
|---|---|
| 动作编号与 `ActionCode` 枚举**双向**一致 | 枚举里加了编号没写动作定义，或写了动作定义没登记枚举 |
| `owner_only` 不得继承店员可得的旧权限 | **退款、折抵、报损等能力被旧宽权限下放** |
| 动作的 permission / entity / stateMachine / errors 引用 | 悬空引用 |
| 解析 `02-ui-specification.md` §5 页面清单，检查每页至少映射一个动作 | **按钮找不到动作** |
| 从 `backend/src/index.ts` 提取旧权限码，与映射表双向比对 | 映射漏码或多出不存在的码 |
| 逐条核对映射 `evidence` 的行号真实存在、且该行确实涉及权限判断 | 编造或过期的证据行号 |
| 保留动作的 `path` 必须为 `null` | 用通用 PUT 绕过业务的取暖做法 |
| 缺口登记的对象与影响动作真实存在 | 缺口清单本身写错 |

### 3.2 闸门有效性的负向测试

脚本通过不等于闸门有效。本卡注入了两个错误复验：

```bash
# 注入 1：把 sales/refund 伪装成继承自旧宽权限 quote/edit
# 注入 2：抽掉「盘点」页面的动作归属（B16 的 uiRefs 置空）
```

脚本输出：

```
失败 2 项：
  ✗ noWidening：owner_only 权限不得继承店员可得的旧权限 —— sales/refund←quote/edit
  ✗ 页面「盘点」至少映射一个动作 —— noWidening 之外的空缺同样不可接受
```

两个错误都被精确抓住且信息可读，退出码 1。随后从备份恢复原文件，重跑确认回到 1911 项通过、退出码 0。**注入过程未提交**。

这次负向测试还纠正了一处自身设计缺陷：`noWidening` 最初写成「`owner_only` 不得有 `legacySource`」，结果把 `store/manage`、`member/manage`、`role/view` 判为违规 —— 而这三个旧码在 03 §8 里**本来就是老板专属**，沿用不放宽。真正的违规是「店员可得的旧权限 → 新的老板专属权限」这条边。据此补了 `permissionModel.legacyPermissions.clerkGrantable` 显式清单，规则才可机检。

### 3.3 通过的判定

| 卡片条件 | 状态 |
|---|---|
| 冻结 B01–B36 的具体请求响应 | ✅ 36 个动作全部含方法、路径、输入、结果、对象、状态机、错误码 |
| 确保每个正式按钮都能找到动作 | ✅ 02 §5 的 18 个页面全部至少映射一个动作，由脚本强制 |
| 定义旧权限 → 新 action 的映射 | ✅ 11 个旧码全部映射，带源码行号证据与 `doesNotGrant` 清单 |
| 补充动作不被绕过 | ✅ B37–B41 已登记；保留动作强制 `path: null` |

**T01b 判定为「本地通过」。** T01 整卡不通过 —— T01c（样本与 DTO 生成）尚未开始，06 §2 的 7 个样本与资金算例**仍未逐项核算**。

---

## 4. 未完成 / 阻断

| 项 | 原因 | 影响 |
|---|---|---|
| 虚构样本与 DTO 生成（T01c） | 本卡按规格只领一张子卡 | 06 §2 样本与资金算例未核算；T01 整卡不通过 |
| **9 项状态机缺口** | 03 §3–§7 无对应原文，本卡不编造 | 已登记；对应任务卡实现前必须补，详见 2.5 |
| **`Purchase`、`ReturnRecord` 缺状态字段** | T01a 对象层遗漏 | T06a / T11a 补，补时同步改 `objects.json` 并提 `contractVersion` |
| B40 价格调整归属未定 | 04 §5 只列名称，未指定任务卡与作用对象 | 保留 `reserved`，不预设路径 |
| 生产 `permissions` 表实际行内容 | 本卡决定不接触生产（见第 0 节） | Q04 移交 T20；映射本身不依赖它 |
| `closed` / `expired` 进入条件 | 方案未定义 | 校验脚本列为提示 |
| 生产迁移实际状态、`quotes.data` 结构、`library` 表数据 | 需数据访问 | Q01 / Q03 / Q02，分别由 T20 / T07 / T20 核实 |
| 模板权限是否需要独立码 | 03 §8 与 04 §5 均未单列 | 暂并入报价域，Q06 交 T07 |

**未验证的部分要说清楚**：本卡只做了静态契约与源码文本核对。动作在真实 D1 上的事务行为、幂等、并发、权限装配后的实际效果**一律未验证**，属 T04 与 T03 的范围。

---

## 5. 下一步

**T01c（样本与 DTO 生成）** 是 T01 的最后一张子卡：依据 06 §2 建立 V1–V4 虚构样本、边界输入与预期结果，并定义 DTO 生成流程（生成文件不手改）。完成后 T01 整卡才能汇总判定。

按 05 的执行顺序，T01 之后是 **T02（双端壳与共享视觉）**；T03（身份与绑定）与 T04（一致性与幂等）可并行启动，两者都已有本卡产出的动作与权限码可依赖。

建议在 T02 开工前把 **2.5 的两处对象层遗漏（`Purchase`、`ReturnRecord` 缺状态字段）** 提交给一次明确的修订决定 —— 它们不阻塞 T02 的壳与视觉，但会阻塞 T06a 与 T11a。
