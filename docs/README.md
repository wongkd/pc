# 文档地图

更新：2026-09-22。按任务选择一个入口；不默认读取整个 docs。

| 要找什么 | 唯一入口 |
|---|---|
| 当前事实 / 下一动作 / 未决项 | [STATUS](STATUS.md) / [交接](NEXT-SESSION-PROMPT.md) / [OPEN-ITEMS](OPEN-ITEMS.md) |
| 业务需求 | [ERP 规划](plans/2026-09-19-erp-first/README.md)与[原始需求对照](plans/2026-09-19-erp-first/00-requirements.md) |
| 报价业务 | [报价规则](2026-09-19-报价单业务规则.md)；[Q01](plans/2026-09-19-quote-flow/README.md)供追溯 |
| 已冻结经营规则 / 实施边界 | [D01–D10 规则R1](plans/2026-09-23-owner-decisions/README.md)与[异常及实施台账](plans/2026-09-23-owner-decisions/edge-cases.md)：用户已授权采纳推荐，未交付能力逐项暂缓 |
| 配件收发流程 V2 | [流程复评与简化方案](plans/2026-09-26-item-flow-simplification/README.md) / [V2 生产发布回执](verification/2026-09-26-v2-item-flow-release/README.md)：保留 V1 基线、记录 V2 变更与生产验收边界 |
| 仓库体验与库存登记 | [2026-09-26 生产发布回执](verification/2026-09-26-warehouse-refresh/README.md)：固定商品分类、实盘解释和全员可读的折叠日志；[轻量化现有库存登记](plans/2026-09-26-lightweight-stock-entry/README.md)：取消登记窗口前置步骤 |
| ERP 管理员测试数据清理 | [生产发布与验收边界](verification/2026-09-26-admin-data-cleanup/README.md)：B45 报价草稿与 B46 无引用商品已部署；登录后浏览器业务验收未做 |
| 库存登记弹窗与清理入口 UI 修复 | [生产发布回执](verification/2026-09-26-inventory-ui-cleanup-release/README.md)：弹窗响应式布局、报价/仓库页快捷入口 |
| ERP 视觉 | [彩色 Core V2](design/2026-09-19-erp-core/v2/README.md)，维修/回收原型由验证索引进入 |
| 顾客小程序 | [4Tab 任务包](plans/2026-09-22-customer-miniprogram-reset/README.md)；[主体与上线背景](2026-09-19-小程序主体与上线方案.md)不代表当前平台核验 |
| 生产重置 / 旧工具下线 | [2026-09-25 发布回执](verification/2026-09-25-production-reset-release/README.md)；历史文件分类见[入口治理回执](verification/2026-09-25-erp-entry-cleanup/README.md) |
| 工程规则 / 源码定位 | [工程指南](engineering/README.md) / [代码地图](engineering/CODE-MAP.md) / [踩坑检索](engineering/PITFALLS.md) |
| 测试与截图证据 | [验证索引](verification/README.md)，各卡只证明当时对应范围 |
| 一键提示词与进度 | [开发进度台](design/2026-09-21-prompt-launcher/README.md) |
| 历史决定与整理前原文 | [归档](archive/README.md)，仅追溯时读取 |

plans 存计划，design 存设计/原型，verification 存证据，archive 存历史。
旧双端方案、风格探索、旧提示词不作为当前指令；已确认决定以当前任务与 STATUS 为准。
