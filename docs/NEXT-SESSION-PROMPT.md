# 下一对话交接提示词

> 用途：把下面代码块里的内容整段复制到新对话，即可无缝接手。
> 维护人：每次收工前更新本文件（改「收工状态」与「下一步」两节即可）。
> 专项开卡：只做 **T05a** 时，改用 [T05-KICKOFF.md](./T05-KICKOFF.md)（更聚焦，已钉规格行号）。

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

【收工状态 · 2026-09-17】
- 已完成：T00 / T01（契约 v1 冻结，校验 3047 项）/ T02a（网页六导航壳 + 今天工作台）/
  T02b（小程序壳 + 排版层对齐设计稿）/ T02b-rev2（修 R-14 统计条金额溢出）/
  **T04（一致性与幂等基础 a/b/c）← 本轮新增**
- 负责人裁定（2026-09-17）：**跳过 T02c**（组件提取），视觉细化并入 G2 收尾。
  本轮只单独记下一个真 bug 隐患：网页端 describeAmount 缺 store_due 分支，
  「应付客户」被显示成「待收」——方向反转（OPEN-ITEMS T-10），尚未修。
- **T04 做了什么**（这是本轮唯一改动，细节见验证记录）：
  · 新增迁移 `backend/migrations/0006_consistency_core.sql`：
    operations（幂等记录）/ assertion_guards（守卫表 + RAISE 触发器）/
    entity_version_log（版本日志）/ operation_failures（脱敏诊断）。
    **只新增，未动 0000–0005 任何表**。
  · 新增 `backend/src/domains/operations.ts`：幂等执行器 runIdempotent、
    守卫 guardStatement、版本推进 bumpVersionStatement、结果查询 queryOperation。
  · 新增 `backend/scripts/sync-error-codes.mjs`：契约错误码单向生成到后端
    （生成物 `backend/src/generated/error-codes.ts`，可 `--check` 防漂移）。
  · 新增 `backend/tests/`：本地 D1 测试入口。**命令 `npm --prefix backend test`，21 用例通过**。
  · 契约 `contracts/v1/legacy-mapping.json` 纯追加 51 行（登记 4 张新表，校验脚本要求
    「迁移表必须被映射覆盖」）。未改任何枚举/字段/校验规则。
  · `backend/src/index.ts` **一行未动**；旧 Worker 与新基础设施暂未接线。
- **T04 的核心结论（后续所有业务卡都要用）**：
  · **D1 里「条件 UPDATE 影响 0 行」不是报错**，批次会继续跑 → 静默产生半截账。
    已实测复现（反例测试），这是 T04 存在的唯一理由。
  · 解法是**约束即断言**，不靠「检查影响行数」：
    幂等 → UNIQUE(store_id, request_id)；有效逐件预留 → 部分唯一索引 WHERE status='active'；
    非负/不超额 → CHECK；其余复合条件 → assertion_guards 守卫 + RAISE(ABORT, code)
    （实测能把契约错误码带进异常消息）。
  · **版本推进用「插入版本日志」**，不要用「条件 UPDATE + 查影响行数」——
    并发下后者会把别人的推进误判成自己的成功（主键 (entity_type, entity_id, version)
    天然决出唯一胜者）。
  · **不依赖 changes()、不依赖 Worker 内存锁**（D1 禁了 sqlite_version()；
    changes() 是连接级的，跨语句不可靠）。
  · ⚠️ **后续卡必须遵守**：幂等记录与业务语句在同一个 batch 内写入，因此
    **动作结果不能依赖自增主键**（batch 内取不到自增 ID）——
    实体 ID 必须在拼 SQL 之前由服务端生成。
- 验证基线（本轮实测）：后端 **21 用例** ✅、契约校验 ✅ 3047 项、两端生成物防漂移 ✅、
  后端错误码防漂移 ✅、前端 50 用例 ✅ + build ✅、小程序 39 用例 ✅、
  `wrangler deploy --dry-run` ✅（99.52 KiB，**未部署**）。
- **顺带做了的只读检查**：`backend/tests/lib/build.mjs` 用 esbuild 预打包 TS 供测试调用；
  这是为了绕开「miniflare 的 scriptPath 不编译 TS」与「Node 类型擦除不解析无扩展名导入」
  两个限制，不必为此改生产代码的导入风格。

【下一步优先级】
1. **T03（身份、微信绑定与请求层）** —— 仍缺微信主体 / 小程序成员 / API 域名（T-05）。
   可先做不依赖微信的部分：T03b 两端请求封装 + 错误码映射 + 401/403 + requestId 保存。
   ⚠️ T03 必须保证 runIdempotent 的 storeId / actorUserId **来自会话**，
   绝不采信客户端请求体——T04 的接口目前只是「由调用方传入」。
2. **T05（商品、实物与期初库存）** —— 前置 T04 已就绪，**这是第一张能让人真用起来的卡**。
   开卡前先读 04 §2 的 Product / StockBalance / StockItem 与 05 卡面；
   写库一律走 runIdempotent + 约束断言，不要新写裸 SQL。
3. T07/T08 之前需要负责人裁定 **D-H**（operations.result_json 是否升入契约）与
   **D-A**（amountSummary / primaryAction 是否升入 objects.json）——两者都涉及是否建 contracts/v2。

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

【证据等级要求】
- 模拟器截图 ≠ 真机；设计原型 ≠ 已批准设计；本地原型 ≠ 已上线。
- 02 §188 明确：小程序验收截图**不能拿 mobile-review.html 截图代替**。
- 未运行的检查一律如实写「未运行」，不得写成通过。
- **本轮特别声明**：T04 的「并发」是同一实例内两条请求同时在途、由数据库约束决出胜者，
  **不等于跨实例/跨机房压测**；0006 **未应用到任何远端**；生产 D1 的 0004/0005 是否已应用
  本身仍未核实。
```
