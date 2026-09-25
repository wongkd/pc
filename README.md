# 装一下机 · 门店 ERP 与顾客小程序

网页供门店经营；微信小程序供顾客查看报价、订单和服务。React / TypeScript / Vite + Workers / D1 + 原生小程序。

## AI 接手：按需读取

1. 遵守 [AGENTS.md](AGENTS.md)，读取 [当前状态](docs/STATUS.md)与[下一动作](docs/NEXT-SESSION-PROMPT.md)。
2. 根据任务进入下面对应目录；只读相关源码、任务卡及证据。
3. 需要查问题时搜索 [未决项](docs/OPEN-ITEMS.md)；需要找资料时查 [文档地图](docs/README.md)。不默认通读历史。

| 任务 | 入口 |
|---|---|
| 网页 ERP | [frontend](frontend/README.md) |
| 后端业务 / 库存资金 | [backend](backend/README.md) |
| 顾客微信端 | [miniprogram](miniprogram/README.md) |
| 跨端协议 | [contracts](contracts/README.md) |
| 文件管理 / 检查命令 | [工程指南](docs/engineering/README.md)与[维护工具](scripts/README.md) |

## 本地运行

在仓库根分别启动后端和网页：

    npm --prefix backend run dev:local
    npm --prefix frontend run dev

默认网页 /api 代理到本机 8787；后端为内存 D1 演示环境，退出即清空。
其他目标由 VITE_API_TARGET 指定，使用前核实环境。微信工具导入 miniprogram 目录。

    node scripts/audit-repository.mjs
    node scripts/check-doc-links.mjs

ERP 首页与登录落点为 /dashboard；旧 /quotes 编辑器及其本地草稿已移除，历史地址跳转到新版 /sales/quotes。店员小程序页面已清理，当前小程序只保留顾客端四个主页面。治理范围与上线记录见[回执](docs/verification/2026-09-25-production-reset-release/README.md)。

业务状态只维护在 STATUS；此文件不堆测试计数和历史回执。不自动提交、部署或迁移远端。
