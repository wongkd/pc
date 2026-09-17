# T02b · 小程序壳与契约回写

日期：2026-09-17
状态：**本地通过（契约、类型、单元、结构自检）· 微信开发者工具编译未运行（待重启工具开启服务端口）· 真机未运行**
提交：`887b267`
依据：[05-implementation-tasks.md · T02b](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md)、[02 UI 规格 §4](../../plans/2026-09-17-web-wechat-plan/02-ui-specification.md)、[02 §2 页面地图](../../plans/2026-09-17-web-wechat-plan/02-ui-specification.md)

本卡建立小程序独立项目、原生 tabBar 四项、列表与详情的真实页面跳转，并回写契约的生成物目标状态。**未连接生产、未写任何业务数据、未新增数据库迁移、未部署、未上传微信**。跨卡片未决项见 [docs/OPEN-ITEMS.md](../../OPEN-ITEMS.md)。

---

## 1. 本卡文件范围

| 类型 | 路径 | 说明 |
|---|---|---|
| 新增 | `miniprogram/project.config.json` | 项目配置：无 AppID 模式、`miniprogramRoot` 取项目根、TS 编译插件、打包忽略清单 |
| 新增 | `miniprogram/app.json` | 主包四页、原生 tabBar 四项、分包 `packages/sales` |
| 新增 | `miniprogram/app.ts` / `app.wxss` | 入口与设计变量（`--mp-*`，单位换算为 rpx） |
| 新增 | `miniprogram/sitemap.json` | 全部 disallow |
| 新增 | `miniprogram/tsconfig.json` / `package.json` | 类型检查配置、脚本与类型依赖 |
| 新增 | `miniprogram/pages/{today,sales,inventory,more}/index.*` | 主包四页（每页 ts / wxml / wxss / json） |
| 新增 | `miniprogram/packages/sales/order-detail/index.*` | 事项详情（分包页面，真实页面跳转目标） |
| 新增 | `miniprogram/features/demo-data.ts` | V1 演示样本、指标、演示排序、逾期判断 |
| 新增 | `miniprogram/features/amount-view.ts` | 金额格式化与五种呈现形态的口径 |
| 新增 | `miniprogram/templates/landing.wxml` | 三个域落地页共用的排版模板 |
| 新增 | `miniprogram/contracts/generated/`（6 个） | 端内契约生成物，来源 `contracts/generated` |
| 新增 | `miniprogram/scripts/sync-contracts.mjs` | 生成物落地与三方防漂移 |
| 新增 | `miniprogram/scripts/check-pages.mjs` | 结构自检：app.json 注册 ↔ 磁盘文件 |
| 新增 | `miniprogram/tests/*.test.mjs`（2 个） | 样本 ↔ 契约一致性、金额口径，共 26 用例 |
| 新增 | `miniprogram/README.md` | 项目职责、运行方式、已实现 / 未实现、硬性约束 |
| 修改 | `contracts/v1/fixtures.json` | 回写 `dtoGeneration.targets` 两端状态为 `done`，新增 `revisions`（T02b-rev1） |
| 修改 | `contracts/tools/generate-dto.mjs` | manifest 的 `targets` 改为从 fixtures 读取（原先硬编码，见 §6 问题 1） |
| 修改 | `contracts/generated/manifest.json`、`frontend/src/contracts/generated/manifest.json` | 重新生成后的产物（其余 5 个生成物内容未变） |

未触碰 `backend/`、未新增迁移、未运行 `wrangler`、未访问线上数据、未上传小程序。
`frontend/src/` 下唯一变化是生成物 `manifest.json`（重新同步所致），**源码一行未改**。

---

## 2. 结构与跳转

主包四页与原生 tabBar（依据 02 §4 第 93 行「原生 tabBar 使用今天、开单、库存、更多，选中森林绿」）：

| tabBar | 页面 | 主要动作 |
|---|---|---|
| 今天 | `pages/today/index` | 四项统计、事项筛选、竖向任务列表 → 跳详情 |
| 开单 | `pages/sales/index` | 域落地页（入口均为未接通说明） |
| 库存 | `pages/inventory/index` | 域落地页 |
| 更多 | `pages/more/index` | 账本 / 售后 / 回收置换 / 设置入口 |

