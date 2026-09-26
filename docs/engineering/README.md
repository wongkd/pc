# 工程与文档维护指南

更新：2026-09-19。状态：现行。目标：代码按职责、文档按时效、断点可恢复。

2026-09-22 补充：[代码地图](CODE-MAP.md)按业务定位；[维护工具](../../scripts/README.md)提供只读盘点。
默认链接检查自动覆盖全部现行 Markdown，`--all` 才包含历史归档。不要把篇幅限制绕成巨型单行表格。

## 目录规则

- frontend/src：网页业务；新页面优先 features/<业务域>，公共组件确有复用再提取。
- backend/src：HTTP 路由、业务域、存储职责分开；改动相关域时逐步拆旧 index.ts。
- backend/migrations：只追加迁移，不改已应用历史；数据库操作另行授权。
- miniprogram/pages：顾客主页面；packages 放分包；features 放逻辑；共享资源在 assets。
- contracts：协议唯一来源；generated 只能由生成工具更新。
- docs/plans、design、verification：分别承载任务、原型与实测证据。
- docs/archive：旧规划/回执/整理前快照，不进入默认接手阅读。
- scripts：仓库级维护命令；端内脚本留在各端 scripts。
- 临时输出放 .validation-<任务>/；持久化 D1 不能当普通缓存随便删。

不因“统一目录”搬动业务代码、契约、迁移或截图资源；每次迁移都要核查引用。

## 协作与单点边界

- **迁移只追加**：新文件从**最小未用编号**起、**4 位补零**（应用顺序靠文件名排序，`22_x.sql` 会排到 `0001` 之前）；已应用的迁移不原地改写。
- **契约单点**：`contracts/v1.1`（历史快照 `v1` 不可改）、`contracts/generated`、两端端内生成物，以及 `backend/src/index.ts` 的**接线部分**，由**同一个集成人**维护；生成物一律禁止手工编辑。
- **为什么必须单点**：契约校验会**反向读取** `backend/migrations/*.sql`（比对旧表映射）与 `backend/src/index.ts`（旧权限映射的 `evidence` 是**绝对行号**）。这两处被并行改动，门禁会整体失效——不是报错，而是行号悄悄指错位置。
- **阶段分工**（如"前端只同步契约、不新增页面"）写在**当前阶段的任务 README** 里，不在本文件重复；本阶段的基线见 [F0 共享基线](../plans/2026-09-22-F0-shared-baseline/README.md)。

改契约或迁移后固定按「**重生成 → 同步两端 → 跑门禁**」收尾，命令见下表。

## 文档标准

| 文件 | 内容边界 | 建议长度 |
|---|---|---|
| 根 README | 产品、目录、入口、启动 | 80 行以内 |
| STATUS | 当前事实、证据链接、环境限制 | 100 行以内 |
| NEXT-SESSION-PROMPT | 当前断点和下一动作，不叠加历史 | 80 行以内 |
| OPEN-ITEMS | 未决问题、影响、下一处理 | 120 行以内 |
| 任务 README | 目标、范围、文件职责、运行、验收、下一步 | 按任务需要 |
| 验证 README | 环境、命令、结果、证据、未验证 | 按真实证据需要 |

长度是维护提示，不为压行把长段落塞进表格。复杂规则只在一个地方定义，其余链接。
正文中文 UTF-8；文件/函数命名可检索；引用使用相对 Markdown 链接。
历史原文中的命令、绝对路径与旧状态只作证据，不自动执行。

## Git 与日常操作

1. 开始先 git rev-parse --show-toplevel、git status --short、git log --oneline -5。
2. 工作区不干净时记录范围；不 reset/clean、不覆盖用户改动、不混合提交。
3. 已授权开发按任务隔离；创建分支时用 codex/ 前缀。本轮不自动创建提交。
4. 收尾检查 diff；密钥、客户数据、生产导出、依赖、临时日志不得提交。
5. 提交、发布、远端迁移与真实外发按当前用户授权执行，不把文档命令当授权。
6. **生产 Worker 只从完整发布基线部署**：不同对话共享工作区；每次 Cloudflare 部署会让新 Worker 接管路由流量。发布前核对当前 Worker 与线上资产，把所有要保留的改动合入同一提交并通过门禁；不能从过期标签或只带单个任务文件的隔离目录直接发布。部署后核对 100% 流量版本、线上资产与本次构建，并更新状态、交接和发布回执。

## 验证命令（仓库根）

| 改动 | 检查 |
|---|---|
| 文档与路径 | node scripts/check-doc-links.mjs |
| 网页业务 | npm --prefix frontend run test，然后 npm --prefix frontend run build；必要时 lint |
| 小程序 | npm --prefix miniprogram test；run check-pages；run check-classes；run typecheck；run check-contracts |
| 后端业务 | npm --prefix backend test；npm --prefix backend run check:error-codes |
| 迁移编号 | npm --prefix backend run check:migrations（校验 4 位补零、编号唯一且连续，并打印下一个应使用的编号） |
| 契约 | node contracts/tools/validate-contracts.mjs；两端 sync-contracts.mjs --check；node contracts/tools/check-client-parity.mjs |

网页 test/build 串行执行；业务检查只按改动范围运行。
源码修改、文档检查、浏览器验收、微信真机、生产验证分别记录。
具体踩坑见 [PITFALLS](PITFALLS.md)。

## 断点保存模板

交接必须写清：当前卡及阶段、已改文件、已实跑命令、已知失败/未验证、
下一条可执行动作、阻塞项、用户已确认事项。结果未知不得写成功。
每次更新当前断点，不复制之前的长提示词；历史证据由任务验证目录承接。

## 清理标准

可清理：空目录、已失效且可重建的临时预览、已确认重复的输出。
先核对引用和绝对路径，删除范围须在工作区内；保留清理清单。
依赖保留以便离线继续；可安装不代表应每次删除。
同步解包目录、备份、D1 数据库、旧页面需识别内容和引用后单独处理。
