# 装一下机 · 门店 ERP 与顾客小程序

更新：2026-09-19。状态：ERP 优先。E01 核心四屏原型已形成（待用户视觉评审）；E02 开发基线与 E04 客户主数据已落地，客户台账接真实接口；尚未形成可正式营业的新版闭环。

网页 ERP 供老板与少量店员经营单门店；原生微信小程序供顾客确认专属报价、下单、付款和查进度。
先做好完整 ERP，再接顾客端。装机销售、配件零售、维修、回收拆件与置换都属于完整首版。

## 从这里开始

1. [AI 工程约定](../../../AGENTS.md)。
2. [当前状态](../../STATUS.md)与[断点交接](../../NEXT-SESSION-PROMPT.md)。
3. [ERP 整体规划](../../plans/2026-09-19-erp-first/README.md)：先读原始需求对照，再读产品、UI/UX、复用与实施卡。
4. [E01 核心四屏原型](../../design/2026-09-19-erp-core/v2/README.md)。
5. [文档地图](../../README.md)。
6. [顾客 4Tab 小程序规划与 65 张任务卡](../../plans/2026-09-22-customer-miniprogram-reset/README.md)：按已确认效果图还原，附一键复制入口；尚未实施。

## 当前方向

用户明确不满意现有 ERP 界面；旧奶油白/森林绿、衬线标题与历史截图不再是新设计基准。
新设计以本轮[七张参考图](../../design/2026-09-19-erp-references/README.md)研究现代浅色后台；E01 原型已完成，等待用户视觉与操作评审。
可复用旧业务代码与数据，不因换界面推倒库存、幂等、报价打印等基础。

## 工程目录

| 目录 | 职责 |
|---|---|
| [frontend](../../../frontend/README.md) | React / TypeScript / Vite，店内 ERP |
| [backend](../../../backend/README.md) | Workers / D1，权限与业务规则 |
| [miniprogram](../../../miniprogram/README.md) | 原生顾客小程序，后续接入 |
| [contracts](../../../contracts/README.md) | 跨端协议唯一来源 |
| [docs](../../README.md) | 需求、规划、设计、验证与历史 |
| scripts | 仓库级维护工具 |

## 本地命令

    npm --prefix backend run dev:local      # 隔离后端：真实 Worker + 内存 D1 + 演示数据（127.0.0.1:8787）
    npm --prefix frontend run dev           # 网页端；/api 自动代理到上面的本地后端
    node scripts/check-doc-links.mjs

对应业务检查见[工程指南](../../engineering/README.md)。
开发期 `/api` 默认只打到本地隔离后端，**不再默认指向生产**；要连别的环境用 `VITE_API_TARGET` 显式指定。
本地后端的数据全在内存、进程退出即清空，且明确是演示数据。
旧登录/接口可能连接生产，联调前核实隔离；演示页面不能作为营业版发布。

保护已有未提交修改和业务数据；不自动提交、部署、迁移远端或删除备份。
