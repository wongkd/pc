# T00 · 可追踪基线与条件登记

日期：2026-09-17
状态：**T00a 本地通过（基线已建立）· T00b 部分完成（凭据已迁移，平台条件待登记）· T00c 本地通过**
依据：[05-implementation-tasks.md · T00](../../plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md)、[01 第 5、7 节](../../plans/2026-09-17-web-wechat-plan/01-scope-and-architecture.md)、根 [AGENTS.md](../../../AGENTS.md)

本卡为只读核对与基线记录，未修改任何业务代码、未新增迁移、未部署、未接触生产数据。

---

## 1. 本卡文件范围

| 类型 | 路径 | 说明 |
|---|---|---|
| 写入 | `docs/verification/2026-09-17-T00/README.md` | 本文件 |
| 写入 | `docs/verification/2026-09-17-T00/logs/frontend-baseline.log` | 前端 test/build/lint 原始输出 |
| 只读 | 根 `README.md`、`AGENTS.md` | 入口与工程约定 |
| 只读 | `装机店经营工作台-重做规划-2026-09-17.md` | 业务方向 |
| 只读 | `docs/plans/2026-09-17-web-wechat-plan/` 全部 7 份 | 执行规格 |
| 只读 | `frontend/package.json`、`backend/package.json`、`backend/wrangler.toml`、`backend/tsconfig.json` | 脚本与配置基线 |
| 只读 | `frontend/src/erpNavigation.ts`、`App.tsx` 等源码目录清单 | 现状核对 |

未递归扫描 `node_modules/`、`backups/`、历史截图。

---

## 2. T00a · 仓库与工作目录

