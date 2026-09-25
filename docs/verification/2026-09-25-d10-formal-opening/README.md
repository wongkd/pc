# D10 正式期初库存实施与隔离验收

日期：2026-09-25  
状态：成本分类、窗口规则与正式期初流程已在本地实现并通过隔离验收；生产尚未部署或验收，未录入真实库存。

后续生产发布状态见[2026-09-26 D10 / E04 生产发布回执](../2026-09-26-d10-production-release/README.md)；本文件保留本地隔离验收证据。

## 目标与已冻结口径

把现存库存正式建账所需的成本口径、盘点行依据及一次性录入窗口落实到契约、数据库、服务端与网页。经营决定沿用[D10 冻结规则](../../plans/2026-09-23-owner-decisions/README.md#d10期初成本与流水)：

| 成本分类 | 正式期初要求 | 实际成本汇总 |
|---|---|---|
| `known_actual` | 实际金额大于 0，附单据/凭据引用 | 写实际成本 |
| `assessed_estimate` | 估值大于 0，附估值依据和估值日期 | 单独保存估值，不混入实际成本 |
| `unknown` | 金额必须为空；未知不等于 0 | 保留 `NULL` |
| `zero_cost` | 明确填 0，老板批准并留赠与等依据 | 真实 0，与未知区分 |

老板可为门店开启一次正式期初窗口，期限 1–7 天；首笔正式经营库存出入流水或截止时间先到即关闭。预览不启动窗口，关闭后不能重开；漏项需另行补录/调整流程。每行必须有人工盘点依据和唯一盘点明细引用；只录本店自有现存库存。在途采购、未结应付、客供、送修、暂存和未取得回收不混入期初。

## 实现入口

- 增量契约与生成器：`contracts/v2/inventory-opening.json`、`contracts/tools/generate-d10-contract.mjs`。v1 冻结内容未改。
- 数据追加迁移：`backend/migrations/0030_d10_formal_openings.sql`。估值使用独立字段，旧实际成本列继续保持 `NULL`。
- 服务端校验、窗口状态、幂等与重复盘点行拒绝：`backend/src/domains/inventory.ts`、`backend/src/routes/inventory-v2.ts`。
- 窗口设置与分类录入界面：`frontend/src/features/workbench/WorkbenchInventoryPage.tsx`；隔离验收服务器可通过 `PREVIEW_INVENTORY_OPENING_MODE=formal` 启动，默认仍为 preview。
- `backend/wrangler.toml` 的下一版本源码配置为 `formal`；生产环境尚未部署此版本，因此该配置不等于生产放行。

## 验证

- `node --test tests/d10-opening.test.mjs`：4/4 通过；覆盖成本四分类、窗口期限/超时、盘点行防重、已有流水阻止首次开启、首笔正式经营库存流水关闭，以及 preview 旧格式边界。
- `node --test --test-name-pattern="显式关闭期初入口" tests/e04b-inventory-http.test.mjs`：显式关闭环境拒绝正式写入且不产生操作记录。
- `npm --prefix frontend run test -- src/features/workbench/WorkbenchInventoryPage.test.tsx`：18/18 通过。
- `npm --prefix frontend run build`：通过；仅有既有的大 chunk 警告。
- `npm --prefix backend run check:migrations`：31 个迁移 `0000–0030` 连续，下一号 `0031`。
- `node contracts/tools/generate-d10-contract.mjs --check`：中心生成物及网页、后端副本一致。
- 本地浏览器通过 `127.0.0.1:5174` 访问隔离 Worker `127.0.0.1:8788`（formal、内存 D1、仅演示商品）。开启 7 天窗口后录入 3 件 Kingston NV2，单件估值 ¥260.00，依据与估值日期齐全；页面回读显示估值与依据/日期，型号汇总不把估值当实际成本，库存数量更新为 3。此演示行只存在于临时内存库，不是门店真实盘点。
- 一次组合 HTTP 回归运行的 D10 测例已通过；该批次还发现一个非本范围旧 `/api/products` 测例仍期望 200、当前源码返回 410。此旧路由断言未在本任务中改写，不能把该组合批次记作全绿。

## 未完成与下一步

- 没有部署迁移或 Worker、没有对生产数据库写入；清理后的生产环境仍无本回执证明过的正式期初入口。须在单独的生产发布与验收中先核对目标环境、迁移状态和回滚/放行门禁，再做真实盘点建账。
- D10 后续销售例外（未知成本须老板逐件/批次批准）、估值毛利单独报表及关闭窗口后的追加调整不由期初入口替代，仍未在本任务实现或验收。
- 前端首屏加载现会保存服务端的 `openingWindow` 状态；否则正式/预览入口会在首次进入时消失，直到手动刷新。
