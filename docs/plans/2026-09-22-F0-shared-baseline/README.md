# F0 · 共享基线（第一阶段：基础设施与契约）

日期：2026-09-22。状态：**核查完成，约束生效**。
范围：**只做核查与约定，不新增业务功能、不改业务代码**。

- 工程规则：[docs/engineering](../../engineering/README.md)
- 契约唯一来源：[contracts/README.md](../../../contracts/README.md)
- 上游阶段：[上线硬前置清单](../2026-09-22-go-live-prerequisites/README.md)
- 当前断点：[NEXT-SESSION-PROMPT](../../NEXT-SESSION-PROMPT.md)

## 结论（先看这条）

五项基线**全部成立**，本轮实测 268 后端用例通过。
同时查出 **3 条会让后续会话误判的隐患**（见第 4 节），其中 **1 条是真实漂移**——小程序端契约溯源清单已过期，需指定人执行一次修复。

---

## 1. 五项核查

### F0-1 本地迁移链到 0021 ✅ 成立

| 判据 | 实测 |
|---|---|
| 文件链 | `backend/migrations/` 共 **22 个** `.sql`，编号 `0000`–`0021` **连续无缺号、无重复** |
| 末端文件 | `0021_tradein.sql` 在位，建 `trade_ins` + `offsets` 两表 |
| 应用机制 | `backend/tests/lib/env.mjs` 的 `applyMigrations()` 读取**整个** `migrations/` 目录、按文件名排序、逐个执行 |

**要点**：迁移链是否"到 0021"，由**目录内容**决定，不由任何一处状态标记决定。
测试与本地预览（`createWorkerEnv` / `createTestEnv`）每次起**随机库名的内存 D1**，再全量重放这条链 —— 所以只要 `0022` 文件补进去，下一次跑测试就会自动带上它。

> ⚠️ **不要再引用 `backend/.wrangler/state/` 判断迁移状态。**
> 那里的 `miniflare-D1DatabaseObject/*.sqlite`（258 KB）只有 **20 张早期表**（`hardware` / `library` / `templates` / `quotes` 这一套），**没有 `d1_migrations` 表**，也没有 `customers` / `inventory_movements` / `trade_ins`。
> 它是早期调试遗留的持久化文件，**不反映当前迁移链**。拿它当证据会得出"迁移没跑"的错误结论。

> ⚠️ **远端与本地必须分开陈述。** 本地链到 0021 ≠ 远端已应用。
> 远端（D1 `pc-db`）实际应用到哪一号，**本轮未核实**，不予推断。

### F0-2 后端 268 个用例通过 ✅ 实测

```
命令：npm --prefix backend test
结果：# tests 268  |  # pass 268  |  # fail 0  |  # cancelled 0  |  # skipped 0
耗时：约 270 秒（270032 ms）
```

测试夹具：20 个 `backend/tests/*.test.mjs`，各自起独立内存 D1 + 真实 Worker 入口。

### F0-3 后续迁移固定从 0022 开始 ✅ 约定生效

- 当前最大编号：**0021** ⇒ **下一个迁移必须是 `0022_<描述>.sql`**。
- 命名规则：**4 位补零** + 下划线 + 小写描述。补零是**功能要求**，不是风格问题 —— 应用顺序靠字符串排序，`22_x.sql` 会排到 `0001` 之前。
- 已应用的迁移**只追加、不原地改写**（见 [engineering 目录规则](../../engineering/README.md)）。
- ⚠️ 尚无自动守卫强制该规则（见第 5 节建议）。

### F0-4 `contracts/v1`、生成物、`backend/src/index.ts` 由单一集成人统一维护 ⚠️ 约束建立

链路是**单向**的，任一环被多人同时改都会断：

```
contracts/v1/*.json          ← 唯一来源，8 份，冻结，只追加版本
        │  node contracts/tools/generate-dto.mjs
        ▼
contracts/generated/*        ← 中立生成物，6 个文件，禁止手工编辑
        │  node frontend/scripts/sync-contracts.mjs      （小程序：miniprogram/scripts/sync-contracts.mjs）
        ▼
frontend/src/contracts/generated/*   ← 端内消费副本，禁止手工编辑
```

