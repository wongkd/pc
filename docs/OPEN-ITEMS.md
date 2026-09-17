# 未决项与踩坑台账（跨卡片）

更新：2026-09-17（最后由 T02b-rev2 维护）
用途：**把「规格没写的」「需要你拍板的」「已经踩过的坑」集中在一处**，便于换一个 AI 继续做，也便于你逐条决定。

- 本文件只做索引与结论，**不复述业务规范**；业务规则以 `docs/plans/2026-09-17-web-wechat-plan/03-domain-rules.md` 与契约 `contracts/` 为准。
- 状态只有四种：**待裁定**（要人决定）/ **待实现**（已定，等某张卡做）/ **未核实**（事实不明）/ **已解决**（留档）。

## 0 · 接手前先做这三件事

```bash
git log --oneline -8                       # 看做到哪张卡
node contracts/tools/validate-contracts.mjs # 契约自洽（应 3047 项、退出码 0）
node frontend/scripts/sync-contracts.mjs --check    # 网页端内生成物未漂移
node miniprogram/scripts/sync-contracts.mjs --check # 小程序端内生成物未漂移
npm --prefix frontend run test              # 应 6 文件 / 50 用例通过
npm --prefix miniprogram test               # 应 4 文件 / 39 用例通过（T02b-rev2 后；需先 npm --prefix miniprogram install）
```

然后读：根 `README.md` → 本文件 → `docs/verification/<最新卡号>/README.md` → 当前任务涉及的规格小节。
**不要**递归扫 `node_modules/`、`backups/`、历史截图。

---

## 1 · 需要你（负责人）拍板

| 编号 | 事项 | 现状 | 为什么要你定 | 影响 |
|---|---|---|---|---|
| **D-A** | `amountSummary` / `primaryAction` 的结构是否升入 `objects.json` 成为规范性定义 | 契约把这两个字段声明为 `JsonObject`（结构未固定），实际结构定义在 `contracts/v1/fixtures.json` 的 `shapeDefinitions`（T01c 冻结）。T02a 的端内类型已与之一致 | 往已冻结的 `objects.json` 里加结构属于**新增规范性表面**，按契约规则必须提 `contractVersion` → 建 `contracts/v2/` | 不定则 F03 一直挂着；两端类型只能引用 `shapeDefinitions`，生成器不会输出这两个子结构 |
| **D-B** | T01-rev1 与 T01c 的非规范性追加是否提 `contractVersion`（重建 v2） | 两次都只在原文件内留 `revisions` 记录，未提版 | 这是治理决策：严格按规则该提版，但会动全部文件的引用路径 | 影响后续所有契约变更的流程与两端生成物路径 |
| **D-C** | 六导航是否按权限隐藏？用哪个权限码？ | 规格只写「网页六导航」，**没有说哪项对谁可见**。T02a 实现为六项全部可见 | 04 §9 有 49 个权限码，但没有任何一条能直接对应「今天/开单/库存/售后/回收置换/账本」的可见性 | 不确定就只能在 T03（身份与权限）时猜，属于把风险推给实现模型 |
| **D-D** | 旧壳 `ErpShell.tsx`、旧 12 项导航清单、死代码 `DashboardPage` 何时收敛 | T02a 换了新壳，但三者都保留着：旧 12 项仍用于生成占位路由，删不掉 | 留着会造成「两份导航定义」，删了要确认没有别的引用 | 影响可维护性，不影响功能 |
| **D-E** | 演示样本进了生产构建产物是否现在处理，还是等 T18 | 契约要求「生产包不得携带样本」，现实是 `dist/assets/*.js` 里有 `DEMO-SO-003` | 处理方式有三种（按环境动态导入 / 构建期排除 / 保留到 T18 统一做），代价不同 | **在此之前本卡产物不得当可用版本发布** |
| **D-F** | 今天页统计条**不再四格等分**（金额格 260rpx、计数格 ≈153rpx） | T02b-rev2 修 R-14 时采用了「金额格加宽 + 字号分档」。设计稿 v3 是四格等分，但那与 02 §1「小数位不能为了好看掩盖分」冲突（设计稿写 `¥12,800`，真实渲染是 `¥12,800.00`） | 要维持严格等分只能改走方案 A（保住等分、金额压到 ≈30rpx，比同排计数小 25%），观感取舍需你定 | 三种方案与实测数见 `docs/verification/2026-09-17-T02b-rev2/README.md` §3 |

