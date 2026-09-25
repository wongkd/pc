# 装一下机 · 门店经营系统

更新：2026-09-19。状态：本地开发中，尚未形成可正式营业的新版业务闭环。

网页 ERP 供老板和店员使用；微信小程序供顾客看专属报价、付款、查进度。
两端计划共用后端和数据库，但顾客只接收经过服务端权限过滤的数据。
现有报价/订单功能与新版演示工作台并存，不能把页面存在视为功能已接通。

## 从这里开始

1. [AI 工程约定](AGENTS.md)：改动边界、文件、Git 与验证规则。
2. [当前状态](docs/STATUS.md)：已实现、未接通、证据和环境边界。
3. [断点交接](docs/NEXT-SESSION-PROMPT.md)：只记录当前任务与下一步。
4. [文档地图](docs/README.md)：按任务查业务、契约、设计、历史材料。

## 当前主线

[Q01：ERP 专属报价管理＋顾客我的报价单流程原型](docs/plans/2026-09-19-quote-flow/README.md)。
专属入口从 ERP 报价单生成和管理；公开商品、门店资料各在对应管理入口维护。
先走通报价与分享流程，再接身份、真实报价、支付、库存和交付。当前仅完成任务定义。

## 工程目录

| 目录 | 职责 |
|---|---|
| [frontend](frontend/README.md) | React / TypeScript / Vite，店内 ERP |
| [miniprogram](miniprogram/README.md) | 原生微信小程序，顾客端 |
| [backend](backend/README.md) | Cloudflare Workers / D1，鉴权与业务规则 |
| [contracts](contracts/README.md) | 跨端契约源、生成工具与一致性检查 |
| [docs](docs/README.md) | 当前状态、计划、设计、验证和历史归档 |
| scripts | 仓库级维护工具 |

## 本地启动与检查

在仓库根执行：

    npm --prefix frontend run dev
    node scripts/check-doc-links.mjs
    node contracts/tools/validate-contracts.mjs

业务检查按 [开发指南](docs/engineering/README.md) 选择。
启动网页后不要随意登录联调：旧接口可能指向生产。后端部署不是本地启动命令。

## 重要边界

- 新版工作台与小程序仍使用演示数据，不能直接作为营业版本发布。
- 历史验证仅说明对应日期与范围；生产迁移、网络及平台资格须另行核实。
- 当前有多项未提交改动；不得覆盖，也不自动提交、发布或执行远端迁移。
- 历史回执已移入 [归档](docs/archive/README.md)，不作为当前状态来源。
