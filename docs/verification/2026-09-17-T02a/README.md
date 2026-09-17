# T02a · 网页六导航与工作台骨架

日期：2026-09-17
状态：**本地通过（构建、测试、防漂移闸门）· 浏览器视觉验收未运行**
提交：`455c66f`
依据：[05-implementation-tasks.md · T02a](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md)、[01 §3 六模块与六项顶栏](../../plans/2026-09-17-web-wechat-plan/01-scope-and-architecture.md)、[02 UI 规格](../../plans/2026-09-17-web-wechat-plan/02-ui-specification.md)、[06 §2 V1 样本](../../plans/2026-09-17-web-wechat-plan/06-acceptance-and-handoff.md)

本卡只建立网页壳、导航与工作台骨架，**未连接生产、未写任何业务数据、未新增迁移、未部署**。跨卡片未决项见 [docs/OPEN-ITEMS.md](../../OPEN-ITEMS.md)。

---

## 1. 本卡文件范围

| 类型 | 路径 | 说明 |
|---|---|---|
| 新增 | `frontend/src/app/navigation.ts` | 六导航定义 + 12 项旧深链映射（每条附规格依据） |
| 新增 | `frontend/src/app/AppShell.tsx` | 六导航顶栏、全局搜索、账号菜单（含设置） |
| 新增 | `frontend/src/app/WorkspaceLandingPage.tsx` | 域落地页骨架（开单 / 回收置换当前落点） |
| 新增 | `frontend/src/features/workbench/demoData.ts` | V1 七条演示样本（DEMO 前缀）与指标 |
| 新增 | `frontend/src/features/workbench/WorkbenchTodayPage.tsx` | 今天工作台：指标、列表 / 看板、详情 |
| 新增 | `frontend/src/features/workbench/demoData.test.ts` | 端内样本 ↔ 契约一致性（14 项） |
| 新增 | `frontend/src/features/workbench/WorkbenchTodayPage.test.tsx` | 渲染与交互（18 项，jsdom） |
| 新增 | `frontend/src/styles/theme.css`、`appShell.css`、`workbench.css`、`landing.css` | 设计变量与页面样式 |
| 新增 | `frontend/src/contracts/generated/`（6 个） | 端内消费的契约生成物，来源 `contracts/generated` |
| 新增 | `frontend/scripts/sync-contracts.mjs` | 生成物落地与三方防漂移校验 |
| 修改 | `frontend/src/App.tsx` | 换壳、接入 /sales 与 /recovery、/dashboard 换页（见 §3） |
| 修改 | `contracts/tools/generate-dto.mjs` | 修复生成物未使用类型导入（见 §6 问题 2） |
| 修改 | `frontend/vitest.config.ts` | include 增加 `*.test.tsx` |
| 修改 | `frontend/tsconfig.app.json` | `types` 增加 `node`（见 §6 问题 4） |
| 只读 | 规划 7 份、`contracts/v1/*`、既有 `App.tsx` / `index.css` / `ErpShell.tsx` | 未改动既有报价、订单、库存等页面逻辑 |

未触碰 `backend/`、未新增迁移、未运行 `wrangler`、未访问线上数据。

---

## 2. 六导航与旧深链

导航项与页面 ID 的对应（依据 01 §3 第 41 行「电脑六项顶栏：今天、开单、库存、售后、回收置换、账本；设置置于头像菜单」）：

| 导航 | 路径 | 覆盖页面 ID |
|---|---|---|
| 今天 | `/dashboard` | P01 |
| 开单 | `/sales` | P03 / P04 / P05 |
| 库存 | `/inventory` | P06 / P07 / P08 |
| 售后 | `/after-sales` | P09 / P10 |
| 回收置换 | `/recovery` | P11 |
| 账本 | `/finance` | P12 |

旧 12 项深链的逐条处置写在 `frontend/src/app/navigation.ts` 的 `LEGACY_DEEP_LINK_MAP`，含 `kept` / `kept-editor` / `placeholder` / `account` 四种处置与依据。要点：

- `/quotes` 标记为 **`kept-editor`** —— 它是报价编辑器本体，必须继续渲染编辑器，**不得改成重定向**。本卡未改其任何逻辑。
- `/dashboard` 由新的今天工作台承接；旧 `DashboardPage` 不再被路由使用（见 §6 问题 7）。
- `/purchases`、`/suppliers`、`/customers`、`/assembly` 仍为占位页，**本卡不做重定向**，避免让占位入口凭空消失。
- `/settings` 从顶栏移入头像菜单（01 §3），路径与页面不变。

---

## 3. App.tsx 的改动边界

只做四件事，不改业务逻辑：

