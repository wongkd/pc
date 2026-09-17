# 下一对话交接提示词

> 用途：把下面代码块里的内容整段复制到新对话，即可无缝接手。
> 维护人：每次收工前更新本文件（改「收工状态」与「下一步」两节即可）。

---

```
继续 pc-quote 项目（装机店经营工作台）。

【先做这三件事，不要跳过】
1. 读 docs/OPEN-ITEMS.md（跨卡片未决项 + 踩坑台账，含需要负责人裁定的项）
2. 读 docs/verification/2026-09-17-T02b/README.md，**重点 §12–§14**（排版对齐、工具踩坑、模拟器实拍验收）
3. git log --oneline -10 确认进度到哪张卡

【项目是什么】
电脑硬件报价系统 → 正在演化为「装机店经营工作台」（电脑店轻量 ERP：报价/订单/采购/库存 SN/
装机交付/售后/收支毛利）。前端 React 19 + Vite + TS；后端 Cloudflare Workers + D1；
两端（电脑网页 + 微信小程序）共用 contracts/v1 契约（唯一协议来源，从契约单向生成到两端）。
规划入口：docs/plans/2026-09-17-web-wechat-plan/（7 份，T00–T22 卡）。
推进规则：**一次只执行一张子卡**，每卡产 docs/verification/<日期>-<卡号>/README.md。

【收工状态 · 2026-09-17 23:16】
- 已完成：T00 / T01（契约 v1 冻结，校验 3047 项）/ T02a（网页六导航壳 + 今天工作台）/
  T02b（小程序壳 + 契约目标回写 + **排版层对齐设计稿**）
- 小程序端：`miniprogram/`，原生 tabBar 四项（今天/开单/库存/更多）+ 分包
  `packages/sales/order-detail`。AppID `wx1b14bf01ef71718d` 已配。
  **今天页已在开发者工具模拟器实拍确认**（截图：docs/verification/2026-09-17-T02b/screenshots/today-01.png）
- 项目归属已裁定（用户选 A）：**`pc-quote/miniprogram` 是本项目唯一的小程序项目**。
  同盘原「装一下机小程序」（云开发模板，无业务代码）已移除，完整保留在 backups/（已 gitignore）。
- 验证基线：小程序 32 用例 ✅、tsc --noEmit ✅、check-pages ✅、check-classes ✅、
  check-contracts ✅；网页端 50 用例 + build ✅，lint **39 项既有失败**（不是新引入，别说成通过）
- **待修缺陷**：统计条「待收款」金额溢出（`¥12,800.00` 超宽被裁）→ OPEN-ITEMS **R-14**

【下一步优先级】
1. **修 R-14**：统计条金额溢出。必须同时满足 02 §103「不把 ¥128,000.50 缩成极小字号
   或省略成无法核账的数」—— 既要放得下，又不能缩到不可读。改完补一条约束测试。
2. **补视觉验收缺口**：在工具模拟器里看 `packages/sales/order-detail` 详情页、
   320 / 375 / 430 宽度档、字体放大、对比度、页面末尾的数据来源说明条。
3. **T02c 组件提取**：TaskRow / DeviceSummary / ProgressSteps / AmountActionBar / Feedback。
   注意 02 §T02c 明确要求**不共享 React 组件给微信**，两端各自实现、共用契约与口径。
4. 之后 T03 / T04 可并行（T03 仍缺微信主体 / 成员 / API 域名）。

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
  · **本机安全策略封了 PowerShell 截屏**（Add-Type / 反射加载 / COM 全被拒）→ 要截图只能在工具界面手动截。
  · CLI spawn 的 IDE 实例会随 CLI 退出而关；要工具留着得手动启动工具本体。
- 工具会**自动改写 `miniprogram/project.config.json`**（加 minifyWXML + 重排格式），
  跑工具验证前后先看 `git status`，别把自己的编辑和工具的自动改写混在一起。
- 小程序 JSCore 的 `toLocaleString` 支持不完整 → 金额格式化一律用纯字符串运算（已在 amount-view.ts）。
- `@testing-library/react` 在本项目不自动清理 DOM（vitest 未开 globals）→ 测试文件内显式 `afterEach(cleanup)`。
- jsdom 不加载资源 → 图片降级要用 `fireEvent.error` 主动触发。

【证据等级要求】
- 模拟器截图 ≠ 真机；设计原型 ≠ 已批准设计；本地原型 ≠ 已上线。
- 02 §188 明确：小程序验收截图**不能拿 mobile-review.html 截图代替**。
- 未运行的检查一律如实写「未运行」，不得写成通过。
```
