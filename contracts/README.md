# contracts · 跨端契约

日期：2026-09-17。状态：v1 已冻结（T01a、T01b 完成并经 T01-rev1 修订，T01c 补齐虚构样本与 DTO 生成流程，T02a 修生成器的类型导入并按契约落地网页端生成物）。入口：[方案总览](../docs/plans/2026-09-17-web-wechat-plan/README.md)。跨卡片未决项：[docs/OPEN-ITEMS.md](../docs/OPEN-ITEMS.md)。

本目录是电脑网页端与微信小程序共用的协议唯一来源。两端不得各自维护一份枚举、金额公式或错误码。

## 1. 目录职责

| 路径 | 内容 | 冻结卡 |
|---|---|---|
| `v1/conventions.json` | ID、金额、数量、时间、nullable、分页、响应信封、写入约定、兼容策略 | T01a |
| `v1/enums.json` | 全部枚举取值、五个状态机、库存桶转换、待补枚举清单 | T01a |
| `v1/objects.json` | 31 个对象的协议字段、类型、nullable、枚举引用、派生态与事实映射，以及待办读模型与工作台指标口径 | T01a（T01-rev1 修订） |
| `v1/errors.json` | 标准错误码、HTTP 状态、客户端处理、结果未知的处理流程 | T01a |
| `v1/money-rules.json` | 金额公式、冲销策略、优惠分摊、部分退货、成本与毛利 | T01a |
| `v1/legacy-mapping.json` | 旧表 → 新模型映射、保留的数据库机制、单位换算、未决问题 | T01a |
| `v1/actions.json` | B01–B36 动作目录、多路径操作的分别权限、49 个新权限码、11 个旧权限码映射、状态机缺口登记（含 `specBasis` 依据） | T01b（T01-rev1 修订） |
| `v1/fixtures.json` | 06 §2 的 V1–V4 虚构样本、边界输入、预期结果、可机械重算的金额算例、DTO 生成配置 | T01c |
| `generated/` | 由 `tools/generate-dto.mjs` 从 v1 单向生成的端内枚举与类型。**生成物禁止手工编辑** | T01c |
| `tools/validate-contracts.mjs` | 契约自洽性校验脚本 | T01a + T01b + T01-rev1 + T01c |
| `tools/generate-dto.mjs` | 端内 DTO 生成器（单向生成，带 `--check`） | T01c（T02a 修复未使用类型导入） |
| `frontend/scripts/sync-contracts.mjs` | 把生成物落到网页端内目录，并做「契约 → 中立生成物 → 端内」三方防漂移校验（不在本目录，属端内脚本） | T02a |

## 2. 校验方式

```bash
node contracts/tools/validate-contracts.mjs
```

脚本做静态检查与源码 / 规格文本核对，不连接数据库、不部署、不读生产数据。它会：