---

## 2 · 规格缺口（规格没写，实现时不许自己编）

| 编号 | 缺口 | 契约里的登记 | 归属 |
|---|---|---|---|
| G-01 ~ G-08 | 8 项状态机缺口：`Reservation` / `ReturnRecord` / `Offset` / `Attachment` / `Operation` / `CashEntry` / `Product` / `QuoteVersion` | `contracts/v1/actions.json` 的 `stateMachineGaps`，每条附 `specBasis` 依据与 `origin`（`spec-undefined` / `spec-partial`） | T08a / T11a / T14a / T16a / T04a / T09a / T05a / T07a |
| G-09 | `closed` / `expired` 状态的**进入条件** | 校验脚本列为提示项 | 对应业务卡实现前补 |
| G-10 | 「贷项」是否需要独立状态 | T01-rev1 已更正为「规格留白」而非转录遗漏 | T11a |
| G-11 | 供应商（`/suppliers`）没有独立页面 ID | T02a 暂归库存导航、保留占位 | 待定 |
| G-12 | SN 台账（`/sn`）是否单列导航 | 02 §2 无独立 SN 导航项，T02a 暂归库存 | T05 |
| G-13 | 列表排序规则 | 契约 V1 明确 `order: "unspecified"` | T18 |
| G-14 | 缺少「已逾期」样本 | V1 七条没有逾期项，02 §4 却要求「逾期明确写已逾期」 | 需要补样本，否则该体验项无法验 |
| G-15 | 统计条金额的**宽度预算上限**没有规格依据 | 02 §103 只说「不缩成极小字号、不省略成无法核账的数」，没给金额量级上限或格宽预算。T02b-rev2 按 375px 设计宽度把预算定为 120px，覆盖到千万级；亿级以上落到下限档后可能溢出（`¥128,000,000.00` 估算 120.3px 刚好越界） | T02c 或 T15（账本）按实际资金规模定 |

---

## 3 · 已定但还没做（后续卡片必须处理）

| 编号 | 事项 | 卡在哪 | 归属 |
|---|---|---|---|
| T-03 | 后端三个生产 secret 未写入远端 | 本机无 Cloudflare 登录态 | **补做 `wrangler secret put` 前禁止 `wrangler deploy`** |
| T-04 | 本地 D1 测试入口不存在（历史 harness 已丢失，`backend/package.json` 无 `test` 脚本，未装 `typescript`） | 需重建 | T04 |
| T-05 | 微信平台条件：**AppID 已提供（`wx1b14bf01ef71718d`，2026-09-17）**；小程序主体 / 成员、API 域名、对象存储、店内网络、真机仍未知 | 部分已提供，其余等用户 | 阻塞 T03 / T16 / T21 |
| T-06 | 生产 D1 的 `0004` / `0005` 是否已应用 | 未核实 | T20 |
| T-07 | `permissions` 表实际行内容 | 未核实（契约已改为按代码守卫映射，不依赖表行） | T20 |
| T-08 | 后端仍是 `index.ts` 单文件 1551 行，未拆 `routes/domains/repositories` | 边做边拆 | 各业务卡 |
| T-09 | 小程序只有一个详情页 `packages/sales/order-detail`，售后与回收事项暂也跳它 | 与 02 §2 页面地图有偏差（售后应为 `packages/service/detail`、回收应为 `packages/recovery/detail`） | T12 / T14 |

---

## 4 · 踩过的坑（下次别再踩）

