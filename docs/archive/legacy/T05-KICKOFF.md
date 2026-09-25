# T05a 开卡提示词

> 用法：把下面代码块里的内容**整段复制**到新对话即可接手。
> 生成：2026-09-18（T04 收工后）。适用：只做 T05a（后端），不含界面。

---

```
继续 pc-quote 项目（装机店经营工作台），本次只执行 **T05a**（商品、实物与期初库存的后端实现）。
不要顺手做 T05b 界面、不要碰 T03、不要动前端与小程序。

【先做这三件事，不要跳过】
1. 读 docs/OPEN-ITEMS.md（未决项 + 踩坑台账，含需负责人裁定的项）
2. 读 docs/verification/2026-09-17-T04/README.md，**特别是 §3「核心设计决策」**——
   本卡每一次写库都必须遵守它
3. git log --oneline -6 确认进度停在 `df2a718`（T04）；`git status` 应为干净

【项目是什么】
电脑硬件报价系统 → 正在演化为「装机店经营工作台」（电脑店轻量 ERP：报价/订单/采购/库存 SN/
装机交付/售后/收支毛利）。前端 React 19 + Vite + TS；后端 Cloudflare Workers + D1；
两端（电脑网页 + 微信小程序）共用 contracts/v1 契约（唯一协议来源，从契约单向生成到两端）。
规划入口：docs/plans/2026-09-17-web-wechat-plan/（7 份，T00–T22 卡）。
推进规则：**一次只执行一张子卡**，每卡产 docs/verification/<日期>-<卡号>/README.md。
当前进度：T00 / T01 / T02a / T02b / T02b-rev2 / **T04** 已完成；T02c 已裁定跳过。

【T05 卡原文（05-implementation-tasks.md）】
> T05 · 商品、实物与期初库存
> - 前置：T04；范围：inventory 域、必要增量迁移、两端库存列表 / 详情。
> - T05a：Product、StockItem、数量余额、流水、客户财产边界，旧 hardware / SN 映射；
>   实现查询与受控期初记录 B12 / B13。
> - T05b：网页库存表格 / 逐件视图，小程序搜索 / 实物页；成本按权限，数量构成能点开。
> - T05c：执行「同型号不同实物、无 SN 二手、客户寄存、未知成本、重复 SN、数量守恒」样本。
> - 通过：可卖 / 已订 / 待处理 / 在途不会混算；不从历史 SN 表数量直接推断期初库存。
本次**只做 T05a**（含必要的迁移、查询与受控期初）。T05b 界面与 T05c 的样本执行
若能在同一卡内顺带覆盖则做，否则明确留下，不要假装完成。

【必须读的规格（已钉到行，别凭印象）】
- 03-domain-rules.md **§1 全域不变量**（第 13 行 R03：库存必须区分门店所有与客户所有）
- 03-domain-rules.md **§4 库存与采购（第 84–108 行）**，其中：
  · 第 84 行：自有在库量 = 可卖 + 已订 + 待处理，三类互斥；在途不算在库；客户保管另列
  · 第 86 行：是否逐件管理是商品属性；二手一律逐件；无厂商 SN 的二手也有内部唯一 ID；
    SN 保留原始值并规范化检索；**重复 SN 进人工核对，不自动合并所有权**
  · 第 88–98 行：事件 → 数量变化对照表（成交预留、领料装机、交付、取消、退回、报损…）
  · 第 100 行：待检预留件故障时**原子执行**撤销占用 → 待处理 → 原单缺件，不得重复扣减
- 04-data-and-api.md **§2 第 19–21 行**：Product / StockBalance / StockItem 最低字段与约束
- 04-data-and-api.md **§3 第 57–58 行**：GET /inventory、GET /inventory/items/:id
- 04-data-and-api.md **§5 第 98–99 行**：B12 /inventory/products、B13 /inventory/openings
  （B13 原文：期初数量 / 实物 / 成本与审计；**不是日常入库捷径**）
- contracts/v1/objects.json：Product、StockBalance、StockItem、InventoryMovement
- contracts/v1/actions.json：B12 / B13 的动作码与请求响应
- contracts/v1/legacy-mapping.json：hardware、serial_numbers、sn_events、order_item_sn 现有映射
- contracts/v1/enums.json：trackingMode、condition、ownership、availability 等枚举取值

【T04 留下的硬约束（违反就等于白做）】
1. 所有写动作走 `backend/src/domains/operations.ts` 的 `runIdempotent`，不要自己拼裸批次。
2. **动作结果不能依赖自增主键** —— batch 内取不到自增 ID，实体 ID 必须在拼 SQL 之前生成。
3. 断言一律用**约束**表达：唯一约束 / CHECK / `assertion_guards` 守卫。
   **不要用「条件 UPDATE + 检查影响行数」**——并发下会把别人的推进误判成自己的成功。
4. 版本推进用 `bumpVersionStatement`（往版本日志插一行），不要手写 `UPDATE ... SET version`。
5. 失败不落 `operations`；脱敏诊断落 `operation_failures`，且不得写入载荷原文。
6. 新增迁移编号接 **0007**，写在 backend/migrations/。参考 0006 的注释风格（英文注释）。
7. **新建的表必须登记进 `contracts/v1/legacy-mapping.json` 的 `tables` 数组**，
   否则 `node contracts/tools/validate-contracts.mjs` 会直接报红（T04 就是这么被拦下的）。
   改动**用纯文本外科替换，禁止整体 `JSON.stringify` 重写**；改完 `git diff --stat`
   确认是「纯追加」，并在 `revisionNote` 里追加一条记录（保留原文，不要覆盖）。

【本卡最容易做错的三件事（先想清楚再动手）】
1. **把历史 SN 表的行数当成库存**。禁止。库存只能来自：采购入库、期初实盘确认、
   回收取得所有权、退货接收。期初必须经**人工确认的实盘**（B13 的 approvedCountRef），
   不是把旧表数一刷了事 —— 卡面的通过标准明文写了这条。
2. **三类数量混算**。自有在库 = 可卖 + 已订 + 待处理，三者互斥；在途不算在库；
   客户保管（客供 / 暂存 / 送修）另列，不进自有库存汇总。
   这三个桶要能分别查、分别对账，并且**从任何角度看总和都一致**。
3. **同一实物的重复占用**。逐件实物同一时刻只能有一条有效占用 →
   用部分唯一索引（T04 已实测可用）。同型号的不同实物要能分别定位，
   不能被型号汇总吞掉；无 SN 的二手也必须有自己的内部编号。

【技术环境（已就绪，直接用）】
- 本地测试：`npm --prefix backend test`
  （miniflare 起**真实 workerd + 真实 D1**，按序应用全部迁移，esbuild 预打包 TS 后直接调用）。
  测试文件放 `backend/tests/`，命名 `t05*.test.mjs`；共用夹具在 `backend/tests/lib/`。
  ⚠️ `node --test` 跑完不退出会挂住管道 → 日志重定向到文件再读，别用管道 tail。
- 错误码：用生成物 `backend/src/generated/error-codes.ts`，**不要手写副本**；
  改了契约就跑 `node backend/scripts/sync-error-codes.mjs` 重新生成。
- 生产构建自检：`npx wrangler deploy --dry-run` —— **只允许 dry-run，禁止真部署**
  （`pc-backend` 是生产与测试共用的 Worker，真部署会同时影响 pc.huangqidong.cn）。

【操作铁律（踩过的坑，别重踩）】
- **注释里不要写出「星号紧跟斜杠」**：会提前闭合块注释，报错却指向下一行 SyntaxError。
- **同一文件的多处 Edit 必须串行**，一条消息里发多个会互相覆盖。
- **D1 的 `exec()` 按换行切分语句**，多行 DDL 会被切坏 → 用 `backend/tests/lib/sql.mjs` 的拆分器。
- **miniflare 的 scriptPath 不编译 TypeScript**（只有 wrangler 走 esbuild）→
  测试要调 TS 就先 esbuild 打包（`backend/tests/lib/build.mjs`）。
- 小程序 JSCore 的 `toLocaleString` 不完整 → 金额格式化用纯字符串运算（本卡若动金额需注意）。
- 登记缺口 / 下结论**必须钉规格原文行号**，不能凭印象。

【交付要求】
- 产出 `docs/verification/2026-09-18-T05a/README.md`：
  实际改动、数据变化（迁移文件、是否只本地执行）、验证证据（命令 / 时间 / 环境 / 结果）、
  未完成与阻断、下一步。
- 如实跑并记录：
  `npm --prefix backend test`、
  `node contracts/tools/validate-contracts.mjs`、
  `node backend/scripts/sync-error-codes.mjs --check`、
  `npx wrangler deploy --dry-run`。
- 本卡未动前端与小程序，**不要跑它们的测试**；未运行的检查一律写「未运行」，不得写成通过。
- 完成后**停下等确认**，不要自动开始 T05b。
- 若卡内仍有未完成项，不标「通过」。

【证据等级要求】
- 本地通过 ≠ 已上线。**0007 未应用到任何远端**；生产 D1 的 0004/0005 是否已应用本身仍未核实。
- 测试用例数量不等于业务完成度。
- 不得删除既有测试以求通过。

【可能遇到的岔路（先记下，别临场即兴）】
- 若发现 03 §4 与 04 §2 的字段要求冲突，**停下来引用行号报冲突**，不要自行「简化」库存规则。
- 若某个不变量（如数量守恒）无法用现有约束表达，**记录下来**并说明影响，
  不要用 JS 侧检查冒充数据库约束。
- G-12「SN 台账是否单列导航」属界面问题，留 T05b，本卡不决定。
```