分包（依据 02 §2 页面地图的 `packages/sales/order-detail`）：事项详情，**真实页面跳转**，底部固定金额与动作条，无 tabBar。

跳转与返回恢复（02 §4「返回和跨端状态」）：

- 列表 → 详情用 `wx.navigateTo`，**只传 `taskId`**，详情重新取数，不把列表旧对象当可提交依据；
- ＋开单 用 `wx.switchTab` 进入开单域（tabBar 页不能用 `navigateTo`）；
- 今天页 `onShow` **刻意不做任何 `setData`**：navigateTo 返回与 switchTab 切回都复用同一页面实例，筛选与滚动位置由框架保留。任何后续改动若在 `onShow` 重置列表，都会破坏这条体验，改动时必须先看该处注释。

---

## 3. 验证证据（实际运行）

执行环境：Windows，Node v22.22.2，命令在项目根执行。

| 检查 | 命令 | 结果 |
|---|---|---|
| 契约总校验 | `node contracts/tools/validate-contracts.mjs` | ✅ **3047 项通过，退出码 0**（与 T01c / T02a 相同） |
| 生成物幂等 | `node contracts/tools/generate-dto.mjs --check` | ✅ 一致（6 个文件） |
| 小程序端防漂移 | `node miniprogram/scripts/sync-contracts.mjs --check` | ✅ 6 个文件与 `contracts/v1` 一致 |
| 网页端防漂移（回归） | `node frontend/scripts/sync-contracts.mjs --check` | ✅ 6 个文件一致 |
| 两端生成物逐字节比对 | 逐文件 `cmp` | ✅ 6/6 完全相同 |
| 小程序单元测试 | `npm --prefix miniprogram test` | ✅ **2 文件 / 26 用例全通过** |
| 小程序类型编译 | `npm --prefix miniprogram run typecheck`（`tsc --noEmit`） | ✅ 通过（strict + noUnusedLocals） |
| 小程序结构自检 | `npm --prefix miniprogram run check-pages` | ✅ 主包 4 页 + 分包 1 页，注册与磁盘一致 |
| 网页端单元测试（回归） | `npm --prefix frontend run test` | ✅ 6 文件 / 50 用例全通过（与 T02a 基线一致） |
| 网页端构建（回归） | `npm --prefix frontend run build` | ✅ `tsc -b && vite build` 通过 |
| 网页端代码检查（回归） | `npm --prefix frontend run lint` | ⚠️ 39 项（35 error / 4 warning），与 T00 基线完全相同，未新增 |
| 微信开发者工具编译 | `cli.js open --project miniprogram` | ❌ **未运行** —— 工具服务端口关闭，见 §7 |
| 真机 / iOS / Android | — | ❌ **未运行** —— 无 AppID，且无真机条件 |

### 测试覆盖的真实断言（26 项）

- **样本 ↔ 契约**（15 项）：逐字段与 `fixtures.datasets.V1.tasks` 相等（字段顺序不计）；条数与 `expected.taskTotal` 一致；`DEMO-` 前缀；taskId / entityId 唯一；固定演示日期取自契约；四项指标与 `metrics` 一致；类别计数与 `expected.categoryCounts` 一致；待收按 `countsTowardReceivable` 重算；契约列出的三笔排除项（维修初估 480、回收未收购 1,500、未定收费）不得计入；金额恒等式；禁用动作必须有可读 blocker；排序可复现且不改原集合；无截止时间的排在最后；`findTaskById` 命中与未命中；逾期分支（**V1 无逾期样本，本项构造用例**）。
- **金额口径**（11 项）：千分位与两位小数；负数保留负号；不吞掉「分」；待收形态与明细；**结清要提醒确认实物交出**；**应付不得显示成负尾款**；**初估要标「预计」且不计确定应收**；**未定价写「待确认」，不得用 ¥0 冒充**；无金额记录不虚构金额；禁用动作给出可读原因。

### 防漂移闸门（三次负向测试，全部如期失败）

| 注入 | 期望 | 实际 |
|---|---|---|
| 手改端内生成物 `objects.ts`（`customerDisplay` → `customerDisplayX`） | 防漂移脚本报错 | ✅ 退出码 1，同时报「端内内容与契约不一致」与「端内与 contracts/generated 不一致」 |
| 改端内样本 `balanceCents: 428000` → `428001` | 测试失败 | ✅ **3 项失败**（字段比对、待收重算、金额恒等式） |
| 改契约侧 V1 `totalCents` 628000 → 628001 | 测试失败 | ✅ 3 项失败（与上一条叠加） |

