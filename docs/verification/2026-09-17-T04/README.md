# T04 · 一致性与幂等基础（a / b / c）

日期：2026-09-17。状态：**本地通过**（前置 T03 未做，本卡只覆盖与身份无关的部分，见「未完成 / 阻断」）。

入口：`backend/tests/`。规格依据：[04-data-and-api.md](../../plans/2026-09-17-web-wechat-plan/04-data-and-api.md) §7；任务卡 [T04](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md)。

---

## 1 · 为什么要做这张卡（一句话）

**D1 里「条件 UPDATE 影响 0 行」不是报错。** 批次会继续往下跑，于是「库存没扣成、流水却写进去了」这种半截账会静默产生。T04 的唯一目的，就是让每一处「这件事必须发生过」在数据库层变成硬错误；不做这一步，后面 T05–T11 的库存和收款一定出错。

这不是推测，已在本卡实测复现（见 §4 反例 A）。

---

## 2 · 实际改动

| 文件 | 状态 | 职责 |
|---|---|---|
| `backend/migrations/0006_consistency_core.sql` | 新增 | 建 `operations`、`assertion_guards`(+触发器)、`entity_version_log`、`operation_failures`。**只新增，不动 0000–0005 任何表、列、触发器、行** |
| `backend/src/domains/operations.ts` | 新增 | 幂等执行器 `runIdempotent`、断言守卫 `guardStatement`、版本推进 `bumpVersionStatement`、结果查询 `queryOperation`、错误分类 `classifyDatabaseError` |
| `backend/scripts/sync-error-codes.mjs` | 新增 | 从 `contracts/v1/errors.json` 单向生成后端错误码常量，支持 `--check` 防漂移 |
| `backend/src/generated/error-codes.ts` | 新增（生成物） | 16 个契约错误码 + HTTP 状态 + retryable。首行 DO NOT EDIT |
| `backend/tests/lib/{env,sql,build,demo}.mjs` | 新增 | 本地 D1 环境、SQL 拆分器、TS 打包、共用夹具 |
| `backend/tests/harness/{demo-action.ts,demo-schema.sql}` | 新增 | 测试专用演示动作与表。**不属于生产代码** |
| `backend/tests/t04{a,b,c}-*.test.mjs` | 新增 | 21 个用例 |
| `backend/package.json` | 修改 | 加 `test`、`check:error-codes` 脚本；`esbuild`、`miniflare` 由传递依赖改为显式声明 |
| `contracts/v1/legacy-mapping.json` | 修改 | **+49 行纯追加**：登记 4 张新表（校验脚本要求「迁移表必须被映射覆盖」）。未改任何枚举取值、目标对象名或校验规则 |

**未改**：`backend/src/index.ts`（旧 Worker 一行未动）、`frontend/`、`miniprogram/`、`wrangler.toml`、0000–0005 迁移。

---

## 3 · 核心设计决策（给后续卡用）

1. **约束即断言，不靠「检查影响行数」。**
   能被 SQL 表达的条件一律写成约束：
   - 幂等 → `UNIQUE (store_id, request_id)`
   - 有效逐件预留 → 部分唯一索引 `WHERE status='active'`
   - 数量/金额非负 → `CHECK`
   - 其余复合条件 → `assertion_guards` 守卫 + `RAISE(ABORT, code)`

2. **版本推进用「插入版本日志」，不用「条件 UPDATE + 查影响行数」。**
   并发下两个客户端都从版本 N 出发，若用「更新后 version 是否 = N+1」判断，**后到的那个会把别人的推进误判成自己的成功**。改为主键 `(entity_type, entity_id, version)` 插入后，唯一冲突天然决出唯一胜者。业务表的 `version` 列只是便于读取的冗余。

3. **幂等记录的 `result_json` 与业务语句在同一个 batch 内写入。**
   副作用因此由数据库保证「恰好一次」，而不是靠调用方小心。
   代价（后续卡必须遵守）：**`outcome` 不能依赖自增主键**——batch 内取不到自增 ID，业务实体 ID 必须在拼 SQL 之前由服务端生成。

4. **失败不落 `operations`，只落 `operation_failures`**（表名即语义，不会被误读为「动作成功」）。

5. **错误码不在后端手写第二份**：从契约生成，`--check` 可做门禁。

---

## 4 · 验证证据

环境：本机 `workerd` via `miniflare` 4.20260625.0 + 真实 D1 binding；Node v22.22.2；隔离内存库，按序应用 7 个迁移。**未连远程、未 deploy、未接触生产 D1。**

```
npm --prefix backend test
→ 21 用例 / 21 通过 / 0 失败（约 34s）
```

| 覆盖点 | 用例 | 结果 |
|---|---|---|
| 结构：0006 四处对象与触发器 | 迁移与结构 | ✅ |
| 守卫表静息为空 | 守卫表静息为空 | ✅ |
| 正常路径（扣减/流水/幂等/版本日志各一笔） | 正常路径 | ✅ |
| 同 ID 同载荷复用 | req-reuse | ✅ |
| 同 ID 改载荷拒绝 | req-mismatch | ✅ |
| 版本冲突无副作用 | req-version | ✅ |
| 余量不足无副作用 | req-stock | ✅ |
| **批次中途失败整批回滚** | req-tail | ✅ |
| **反例：不设防时 0 行静默放过后续写入** | 反例 | ✅ |
| 同场景设防后整批回滚 | 设防后 | ✅ |
| CHECK 约束即断言 | 扣成负数 | ✅ |
| 唯一约束即断言 | 版本日志重复 | ✅ |
| **并发抢同一资源只有一个胜者** | req-race | ✅ |
| **并发同 requestId 副作用恰好一次** | req-same-id | ✅ |
| **不同 requestId 抢同一实物被唯一约束拒绝** | req-item | ✅ |
| **响应丢失后可查询恢复 + 重发复用** | req-lost | ✅ |
| 查询未知 ID 如实返回 found=false | req-never | ✅ |
| 查询载荷不一致标 mismatch | req-mismatch-query | ✅ |
| 失败后换新 ID 重试成功且无残留 | req-retry | ✅ |

