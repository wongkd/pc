# 网页端 · 店员 ERP

更新：2026-09-19。React 19 / TypeScript / Vite。
目标：报价、订单、库存、装机交付、回收、售后与账本集中办事。
状态：旧报价订单功能与新版工作台并存；今天和库存工作台仍是演示数据。

## 入口与职责

| 路径 | 职责 |
|---|---|
| src/App.tsx | 当前路由及旧报价编辑流程，逐任务拆分 |
| src/app | 壳、导航、登录边界 |
| src/features | 按业务域组织页面与视图模型 |
| src/components | 既有报价、订单与管理组件 |
| src/api、src/utils | 请求、错误行为及工具 |
| src/styles | 工作台设计变量和页面样式 |
| src/contracts/generated | 生成物，禁止手改 |

新样式沿用 wb- 前缀与限定作用域，避免污染旧报价页。
内部成本等权限必须在服务端控制，顾客预览不能仅用 CSS 隐藏。

## 运行与验证（仓库根）

    npm --prefix frontend run dev
    npm --prefix frontend run test
    npm --prefix frontend run build
    node frontend/scripts/sync-contracts.mjs --check

test/build 串行；lint 按范围运行，历史失败不能假定已经修好。
本地旧登录/请求可能触达生产，界面验收用隔离的演示入口。

## 证据与下一步

桌面今天页 [V01](../../../verification/2026-09-18-V01/README.md)、
库存页 [V02](../../../verification/2026-09-19-V02/README.md) 已有历史浏览器验收；
本机可使用 puppeteer + Edge，不再沿用“无自动化工具”的旧结论。

未完成：新版真实业务接入、完整异常态、顾客专属报价分享。
当前主线：[ERP 整体规划](../../../plans/2026-09-19-erp-first/README.md)。用户已否定当前 UI 美观度，历史桌面验收不作为新设计基准；下一动作见根交接。
演示样本仍可能进入构建，产物不可直接当营业版发布。
