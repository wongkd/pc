# PC 报价系统

电脑硬件智能报价系统 — AI 驱动的硬件 SKU 标准化 + 报价方案管理。

## 当前设计与协作入口（2026-09-17）

- [AI 协作与工程约定](./AGENTS.md)：文件、文档、Git、代码和验收标准。
- [电脑网页＋微信小程序双端实施方案](./docs/plans/2026-09-17-web-wechat-plan/README.md)：基于 A+B 效果图的页面、业务规则、数据接口、分步任务与验收；用于后续低端模型实施，本轮仅规划，不建设手机网页端。
- [装机店经营工作台重做规划](./装机店经营工作台-重做规划-2026-09-17.md)：产品与业务规划。
- [A+B 融合原型](./docs/design/2026-09-17-style-exploration/v3/README.md)：沿用 B 的视觉，加入 A 的订单处理；手机改为待办优先、详情处理、底部主操作。
- [跨端契约](./contracts/README.md)：两端共用的枚举、对象字段、金额规则、错误码、动作目录与权限映射、旧表映射、虚构样本与 DTO 生成；v1 已冻结（T01a、T01b、T01-rev1、T01c 完成，T01 整卡本地通过）。校验命令 `node contracts/tools/validate-contracts.mjs`，生成命令 `node contracts/tools/generate-dto.mjs`。
- [未决项与踩坑台账](./docs/OPEN-ITEMS.md)：**换人 / 换 AI 接手先读这份**。汇总需要负责人拍板的事项、规格缺口、已知技术债和已经踩过的坑。
- [网页壳与工作台骨架（T02a）](./docs/verification/2026-09-17-T02a/README.md)：六导航、设计变量、今天工作台与列表 / 详情切换；验证记录、未运行清单与发现的问题。
- [微信小程序端（T02b）](./miniprogram/README.md)：独立小程序项目、原生 tabBar 四项、列表与详情的真实页面跳转。验证记录见 [T02b](./docs/verification/2026-09-17-T02b/README.md)。
- [前一轮独立 A / B / C 提案](./docs/design/2026-09-17-style-exploration/v2/README.md)：历史对照，保留原稿。

融合版目前是独立本地原型，尚未接入业务 API、部署或实现原生小程序 / App。预览命令与验证结果见对应说明。本目录已建立 Git 基线（`main` 分支，起始提交 `e5ca594`，见 T00 记录）。

## 进度

| 阶段 | 卡 | 状态 |
|---|---|---|
| G0 基线 | T00 基线与条件登记 | 本地通过（微信平台条件待登记） |
| G0 基线 | T01 契约与样本（a/b/c） | 本地通过（校验 3047 项） |
| G0 基线 | T02a 网页壳与工作台骨架 | **本地通过**（浏览器视觉验收未运行） |
| G0 基线 | T02b 小程序壳与契约目标回写 | **本地通过**（开发者工具编译未运行） |
| G0 基线 | T02c 组件提取 | 未开始 |
| G1+ | T03–T22 | 未开始 |

**⚠️ 当前前端仍是演示数据源**：`dist` 产物里含 `DEMO-` 前缀样本，不得当作可用版本发布；详见 [OPEN-ITEMS](./docs/OPEN-ITEMS.md) 的 D-E 与 T-01。


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
