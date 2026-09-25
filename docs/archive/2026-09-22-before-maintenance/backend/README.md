# 后端 · Workers 与 D1

更新：2026-09-19。状态：旧接口与新业务基础并存；新顾客报价/支付闭环未完成。
目标：统一身份、权限、业务动作、库存流水及收付款一致性。

## 文件职责

| 路径 | 职责 |
|---|---|
| src/index.ts | 现有 HTTP 入口与旧业务路由，按任务逐步拆分 |
| src/domains | 库存、身份、会话、幂等等新业务基础 |
| migrations | 数据库增量迁移，禁止随意删除/重写 |
| tests | 真实 workerd/D1 本地验证及夹具 |
| tests/lib/worker.mjs | 把 `src/index.ts` 打包进 miniflare 跑的夹具；测试与本地预览共用同一套 |
| scripts/dev-server.mjs | 本地隔离后端（内存 D1 + 演示数据），只监听回环地址 |
| scripts | 契约错误码同步等维护工具 |

## 本地验证

仓库根执行：

    npm --prefix backend run dev:local     # 起隔离后端，默认 127.0.0.1:8787
    npm --prefix backend test
    npm --prefix backend run check:error-codes

`dev:local` 只跑本机 workerd 与内存 D1，不 deploy、不应用远端迁移、不读生产数据；
数据是演示数据，进程退出即清空。不要把 `wrangler deploy` 当运行或测试命令。
新 HTTP 路由接入前先确认鉴权、权限和环境；新库存基础不能因旧接口存在就标记为已接通。

证据：[T04](../../../verification/2026-09-17-T04/README.md)、
[T05a](../../../verification/2026-09-18-T05a/README.md)、
[T03a](../../../verification/2026-09-18-T03a/README.md)、
[E04 客户主数据](../../../verification/2026-09-19-E04-customers/README.md)。

未实现/未验证：商品与实物的 HTTP 路由、新顾客报价归属授权、分享版本、支付链路、完整业务联调、
当前远端迁移状态（0006–0010 是否应用仍未核实）。
接入顺序按 [ERP 整体规划](../../../plans/2026-09-19-erp-first/README.md) 的 E02–E14；Q01 模型保留复用，下一动作以根交接为准。