- 校验各文件 JSON 可解析、`contractVersion` 一致、冻结来源已声明；
- 校验每个字段的类型在约定集合内、枚举引用存在、金额字段以 `Cents` 结尾；
- 校验状态机与库存桶转换的取值都在对应枚举内、动作编号已登记；
- 校验金额公式与分摊规则引用的 `对象.字段` 真实存在于 `objects.json`；
- **反向读取 `backend/migrations/*.sql` 提取实际表名**，与旧表映射逐表双向比对，防止映射漏表或多列不存在的表；
- **反向读取 `backend/src/index.ts`**，检查旧权限映射是否覆盖了源码里实际出现的每一个权限码，并核对每条映射的 `evidence` 行号真实存在、且该行确实涉及权限判断；
- **校验动作编号与 `ActionCode` 枚举双向一致**、动作的 permission / entity / stateMachine / errors 引用都不悬空；
- **解析 `02-ui-specification.md` §5 的页面清单**，检查每个正式页面至少映射一个动作（防止按钮找不到动作）；
- **强制 `noWidening`**：`owner_only` 权限码不得继承「店员可得」的旧权限（`quote/edit`、`library/edit` 等），即旧宽权限不得自动获得退款、折抵、报损等能力；
- **校验每条状态机缺口的 `specBasis`**：文件存在、行号在文件范围内、引文字符串**逐字出现在该行**。拿不出可核对原文者不得登记为缺口（起因见 [T01-rev1 验证记录](../docs/verification/2026-09-17-T01-rev1/README.md)）；
- **解析 `04-data-and-api.md` §2「数据对象与最低字段」表格**，逐行与 `objects.json` 双向核对字段覆盖（复合行如 `Purchase / Receipt` 按两对象并集比对），防止对象字段漏抄；
- **机械重算 `fixtures.json`**：V1 的 7 条样本逐条核对 TaskReadModel 字段覆盖、枚举取值、金额恒等式与 metrics 汇总；12 组金额算例按 `money-rules.json` 的公式逐阶段重算，结果为 `null` 的必须写明原因；优惠分摊与部分退货用整数运算复算余分顺序与累计上限；
- **重建并逐字节比对生成物**：调用 `generate-dto.mjs` 重新生成，与 `contracts/generated/` 下的文件比对，并核对清单里的源文件哈希。手工编辑生成物会被直接判为失败。

退出码 0 表示通过，1 表示存在失败项。提示项不阻断，代表方案本身尚未定义的规则缺口。

校验闸门自身做过负向测试，改脚本后应照此复验：

- 注入「`sales/refund` 伪装继承 `quote/edit`」与「抽掉盘点页动作归属」→ T01b 已验；
- 注入「缺口 `specBasis` 引文不存在」「`origin` 不在取值表内」「删掉 `Purchase.orderedQty`」→ T01-rev1 已验，三项分别报出对应失败项；
- 注入「手改生成物一个字符」「改一个算例的期望金额」「抽掉一条 V1 样本」「删掉算例的空值原因」→ T01c 已验，四项分别报出对应失败项。

## 2.1 端内生成物与防漂移

生成物从 `contracts/v1` 单向生成，中立产物在 `contracts/generated/`，各端在**自己的任务卡**里落地一份消费副本（`fixtures.dtoGeneration.targets` 冻结了路径）。

```bash
node contracts/tools/generate-dto.mjs            # 重生成中立产物
node frontend/scripts/sync-contracts.mjs         # 落网页端内目录
node frontend/scripts/sync-contracts.mjs --check # 三方防漂移复验
```

`sync-contracts.mjs` 会自检「契约声明的 web 目标路径」与「脚本实际写入路径」是否一致（改路径必须先改契约），并做三方比对：**契约源文件 → 中立生成物 → 端内副本**。任何一方被手工改动都会报错。T02a 已用三种注入（手改端内生成物、改端内样本、改契约样本）验证闸门有效。

## 3. 变更流程

1. 已冻结文件**不原地改写**。需要变更时新增 `v1.x` 或 `v2` 目录并提升 `contractVersion`。
2. 新增枚举值、错误码、字段、动作编号，都必须先改本目录，再改两端实现。
3. 补充动作（采购取消、退供、报损、价格调整）已在 `actions.json` 的 `supplementaryActions` 中预留编号并标 `status: "reserved"`、`path: null`。对应任务补齐路径与载荷后改为 `frozen`，**不得由两端自行取名**，也不得用通用 `PUT status` 绕过业务。
4. 生成物（端内枚举与 DTO）由 `node contracts/tools/generate-dto.mjs` 从 v1 **单向生成**到 `contracts/generated/`，**生成文件不得手工编辑**。改契约源文件 → 重新生成 → `node contracts/tools/generate-dto.mjs --check` 复验。端内目录（`frontend/src/contracts/generated`、小程序同名目录）由 T02a / T02b 建立后接同一份产物。

## 4. 已知缺口（不要当成已完成）