### 4.1 反例实测输出（证明这个洞真实存在）

```
[PASS] E 反例·裸条件 UPDATE 0 行静默通过
       err=(无错误) | available=5 flows=1(已插入1条 => 半截账)
```

同一条批次换成守卫后：`err=D1_ERROR: STOCK_CONFLICT: SQLITE_CONSTRAINT`，`available=5`、`flows=0`。

### 4.2 回归（确认没碰坏既有东西）

| 检查 | 命令 | 结果 |
|---|---|---|
| 契约自洽 | `node contracts/tools/validate-contracts.mjs` | ✅ 退出码 0 |
| 网页端生成物防漂移 | `node frontend/scripts/sync-contracts.mjs --check` | ✅ 退出码 0 |
| 小程序端生成物防漂移 | `node miniprogram/scripts/sync-contracts.mjs --check` | ✅ 退出码 0 |
| 后端错误码防漂移 | `node backend/scripts/sync-error-codes.mjs --check` | ✅ 16 个码一致 |
| 网页端单测 | `npm --prefix frontend run test` | ✅ 6 文件 / 50 用例 |
| 网页端构建 | `npm --prefix frontend run build` | ✅ built in 2.07s |
| 小程序单测 | `npm --prefix miniprogram test` | ✅ 39 用例 |
| **生产构建可编译** | `npx wrangler deploy --dry-run` | ✅ 99.52 KiB / gzip 22.68 KiB，**未部署** |

日志：`logs/` 目录。

---

## 5 · 机制探测结论（本卡开工前的实测，决定了整套设计）

| 问题 | 结论 |
|---|---|
| D1 batch 是否事务性 | **是**。中间任一语句失败，整批回滚 |
| 「影响 0 行」是否报错 | **不报错**，后续语句照跑 → 半截账 |
| CHECK 约束失败能否中止整批 | **能** |
| 唯一约束失败能否中止整批 | **能** |
| `RAISE(ABORT, NEW.code)` 能否把错误码带出来 | **能**（消息形如 `D1_ERROR: STOCK_CONFLICT: SQLITE_CONSTRAINT`） |
| 部分唯一索引（`WHERE`）是否可用 | **可用** |
| 外键是否默认启用 | **是**（`PRAGMA foreign_keys=1`） |
| `changes()` | 可用，但连接级、跨语句不可靠 → **本设计不依赖它** |
| `sqlite_version()` | **被 D1 禁用** |

---

## 6 · 未完成 / 阻断

| 项 | 说明 |
|---|---|
| **前置 T03 未做** | T04 卡面前置为 T01、T03。T03 依赖微信主体 / 成员 / API 域名（仍缺），故本卡只实现**与身份无关**的部分。**动作入口目前没有鉴权**：`runIdempotent` 的 `storeId` / `actorUserId` 由调用方传入，T03 必须保证它们来自会话而不是客户端请求体 |
| **0006 未应用到任何远端** | 生产 D1 的 0004 / 0005 是否已应用本身就未核实（OPEN-ITEMS T-06），**0006 更未应用**。在 T20 迁移演练与明确授权之前不得 apply |
| **本地并发 ≠ 跨实例压测** | workerd 单线程调度，本卡的「并发」是两条请求同时在途、由数据库约束决出胜者。真实跨机房竞争未测 |
| **旧写入口未收口** | `index.ts` 里直接改履约状态、直接收款的老接口仍在，且不经过 `runIdempotent`。不违本卡范围，但 T19 必须封掉旁路 |
| **失败诊断未做脱敏过滤** | 目前只截断 500 字符。T19 需核对不得写入载荷原文 |
| **小程序 / 网页端未接** | 两端仍用样本数据，本卡不涉及 |

---

## 7 · 踩坑（已登记进 `docs/OPEN-ITEMS.md`）

| 编号 | 坑 |
|---|---|
| P-15 | **注释里出现 `*/` 会提前闭合块注释**：文件头写了 `.validation-*/`，导致后面整段被当代码，报出位置的下一行 `SyntaxError`，极具误导性 |
| P-16 | **miniflare 的 `scriptPath` 不编译 TypeScript**（只有 wrangler 走 esbuild）→ 报 `Unexpected token`。测试改用 esbuild 预打包后直接调用 |
| P-17 | **D1 的 `exec()` 按换行切分语句**，多行 DDL 会被切坏；触发器体内还含分号。需自己按「注释/字符串/触发器 BEGIN…END」规则拆分 |
| P-18 | **`node --test` 不会因测试跑完就退出**：若留下活动句柄会挂住管道。要么确保 `dispose()`，要么像探测脚本一样显式 `process.exit()` |

---

## 8 · 下一步

D4 已裁定跳过 T02c，按依赖顺序继续。

1. **T03**（身份、微信绑定与请求层）—— 仍缺微信主体 / 成员 / API 域名；本地可先做 T03b 请求封装与错误码映射，`/me`、权限装配可先接本地 D1。
2. **T05**（商品、实物与期初库存）—— 依赖 T04 已就绪；这是第一张能让人「真用起来」的卡。
3. 未决项：本卡新增 **D-H**（`operations.result_json` 是否成为契约对象，或继续由实现自定）待负责人裁定。
