# 下一对话交接提示词

> 用途：把下面代码块里的内容整段复制到新对话，即可无缝接手。
> 维护人：每次收工前更新本文件（改「收工状态」与「下一步」两节即可）。

---

```
继续 pc-quote 项目（装机店经营工作台）。

【先做这三件事，不要跳过】
1. 读 docs/OPEN-ITEMS.md（跨卡片未决项 + 踩坑台账，含需要负责人裁定的项）
2. 读 docs/verification/2026-09-17-T02b-rev2/README.md（最新卡：R-14 金额溢出修复）
   → 再读 docs/verification/2026-09-17-T02b/README.md 的 §12–§14（排版对齐、工具踩坑、模拟器实拍）
3. git log --oneline -10 确认进度到哪张卡

【项目是什么】
电脑硬件报价系统 → 正在演化为「装机店经营工作台」（电脑店轻量 ERP：报价/订单/采购/库存 SN/
装机交付/售后/收支毛利）。前端 React 19 + Vite + TS；后端 Cloudflare Workers + D1；
两端（电脑网页 + 微信小程序）共用 contracts/v1 契约（唯一协议来源，从契约单向生成到两端）。
规划入口：docs/plans/2026-09-17-web-wechat-plan/（7 份，T00–T22 卡）。
推进规则：**一次只执行一张子卡**，每卡产 docs/verification/<日期>-<卡号>/README.md。

【收工状态 · 2026-09-17 23:40】
- 已完成：T00 / T01（契约 v1 冻结，校验 3047 项）/ T02a（网页六导航壳 + 今天工作台）/
  T02b（小程序壳 + 契约目标回写 + **排版层对齐设计稿**）/ **T02b-rev2（修 R-14 统计条金额溢出）**
- 小程序端：`miniprogram/`，原生 tabBar 四项（今天/开单/库存/更多）+ 分包
  `packages/sales/order-detail`。AppID `wx1b14bf01ef71718d` 已配。
  **今天页已在开发者工具模拟器实拍确认过一次**（截图：docs/verification/2026-09-17-T02b/screenshots/today-01.png）
  —— 但那是**修复前**的形态。
- 项目归属已裁定（用户选 A）：**`pc-quote/miniprogram` 是本项目唯一的小程序项目**。
  同盘原「装一下机小程序」（云开发模板，无业务代码）已移除，完整保留在 backups/（已 gitignore）。
- **R-14 已修**（提交 `b8ea5e8`）：根因是**格宽与内容不匹配**（四格等分单格内容宽 ≈89.75px，
  带分位金额 10 字符 ≈117px），不是字号选错。修法＝金额格 `min-width: 260rpx` + 数值按字符类别
  分档（40/36/32/28rpx，下限 28rpx、永不省略）。设计稿那一行写 `¥12,800`（不带分位）所以看着够用，
  02 §1 却要求保留分位 —— **这是设计稿与规格的冲突，不是笔误**（OPEN-ITEMS P-14）。
- 验证基线：小程序 **39 用例** ✅、tsc --noEmit ✅、check-pages ✅、check-classes ✅、
  check-contracts ✅、契约校验 3047 项 ✅；**`cli.js preview` 实际编译通过** ✅
  （总 77.4KB / 主包 68.5KB / 分包 9.0KB）；网页端 50 用例 + build ✅，
  lint **39 项既有失败**（不是新引入，别说成通过）
- **待负责人裁定**：OPEN-ITEMS **D-F** —— 统计条修好后不再四格等分（1 宽 + 3 窄）。
  维持严格等分只能把金额压到 ≈30rpx（比同排计数小 25%）。
- **本轮另做了 T02c 前置勘察**（只读，未动代码）：发现 **D-G**（详情页「阶段」两端做法相反，
  卡住 ProgressSteps）与 **T-10**（两端金额口径无门禁 + 网页端 `store_due` 方向反转）。
  结论与建议顺序写在下节「下一步优先级」第 2 条，别跳过。

【下一步优先级】
1. **补视觉验收**（当前最大缺口，且必须在工具/真机里由人完成）：
   - 今天页统计条复拍一张（确认 `¥12,800.00` 不被裁、不换行）；
   - 逐档切 320 / 375 / 390 / 430；系统字号放大一档再看；
   - 详情页 `packages/sales/order-detail`（从未在渲染环境里看过）；
   - 页面末尾的数据来源说明条（要滚到底）、返回恢复的滚动位置；
   - 对比度（`danger` 是 02 §1 新增语义色）。
2. **T02c 组件提取**（卡范围：TaskRow / DeviceSummary / ProgressSteps / AmountActionBar / Feedback；
   02 §T02c 明确要求**不共享 React 组件给微信**，两端各自实现、**共用契约与口径**）。
   ⚠️ **开卡前先看 2026-09-17 勘察结论**（本轮只勘察未动代码）：
   · **有硬阻塞（OPEN-ITEMS D-G）**：网页端 `WorkbenchTodayPage.tsx` 已**硬编码三步**
     `['已确认成交','备货 / 检测','收款与交付']` 并用「有没有卡点」**推测**当前进度；
     小程序端按 T02b D8 **明确拒绝画推测进度**，只写承位说明 → 同一规格点两端相反。
     `ProgressSteps` 提取什么，取决于「阶段」数据从哪来，需先裁定（三选项见 D-G）。
   · **两端金额口径无任何机器门禁（OPEN-ITEMS T-10）**：两端各写一份 `describeAmount`。
     并排实跑发现网页端**缺 `store_due` 分支**（应付客户被显示成「待收」，方向反转）+
     结清兜底不一致。这两条 **V1 样本未覆盖故当前不触发**，T11/T14 引入退款与超额收款后会撞上。
     ⇒ T02c 第一项建议就做「跨端口径一致性门禁」：把契约 V1 样本 + 边界喂给两端实现，
     断言语义（方向 / 是否计入待收 / 是否用 ¥0 冒充 / 结清是否带提醒）一致。
     注意网页端 `describeAmount` 目前**未导出**、在 TSX 页面内，得先提出来才能做真门禁。
   · **小程序端可提取的有 4 个**（TaskRow / DeviceSummary / AmountActionBar / Feedback），
     **ProgressSteps 无内容可提**。技术风险：自定义组件默认样式隔离 → `app.wxss` 的工具类
     （`.mp-tabular` 等）在组件内可能不生效（`--mp-*` 变量靠继承仍可用）；
     `check-classes.mjs` 的语义要跟着改（组件有自己的 wxss + usingComponents），否则会**假通过**。
     这两点都无法在看不见渲染的情况下确认 → 建议**先在工具/真机验收完再做组件提取**。
   · 顺手把统计格与任务行的视图模型从页面 ts 里提成纯模块（现在有一条正则查源码的结构检查，
     届时换成真正的单元测试）。
3. 之后 T03 / T04 可并行（T03 仍缺微信主体 / 成员 / API 域名）。

【操作铁律（踩过的坑，别重踩）】
- **契约 JSON 禁止整体 JSON.stringify 重写**（紧凑排版被毁），用纯文本外科替换。
- **同一文件的多处 Edit 必须串行**，一条消息里发多个会互相覆盖（已犯 3 次）。
- 改动**必须跑**：`npm --prefix miniprogram test`、`npm --prefix frontend run test`。
- 小程序端：`check-pages`（页面注册↔磁盘）、`check-classes`（wxml 类名↔样式定义）、
  `scripts/sync-contracts.mjs --check`（生成物三方防漂移）。
- **微信开发者工具**（`D:\Software\微信web开发者工具`，用 `./node.exe ./cli.js <cmd>` 驱动，
  不是 cli.bat）：
  · 「打开项目」必须选到 **`…\pc-quote\miniprogram` 这一层**；选浅一层（`…\pc-quote`）
    会报「在项目根目录未找到 app.json」。
  · `cli.js open` 对**已打开的项目**会报 `TypeError: d.on is not a function` → 先 `cli.js quit` 再 open。
  · 本版本 `cli.js auto` **没有 `--auto-port`**，miniprogram-automator 连不上 → **自动化截图不可用**。
  · **编译验证走 `preview`**：`node.exe cli.js preview --project "<…\pc-quote\miniprogram>" --qr-format image --qr-output "<gitignore 内的路径>"`。
    它会真编译、报 AppID、给体积报告（T02b-rev2 实测 总 77.4KB / 主包 68.5KB / 分包 9.0KB），
    并在**不打开新窗口**的前提下产出预览码（约 25 分钟失效）→ 扫码即可在自己手机上看真机观感，
    这是本机唯一绕开「截不了屏」的通道。登录态用 `cli.js islogin` 查（应输出 `{"login":true}`）。
  · 服务端口状态在 `%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\Default\.ide-status`（`On` = 已开）。
  · **本机安全策略封了 PowerShell 截屏**（Add-Type / 反射加载 / COM 全被拒）→ 要截图只能在工具界面手动截。
  · CLI spawn 的 IDE 实例会随 CLI 退出而关；要工具留着得手动启动工具本体。
- 工具会**自动改写 `miniprogram/project.config.json`**（加 minifyWXML + 重排格式），
  跑工具验证前后先看 `git status`，别把自己的编辑和工具的自动改写混在一起。
- 小程序 JSCore 的 `toLocaleString` 支持不完整 → 金额格式化一律用纯字符串运算（已在 amount-view.ts）。
- `@testing-library/react` 在本项目不自动清理 DOM（vitest 未开 globals）→ 测试文件内显式 `afterEach(cleanup)`。
- jsdom 不加载资源 → 图片降级要用 `fireEvent.error` 主动触发。
- **用设计稿核对排版时，宽度按「真实渲染文案」算，别用稿上的示例值**：设计稿统计条写 `¥12,800`，
  实际必须渲染 `¥12,800.00`（02 §1 不许为了好看掩盖分），等分格因此装不下 → R-14。
  这类约束要写成可机械执行的测试，不要靠眼看。

【证据等级要求】
- 模拟器截图 ≠ 真机；设计原型 ≠ 已批准设计；本地原型 ≠ 已上线。
- 02 §188 明确：小程序验收截图**不能拿 mobile-review.html 截图代替**。
- 未运行的检查一律如实写「未运行」，不得写成通过。
```