| 项 | 状态 | 归属 |
|---|---|---|
| `closed` / `expired` 状态的进入条件 | 方案未定义，校验脚本列为提示 | 对应业务卡实现前补 |
| **状态机缺口 8 项**（Reservation、ReturnRecord、Offset、Attachment、Operation、CashEntry、Product、QuoteVersion） | 已在 `actions.json` 的 `stateMachineGaps` 登记，每条附 `specBasis` 依据。经 T01-rev1 更正：**8 项全部属「规格未定义」，无一项是转录遗漏** | T08a / T11a / T14a / T16a / T04a / T09a / T05a / T07a |
| ReturnRecord 的「贷项」是否需独立状态 | 规格未定义，T01-rev1 拆出的未决项 | T11a |
| 补充动作 B37–B41（采购取消、退供、报损、价格调整、售后收款） | B37–B39 标 reserved、B40 阻塞、B41 已定路径 | T06a / T06c / 待指定 / T12c |
| 生产 D1 实际已应用哪些迁移（0004 / 0005） | 未核实 | T20 |
| `library` 表是否有历史数据 | 未核实（代码零引用） | T20 |
| `quotes.data` blob 实际结构 | 未核实（现为单行工作副本） | T07 |
| 生产 `permissions` 表实际行内容 | 未核实（已改为按代码守卫映射，不依赖表行） | T20 |
| 取消未交付单时原确认成交额如何退出销售净应计 | 方案未定义，fixtures 的 `openItems` F01 已登记 | T08a |
| 回收未取得所有权时剩余应付的表示（null 还是另有约定） | 方案未定义，`openItems` F02 已登记 | T14a |
| `amountSummary` / `primaryAction` 子结构是否升为 objects.json 的规范性定义 | 本契约暂冻结在 `fixtures.json`，`openItems` F03 待裁定 | 项目负责人 |
| **生成物在前端严格配置下无法编译**（T02a 发现并修复） | `objects.ts` 原先把全部 36 个枚举类型无条件导入，前端 `noUnusedLocals` 下报 6 处 `TS6196`。已把 `buildObjects()` 改为按正文实际引用过滤 import。**生成物仍禁止手工编辑**，同类问题一律改生成器 | 已修（T02a），如需分行输出超长导入行仍属生成器改动 |
| 生成物落地到端内目录的方式 | 网页端已落地 `frontend/src/contracts/generated`（T02a，含防漂移脚本）；**契约里 `dtoGeneration.targets[id=web].status` 仍是 `pending`，需一次契约修订回写**（改已冻结文件须留 `revisionNote`）；小程序端仍待 T02b | T02c / T02b |
| V1 样本的列表排序 | 本卡只冻数据不冻顺序，`openItems` F05 | T18 |

**已澄清、不再视为缺口**：`Purchase` 不需要存储状态字段 —— 采购进度由 `orderedQty / receivedQty / cancelledQty` 派生（在途 = 三者相减），04 §2 的最低字段列本就没有状态字段。派生式见 `objects.json` 的 `Purchase.derivedFields`。T01b 曾误将其登记为「对象层遗漏」，T01-rev1 已更正。

## 5. 与其他文档的关系

- 业务规则细节以 `docs/plans/2026-09-17-web-wechat-plan/03-domain-rules.md` 为准，本目录只做机器可读化，不新增业务规则。
- 接口设计草案见同目录 `04-data-and-api.md`；本目录兑现其中可冻结的部分，并把无法从草案推断的内容（如 `closed` 进入条件）显式标为缺口。
- 虚构样本与边界输入以 `docs/plans/2026-09-17-web-wechat-plan/06-acceptance-and-handoff.md` §2 为准；`v1/fixtures.json` 只是把 §2 的样本数值化并提供可重算的算例，**不代替 06 的验收矩阵**（A01–A46、U01–U15 仍由各自任务卡执行）。
- 设计原型 `docs/design/2026-09-17-style-exploration/v3/` 不是契约来源。

## 6. 权限模型要点

