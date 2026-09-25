# MP16 · 隔离环境与演示开关

日期：2026-09-23。状态：**实现完成，M 档门禁全绿，待复核（review）**。
上游断点：[排版重做接续入口](../2026-09-23-layout-rework/README.md)（MP15 仍 blocked）。

## 本卡交付

让「当前该连哪个后端」在全端只有**一个**结论来源，并且**算不出来就报错，不降级**。

| 交付物 | 说明 |
|---|---|
| `features/customer/environment.ts`（新增） | 三档环境、地址表、解析守卫、顾客存储命名空间 |
| `services/customer/client.ts`（新增） | 顾客端 API 客户端装配（既有请求核心不动） |
| `app.ts`（改） | 启动解析环境，写入 globalData；失败时记录原因不回落 |

## 已改文件

| 文件 | 改动 |
|---|---|
| `miniprogram/features/customer/environment.ts` | **新增**。零运行时依赖（只 `import type`），可被 `node --test` 直接加载 |
| `miniprogram/services/customer/client.ts` | **新增**。装配层，与 `api-client.ts` 同类，不参与 Node 测试 |
| `miniprogram/app.ts` | 改。`demoMode` 由恒 `true` 改为按环境解析结果；新增 `environmentName` / `environmentNote` / `environmentError` |
| `miniprogram/tsconfig.json` | 改。`include` 增加 `services/**/*.ts` |
| `miniprogram/tests/customer-environment.test.mjs` | **新增**。10 项用例 |

未改动（本卡刻意保留）：`features/api-core.ts`、`features/api-client.ts`、`features/session.ts`、`contracts/**`、`backend/**`、任何页面 wxml/wxss。

### 关于 `tsconfig.json`（超出卡内清单，理由如下）

卡内「只允许改动」未列 `tsconfig.json`，但 `03-execution-and-acceptance.md` 明确要求
「新组件/目录要纳入 tsconfig 和结构检查，不能通过 exclude 逃避检测」。本卡新增了 `services/` 目录，
不改 include 则新代码**不被类型检查**。故只加一行 `services/**/*.ts`，未动其他配置。

## 实测命令与结果

在仓库根执行（`npm` 不在 PATH，`tsc` 用项目内绝对路径）：

| 命令 | 结果 |
|---|---|
| `node --test "miniprogram/tests/*.test.mjs"` | **pass 123 / fail 0**（原 113 + 本卡新增 10） |
| `miniprogram/node_modules/.bin/tsc.cmd -p tsconfig.json --noEmit` | pass |
| `node miniprogram/scripts/check-pages.mjs` | pass（app.json 注册与磁盘一致；顾客 tabBar 四项与顺序一致） |
| `node miniprogram/scripts/check-classes.mjs` | pass |
| `node miniprogram/scripts/sync-contracts.mjs --check` | pass（6 个文件一致） |

路径 `docs/verification/customer-4tab/MP16/` 已包含 `receipt.json` 与本文件。历史通过数未复制。

## 设计要点（每条对应一种真实事故）

1. **正式版不得连测试库或显示演示数据**
   `envVersion === 'release'` 且解析结果不是 `prod` → 抛 `CustomerEnvironmentError`。
   体验版默认解析为 `test`，**不**默认演示数据 —— 走查版本显示虚构商品比打不开更糟。
2. **真实模式缺地址立即失败**
   `test` / `prod` 无 API 地址 → 抛错；**不**回落演示样本，也**不**返回一个「看起来能用」的客户端。
   非 HTTPS 地址同样在此层提前拒绝（与 `api-client.ts` 的既有校验一致）。
3. **顾客与员工物理隔离**
   顾客端所有键带 `pc-customer:` 前缀，由 `createCustomerStorage` 统一加前缀。
   这一点是必需的：待确认动作的键由 `api-core.ts` 的 `PENDING_STORAGE_KEY` **固定写入、无法按调用方配置**，
   所以隔离只能做在前缀层，而不是逐个键去动既有核心。
4. **演示模式不建 API 客户端**
   `createCustomerApiClient` 在 `demo` 环境直接抛错，避免「已经连上服务」的错觉。

## 未验证范围

- **未在微信开发者工具运行**：本卡未改动任何 wxml/wxss，四屏视觉不变，故未截图（`visual: not_applicable`）。
  `app.ts` 的启动路径没有原生证据；其调用的解析规则由 10 项 Node 用例覆盖，入口本身仅 try/catch + 赋值。
- **微信实连未做**（见阻塞）。`test` / `prod` 两档地址在当前仓库状态下均为 `null`。
- 未做真机、未访问生产、未部署、未提交。

## 阻塞

1. **无可用 HTTPS API 域名**：`pc.huangqidong.cn` 挂在 Cloudflare 且未做国内接入备案，
   不能作为小程序 `wx.request` 合法域名；本地 Worker 入口是 `http://127.0.0.1:8787`（非 HTTPS）。
   故 `CUSTOMER_ENVIRONMENT_SPECS` 中 `test` / `prod` 的 `apiBaseUrl` 均留空。
   拿到备案域名后**只需在该表填地址**，其余代码零改动。
   备案真实状态属现场事实，以腾讯云备案控制台为准，本回执不代作断言。
2. `app.json` 仍注册 4 个员工端页面（`today` / `sales` / `inventory` / `more`）与 2 个员工分包页。
   本卡未动 app.json；按计划由 **MP60** 做「演示资源与旧员工路由发布隔离」。

## 下一动作

**MP17 · 顾客身份与归属契约**（前置 MP16 已完成）。动 `contracts/v1` / `backend/migrations` / `index.ts` 接线前，
先复核这几个路径的时间戳与 diff，确认无其他会话写入。本卡未自动进入下一卡。