| 核对项 | 命令 | 实际结果 |
|---|---|---|
| 工作目录是否 Git 仓库 | `git rev-parse --is-inside-work-tree` | `fatal: not a git repository` |
| 工作区状态 | `git status --short` | 同上，非仓库 |
| 上级目录是否仓库 | 在 `C:\Users\wuerl\Documents\工作同步\` 执行 | 同样不是仓库 |
| 实际工作目录 | — | `C:\Users\wuerl\Documents\工作同步\pc-quote` |

**结论**：核对时当前目录及上级目录均无 Git 仓库，无可追踪提交基线。本卡按卡片要求**未擅自初始化**，将该决定上报用户，并在获得"授权初始化"的明确答复后执行。

**执行结果（用户授权后，2026-09-17 20:05 起）**

| 项目 | 结果 |
|---|---|
| 仓库 | `C:\Users\wuerl\Documents\工作同步\pc-quote`，`git init -b main` |
| 分支 | `main` |
| 基线提交 | `e5ca594c05cb034db5331f53506c51f69f50ea31`（短 `e5ca594`） |
| 纳管文件 | 151 个（`docs` 64、`frontend` 52、`backend` 14、根文档等） |
| 提交后状态 | 工作区干净，无未跟踪残留 |
| `.git` 体积 | 6.8 MB |
| 身份配置 | **仓库级**（`--local`）：`user.name=wongkd`、`user.email=563838884@qq.com`；未改动全局配置 |
| 换行符策略 | `core.autocrlf=false`（保持工作区原样，避免批量伪改动） |

**连带发现与认知修正**：项目记忆中记录的本地 D1 验证 harness（根目录 `verification/local-d1-20260722/` 下的 `d1-adapter.mjs`、`run-migrations.mjs`、`verify-handler.mjs`）**脚本文件在本机已不存在**，该目录为空。但同时在 `backend/` 下发现了 5 个 miniflare 运行产物目录（`.validation-d1`、`.validation-d1-apply`、`.validation-d1-final`、`.validation-d1-runner`、`.validation-d1-runner-final`）与 `.validation-stage1b.sqlite`，说明**本地 D1 验证确实跑通过、基础设施可用，只是脚本没有留在仓库内**。T04 应重建可复现的测试入口，而不是重造运行环境。

---

## 3. T00b · 平台与外部条件登记

> 本表只登记"是否具备"，不写入任何密钥、完整账号凭据或令牌值。

### 3.1 已核实的代码事实

| 项 | 事实 | 影响 |
|---|---|---|
| D1 绑定 | `backend/wrangler.toml` → binding `DB`，dashboard `pc-db`，database_id `2218dbef-…0a17` | 生产库与本地开发需明确隔离 |
| Worker 名称 | `pc-backend` | 生产/测试共用后端（历史已记录） |
| 迁移文件 | `backend/migrations/` 共 6 个：`0000_baseline`、`0001_erp2_stores_members_permissions`、`0002_product_master_data`、`0003_orders`、`0004_sn`、`0005_sn_hardening` | T01 需完成旧表→新模型映射 |
| 后端结构 | `backend/src/index.ts` 单文件（约 1551 行 / 103 KB） | 与新方案 `routes/domains/repositories` 分层差距大 |
| 前端导航 | `frontend/src/erpNavigation.ts` 共 12 项 | 需收拢为 6 项 |
| 后端测试脚本 | `backend/package.json` **无 `test` 脚本** | 符合方案描述；T04 必须自建 |
| 后端可用本地工具 | `backend/node_modules/.bin/` 存在 `wrangler`、`miniflare`、`workerd`、`esbuild` | 本地 D1 测试可走 miniflare 路线（比历史 node:sqlite 等价方案更接近真实运行时） |
| 后端类型检查 | `backend/tsconfig.json` 为 `strict` + `noEmit`；但 `backend/node_modules` **未安装 `typescript`** | 现无开箱即用的 `tsc`；T04 需补齐或改用其他静态检查 |
| 前端环境变量 | `frontend/` 无 `.env*` 文件 | 接口地址走代码内配置 |

### 3.2 明文凭据（已处理）

核对时 `backend/wrangler.toml` 的 `[vars]` 段存在**明文第三方凭据**：`PDD_CLIENT_ID`、`PDD_CLIENT_SECRET`、`PDD_PID`。

用户决策为"改用 `wrangler secret` 并清除明文"，执行结果：

| 步骤 | 结果 |
|---|---|
| 备份原文件 | `backups/wrangler.toml.bak-20260917`（`backups/` 已被 `.gitignore` 排除） |
| 值迁出 | 三个变量写入 `backend/.dev.vars`（长度校验与原值一致：32 / 40 / 18 字符） |
| 清除明文 | `wrangler.toml` 的 `[vars]` 段删除，替换为 secret 使用说明注释 |
| 残留检查 | `grep -E '^PDD_[A-Z_]+ *=' wrangler.toml` 结果为 **0** |
| 提交验证 | `git grep` 确认 HEAD 内 `wrangler.toml` 不含任何凭据赋值；`.dev.vars` 未被跟踪 |

`DEEPSEEK_KEY` 与 `JWT_SECRET` 此前**已不再明文**——文件中仅有注释提示用 `wrangler secret put` 配置，该项历史风险已消除。

**⚠️ 未完成的前置动作（重要）**：本机 `wrangler` 4.105.0 可用，但**没有 Cloudflare 登录态，也没有 API Token 环境变量**，因此三个生产 secret **尚未写入远端**。当前线上 Worker 的 `PDD_*` 来自上一次带 `[vars]` 的部署。

- 在完成下列命令前，**不要执行 `wrangler deploy`**，否则新配置会让这三个变量从线上消失：

```bash
cd backend
wrangler secret put PDD_CLIENT_ID
wrangler secret put PDD_CLIENT_SECRET
wrangler secret put PDD_PID
```

- PDD 集成代码仍在 `backend/src/index.ts`（含网关地址常量），说明该功能未废弃，凭据必须保留而非删除。

### 3.3 待用户提供（本卡无法自行核实）

| 编号 | 待登记项 | 现状 | 阻塞范围 |
|---|---|---|---|
| B-01 | 微信小程序 AppID / 主体 / 开发成员 | **未知** | 阻塞 T03 联调、T21 真机；不阻塞 T01/T02 |
| B-02 | 小程序 API 请求域名（HTTPS） | **未知** | 阻塞 G0 可达性预检与真机 |
| B-03 | 照片 / 文件的私有对象存储方案 | **未知**（历史用 Cloudflare，未确认） | 阻塞 T16 |
| B-04 | 店内网络环境（带宽 / 稳定性 / 是否已有扫码枪、打印机） | **未知** | 影响 G3 试用与性能目标校准 |
| B-05 | iOS / Android 真机测试设备 | **未知** | 阻塞 T21b |
| B-06 | 在本目录初始化 Git 并建立基线 | ✅ **已完成**（提交 `e5ca594`，分支 `main`，仓库级身份） | 不再阻塞 |

---

## 4. T00c · 前端基线检查结果

执行时间：2026-09-17 20:01（Asia/Shanghai）。原始日志：`logs/frontend-baseline.log`。
命令统一在项目根执行，前缀 `npm --prefix frontend run`。

| 检查 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 单元测试 | `npm --prefix frontend run test` | `0` | ✅ **4 个测试文件 / 17 个用例全部通过**（`api.test.ts` 9、`money.test.ts` 3、`hardwareLibraryExcel.test.ts` 3、`date.test.ts` 2） |
| 生产构建 | `npm --prefix frontend run build` | `0` | ✅ `tsc -b && vite build` 通过，253 个模块，耗时 2.07s |
| 代码检查 | `npm --prefix frontend run lint` | `1` | ❌ **39 个问题（35 error / 4 warning）** —— 既有失败基线，本卡不修复 |

### 4.1 lint 既有失败分布（9 个文件）

| 文件 | 主要规则 |
|---|---|
| `src/App.tsx` | `react-hooks/set-state-in-effect` |
| `src/components/OrdersPages.tsx` | `react-hooks/set-state-in-effect` |
| `src/components/ProductManagementPage.tsx` | `set-state-in-effect`、`no-explicit-any` |
| `src/components/SystemSettingsPage.tsx` | `set-state-in-effect`、`no-unused-vars` |
| `src/components/HardwareLibrarySection.tsx` | `no-explicit-any` |
| `src/components/QuoteItemsSection.tsx` | `no-explicit-any` |
| `src/utils/api.ts` | `no-explicit-any` |
| `src/utils/api.test.ts` | 其他 |
| `vite.config.ts` | `no-explicit-any` |

**规则分布**：`@typescript-eslint/no-explicit-any`（约 25 项）> `react-hooks/set-state-in-effect`（约 7 项）> `react-hooks/exhaustive-deps` warning（4 项）> 其余（`no-empty`、`no-unused-vars`、`react-refresh/only-export-components`）。

**说明**：`lint` 失败为**改动前既有状态**。`no-explicit-any` 大量集中在 `utils/api.ts`，与新方案"按域渐进拆分接口层"的改造方向一致，可在对应业务切片中顺带收敛；`set-state-in-effect` 集中在将被替换的旧页面组件中。本卡不做任何修复。

---

## 5. 基线纳入范围与忽略规则

新建 `.gitignore`（根目录）。**纳入**：`frontend/`、`backend/` 源码与迁移、`docs/`（含设计与验证记录）、根层文档与配置。
**排除**（附排除理由）：

| 规则 | 排除内容 | 理由 |
|---|---|---|
| `node_modules/` | 三处依赖目录 | 可重建，体积大 |
| `dist/` `build/` `coverage/` | 构建产物 | 可重建 |
| `.dev.vars` `.env*` `*.pem` `*.key` | 凭据与环境变量 | 安全 |
| `backups/` | 本地备份（含生产数据与明文配置） | 安全 |
| `.sync_temp_dir/` | 坚果云同步临时目录 | 非项目内容 |
| `.validation-*/` `*.sqlite*` | miniflare / D1 本地验证数据库 | 含本地业务数据，可重建 |
| `.workbuddy/` `.learnings/` | AI 工作区数据与项目记忆 | 由坚果云同步承担，避免高频噪音提交 |
| `*.log` | 日志 | 保留例外：`docs/verification/**/logs/*.log` |

**刻意保留在仓库内**：`frontend/public/pc/`（1.3 MB 静态资产）——它是部署时会被原样复制的运行依赖，不是可重建的构建产物。

审阅中修正的问题：初次暂存时 `backend/.validation-*` 下 31 个 miniflare 数据库文件被误纳入（当时规则未覆盖），已补齐规则并重建索引；另修正了 T00 日志初次写错到根目录 `verification/` 的路径不一致。

---

## 6. 通过的判定

| 卡片条件 | 状态 |
|---|---|
| 正确目标可追踪 | ✅ 基线提交 `e5ca594`（分支 `main`，151 个文件），此后改动可追溯 |
| 不会误触生产 | ✅ 未运行 `wrangler deploy`、未连接 D1、未接触生产数据 |
| 后续知道哪些检查原本就失败 | ✅ lint 39 项、后端无 `test` 脚本均已登记 |

**T00a / T00c 判定为「本地通过」。** T00b 因微信侧平台条件尚未提供，记为「部分完成」，不标通过。

---

## 7. 未完成 / 阻断

| 项 | 原因 | 影响 |
|---|---|---|
| 三个生产 secret 未写入远端 | 本机无 Cloudflare 登录态与 API Token | 仅阻塞 `wrangler deploy`；**部署前必须补做**，否则线上 PDD 变量丢失 |
| 微信平台条件未知 | 等用户提供（B-01~B-05） | 阻塞 T03 / T16 / T21，**不阻塞 T01 / T02** |
| 后端本地测试入口缺失 | 历史脚本未留存，且无 `test` 脚本 | 阻塞 T04 的验证；T04 需重建（miniflare 环境已具备） |
| 根目录 `verification/` 空目录残留 | 历史遗留（含空的 `local-d1-20260722/`） | 不影响 Git（空目录不被跟踪）；建议后续清理以统一到 `docs/verification/` |

---

## 8. 下一步

**T01（冻结契约与样本）** 可以立即开始：它只产出 `contracts/` 目录与协议文档，不依赖 AppID、不依赖 Cloudflare 凭据，也不触碰生产。

三项待办并行跟进（均不阻塞 T01）：

1. 补做三个 `wrangler secret put`（需要 Cloudflare 登录或 API Token）。
2. 提供微信侧平台条件（AppID / 主体 / 成员、API 域名、对象存储、店内网络、测试手机）。
3. 后端本地 D1 测试入口在 T04 重建时一并解决。
