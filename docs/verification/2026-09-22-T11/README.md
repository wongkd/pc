# T-11 · 错误提示不吞数据库真因

更新：2026-09-22。状态：已完成，已在本地隔离 Worker + 内存 D1 验证；未部署、未访问生产。

## 目标

修复新版 v2 写动作把 `VALIDATION_ERROR` 只显示成通用话术的问题。保留原有面向用户的业务提示，同时把数据库失败中可安全展示的真因追加到 `message`；程序仍只按 `error.code` 分支。

## 实现范围

- `backend/src/domains/operations.ts`：失败结果保留最多 500 字符的数据库诊断；新增唯一约束、外键、CHECK 及服务端守卫语义的可读翻译。
- `backend/src/domains/inventory.ts`：SKU 重复、重复期初为守卫附加服务端语义标签；标签不来自客户端，也不改变契约错误码。
- `backend/src/routes/{quote,sales,inventory,purchase,service,finance,recovery}-v2.ts`：新版写动作统一在响应前追加可读诊断。未知格式不直接透出 SQL 原文，只提示保留请求编号排查。
- `backend/tests/t04a-consistency.test.mjs`、`backend/tests/e04b-inventory-http.test.mjs`：增加纯函数和真实 HTTP 回归断言。

本卡没有修改契约 JSON、错误码生成物或数据库迁移，因此不改变 `contractVersion`，也不授权远端迁移。

## 验证

针对性回归：

```text
node --test --test-concurrency=1 tests/t04a-consistency.test.mjs tests/e04b-inventory-http.test.mjs
35 通过 / 0 失败
```

完整后端回归（PowerShell 展开 `tests/*.test.mjs` 后执行）：

```text
node --test --test-concurrency=1 tests/*.test.mjs
258 通过 / 0 失败
```

实际 HTTP 响应已验证为：

```text
商品没有通过校验……（具体原因：本店 SKU 已存在）
```

原生数据库唯一约束也会得到类似「订单号已存在（订单号生成冲突）」的具体原因，不再只显示「报价没有通过转单校验」。

## 边界

- 证据来自本地真实 Worker、Miniflare 与内存 D1；没有微信开发者工具、真机、生产或远端迁移证据。
- 前端已有请求核心原样展示服务端 `message`，本卡未改前端页面，因此未重跑前端 test/build/lint。
- T-11 的“错误提示吞真因”已收敛；其余客户入口、旧商品页边界、演示数据产物隔离仍按 OPEN-ITEMS 保留。