| 项 | 内容 |
|---|---|
| 规模 | 49 个权限码，分 sales / inventory / service / recovery / tradein / finance / platform 七个域 |
| 命名 | `域/动作`，沿用旧 `resource/verb` 形态；语义一致的旧码（`store/manage`、`member/manage`、`role/view`）**不改名** |
| `grantPolicy` | `default` 默认角色可授予；`explicit` 须老板单独勾选（收款、入库、交付）；`owner_only` 仅老板 |
| 字段级 vs 动作级 | `inventory/cost-view`、`inventory/margin-view` 是**字段级**，只决定响应是否返回成本 / 毛利，不守卫动作。旧 `cost/view`、`margin/view` 就是字段级，不是路由守卫 |
| 宽权限来源 | 唯一宽权限是 `*`（`owner` / `admin` 角色），保留但不再扩大适用范围 |
| `noWidening` | 旧 `quote/edit`、`library/edit` 是高危宽权限，**不得**自动映射为退款、折抵、报损、盘差批准、欠款放行、付款、冲销等 `owner_only` 能力。校验脚本第 10.3 节强制此约束 |

旧权限映射的完整依据（含 `backend/src/index.ts` 行号证据）见 `v1/actions.json` 的 `legacyPermissionMap`。映射按**代码实际守卫的资源**判定，不按权限码字面名 —— 例如 `library/*` 实际守卫的是商品与 SN 接口。

## 7. 修订历史

| 修订 | 日期 | 内容 | 版本处置 |
|---|---|---|---|
| T01a | 2026-09-17 | 冻结约定、枚举、对象、错误码、金额规则、旧表映射六份契约 + 校验脚本 | 建立 `v1` |
| T01b | 2026-09-17 | 新增 `actions.json`（动作、权限、旧权限映射、状态机缺口登记）；校验脚本加第 10 节 | v1 不变 |
| T01-rev1 | 2026-09-17 | 更正状态机缺口登记：`Purchase` 移出 gaps（在途为派生值）、`ReturnRecord` 重述为规格未定义；全部条目补 `specBasis` 与 `origin`；`objects.json` 补派生态与事实映射；校验脚本加第 11 节 | v1 不变（见下） |
| T01c | 2026-09-17 | 新增 `v1/fixtures.json`（V1–V4 样本、边界输入、12 组金额算例、DTO 生成配置、5 项未决项）；新增 `tools/generate-dto.mjs` 与 `generated/`；校验脚本加第 12 节（样本重算 + 生成物防手改） | v1 不变（见下） |
| T02a | 2026-09-17 | **修生成器**：`buildObjects()` 只导入正文实际引用的类型（原先全量导入导致前端 `noUnusedLocals` 编译失败）；`generated/objects.ts` 与 `manifest.json` 哈希随之更新并重新生成。契约规范性表面**未变** | v1 不变（见下） |

T01-rev1 **未变更任何规范性表面** —— 字段名、类型、枚举取值、动作编号、错误码均无变化，新增的 `derivedFields` / `factMapping` / `notStored` / `specBasis` / `originValues` 均为非规范性注解，故未提升 `contractVersion`，改为在原文件内留 `revisions` 记录。⚠️ **此判断属治理决策，须项目负责人裁定**；若要求严格按第 3 节第 1 条执行，应改建 `contracts/v2/`。

T01c **同样未变更 T01a / T01b 六份文件的规范性表面** —— `fixtures.json` 是新增文件，`generated/` 是编译产物。唯一需要裁定的是 `fixtures.json` 的 `shapeDefinitions`：它为 `objects.json` 里声明为 `object` 类型、结构未定的 `TaskReadModel.amountSummary` 与 `primaryAction` 首次给出结构，这是**新增的规范性内容**。本卡的处置是把它留在 `fixtures.json` 内并登记 `openItems` F03，不动 `objects.json`；若要求进入 `objects.json` 的规范性表面，应按第 3 节第 1 条改建 `contracts/v2/`。