**为什么这三处必须归一个人管**：`contracts/tools/validate-contracts.mjs` 会**反向读取**它们 ——

- 反向读 `backend/migrations/*.sql`，提取实际表名，与 `legacy-mapping.json` 双向比对；
- 反向读 `backend/src/index.ts`，核对旧权限映射是否覆盖源码里出现的**每一个**权限码，并逐条检查 `evidence` 的**绝对行号**真实存在、且该行确实在做权限判断。

也就是说：**迁移目录多一张表、或 `index.ts` 多几行，契约门禁就会整体失效**（evidence 行号会整体平移）。
记忆里 E05 是 +2 行、E06/E07 是 +4 行 —— 每次都要整体跟着改。多人并行时这是必然的冲突源。

**集成人职责**（具体由谁承担，**待栋哥指定**）：

1. 独占改 `contracts/v1/*`；
2. 改完立即重生成 + 同步两端 + 跑全套契约门禁；
3. 独占改 `backend/src/index.ts` 的**接线部分**（import 与路由分发），改完必须重跑契约校验并修正平移后的 evidence 行号；
4. 迁移文件编号的唯一发放人（保证 F0-3）。

### F0-5 前端只同步生成契约，不新增页面 ⚠️ 约束建立

- 本阶段前端**允许**做的：`node frontend/scripts/sync-contracts.mjs` 把生成契约落进 `frontend/src/contracts/generated/`。
- 本阶段前端**不做**：新增业务页面、新增页面级功能。
- 现状核查：前端副本 `frontend/src/contracts/generated` 与契约源**一致**（三方防漂移复验通过，6 个文件）—— 基线是干净的。

---

## 2. 本轮实测证据汇总

| 检查 | 命令 | 结果 |
|---|---|---|
| 迁移文件链 | `ls backend/migrations/` | 22 个，`0000`–`0021` 连续 ✅ |
| 后端用例 | `npm --prefix backend test` | 268 / 0 失败 ✅ |
| 契约源 → 中立生成物 | `node contracts/tools/generate-dto.mjs --check` | 6 个文件一致 ✅ |
| 契约源 → 前端副本 | `node frontend/scripts/sync-contracts.mjs --check` | 6 个文件一致 ✅ |
| 契约源 → 小程序副本 | `node miniprogram/scripts/sync-contracts.mjs --check` | 6 个文件一致 ✅（**F0 已修复**，见 §4 P-A） |

---

## 3. 生效的协作约束（本阶段适用）

1. **迁移**：新文件从 `0022` 起，4 位补零；已应用的只追加不改写；数据库操作另行授权。
2. **契约**：`contracts/v1` 只由集成人改；改完按「重生成 → 同步两端 → 跑门禁」的顺序收尾。
3. **生成物**：`contracts/generated`、`frontend/src/contracts/generated`、`miniprogram/contracts/generated` **一律禁止手工编辑**；发现问题改生成器或改契约源。
4. **入口**：`backend/src/index.ts` 的接线改动同样归集成人；改完必须重跑契约校验，别照抄旧的行号证据。
5. **前端**：本阶段只同步契约，不新增页面。
6. **收尾**：任何涉及契约或迁移的改动，**先写源码与验证记录，最后再刷回执 `updatedAt`**（进度台会校验 mtime 与 updatedAt 的先后）。

---

## 4. F0 期间发现的既有问题（**本轮未修**，待裁）

### P-A ✅ 小程序端契约溯源清单已过期（真实漂移，**F0 已修复**）

`miniprogram/contracts/generated/manifest.json` 与契约源不符。差异**精确定位在 `generatedFrom` 的哈希**：

| 键 | 中立生成物 | 小程序端 |
|---|---|---|
| `contracts/v1/objects.json` | `7a9396…` | `36e76f…`（旧） |
| `contracts/v1/actions.json` | `300d15…` | `5367da…`（旧） |

而 `artifacts` 里 5 个产物的 sha256 **与中立生成物完全一致**。

**判读**：小程序端的 `.ts` 产物已经同步到位，**只有 manifest 这张溯源清单停在旧契约版本**（E10–E12 期间的契约变更没被它记录）。它不是功能故障，但会让 `--check` 永久报红，也会让日后追溯"这份产物来自哪版契约"时得到假答案。