| 编号 | 坑 | 表现 | 正确做法 |
|---|---|---|---|
| P-01 | **同一文件的多处 `Edit` 并行提交会互相覆盖** | 已犯 3 次（T01b / T01-rev1 / T01c），每次白花一轮排查 | 同一文件的多处编辑必须串行；一条消息里只发一个针对该文件的 `Edit` |
| P-02 | **禁止把契约 JSON 整体 `JSON.stringify(…, 2)` 重写** | 会摧毁手工紧凑排版，diff 从 145 行暴涨到 3079 行 | 用纯文本外科替换 |
| P-03 | 生成物**不能手工编辑** | `validate-contracts.mjs` 第 12 节会重建后逐字节比对；`sync-contracts.mjs --check` 也会报 | 改契约源文件 → 重新生成 → 再同步端内 |
| P-04 | **超长单行 JSX 会让 `tsc` 解析失败** | `App.tsx` 里 500+ 字符的 `<Route … element={<Comp 属性={[…嵌套对象…]} />} />` 报 `TS2657` + `TS1005`，逐字符检查无非法字符 | 嵌套数据先提为模块级常量，再 `{...props}` 展开 |
| P-05 | **生成物没做依赖过滤时，前端 `noUnusedLocals` 直接编译失败** | `objects.ts` 全量导入 36 个枚举类型 → 6 处 `TS6196` | 已修生成器：按 `\b名字\b` 过滤实际引用的类型 |
| P-06 | **CSS 变量名不要用裸名** | `index.css` 的 `:root` 已占用 `--line` / `--muted` / `--ink` / `--page-bg`，而 AppShell 会包住报价编辑器 | 新视觉变量统一加前缀（本项目为 `wb-`），作用域限定在壳内 |
| P-07 | **`@testing-library/react` 在本项目不会自动清理 DOM** | vitest 未开 `globals`，多个用例 DOM 累积 → 14 个用例报「found multiple elements」的**假失败** | 测试文件内显式 `afterEach(cleanup)` |
| P-08 | **jsdom 不加载资源，图片 `error` 不会自然触发** | 图片降级路径测不到 | `fireEvent.error(img)` 主动触发；浏览器里 `demo://` 本来就必然失败 |
| P-09 | **改函数声明行时不要把行尾换行放进 `old_string`** | 会把两行粘成一行（T02a 犯过一次，已当场修复） | 只匹配行内容本身 |
| P-10 | 负向测试的注入备份 | 曾散落在根目录 | 统一放 `.validation-*/`（已 gitignore），用完立即删 |
| P-11 | 登记缺口 / 下结论**必须钉规格原文行号** | T01b 曾凭印象把 `Purchase` 登记为缺口，T01-rev1 更正 | 校验脚本第 11 节会验证「引文逐字出现在该行」 |
| P-12 | 校验脚本自身也会写错 | 曾把「公式结果」当「输入项」判空 → 12 项连锁误报 | 依赖检查必须区分输入项与派生项 |
| P-13 | **换壳 / 搬入口时会连同「可见性条件」一起丢掉** | 旧壳对「系统设置」有 `permissions` 判断，T02a 把它移进头像菜单时差点漏掉，那样任何店员都能看到设置入口 | 迁移入口时逐条对着旧实现核对**条件**，不只核对路径；并补测试 |
| P-14 | **用设计稿对齐排版时，按稿上的示例字符数算宽度会漏掉真实渲染** | 设计稿统计条写 `¥12,800`（7 字符、不带分位），真实必须渲染 `¥12,800.00`（10 字符，02 §1 不许掩盖分）→ 等分格装不下，实测被裁（R-14） | 排版对齐时用**真实渲染文案**（含分位、含千分位、含前后缀）算宽度，不能用稿上的示例值；能算就写成约束测试 |

---

## 5 · 环境与凭据现状（不含密钥值）

