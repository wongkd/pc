# U02 · 检测状态与同型号库存补录

- 日期：2026-09-27。
- 状态：按用户确认的 A/A 方案完成本地契约、迁移、后端和 API 实现；未部署、未应用迁移、未连接生产数据。
- 发布后补记：0032 已随集成版本应用生产。迁移重建流水时保留既有盘点行外键的修复与生产验证见[仓库与客户查询发布回执](../2026-09-27-warehouse-customer-release/README.md)；本节原状态保留为本地实现验收时的记录。
- 需求与决策：[总体方案](../../plans/2026-09-27-used-parts-inventory/README.md)、[决策记录](../../plans/2026-09-27-used-parts-inventory/u02-decision-review.md)。

## 本地实现

- 契约升至 v1.2。StockItem 增加当前 `inspectionStatus`，历史实物默认为 `unrecorded（历史未记录）`；检测与返修事实追加到 `stock_inspection_events`，数据库拒绝更新或删除事件。
- B19 检测结果与库存去向配对：通过才可转可售且必须有有效证据；失败留在待处理或按既有处置退役。失败件不能直接改判通过，必须经 B48 登记返修完成、再以新 requestId 复检。
- 新进入库存的逐件实物从 `quarantine / pending` 开始。采购、期初、回收拆件入口均写入待检状态；数量型号没有逐件检测状态，不做推断。
- 新增独立 B47 `/inventory/backfills`，按型号 trackingMode 增加数量或逐件实物；B13 原有首批重复守卫保持。客户端在请求前持久化 `batchRef` / `lineRef`，未知结果重试可复用原引用；同 `batchRef` 换 requestId 会冲突。重复 SN 拒绝；无 SN 相似件仅供人工核对，不承诺自动判重。
- 检测状态进入 U01 读接口筛选、完整状态计数与实物详情事件读取。U03 页面、U04 来源操作关联尚未实现。

## 实际验证

| 检查 | 结果 |
|---|---|
| `npm.cmd --prefix frontend run build` | 通过：TypeScript 前端构建与 Vite 生产构建完成。 |
| 后端 esbuild Worker bundle | 通过：入口 `backend/src/index.ts` 打包成功，产物写在系统临时目录。 |
| `frontend/node_modules/.bin/tsc.cmd --noEmit -p backend/tsconfig.json` | 已恢复 backend 清单中原本声明的 `@cloudflare/workers-types` 后执行；检查仍因仓库现有 strict 类型错误失败，涉及 `access.ts`、报价 / 服务 / 旧 B13 期初路径、旧 index 与若干旧路由。U02 补录验证的空值类型诊断已修复，最终输出没有指向新增 U02 代码的诊断；依赖清单和锁文件未改。 |
| `npm.cmd --prefix backend run check:migrations` | 通过：33 个迁移编号从 0000 到 0032 连续；下一个编号为 0033。 |
| `npm.cmd --prefix backend run check:error-codes` | 通过：21 个错误码生成物与 v1.2 契约一致。 |
| `node contracts/tools/validate-contracts.mjs` | 通过 3747 项；9 条既有非阻断提示。迁移实际表结构与契约一致。 |
| DTO / D10 生成检查 | 通过：`generate-dto.mjs --check`、`generate-d10-contract.mjs --check`。 |
| 网页 / 小程序契约同步检查 | 通过：两端 generated 副本均与 v1.2 一致。 |
| `node contracts/tools/check-client-parity.mjs` | 通过：两端错误行为、请求核心输出与库存标签一致。 |
| `node scripts/check-doc-links.mjs` | 通过：283 Markdown 文件、886 个本地链接、0 断链。 |
| `git diff --check` | 通过：无空白错误。 |

未运行业务测试套件；本回执中的 build / bundle / 静态门禁不证明 D1 实际迁移行为、登录后业务闭环或页面体验。没有写入生产、部署 Worker 或应用迁移 0032。

## 下一步与边界

下一步进入 U03 页面接入，之后完成 U04 来源关联和 U05 隔离环境真实 API / 浏览器验收。迁移 0032 应按授权与发布流程另行审查、应用；当前没有任何生产业务数据变更。

## 后续补记（2026-09-27）

以上“下一步”是 U02 初次验收时的断点。U03–U05 随后已完成本地实现及隔离环境验收，详见[U03–U05 回执](../2026-09-27-U03-U05/README.md)。本节追加记录后续整合中发现的回归与复验，不改写初次验收结果。

- 0032 重建 `inventory_movements` 时会删除旧表上的触发器；已在迁移末尾恢复 `close_opening_window_after_business_movement`，保留正式业务流水关闭期初窗口的行为。只修改本地迁移文件，未应用远端。
- 首轮完整后端测试发现 6 条旧测试夹具 / 断言与“新入库先进入待检”语义不符，且 D10 触发器确有缺失；已修复触发器并同步调整相关夹具 / 断言。
- 修复后，受影响的 5 个后端文件共 54 项通过，B47 HTTP 用例 2 项通过。修正后的完整 413 项后端测试及本轮静态门禁结果记录在[U03–U05 回执](../2026-09-27-U03-U05/README.md)。
- 生产仍未部署、未应用迁移、未写入业务数据；变更须与完整集成基线一并走单独发布流程。