注入备份放 `.validation-t02b/`（已被 `.gitignore` 覆盖），验证后已删除并复验 26/26 通过、无残留。

---

## 4. 关键决定与理由

**D1 · `miniprogramRoot` 取项目根，让契约路径原样成立。**
契约声明小程序端生成物路径为 `miniprogram/contracts/generated`，并留了「按实际 `miniprogramRoot` 调整并回写」的说明。另一种做法是把源码放 `miniprogram/src/`、生成物留在项目根，但那样小程序源码要跨出 `miniprogramRoot` 引用生成物 —— 微信编译链不处理根目录外的 TS 文件，会直接失败。故取项目根为 `miniprogramRoot`，并回写 `status: done`，**未改动任何 `rootPath`**。
代价：生成物会进小程序包体（6 个文件约 64KB 源码量级）。已在 `packOptions.ignore` 排除 `manifest.json` 与脚本目录；是否进一步优化留待分包体系成型后评估。

**D2 · 两个端各留一份 `sync-contracts.mjs`，不合并成带 `--target` 的脚本。**
契约的 `dtoGeneration.targets` 本就是「每端一个落地目标」的声明；合并会让「改一端要动另一端已通过的产物」。两份脚本各自做「契约 → 中立生成物 → 端内」三方比对，边界清晰。这是设计选择，不是重复代码。

**D3 · 金额格式化不用 `toLocaleString`。**
小程序 JSCore（iOS JavaScriptCore / Android V8）的 Intl 支持不完整，`toLocaleString('zh-CN', …)` 在不同机型可能给出不同的千分位结果甚至静默去分组。金额显示错误属业务事故，故改为纯字符串运算；`tests/amount-view.test.mjs` 断言其与电脑端显示格式一致。

**D4 · 小程序端不引入衬线字体。**
02 §1 要求「只在页标题、设备名和少量大金额使用衬线」，但 02 §1 同时写明小程序「优先系统字体，标题衬线在不同系统可能回退；先验证实际设备，再决定是否引入获授权的子集字体」。本卡按后者执行，统一使用系统字体栈，不引入来源不明的字体。**待真机验证后再定是否引入。**

**D5 · tabBar 不配图标，用系统导航栏。**
原生 tabBar 的 `iconPath` 是可选项。首版用纯文字 tabBar，避免引入授权状态不明的图标素材（AGENTS.md 要求资源注明来源与授权核实状态）。02 §4 要求的「选中森林绿」用 `selectedColor: #334B42`（02 §1 的 ink / primary，其用途明确包含「选中强调」）实现。

**D6 · 四项统计在小程序上两行两列。**
02 §4 写「统计在宽屏四列，320px 或大金额时允许两行两列；不把 ¥128,000.50 缩成极小字号或省略成无法核账的数」。手机不是宽屏，故取两行两列，`¥12,800.00` 保持可读。

**D7 · 未接通的入口只说明，不跳转、不返回假结果。**
与网页端 T02a 的 D4 同一口径。域落地页明确列出「未接通（归属任务卡）」，`＋开单` 只切到开单域（不再伪造四个入口），搜索与待收款指标弹口径说明。

**D8 · 详情页的「阶段」与「事件记录」留空并如实说明，不编造进度。**
V1 读模型样本里没有阶段序列与事件字段（`objects.json` 的 stateMachines 有定义，但样本未提供实例状态）。规格没写的不能自己编（OPEN-ITEMS §2），故该区域只显示一行说明并标归属任务，不画假进度条、不显示推测状态。

**D9 · 契约 `targets.status` 两处一并回写。**
`web` 的实际落地已在 T02a 完成、`miniprogram` 由本卡完成，事实都清楚，一次修订解决 OPEN-ITEMS 的 T-01 与 T-02 两项，避免只改一半造成新的不一致。按契约规则留 `revisions` 记录（T02b-rev1），未提 `contractVersion`——未改任何字段名、类型、枚举取值、动作编号、错误码、金额公式或样本数值，`rootPath` 也未变。

---

## 5. 契约修订（T02b-rev1）