1. 引入 `AppShell` 替换 `ErpShell`；删除因此失效的 `visibleNavItems` 与 `currentNavItem`。
2. `/dashboard` 由 `<DashboardPage />` 改为 `<WorkbenchTodayPage />`。
3. 新增 `/sales`、`/recovery` 两个路由（域名与文案提为模块级常量，见 §6 问题 1）。
4. 其余路由、报价编辑器、登录、改密、转订单等逻辑**一行未动**。
5. 旧壳对「系统设置」入口做过权限过滤（`*` / `store/manage` / `member/manage` / `role/view`），换壳时该逻辑移到 `AppShell` 内保留，**未放宽**（见 §6 问题 8）。

未删除任何既有文件：`ErpShell.tsx`、`erpNavigation.ts`、`OrdersPages.tsx` 的 `DashboardPage` 均保留（见 §6 问题 7）。

---

## 4. 验证证据（实际运行）

执行环境：Windows，命令均在项目根执行。

| 检查 | 命令 | 结果 |
|---|---|---|
| 契约总校验 | `node contracts/tools/validate-contracts.mjs` | ✅ **3047 项通过，退出码 0**（与 T01c 相同；生成器改动后重新比对通过） |
| 生成物幂等 | `node contracts/tools/generate-dto.mjs --check` | ✅ 一致 |
| 端内生成物防漂移 | `node frontend/scripts/sync-contracts.mjs --check` | ✅ 6 个文件与 `contracts/v1` 一致 |
| 端内 ↔ 中立生成物 | 逐文件 `cmp` | ✅ 6/6 完全相同 |
| 单元与渲染测试 | `npm --prefix frontend run test` | ✅ **6 文件 / 50 用例全通过**（基线 4 文件 / 17 用例） |
| 生产构建 | `npm --prefix frontend run build` | ✅ `tsc -b && vite build`，261 模块 |
| 代码检查 | `npm --prefix frontend run lint` | ⚠️ **39 项（35 error / 4 warning）与 T00 基线完全相同，未新增** |

新增测试 33 项，全部是真实断言：

- `demoData.test.ts`（14 项）：端内样本与 `contracts/v1/fixtures.json` 的 V1 **逐字段相等**；待收 12,800 元按 `countsTowardReceivable` 重算；初估 480 / 1,500 不得计入；四类计数；金额恒等式；非确定应收不得用初估冒充；禁用动作必须有阻断原因；排序可复现且不改集合。
- `WorkbenchTodayPage.test.tsx`（19 项）：六导航恰好六项且名称正确；当前页只高亮一项；设置只在账号菜单；**无平台权限的店员看不到设置入口**；Escape 关菜单；搜索未接通如实说明；四项指标与金额；指标点击即筛选；详情默认首条；禁用主动作显示阻断原因；未确认费用显示"预计"；已结清不显示负尾款；筛选无结果显示空状态并可清空；列表与看板同集合；未接通动作只说明不提交；图片失败降级保留设备名；＋开单 只放行已存在入口。

### 防漂移闸门（三次负向测试）

| 注入 | 期望 | 实际 |
|---|---|---|
| 手改端内 `objects.ts`（`customerDisplay` → `customerDisplayX`） | 防漂移脚本报错 | ✅ 报「端内内容与契约不一致」，退出码 1 |
| 改端内样本 `balanceCents: 428000` → `428001` | 测试失败 | ✅ 3 项失败（字段比对、待收重算、恒等式） |
| 改契约侧 V1 `totalCents` 628000 → 628001 | 测试失败 | ✅ 1 项失败 |

注入前备份放在 `.validation-t02a/`（已被 `.gitignore` 覆盖），验证后已删除并复验通过。

---

## 5. 关键决定与理由

**D1 · 生成物落地方式：端内副本 + 三方一致校验，不用 tsconfig 路径别名。**
`fixtures.dtoGeneration.targets` 已把 web 目标冻结为 `frontend/src/contracts/generated`，故按契约落地。直接引用 `contracts/generated` 需要放宽 `tsconfig` 的 `include` 与 Vite 的 `fs.allow`，改动面更大。改用独立脚本 `sync-contracts.mjs` 一次性写出并做「契约 → 中立生成物 → 端内」三方比对，手工改动任意一方都会失败。

**D2 · 设计变量加 `wb-` 前缀，不占用裸名。**
`02 §1` 的变量名是语义名（paper / ink / muted / line），但 `frontend/src/index.css` 的 `:root` 已经占用了 `--line`、`--muted`、`--ink`、`--page-bg`。AppShell 会同时包住报价编辑器，若在壳里重定义裸名，**报价页的分隔线与次要文字会跟着变色**。故全部加前缀，作用域限定在 `.app-shell` 内。

**D3 · 演示标识由 ID 前缀承载，页面上只用一行小字说明。**
`demoPolicy.markerCarrier` 明确「演示标识由 ID 前缀承载，不新增协议字段」；`02 §1` 同时要求「示例数据」这类评审环境的标注不应出现在生产页面。故列表与详情直接显示 `DEMO-` 单号，另加一行运行状态说明（样本数据 / 固定日期 / 未连接门店服务），不加横幅。

