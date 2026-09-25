# 网页端 · 门店 ERP

React / TypeScript / Vite。代码入口 src/main.tsx → App.tsx → app/AppShell.tsx。
当前业务完成度见[STATUS](../docs/STATUS.md)，此处只维护代码职责和运行方式。

| 路径 | 职责 |
|---|---|
| src/App.tsx | 认证、门店会话与路由；默认进入 /dashboard |
| src/app | 当前外壳、导航 |
| src/features/workbench | 新版 ERP 页面、*-api 请求适配、*-view 纯逻辑 |
| src/components | 客户、商品与系统管理页面 |
| src/api / src/utils | 请求核心、当前 API 适配与通用工具 |
| src/styles | 当前页面与公共样式 |
| src/contracts/generated | 自动生成，禁止手改 |

## 运行与检查（仓库根）

    npm --prefix frontend run dev
    npm --prefix frontend test
    npm --prefix frontend run build
    npm --prefix frontend run lint

test/build 串行。默认 /api 代理本地 8787；配合 backend dev:local，不用演示构建代替正式营业版本。
今天页、库存、报价与销售均走新版业务入口。旧报价页及其独有编辑器、订单页和店员小程序已移除；旧网页地址保留跳转到新版路由。
生产配置由 backend/wrangler.toml 的 assets 指向 frontend/dist；构建后可用 `node scripts/check-web-release.mjs https://erp.huangqidong.cn/` 比对线上包，脚本本身不发布。
未完成项、验证入口及下一步分别见根 STATUS、验证索引与交接；不在多份 README 重复历史状态。