`contracts/v1/fixtures.json`：

- `dtoGeneration.targets[id=web].status`：`pending` → `done`，补 `landedNote`；
- `dtoGeneration.targets[id=miniprogram].status`：`pending` → `done`，`pathNote` 改为记录实际落地方式（`miniprogramRoot` 取项目根，路径与规划值一致）；
- 新增 `revisions` 数组与 T02b-rev1 记录（本文件原先没有 `revisions`，格式对齐 `objects.json`）。

**顺带修掉的生成器缺陷**：`contracts/tools/generate-dto.mjs` 原先把 `targets` 硬编码在 `manifest` 里（`{ id: 'web', …, status: 'pending' }` 等两行字面量），那是与 `fixtures.json` 并存的手写副本，改契约不会反映到 manifest。现改为从 `fixtures.json` 读取，使 `targets` 保持单一来源。改动后 `manifest.json` 内容随契约变化，已在两端重新生成并复验。

---

## 6. 本卡发现的问题

### 问题 1 · 生成器把生成物目标硬编码（已修，属真实缺陷）

`manifest.json` 的 `targets` 不是从契约读的，而是在生成器里写死两行字面量，且状态永远停在 `pending`。这类「第二份手写副本」会让契约声明与生成物静默分叉。修法与 T02a 修生成器导入过滤同一思路：**改生成器，不手改生成物**。

### 问题 2 · 详情页由三类事项共用（有意为之，但属与页面地图的偏差）

02 §2 的页面地图里，售后详情是 `packages/service/detail`（T12）、回收详情是 `packages/recovery/detail`（T14），销售详情才是 `packages/sales/order-detail`。V1 样本的七个事项含 `service_order` 与 `recovery_order`，本卡只有一个详情页，三类都跳它。

**这不是最终形态**：售后与回收的详情内容（维修方案、验机与估价）差异很大，必须分开。归属 T12 / T14，届时按页面地图拆包并改跳转。本卡不自行宣布为最终形态。

### 问题 3 · 「阶段」与「事件记录」无样本可依（未实现，已登记）

见 D8。V1 样本的 `TaskReadModel` 没有状态字段与事件数组，故详情页顶部只有「单号 / 类别 / 交期」，没有「单据状态」。这是**读模型缺字段**，不是页面漏做；`objects.json` 的状态机定义齐备，缺的是样本实例与读模型字段，归 T08 / T18。

### 问题 4 · 逾期分支无样本（沿用 G-14）

02 §4 要求「逾期明确写已逾期，不能只变红」，V1 七条没有逾期项。实现已按固定演示日期比较写好并由单测构造用例覆盖，但**演示数据下不会渲染出该形态**，所以「逾期在真机上的可读性」仍未验。需要补一条逾期样本才能做界面验收。

### 问题 5 · 测试必须用 Node 类型擦除跑 TS，带来两条约束（已修，需记住）

- Node 22 的类型擦除可直接加载 `.ts`，但**不解析无扩展名的相对导入**。因此被测试引用的模块（`demo-data.ts`、`amount-view.ts`）只能有 `import type`，不能有值导入。原本放在 `utils/format.ts` 的格式化函数因此并入 `amount-view.ts`，`utils/` 目录已删除。
- `node --test <目录>` 在本机不工作（会被当成单个文件执行并报 `MODULE_NOT_FOUND`），必须写成 `node --test "tests/*.test.mjs"`。npm script 已按此写法。

### 问题 6 · 新版 TypeScript 移除了 `moduleResolution: node`

`tsc --noEmit` 首次运行报 `TS5108: Option 'moduleResolution=node10' has been removed`。改为 `bundler`（配合 `module: ESNext`，允许无扩展名导入，符合小程序编译习惯）。

### 问题 7 · 契约 WXSS 变量名不能沿用网页端（沿用 P-06 教训）

网页端变量挂在 `.app-shell` 上，小程序没有该选择器，变量定义在 `page` 上。两端是独立编译链，没有共享前提，故小程序端统一用 `--mp-` 前缀，不复用 `wb-`。

---

## 7. 未运行 / 未覆盖（不得当作通过）