**D4 · 未接通的入口不跳转、不返回假结果。**
＋开单 的四个入口里只有装机报价与回收置换可导航，其余弹出「尚未接通，未提交任何数据」；全局搜索同理。这符合 `05` 执行原则中「生产模式禁止假数据降级」「失败不能回退到 fixture 并显示成功」。

**D5 · 列表与详情用派生选中，不用 effect。**
按 `02 §3`，「切换筛选后旧任务若不在结果内则清空详情并选首条有效任务」用 `useMemo` 派生实现，避免 `set-state-in-effect`（该规则在既有代码里已有 7 处失败，不新增）。

**D6 · 演示排序显式声明为「不是最终排序」。**
契约 V1 的 `order` 是 `"unspecified"`（未决项 F05，归 T18）。端内按截止时间升序、空值最后，仅为了让演示可复现，代码注释与文档都写明这一点。

---

## 6. 本卡发现的问题

### 问题 1 · 超长 JSX 行导致编译失败（已修）

在 `App.tsx` 的两个路由里直接内联 500+ 字符的 JSX（含嵌套对象数组属性）时，`tsc` 报 `TS2657 JSX expressions must have one parent element` 与后续 `TS1005`。逐字符检查未发现非法字符（引号配对、无非 ASCII 异常）。改为把 props 提为模块级常量后编译通过。

**结论**：本项目的 `tsc` 版本对超长单行 JSX 属性不可靠。**后续写 JSX 一律避免单行超长属性，嵌套数据先提为常量。**

### 问题 2 · 生成物在前端严格配置下无法编译（已修，属跨端集成真问题）

`contracts/generated/objects.ts` 原来把**全部 36 个枚举类型**无条件导入，而 `frontend/tsconfig.app.json` 开了 `noUnusedLocals`，`tsc -b` 直接报 6 处 `TS6196: 'X' is declared but never used`。**生成物本身不能手工编辑**，所以修的是生成器：`buildObjects()` 改为先拼正文、再按 `\b名字\b` 过滤出真正被引用的类型才写入 import。

- 影响面：`contracts/generated/objects.ts`、`manifest.json` 的哈希随之变化；已重新生成并同步端内，契约总校验 3047 项仍通过。
- 遗留：`import type { ... }` 仍是单行 36 个类型的长行。**若小程序侧编译器对超长导入行有意见，需要按同样思路再改生成器（分行输出），不要在生成物里手改。**

### 问题 3 · 演示样本进了生产构建产物（未修，必须处理）

`grep DEMO-SO-003 frontend/dist/assets/*.js` 命中。契约 `dtoGeneration.notGenerated` 明确要求「样本只在测试与演示环境使用，**生产包不得携带**」。

当前是骨架阶段的必然结果（本卡只有演示数据源）。**T18 接真实服务时必须同时处理**：把演示数据改为按环境动态导入、或构建期排除，并加一条「产物内不得出现 `DEMO-`」的检查。在此之前**不得把本卡产物当作可用版本发布**。

### 问题 4 · `tsconfig.app.json` 的 `types` 缺 `node`（已修，有副作用）

`demoData.test.ts` 需要用 `node:fs` 读契约文件，而 `types: ["vite/client"]` 下 `tsc -b` 报 `TS2307 Cannot find module 'node:fs'`。已加入 `"node"`。

**副作用（需要知道）**：前端源码现在也能通过 Node 全局类型检查，弱化了对「误用 Node API」的拦截。替代方案（给测试单独 tsconfig / 把测试排除出 `tsc`）都会牺牲测试的类型检查，故未采用。

### 问题 5 · 测试基础设施的两个坑（已修）

- `@testing-library/react` 的自动清理依赖全局 `afterEach`，而本项目 vitest 未开 `globals`，导致多个用例的 DOM 累积，14 个用例报「found multiple elements」的**假失败**。修法：测试文件内显式 `afterEach(cleanup)`。
- jsdom 不加载资源，`<img>` 的 `error` 事件不会自然发生，**图片降级路径不会被触发**。修法：`fireEvent.error(img)` 主动触发。这同时说明：浏览器里 `demo://` 图片必然失败，演示态看到的本来就是占位图。

### 问题 6 · Edit 操作失误（已修，教训）

在一次修改中把 `function normalizeStoredState(...) {` 与下一行合并（`old_string` 带了行尾换行、`new_string` 没有），造成两行粘连。已当场修复。

**教训**：编辑函数声明行时，不要把「行尾换行」放进 `old_string`，除非确实要删那一行。

### 问题 7 · 旧壳与旧页面处于「半退役」状态（未决）

