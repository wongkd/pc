# PC 报价系统

电脑硬件智能报价系统 — AI 驱动的硬件 SKU 标准化 + 报价方案管理。

## 当前设计与协作入口（2026-09-17）

- [AI 协作与工程约定](./AGENTS.md)：文件、文档、Git、代码和验收标准。
- [电脑网页＋微信小程序双端实施方案](./docs/plans/2026-09-17-web-wechat-plan/README.md)：基于 A+B 效果图的页面、业务规则、数据接口、分步任务与验收；用于后续低端模型实施，本轮仅规划，不建设手机网页端。
- [装机店经营工作台重做规划](./装机店经营工作台-重做规划-2026-09-17.md)：产品与业务规划。
- [A+B 融合原型](./docs/design/2026-09-17-style-exploration/v3/README.md)：沿用 B 的视觉，加入 A 的订单处理；手机改为待办优先、详情处理、底部主操作。
- [前一轮独立 A / B / C 提案](./docs/design/2026-09-17-style-exploration/v2/README.md)：历史对照，保留原稿。

融合版目前是独立本地原型，尚未接入业务 API、部署或实现原生小程序 / App。预览命令与验证结果见对应说明。本目录当前没有 Git 仓库，正式开发前需核实代码基线。

## 快速开始

### 前端
```bash
cd frontend
npm install
npm run dev        # 本地开发 → http://localhost:5173
```

### 后端
```bash
cd backend
npx wrangler deploy   # 部署到 Cloudflare Workers
```

## 功能
- 🔍 硬件库搜索与管理（支持 Excel 批量导入）
- 🤖 DeepSeek AI 硬件标题标准化
- 📋 报价方案创建 / 导出 HTML / 导出 PDF
- 👤 用户登录注册
- 📊 报价模板管理

## 技术栈
| 层 | 技术 |
|----|------|
| 前端 | React 19, Vite, TypeScript, html2canvas, jsPDF, xlsx |
| 后端 | Cloudflare Workers, D1 Database |
| AI  | DeepSeek Chat API |
| 部署 | Cloudflare / EdgeOne |