| 项 | 现状 |
|---|---|
| Git | 仓库 `C:\Users\wuerl\Documents\工作同步\pc-quote`，分支 `main`，基线 `e5ca594`（151 文件），仓库级身份 `wongkd` / `563838884@qq.com` |
| Worker | `pc-backend` —— **生产与测试共用，部署即同时影响 `pc.huangqidong.cn`** |
| D1 | `pc-db`，id `2218dbef-fb7d-4248-8430-07dcd4fd0a17` |
| Pages | 生产 `pc-quote` → `pc.huangqidong.cn`；测试 `erp-quote` → `erp.huangqidong.cn` |
| 回滚锚点 | Worker `7aa5d48b…`；Pages `erp-quote` 首部署 `e54941c1…` |
| 凭据 | `DEEPSEEK_KEY` / `JWT_SECRET` 已转 `wrangler secret`；`PDD_*` 三项在 `backend/.dev.vars`（**未轮换，且远端未写入**） |
| DNS 写入 | 必须用全局密钥 `cfk_…` + `X-Auth-Email` / `X-Auth-Key`；`cfut_…` 只有 Zone 读权限 |
| 本机坑 | 连 `api.cloudflare.com` 偶发 IPv6 超时，Node `fetch` 需 `dns.setDefaultResultOrder('ipv4first')` |

---

## 6 · 未运行的验证（别当成通过）

| 项 | 为什么没跑 |
|---|---|
| 浏览器视觉验收（U01 尺寸 / U02 缩放 / U05 键盘 / U06 首屏主动作） | 本机无 Playwright 等浏览器自动化；本地登录会触达生产后端，T00 已声明避免接触生产 |
| 颜色对比度实测（`danger` 是 02 §1 新增语义色） | 需要浏览器环境 |
| 断网 / 写超时 / 登录过期 / 冲突 / 无权限等界面状态（02 §7） | 无服务端，骨架只实现了「筛选无结果」与「图片失败」两种 |
| **微信开发者工具编译**（T02b 的「小程序必须编译出原生页面」） | ✅ **T02b-rev2 已跑通**：`cli.js preview` 实际编译通过、AppID 正确识别、无编译错误，并首次拿到体积（总 77.4KB / 主包 68.5KB / 分包 9.0KB）。**但 `preview` 不产出截图，渲染结论仍未验**；`preview` 会生成预览码（约 25 分钟失效），这是本机唯一能拿到真机观感的通道 |
| 小程序真机 / iOS / Android | AppID 已配置（现由本项目单独使用）；**模拟器实拍已确认今天页渲染正常**（T02b §14）；**真机条件仍缺** —— 02 §188 要求的 iOS / Android 实机截图未提供 |
| 小程序视觉验收（320 / 375 / 390 / 430、字体放大、返回恢复的滚动位置） | 需开发者工具或真机。今天页已在模拟器实拍过一次（T02b §14），**R-14 修复后的形态尚未实拍**（T02b-rev2 §7）；详情页仍从未在渲染环境里看过 |
| 后端集成、并发、幂等 | T04 的本地 D1 测试入口还没重建 |

---

## 7 · 已解决（留档，避免重复讨论）