**修复动作**（一行，非破坏性）：

```bash
node miniprogram/scripts/sync-contracts.mjs
```

**F0 处置：已执行（2026-09-22）。** 先备份原文件，再同步，并逐项核对实际改动：

- 实际改动**只有 2 行** —— 正是 `generatedFrom` 的两个哈希（`objects.json`、`actions.json`）；5 个 `.ts` 产物内容**零变化**（与事前判读一致）。
- 复验：小程序端三方防漂移 ✅、契约源 → 中立生成物 ✅，均退出码 0。
- 备份：`~/.workbuddy/tmp/f0-backup/manifest.json.bak`（在工作区外，不进仓库）。

> 教训留档：**生成物同步只更新 `.ts`、漏掉 `manifest.json` 不会报错**，只会让 `--check` 长期报红。
> 反过来也说明这份清单有用 —— 它记住了「这份产物是哪版契约生成的」。

### P-B ⚠️ 本机 `wrangler` 的 workerd 起不来

```
node ./node_modules/wrangler/bin/wrangler.js d1 migrations list pc-db --local
→ *** std::terminate() called with no exception
  X [ERROR] The Workers runtime failed to start.
```

**影响**：`wrangler d1 migrations list/apply --local` 这条常规路径在本机**不可用**，无法用它查本地迁移状态。
**替代**：迁移是否生效，看 `backend/migrations/` 目录内容 + `applyMigrations()` 的实测行为（本轮即如此核实）。
**注意**：这不影响测试 —— 测试走的是 `miniflare` 内的 workerd（`createTestEnv`），268 项用例正常通过。两者启动方式不同，别混为一谈。

### P-C ⚠️ `.wrangler/state/` 里的旧库会误导判断

见 F0-1 的警示框：它是遗留脏文件，**不能**作为迁移状态证据。

---

## 5. F0 处置决定（2026-09-22 已执行）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 修 P-A 小程序 manifest 漂移 | ✅ 已执行，复验全绿（见 §4） |
| 2 | 加迁移编号守卫 | ✅ 已执行 —— `backend/scripts/check-migration-sequence.mjs`，入口 `npm --prefix backend run check:migrations` |
| 3 | 约束写进 `AGENTS.md` | ✅ 已执行 |
| 4 | 明确「集成人」 | ✅ 改为**锁**规则，见 §5.1 |

### 5.1 「集成人」的落地方式：一把锁，而不是一个名字

栋哥常态**同时开多个会话**，指定「某个人」在流程上管不到别的会话。所以 F0-4 的实际执行方式是：

> **同一时间，只允许一个会话改动** `contracts/v1`、`contracts/generated`、两端端内生成物、`backend/migrations`、以及 `backend/src/index.ts` 的**接线部分**。

零成本做法，不需要新工具：

1. 开工前声明占用：「本轮我要动契约 / 入口 / 迁移」；
2. 动手前看这些文件的**时间戳**，确认没人在写；
3. 改完立刻按「**重生成 → 同步两端 → 跑门禁**」收尾，**门禁全绿才算交付**；
4. 收尾时刷回执 `updatedAt`（先写源码与验证记录，**最后**才刷时间）。

**为什么"锁"比"指定人"可靠**：它约束的是**动作**，任何会话都能遵守；而"记得住某个名字"一旦换会话就失效。

### 5.2 新增守卫：迁移编号

- 脚本：`backend/scripts/check-migration-sequence.mjs`（只读：不写文件、不连库、不改状态）
- 入口：`npm --prefix backend run check:migrations`
- 校验：`NNNN_小写描述.sql` 命名 + 编号唯一 + **从 0000 起连续无缺号**，并打印**下一个必须使用的编号**
- 负向已验：临时插入 `22_zeroless.sql`（未补零）→ 正确报「命名不合规」并退出码 1；清理后恢复通过

---

## 6. 未验证 / 边界

- 远端 D1 实际应用的迁移编号：**未核实**（本机无 CF 登录态，且 workerd 不可用）。
- 前端 / 小程序功能本身：**未验证**，F0 不覆盖。
- 小程序端其余检查（`check-pages` / `check-classes` / `typecheck`）：**未跑**。
- 本轮所有数字是**单次实测**；历史文档里的旧数字不作数。
