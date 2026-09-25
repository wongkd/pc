# D10 生产发布前只读预检与放行步骤

- 日期：2026-09-25
- 状态：本轮只读预检完成到可访问范围；**生产发布不放行**。
- 目标：确认生产目标、D10 迁移状态及发布门禁，形成可审查的后续发布与验收步骤。
- 边界：未部署 Worker、未应用生产迁移、未写生产 D1/R2、未开启期初窗口、未录入真实库存。生产 D1 只读命令因 Cloudflare API 授权失败，迁移状态本轮不能独立复核。
- 关联：[D10 实施与隔离验收](../2026-09-25-d10-formal-opening/README.md)、[生产运行与浏览器续验](../2026-09-25-production-runtime-browser-followup/README.md)、[生产发布前只读核查](../2026-09-25-production-release-readiness/README.md)。

## 当前核查结果

| 检查项 | 当前证据 | 放行判断 |
|---|---|---|
| 生产 Worker | 本轮 wrangler deployments status --config wrangler.toml 成功：100% 流量在版本 68917714-5b4e-4786-8ef6-507d9b015b40，创建时间 2026-09-25T07:56:50Z。 | 这是当前可读到的部署版本；状态查询不证明 D10 代码已部署。最新交接记录说明此版本为回收指引发布，未应用 D10 迁移。 |
| 生产目标 | 当前 backend/wrangler.toml 声明 Worker pc-backend、D1 pc-db、路由 erp.huangqidong.cn/*、R2 pc-attachments；文件设置 keep_vars=false、INVENTORY_OPENING_MODE=formal。 | 源配置指向生产并会在部署时启用 formal；源码配置不等于线上运行值。 |
| D10 文件时序 | 本地 Wrangler 配置最后修改于 2026-09-25 14:54:55Z；0030 迁移、inventory domain/route、网页和 D10 契约文件均在当前可读生产版本创建后修改。 | D10 工作区修改晚于当前部署，不可把本地 formal 状态称作生产已启用。 |
| 生产 D1 迁移 | 本轮通过已登录的 Cloudflare 控制台对 pc-db 执行只读查询：29 条记录，最新为 0028_document_export_attachments.sql；0029 与 0030 均未应用。PRAGMA foreign_key_check 成功且无异常行。 | 已独立确认生产迁移状态。D10 迁移尚未应用。 |
| D10 schema 对象 | sqlite_master 查询确认 inventory_openings、inventory_opening_lines、stock_items、stock_batches、inventory_movements 等既有表存在；inventory_opening_windows、D10 唯一索引和关窗触发器尚不存在。 | 当前生产仍是 0028 结构；0030 的前序迁移 0029 也未应用。 |
| Wrangler 访问 | 本机 Wrangler 4.105.0。deployments status 成功；deployments list 报 No API token found，D1 CLI 请求报 7403。通过现有 Cloudflare 浏览器会话完成了 D1 控制台只读查询。 | 不需要用户另交 token。CLI 授权与浏览器控制台权限不同；本轮迁移实证来自控制台 SELECT。未读取、复制或记录任何凭据值。 |
| 本地迁移序列 | npm run check:migrations（backend/）通过：31 个文件，0000–0030 连续，下一号 0031。 | 只证明工作区迁移编号连续，不证明生产已应用 0029 或 0030。 |
| D10 契约生成物 | node contracts/tools/generate-d10-contract.mjs --check 通过：中心生成物、网页及后端副本一致。 | 仅为本地门禁；D10 HTTP/浏览器验收引用原 [D10 回执](../2026-09-25-d10-formal-opening/README.md)，本轮没有重跑。 |
| 工作区范围 | D10 迁移 0030 和多个源文件未提交；backend/src/index.ts、backend/wrangler.toml、inventory.ts、inventory-v2.ts 等共享文件也包含其他未提交改动，另有大量跨任务改动。 | 当前工作区不能直接作为 D10 生产发布包。须先审定并隔离 D10 专属候选差异。 |

生产 D1 当前读数与用户说明一致：没有应用 D10 迁移或写入。本轮只读确认到 0028；生产发布、迁移、开启期初窗口及真实库存录入均未执行，且仍须分别得到明确授权。

## 迁移顺序门槛

工作区中有 0029_customer_source_channel.sql 和 0030_d10_formal_openings.sql。迁移检查器确认顺序为 0000–0030。Wrangler 帮助显示 d1 migrations apply 会应用所有未应用迁移，命令没有选择单个迁移编号的选项；非交互命令会跳过确认提示。

生产当前停在 0028。直接对生产执行 apply 会同时进入 0029 和 0030，把客户来源字段混入 D10 发布。D10 本轮不得静默接管 0029。处理方式是先独立审查并确定 0029 是否能进入同一发布；未获范围确认时停止，不执行 apply。若生产之后已经单独应用 0029，再按只剩 0030 的实际清单审查。

## 可审查的发布前步骤

以下步骤是后续工作单，不是本轮执行授权。

1. **补齐只读访问并固定目标。** 由有权维护者提供受控的 Wrangler 只读访问；不通过聊天传递 token。再次读取当前生产 Worker 状态、D1 迁移清单及 d1_migrations，确认账号、pc-backend、pc-db 和生产路由。读数只留迁移名、版本和行数，不读客户或库存内容。

   ~~~powershell
   .\node_modules\.bin\wrangler.cmd deployments status --config wrangler.toml
   .\node_modules\.bin\wrangler.cmd d1 migrations list DB --remote --config wrangler.toml
   .\node_modules\.bin\wrangler.cmd d1 execute pc-db --remote --command "SELECT name FROM d1_migrations ORDER BY name" --json --config wrangler.toml
   .\node_modules\.bin\wrangler.cmd d1 execute pc-db --remote --command "PRAGMA foreign_key_check" --json --config wrangler.toml
   ~~~

2. **核对 D10 schema 前置。** 只读检查 inventory_openings、inventory_opening_lines、stock_items、stock_batches、inventory_movements 当前列、索引与触发器；确认应用 0030 的先决表均存在。迁移名或 schema 与仓库不一致时停止，先隔离复现并形成审查结论；不得手工改 d1_migrations。

3. **隔离并审查 D10 候选。** 从干净、可追溯的基线准备只含 D10 的变更包；逐项审查 0030、共享接线 backend/src/index.ts、inventory domain/route、前后端生成物、契约生成器、工作台和 backend/wrangler.toml。排除旧 API、客户来源、页面治理及其他卡片改动。当前脏工作区不直接部署。

4. **在隔离环境复验候选。** 串行执行迁移连续性、生成物一致、D10 后端分类/窗口/盘点行防重用例、正式/关闭入口 HTTP 检查、前端定向回归和 build；再按 D10 回执实看正式入口及关键状态。组合 HTTP 回归中旧 /api/products 断言期望 200、实测 410 的差异按原记录单独跟踪，不在 D10 发布中改旧路由或断言。

5. **补足数据恢复门禁。** 在单独审查的隔离库验证最新生产 D1 备份可恢复，并确认恢复点和发布前置条件。生产完整恢复及代码/数据回退尚无完成证据；恢复、回滚副作用和停机/维护窗口未确认时不放行。

6. **形成生产操作单并等待明确授权。** 操作单逐项列目标 Worker/D1、核对后的迁移名单、部署制品版本、备份点、操作者、维护窗口、回退判断和停止条件。生产部署与 schema migration 必须得到明确授权后再执行；非交互环境不能依赖 Wrangler 的迁移确认提示来防误操作。迁移成功后只读复核 d1_migrations、目标列/索引/触发器及外键检查，再部署包含 INVENTORY_OPENING_MODE=formal 的审定版本。

7. **先做生产只读验收。** 确认部署版本 100% 生效、生产路由和 D1 绑定正确、Owner 登录可见正式期初入口、服务端返回的 openingWindow 状态可读。保留原有空库/数量状态证据；不点“开启窗口”、不提交盘点行、不制造测试库存。

8. **真实期初另行授权。** 完整生产写验须另获明确授权并使用已审核的门店盘点表。由 Owner 选定 1–7 天期限，逐行复核归属、数量、盘点引用、成本四分类及对应凭据。开启窗口后才录入真实盘点；第一笔正式经营库存流水或期限到达会关闭窗口。检查汇总后记录操作人、时间、生产 Worker 版本、迁移状态和页面回读，不以估值计入实际成本，不把未知成本写成零。

## 停止条件与范围

- 生产 D1 只读访问不可用、目标映射不一致、迁移顺序不确定、0029 未获范围确认、生产快照/恢复门禁未完成或候选差异混入其他任务时，保持 **no-go**。
- 迁移报错、部署版本未达 100%、路由/绑定与审定目标不一致、期初状态或成本汇总不符时，停止后续步骤并保留证据；不手工修迁移账本，不假设时间旅行恢复或代码回退已验证。
- 本卡范围不含 D10 未知成本销售例外、估值毛利单列报表、关窗后追加调整；三项继续单独跟踪。
- 本轮没有生产验收结果，也没有生产发布放行结论。
