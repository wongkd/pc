# 今天工作台 R02 接口与页面回归

- 日期：2026-09-25
- 状态：**本地 HTTP 与前端回归通过；浏览器端到端和远端未验收**。
- 目标：验证今天页消费 `/api/v2/workbench` 响应、接口失败可重试、演示图片不会冒充真实附件，待办主动作能进入相应业务操作页。
- 入口：`frontend/src/features/workbench/WorkbenchTodayPage.tsx`；后端读模型见 `backend/src/domains/workbench.ts`。
- 环境：后端测试通过本地真实 Worker / 内存 D1 发 HTTP 请求；前端组件测试使用与 R02 响应形状一致的接口返回，不连接预览或生产。

## 完成内容

- 今天页保持调用 `fetchWorkbench()`，由请求客户端读取 `/api/v2/workbench?scope=open&limit=200`；页面不导入 `demoData.ts`。
- 激活原来整组 `describe.skip` 的回归，覆盖服务端指标与待办、类别/文本筛选、空态、附件 URL 原样展示、缺图占位、错误重试、异常拒绝后的重试、服务端阻断和主动作跳转。
- R02 主动作进入实际业务页并携带单号：交付打开履约单详情；缺货进入采购到货工作区并提供返回销售单入口；维修和回收打开对应单据详情。实际写入仍由各业务页的权限、字段和服务端状态守卫控制。
- 图片只使用接口提供的 URL。`demo://` 地址在页面端被拒绝并显示“演示素材已禁用”；无 URL 显示“暂无附件”。真实 HTTP 回归同时断言 `/api/v2/workbench` 返回的任务没有 `demo://` 图片地址。
- **演示素材决定：**删除工作台运行时映射 `demoVisuals.ts`。保留 `demoData.ts` 和 `demoData.test.ts` 作为契约漂移回归夹具；当前只有该测试文件导入 `demoData.ts`，工作台业务入口没有引用。保留四张 web JPEG，因为设计资源归档页和资源优化脚本仍引用它们；它们不再通过工作台代码展示。

## 实际验证

- `npm.cmd --prefix frontend run test -- src/features/workbench/WorkbenchTodayPage.test.tsx src/features/workbench/WorkbenchFulfillmentPage.test.tsx src/features/workbench/WorkbenchRecoveryPage.test.tsx src/features/workbench/WorkbenchServicePage.test.tsx src/features/workbench/WorkbenchPurchasePage.test.tsx src/features/workbench/demoData.test.ts`：6 个测试文件通过，44 项通过，0 项跳过。
- `node --test --test-concurrency=1 backend/tests/r02-workbench.test.mjs`：18 项通过、0 失败、0 项跳过；真实 Worker HTTP 响应不含 `demo://` 地址或 `/assets/workbench/*.jpg` 静态演示图路径。
- `npm.cmd --prefix frontend run build`：TypeScript 与生产构建通过。Vite 报主 bundle 超过 500 kB（本次 636.26 kB），构建成功。
- `node scripts/check-doc-links.mjs`：241 个 Markdown 文件、629 个本地链接，0 个断链。

## 未验证与下一步

- 未启动本地浏览器做工作台到业务页的整链实看、真实网络故障注入或截图验收；组件回归不替代浏览器证据。
- 未发布当前工作区到隔离预览或生产；预览/生产接口和部署包状态不由本地 Worker 测试推断。
- 下一步如需继续本卡，使用同一隔离 Worker + 前端会话实看交付、缺货到货、维修、回收四条跳转及返回路径，并注入 `/workbench` 失败验证页面重试；不部署、不提交。
