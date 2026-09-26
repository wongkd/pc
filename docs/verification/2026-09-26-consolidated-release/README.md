# 多对话工作合并发布回执

- 日期：2026-09-26
- 状态：本地提交 `8b75245` 已部署生产；Worker 部署列表确认 100% 流量。员工登录后的业务验收仍待完成。
- 目标：把多个对话分别留下的代码与页面更新集成到一个完整版本，避免较旧或任务专用工作树后部署时替换整个 Worker 版本。
- 生产入口：[ERP](https://erp.huangqidong.cn/)

## 变更与版本

- Git 分支：`codex/v2-item-flow`。
- 代码提交：`8b75245 feat: consolidate pending ERP releases`，78 个文件。
- Cloudflare Worker：`pc-backend`，版本 `18d061cd-e8ee-4343-bec2-312b6a3c8e82`；部署时间 2026-09-26 04:57 UTC，流量 100%。
- 线上构建文件：`/assets/index-DK-iPbPP.css`、`/assets/index-znmx03a7.js`。
- 本版汇总 V2 仓库流程、商品与库存登记、仓库操作日志、管理员测试数据清理、售后/报价页面调整及 v1.1 契约生成物。
- 生产此前已有多次独立 Worker 发布；Cloudflare 部署记录显示最新版本的 100% 流量指向单一 Worker 版本。后续生产发布应从最新集成基线构建完整版本，不能直接从落后的任务工作树发布。
- GitHub 目标：公开仓库 [`wongkd/pc`](https://github.com/wongkd/pc)，默认分支 `main`。仓库描述为电脑硬件报价系统，与本项目匹配。
- 推送：用户确认旧远端可覆盖后，将本地 `codex/v2-item-flow` 推送到 `main`。远端原提交 `169b72a99d586a2fe90dbf2c3627d9d6734b2202` 与本地历史无共同祖先，因此使用 `--force-with-lease`，且只在远端仍为该 SHA 时覆盖；推送后远端 `main` 为 `70ca726`。本地已添加 `origin` 并复核远端 SHA。
- 线上发布由 Wrangler 完成；GitHub 推送保存代码历史，不执行 Cloudflare 部署。

## 验证

- 后端：`npm.cmd --prefix backend test`，393/393 通过。
- 前端：`npm.cmd --prefix frontend test -- --run`，25 个测试文件、217/217 通过。
- 构建：`npm.cmd --prefix frontend run build` 通过；产物 JS 为 595.13 kB，Vite 提示超过 500 kB 建议拆分。
- 契约：`node contracts/tools/validate-contracts.mjs` 通过 3608 项；DTO、D10 生成物、后端错误码、网页/小程序同步及跨端一致性检查通过。校验报告包含 9 条已登记的非阻断提示。
- 迁移：31 个迁移 `0000–0030` 连续，下一编号 `0031`；生产 D1 远端检查无待应用迁移。
- 文档：`node scripts/check-doc-links.mjs`，263 个 Markdown 文件、701 个本地链接、0 断链。
- Wrangler dry-run 确认生产 D1 `pc-db`、R2 `pc-attachments`、Assets 和正式模式环境变量绑定。
- 生产资源检查：`node scripts/check-web-release.mjs https://erp.huangqidong.cn/` 返回 HTTP 200，生产 HTML 引用的 JS/CSS 文件名与本地构建一致。
- `git diff --check` 与提交前工作区差异检查通过。

## 数据与验收边界

- 没有应用数据库迁移，没有开启期初库存窗口，没有新建/删除生产商品、库存、报价或其他业务记录。
- 本轮生产核对只确认部署记录与公开页面资源。没有用生产账号登录，也没有实际操作仓库登记、数据清理、报价、采购或售后流程。
- 资源文件名匹配说明生产指向当前构建，不证明认证后 API、角色权限、业务闭环或 ERP RC 验收通过。
- 前端构建仍有单个 JS chunk 超过 Vite 的 500 kB 提示；全量 ESLint 之前仍报告 9 errors、3 warnings，本次未把 lint 全绿作为放行条件。
- 工作区中原有的未跟踪日志和截图没有加入提交，继续保留。

## 后续发布规则

1. 发布前核对当前 Git 提交、工作树状态和线上 Worker 版本。
2. 多个对话的代码先合并到同一最新集成基线，重新生成契约并通过门禁，再从完整基线构建和部署。
3. 不从只包含单个任务的旧工作树对生产运行 `wrangler deploy`；每次部署会把 Worker 路由流量切到新部署版本。
4. 登录后页面和员工业务验收单独记录；不为验收在生产写入虚构业务数据。