- `frontend/src/components/ErpShell.tsx`：已不被 `App.tsx` 引用，但文件保留。
- `frontend/src/erpNavigation.ts` 的 12 项 `ERP_NAV_ITEMS`：仍被 `App.tsx` 用来生成占位路由，**因此不能删**，于是仓库里同时存在「12 项旧导航清单」和「6 项新导航定义」两份。
- `OrdersPages.tsx` 的 `DashboardPage`：已不被路由使用，成为死代码。

是否收敛、何时收敛、由哪张卡负责，规格未写。见 `docs/OPEN-ITEMS.md` 的 Q12。

### 问题 8 · 换壳时差点静默放宽「系统设置」的可见性（已修）

旧壳里「系统设置」导航项的显示条件是 `permissions` 含 `*` / `store/manage` / `member/manage` / `role/view`。按 01 §3 把它移入头像菜单时，这一层判断很容易在迁移中丢掉 —— 那样任何店员都能在菜单里看到设置入口。

已把该判断移入 `AppShell`（`canSeeSettings`）并补了一条渲染测试（无平台权限的店员看不到设置入口）。**注意这仍只是界面提示**：真正边界在后端，`02 §7` 明确「不依赖前端隐藏保护权限」。

**教训**：换壳 / 搬入口时，被搬走的往往不只是入口，还有挂在它上面的**可见性条件**；迁移时要逐条对着旧实现核对，而不是只核对路径。

---

## 7. 未运行 / 未覆盖（不得当作通过）

| 项 | 状态 | 原因 / 缺口 |
|---|---|---|
| 浏览器视觉验收（U01 尺寸、U02 缩放、U05 键盘、U06 首屏主动作） | **未运行** | 本机无 Playwright / 浏览器自动化工具；且本地登录会触达生产后端 `pc.huangqidong.cn`，T00 已明确避免接触生产 |
| 对比度实测（`danger` 是 02 §1 新增语义色，原文要求「需实测对比度」） | **未运行** | 同上，需浏览器环境 |
| 真实断网 / 写超时 / 登录过期 / 冲突 / 无权限状态（02 §7） | **未实现** | 无服务端，本卡只有演示数据源；骨架只实现了「筛选无结果」与「图片失败」两种 |
| 逾期文案（02 §4「逾期明确写已逾期」） | **无样本** | V1 的 7 条没有逾期项；需要补一条逾期样本才能验 |
| 微信小程序端（T02b） | **未开始** | 独立子卡；`fixtures.dtoGeneration.targets` 的 miniprogram 目标仍为 `pending` |
| 组件提取（TaskRow / DeviceSummary / ProgressSteps / AmountActionBar / Feedback） | **未做** | 归 T02c；本卡按最小改动写在页面内 |
| 真机 / 开发者工具 | **不适用** | 本卡只有网页端 |

---

## 8. 待裁定与未决

完整台账见 [docs/OPEN-ITEMS.md](../../OPEN-ITEMS.md)。本卡直接相关的是：

| 编号 | 事项 | 归属 |
|---|---|---|
| F03 | `amountSummary` / `primaryAction` 是否升入 `objects.json` 成为规范性定义（本卡按 `fixtures.shapeDefinitions` 实现，端内类型与之对齐） | **待负责人裁定** |
| F04 | 生成物落端内目录：web 半边已由本卡完成，但契约里 `targets.status` 仍是 `pending`，**需要一次契约修订回写**（改已冻结文件须留 `revisionNote`） | T02c / 下次契约修订 |
| F05 | V1 列表排序未冻结，本卡用了自定的演示排序 | T18 |
| Q04 | 六导航是否按权限隐藏、用哪个权限码 —— 规格未定义，本卡六项全部可见 | 待裁定 |
| Q12 | 旧壳 `ErpShell` / 12 项旧导航 / 死代码 `DashboardPage` 的收敛时机 | 待裁定 |

---

## 9. 复现命令

```bash
# 契约（唯一来源 → 中立生成物 → 端内生成物）
node contracts/tools/validate-contracts.mjs
node contracts/tools/generate-dto.mjs
node frontend/scripts/sync-contracts.mjs         # 写入端内
node frontend/scripts/sync-contracts.mjs --check # 防漂移复验

# 前端
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run lint   # 既有 39 项失败，非本卡引入
```

本地预览（需自行登录）：`npm --prefix frontend run dev`，登录后访问 `/dashboard`。

---

## 10. 下一步

- **T02b**：小程序独立项目、原生 tabBar 四项、列表与详情跳转；生成物落到 `miniprogram/contracts/generated`（路径待 T02b 按实际 `miniprogramRoot` 回写契约）。
- **T02c**：提取跨端组件（TaskRow / DeviceSummary / ProgressSteps / AmountActionBar / Feedback）。
- 开 T18 前必须先解决 §6 问题 3（演示样本不得进生产包）。
