# 后端 · Workers 与 D1

旧 /api 与新版 /api/v2 并存。当前各域进度见[STATUS](../docs/STATUS.md)。

| 路径 | 职责 |
|---|---|
| src/index.ts | 旧接口与入口接线；契约证据依赖绝对行号，修改需门禁 |
| src/routes/*-v2.ts | HTTP 解析、鉴权、响应与各业务前缀分发 |
| src/domains | 业务规则、读模型、事务计划与幂等；[代码地图](../docs/engineering/CODE-MAP.md) |
| migrations | 只追加、4 位编号；不得清理历史迁移 |
| tests / tests/lib | 领域与真实 Worker / D1 本地测试、夹具 |
| scripts/dev-server.mjs | 回环地址的内存 D1 演示后端 |
| scripts/verify-staff-invitation.mjs | 复验默认 `sales` 角色的邀请、接受、登录与逐域权限；只允许本机回环地址 |

## 运行与检查（仓库根）

    npm --prefix backend run dev:local
    npm --prefix backend test
    npm --prefix backend run check:error-codes
    npm --prefix backend run check:migrations

员工权限验收需先在本地隔离端口启动内存 Worker，再运行一次性账号复验脚本；关闭 Worker 后测试账号和邀请随内存 D1 清空：

    $env:PORT='8878'; node backend/scripts/dev-server.mjs
    node backend/scripts/verify-staff-invitation.mjs

本地数据进程退出即清空。远端迁移与生产绑定状态必须另行核实；wrangler deploy 不是本地检查命令。
路由只认领自己的前缀，采购精确路由必须先于库存兜底。库存/资金操作保持幂等和可追溯。
未完成事项及下一步由根 OPEN-ITEMS / 交接统一维护，具体结果见[验证索引](../docs/verification/README.md)。

## Cloudflare 隔离预览

`wrangler.preview.toml` 只绑定 `pc-erp-preview-20260924` 测试 D1，不要将预览配置替换生产 `wrangler.toml`。预览页面与 API 部署在同一 Worker；`erp.huangqidong.cn/*` 使用现有橙云代理 DNS 的 Worker Route，保留了原 DNS 记录；`workers.dev` 地址也保留。前端构建后需从 `frontend/dist` 移除随旧 Pages 规则复制来的 `_redirects`，否则它会把 API 指向生产 Worker。账户尚未启用 R2，因此预览附件不具备持久化能力。

重建或发布预览前先构建前端，再用预览配置 dry-run 核对绑定：

    npm.cmd --prefix frontend run build
    Remove-Item frontend/dist/_redirects
    npx.cmd wrangler deploy --dry-run --config backend/wrangler.preview.toml
    npx.cmd wrangler deploy --config backend/wrangler.preview.toml

仅在已登录的 Wrangler 会话中运行部署命令；迁移只应用到该预览 D1。不要运行无配置的 `wrangler deploy`，也不要对生产 D1 执行迁移。