| 项 | 状态 | 原因 / 缺口 |
|---|---|---|
| 微信开发者工具编译（「小程序必须编译出原生页面」） | **未运行** | 工具 CLI 报「工具的服务端口已关闭」。已通过 CLI 的 `y` 确认流程写入服务端口设置，但**当前运行的实例仍是旧设置**，需关闭并重新打开开发者工具后生效；生效后需先扫码登录，CLI 才能驱动编译。**本卡尚不能声称「编译出原生页面」。** |
| 真机 / iOS / Android | **未运行** | 无 AppID（本卡用无 AppID 模式），无真机条件 |
| 视觉验收：320 / 375 / 390 / 430 宽度、字体放大、真实系统导航与 tabBar 之间的可显示条数 | **未运行** | 需开发者工具或真机；本机无浏览器自动化（同 T02a） |
| 对比度实测（`danger` 是 02 §1 新增语义色） | **未运行** | 需实际渲染环境 |
| 断网 / 写超时 / 登录过期 / 无权限等界面状态（02 §7） | **未实现** | 无服务端；本卡只有演示数据源 |
| 「返回恢复」的滚动位置 | **只做了不破坏，未做实测** | 实现上 `onShow` 不重置状态即由框架保留；需在真机或工具里滚动后往返验证 |
| 分包体积与主包上限 | **未测** | 需工具构建产物报告；本卡生成物约 64KB 源码量级 |
| 旧深链 / 分享路径直接进入详情 | **未实现** | 需 T03（登录恢复目标）与 T18 |

---

## 8. 待裁定与未决

| 编号 | 事项 | 归属 |
|---|---|---|
| T-01 / T-02 | 两端生成物目标状态回写 | ✅ **本卡已解决**（见 §5） |
| D-C / Q04 | 六导航与 tabBar 是否按权限隐藏、用哪个权限码 | **待负责人裁定**（规格未定义；本卡四项全部可见） |
| D-E | 演示样本进了生产构建产物 | **仍未处理**；小程序端同样受约束（`features/demo-data.ts` 必须在 T18 删除） |
| G-11 / G-12 | 供应商页面归属、SN 台账是否单列导航 | 库存域落地页已如实标注为「待定」，未自行裁定 |
| G-14 | 缺逾期样本 | 见 §6 问题 4 |
| 新增 | 售后 / 回收详情是否立即拆包 | 建议 T12 / T14 处理，不在本卡扩大范围 |

---

## 9. 复现命令

```bash
# 契约（唯一来源 → 中立生成物 → 两端端内生成物）
node contracts/tools/validate-contracts.mjs        # 应 3047 项、退出码 0
node contracts/tools/generate-dto.mjs
node frontend/scripts/sync-contracts.mjs
node miniprogram/scripts/sync-contracts.mjs
node frontend/scripts/sync-contracts.mjs --check
node miniprogram/scripts/sync-contracts.mjs --check

# 小程序端
npm --prefix miniprogram install
npm --prefix miniprogram test            # 26 用例
npm --prefix miniprogram run typecheck
npm --prefix miniprogram run check-pages

# 网页端回归
npm --prefix frontend run test           # 50 用例
npm --prefix frontend run build
npm --prefix frontend run lint           # 既有 39 项失败，非本卡引入
```

**开发者工具（需先开启服务端口并重启工具）**：

```bash
cd "D:\Software\微信web开发者工具"
node.exe cli.js islogin                                    # 确认已扫码登录
node.exe cli.js open --project "C:\Users\wuerl\Documents\工作同步\pc-quote\miniprogram"
```

导入本目录后，工具应显示四个 tabBar 与一个分包详情页；「不使用 AppID」模式下可编译预览，但不能真机调试与上传。

---

## 10. 下一步

- **补齐本卡唯一缺口**：重启开发者工具 → 扫码登录 → 用 CLI 打开 `miniprogram/` 抓真实编译结果，把 §7 第一行从「未运行」改为实际结论。
- **T02c**：提取跨端组件（TaskRow / DeviceSummary / ProgressSteps / AmountActionBar / Feedback）。注意 02 §T02c 要求「不共享 React 组件给微信」，两端各自实现、共用契约与口径。
- **T03 / T04** 可并行推进；T03 需要微信平台条件（OPEN-ITEMS T-05，仍待用户提供 AppID / 主体 / 成员）。
- 开 T18 前必须解决 D-E：两端都不得把演示样本打进生产产物。
