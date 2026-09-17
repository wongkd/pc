# 下一对话交接提示词

> 用途：把下面代码块里的内容整段复制到新对话，即可无缝接手。
> 维护人：每次收工前更新本文件（改「收工状态」与「下一步」两节即可）。

---

```
继续 pc-quote 项目（装机店经营工作台）。

【先做这三件事，不要跳过】
1. 读 docs/OPEN-ITEMS.md（跨卡片未决项 + 踩坑台账，含需要负责人裁定的项）
2. 读 docs/verification/2026-09-17-T04/README.md（最新卡：一致性与幂等基础设施）
   → 如需回看前端/小程序状态，再读 docs/verification/2026-09-17-T02b-rev2/README.md
3. git log --oneline -10 确认进度到哪张卡

【项目是什么】
电脑硬件报价系统 → 正在演化为「装机店经营工作台」（电脑店轻量 ERP：报价/订单/采购/库存 SN/
装机交付/售后/收支毛利）。前端 React 19 + Vite + TS；后端 Cloudflare Workers + D1；
两端（电脑网页 + 微信小程序）共用 contracts/v1 契约（唯一协议来源，从契约单向生成到两端）。
规划入口：docs/plans/2026-09-17-web-wechat-plan/（7 份，T00–T22 卡）。
推进规则：**一次只执行一张子卡**，每卡产 docs/verification/<日期>-<卡号>/README.md。

【收工状态 · 2026-09-18（T03b 收工后）】
- 已完成：T00 / T01（契约 v1 冻结，校验 3109 项）/ T02a / T02b / T02b-rev2 /
  T04（一致性与幂等基础，21 用例）/ **T05a（商品、实物与期初库存，58 用例，2026-09-18）** /
  **T03b（两端请求层与错误码映射，2026-09-18）← 本轮新增**；T02c 已裁定跳过。
  （图片与动效资源补充 2026-09-18 已单独提交：四类 AI 示意图接入两端演示，非业务卡。）
- **T03b 做了什么**（细节见 docs/verification/2026-09-18-T03b/README.md）：
  · 两端请求核心（零运行时依赖、同构）：requestId 生成/复用、载荷摘要、Idempotency-Key、
    超时→「结果未知」不当失败、401/403 区别处理、错误码 → 结构化行为枚举（非文本）。
  · 核心规则：结果未知后重试**复用同一 requestId**（防重复扣款）；载荷变了换新 ID；
    只在服务端明确成功后清除；AUTH_REQUIRED 保留草稿与 pending；SESSION_REVOKED 全清（03 §8 L194）。
  · 新增**跨端一致性门禁** `node contracts/tools/check-client-parity.mjs`（36 项）——
    T-10（金额口径无门禁导致方向反转）的教训不再重演；当场抓出「撤权没清 pending」的缺口。
  · **请求层未被任何页面使用**、未连真实后端、backend/index.ts 一行未动、契约冻结未动。
  · 新待裁定项 **D-J**（错误行为枚举是否升入契约，与 D-A/D-H 合并考虑）。
- 验证基线（本轮实测，2026-09-18）：后端 **58 用例** ✅、前端 **91 用例**（8 文件）✅、
  小程序 **67 用例**（6 文件）✅、契约 **3109 项** ✅、两端生成物防漂移 ✅、
  后端错误码防漂移 ✅、**跨端门禁 36 项** ✅、两端 tsc ✅、wrangler dry-run ✅（未部署）。
  lint 全仓既有失败未跑未修（新文件 src/api 0 错误）。
- **下一对话开卡提示**：docs/T05-KICKOFF.md 已过时（按 T05a 写的，T05a 已完成）。

【下一步优先级】
1. **T03a（后端绑定码 / 微信身份交换 / 撤权登出）** —— 阻塞在负责人条件（OPEN-ITEMS T-05）：
   需要微信小程序 **AppSecret**（只进 wrangler secret / .dev.vars）、**主体类型**（个人/企业）、
   **API 域名**（小程序只能请求登记过的 HTTPS 域名）。条件齐了才开卡。
2. **T05b（网页库存表格 / 逐件视图，小程序搜索 / 实物页）** —— 请求层已就绪，但
   B12/B13 的 HTTP 路由仍未接（依赖 T03a）。开卡前先裁定接入方式：
   演示数据 + 请求层并存，还是等 T03a 一次接通。页面必须走 createWebApiClient /
   createMiniProgramApiClient，不得绕过核心自己拼 fetch / wx.request。
3. **T05c（样本执行）** —— 把 T05a 已测通的约束落成契约 fixtures（同型号不同实物、
   无 SN 二手、客户寄存、未知成本、重复 SN、数量守恒）。
4. 待负责人裁定：**D-J**（新，错误行为枚举）、**D-A / D-H**（是否建 contracts/v2）、
   **C-2**（specs 数组/字符串冲突）、**G-07** 停用语义、**D-C**（六导航权限可见性，T03 装配权限时迟早要定）。

【操作铁律（踩过的坑，别重踩）】
- **注释里不要出现「星号紧跟斜杠」**：T04 的文件头写了目录通配 `.validation-*` + `/`，
  块注释被提前闭合，报错却指向下一行 `SyntaxError: Unexpected identifier '$'`（P-15）。
  看语法错误先回看前文。
- **miniflare 的 scriptPath 不编译 TypeScript**（只有 wrangler 走 esbuild）→ 报
  `Unable to parse ...: Unexpected token`。要测 TS 代码就用 esbuild 预打包（P-16）。
- **D1 的 exec() 按换行切分语句**，多行 DDL 会被切坏；触发器体内还含分号。
  用 `backend/tests/lib/sql.mjs` 的拆分器（P-17）。
- **`node --test` 不会因测试跑完就退出**：留下未 dispose 的句柄会挂住管道，
  外面完全看不到输出，像卡死。**日志重定向到文件再读，别用管道 tail**（P-18）。
- **契约 JSON 禁止整体 JSON.stringify 重写**（紧凑排版被毁），用纯文本外科替换。
  改完必须 `git diff --stat` 确认是「纯追加」。
- **同一文件的多处 Edit 必须串行**，一条消息里发多个会互相覆盖（已犯 3 次）。
- 改动**必须跑**：`npm --prefix backend test`、`npm --prefix frontend run test`、
  `npm --prefix miniprogram test`、`node contracts/tools/validate-contracts.mjs`、
  两端 `scripts/sync-contracts.mjs --check`、`node backend/scripts/sync-error-codes.mjs --check`。
- **微信开发者工具**（`D:\Software\微信web开发者工具`，用 `./node.exe ./cli.js <cmd>` 驱动，
  不是 cli.bat）：
  · 「打开项目」必须选到 **`…\pc-quote\miniprogram` 这一层**；选浅一层会报
    「在项目根目录未找到 app.json」。
  · `cli.js open` 对**已打开的项目**会报 `TypeError: d.on is not a function` → 先 `quit` 再 open。
  · 本版本 `cli.js auto` **没有 `--auto-port`** → `miniprogram-automator` 连不上，
    自动化截图不可用。
  · 本机安全策略**封死 PowerShell 截屏**（Add-Type / 反射 / COM 全拒）→ 要截图只能手动。
  · **编译验证走 `preview`**：`node.exe cli.js preview --project "<…\pc-quote\miniprogram>"
    --qr-format image --qr-output "<gitignore 内的路径>"`，会真编译、报体积、给预览码
    （约 25 分钟失效，扫码可在手机看真机观感）。它**不产出截图**。
  · 工具会**自动改写 `project.config.json`**，跑完先看 `git status`。
- 小程序 JSCore 的 `toLocaleString` 支持不完整 → 金额格式化一律用纯字符串运算。
- `@testing-library/react` 在本项目不自动清理 DOM → 测试文件内显式 `afterEach(cleanup)`。
- jsdom 不加载资源 → 图片降级要用 `fireEvent.error` 主动触发。
- **用设计稿核对排版时，宽度按「真实渲染文案」算，别用稿上的示例值**（设计稿写 `¥12,800`，
  真实必须渲染 `¥12,800.00`）→ 这类约束要写成可机械执行的测试。
- **Windows 下动态 `import()` 裸绝对路径（`c:/…`）报 ERR_UNSUPPORTED_ESM_URL_SCHEME**（P-22）→
  用 `pathToFileURL(p).href`；T03b 的 `contracts/tools/check-client-parity.mjs` 有现成写法。
- **两端请求层的铁律（T03b 起）**：页面接入必须走 `createWebApiClient` /
  `createMiniProgramApiClient`，不得绕过核心自己拼 fetch / wx.request；
  结果未知（unknownResult）**不是失败**，写动作先用原 requestId 查 operation；
  改错误行为必须**两端同步改**并跑跨端门禁。

【证据等级要求】
- 模拟器截图 ≠ 真机；设计原型 ≠ 已批准设计；本地原型 ≠ 已上线。
- 02 §188 明确：小程序验收截图**不能拿 mobile-review.html 截图代替**。
- 未运行的检查一律如实写「未运行」，不得写成通过。
- **本轮特别声明**：T04 的「并发」是同一实例内两条请求同时在途、由数据库约束决出胜者，
  **不等于跨实例/跨机房压测**；0006 **未应用到任何远端**；生产 D1 的 0004/0005 是否已应用
  本身仍未核实。
```