| 编号 | 事项 | 结论 |
|---|---|---|
| R-01 | `Purchase` 是否需要存储状态 | **不需要**，在途 = 订购 − 到货 − 取消，是派生值（T01-rev1 更正 T01b 的误判） |
| R-02 | `Receipt` 的 `receiptLines` / `unitCostCents` / `inspectionDisposition` 是否丢失 | **没丢**，在 `Receipt` 上；04 §2 把 `Purchase / Receipt` 写在一行，契约拆成两个对象 |
| R-03 | 旧 `library` 表的作用 | 代码零 SQL 引用，实际读写 `hardware`；仅作权限码 / 路由名 |
| R-04 | 旧 `quotes` 表 | `ORDER BY updated_at DESC LIMIT 1` 的**单行工作副本**，无版本序列 → T07 不能把旧行当 QuoteVersion |
| R-05 | `cost/view` / `margin/view` 的语义 | **字段级权限**，只决定响应是否返回成本 / 毛利，不守卫动作 |
| R-06 | 生成物能否共享成一个 TS 包 | 不能：网页 Vite 与小程序原生编译链不同；改为从 `contracts/v1` 单向生成到各端 |
| R-07 | 优惠分摊的算法 | 必须整数运算：行分子 = `discountCents × grossCents`、分母 = `ΣgrossCents`、取整得商、取模得余数；浮点会在小数第 6 位才分出余数大小 |
| R-08 | 演示标识怎么承载 | 由 ID 前缀 `DEMO-` 承载，不新增协议字段 |
| R-09 | 生成物目标状态回写（原 T-01 / T-02） | **T02b 已回写**：两端 `targets.status` 均为 `done`，留 `revisions` 记录（T02b-rev1）。小程序 `miniprogramRoot` 取项目根，故 `miniprogram/contracts/generated` 与规划值一致，未改任何 `rootPath` |
| R-10 | `manifest.json` 的 `targets` 是生成器内硬编码副本 | **T02b 已修**：改为从 `fixtures.json` 读取，保持单一来源 |
| R-11 | 小程序端能否直接跑 TS 测试 | **可以**：Node 22 的类型擦除可直接加载 `.ts`，但**不解析无扩展名的相对导入**，故被测试引用的模块只能含 `import type`；`node --test <目录>` 在本机不工作，须写 `node --test "tests/*.test.mjs"` |
| R-12 | 微信开发者工具的自动化与截屏 | **三条限制**（均与项目代码无关）：① `cli.js open` 对**已打开的项目**报 `TypeError: d.on is not a function`（`openOrCreateWindow` 缺陷），须先 `cli.js quit` 再 open；② 本版本 `cli.js auto` **没有 `--auto-port` 选项**，`miniprogram-automator` 的 `launch()` 因此连不上 → **自动化截图不可用**；③ 本机安全策略**封死** `Add-Type`、`[Reflection.Assembly]::LoadWithPartialName`、`New-Object -ComObject` 三种截屏途径。⇒ 要小程序截图，只能在工具界面手动截 |
| R-13 | **小程序项目归属（已裁定）** | **`pc-quote/miniprogram` 是本项目唯一的小程序项目**（2026-09-17 用户选 A）。原同盘另一条线 `工作同步\装一下机小程序`（云开发 QuickStart 模板，58 文件 / 1.4MB，**内容已核实无任何业务代码**）按用户指示**已于 2026-09-17 23:15 移除**，完整保留在 `pc-quote/backups/装一下机小程序-已移除-20260917`（放该目录是因为 `backups/` 已被 gitignore）。**AppID `wx1b14bf01ef71718d` 现已归本项目单独使用**。另：在工具里「打开项目」必须选到 **`…\pc-quote\miniprogram` 这一层**；只选到 `…\pc-quote` 会报「在项目根目录未找到 app.json」 |
| R-14 | **统计条金额溢出** | ✅ **T02b-rev2 已修**。根因不是字号选错，而是**格宽与内容不匹配**：四格等分时单格内容宽 ≈89.75px，而 `¥12,800.00` 是 10 字符 ≈117px（T02b §14 的记载写「`.metric-value` 用 `--mp-fs-amount` 48rpx」与代码不符 —— 排版修订已降到 40rpx，记载没跟上，rev2 已更正）。修法：金额格 `min-width: 260rpx`（02 §1 明文许可「金额位数超过样图时允许布局增长」）+ 数值按字符类别分档（40/36/32/28rpx，下限 28rpx、永不省略）。见 [2026-09-17-T02b-rev2](../verification/2026-09-17-T02b-rev2/README.md)。**修复后的渲染仍未实拍**（本机截不了屏），视觉确认待做；布局是否维持等分见 §1 的 D-F |
