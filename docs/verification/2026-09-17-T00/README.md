# T00 · 可追踪基线与条件登记

日期：2026-09-17
状态：**T00c 本地通过 · T00a 待授权 · T00b 待用户提供信息**
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

**结论**：当前目录及上级目录均无 Git 仓库，无可追踪提交基线。本卡按卡片要求**不擅自初始化 Git**，该决定上报用户。

**连带发现（需修正历史认知）**：项目记忆中的本地 D1 验证 harness（`verification/local-d1-20260722/` 下的 `d1-adapter.mjs`、`run-migrations.mjs`、`verify-handler.mjs`）**在本机已不存在**；该目录为空（`find verification -type f` 仅返回本卡今天生成的日志）。历史回执中引用的验证资产不能当作现存资产，T04 需要重新建立本地测试入口。

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

### 3.2 ⚠️ 明文凭据（安全事项）

`backend/wrangler.toml` 的 `[vars]` 段存在**明文第三方凭据**：

| 键名 | 状态 |
|---|---|
| `PDD_CLIENT_ID` | 明文，需迁出并轮换 |
| `PDD_CLIENT_SECRET` | 明文，需迁出并轮换 |
| `PDD_PID` | 明文，需迁出并轮换 |

`DEEPSEEK_KEY` 与 `JWT_SECRET` **已不再明文**——文件中仅有注释提示用 `wrangler secret put` 配置，此项历史风险已消除。

**处理要求**：该文件在完成凭据迁出前**不得进入任何新 Git 仓库**（若后续建立基线，必须先加入 `.gitignore` 或先把凭据改为 `wrangler secret`）。

### 3.3 待用户提供（本卡无法自行核实）

| 编号 | 待登记项 | 现状 | 阻塞范围 |
|---|---|---|---|
| B-01 | 微信小程序 AppID / 主体 / 开发成员 | **未知** | 阻塞 T03 联调、T21 真机；不阻塞 T01/T02 |
| B-02 | 小程序 API 请求域名（HTTPS） | **未知** | 阻塞 G0 可达性预检与真机 |
| B-03 | 照片 / 文件的私有对象存储方案 | **未知**（历史用 Cloudflare，未确认） | 阻塞 T16 |
| B-04 | 店内网络环境（带宽 / 稳定性 / 是否已有扫码枪、打印机） | **未知** | 影响 G3 试用与性能目标校准 |
| B-05 | iOS / Android 真机测试设备 | **未知** | 阻塞 T21b |
| B-06 | 是否授权在本目录初始化 Git 并建立基线分支 | **未决定** | 阻塞 T00a 收尾与后续所有可追溯改动 |

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

## 5. 通过的判定

| 卡片条件 | 状态 |
|---|---|
| 正确目标可追踪 | ⏳ 目录已确认，**基线（Git）未建立，待授权** |
| 不会误触生产 | ✅ 本卡全程只读，未运行 wrangler 部署、未连接 D1、未接触生产 |
| 后续知道哪些检查原本就失败 | ✅ lint 39 项已登记；后端无 test 脚本已登记 |

**本卡不标"通过"**，因为 T00a 的基线建立与 T00b 的 6 项登记尚未闭环。

---

## 6. 未完成 / 阻断

| 项 | 原因 | 是否阻塞后续 |
|---|---|---|
| Git 基线未建立 | 等用户授权（B-06） | 阻塞所有会产生改动的卡（T01 起） |
| 微信平台条件未知 | 等用户提供（B-01~B-05） | 阻塞 T03 / T16 / T21，不阻塞 T01 / T02 |
| 明文 PDD 凭据未迁出 | 需用户决定轮换方式 | 阻塞建库动作，不阻塞文档与契约工作 |
| 后端本地测试入口缺失 | 历史 harness 已丢失，且无 `test` 脚本 | 阻塞 T04 的验证；T04 需重建 |

---

## 7. 下一步

建议顺序：**T01（冻结契约与样本）** 可与平台条件登记并行推进，因为它只依赖 `contracts/` 目录与既有规格，不依赖 AppID 与 Git。

T00 收尾需要用户先给出两项决定：
1. 是否授权在 `pc-quote` 初始化 Git 仓库并建立首个基线提交（需先排除 `wrangler.toml` 明文凭据与 `node_modules`）。
2. 明文 PDD 凭据的处理方式（立即轮换为 `wrangler secret`，还是先建迁出清单后置）。
