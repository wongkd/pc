# M01 · 工程文档整理

日期：2026-09-19。状态：文档整理完成；无用文件物理清理已执行（6 项），另有 1 次早期被策略阻止的记录。
目标：缩短 AI 接手阅读路径、保留历史证据、清理已核实无用文件。

## 范围

- 重写 README、AGENTS、两端 README、交接与未决项。
- 新增 STATUS、文档地图、工程指南、后端说明、验证索引和 Q01 任务定义。
- 15 份旧文件归档；6 份重写前快照保留，包括用户此前未提交内容。
- 从旧台账抽出 P-01～P-23 到工程踩坑文档。
- 修复归档后的 Markdown 相对链接；旧命令/裸路径保留历史上下文。
- 增加只读文档检查脚本，默认只检查现行入口，--all 检查全部 Markdown（排除依赖、缓存、备份）。
- 不修改业务源码、契约或迁移，不提交、不发布、不查询远端。

## 保留项

开发依赖、Git、数据库/本地 D1 状态、backups、同步解包源码、业务图片、
所有设计版本、验证截图及非空日志均保留。
旧小程序页面仍有注册与引用，留待独立清理卡。
根目录旧 HTML 管理快捷指令保留，未作为当前操作入口。

## 验证与局限

本轮运行文档检查及契约校验，不运行业务 test/build。
网页/微信真机/生产行为均未重新验证。历史快照中的旧状态不是当前结论。
下一步：[Q01](../../plans/2026-09-19-quote-flow/README.md)。

本目录文件职责：README 为清单与结果；inventory.json 记录归档、清理目标核实与执行结果、入口前后行数及验证计数。

## 实跑结果

- node scripts/check-doc-links.mjs：15 份现行入口、73 个相对文件链接，0 失效。
- node scripts/check-doc-links.mjs --all：72 份 Markdown、269 个相对文件链接，0 失效。
- 清理执行后复跑上述两条，结果与清理前一致（15/73/0 与 72/269/0，退出码 0）；被删路径未以 Markdown 行内链接形式被引用，故无链接失效。
- node contracts/tools/validate-contracts.mjs：3161 项通过、7 项提示、23 项失败。2 项为微信身份表未登记 legacy-mapping；20 项权限证据行失效；1 项 Product 缺口引文行失效。本轮未修改对应源码/契约，登记 C-01，不冒充通过。
- 链接检查只覆盖 Markdown 行内相对文件路径，不检测网络 URL、锚点、裸路径、代码块或历史命令可执行性。
- 归档和快照完整性按 inventory.json 检查；原来没有变化的规格正文保持原内容，避免打乱契约行号证据。
- 21 个归档/快照目标全部存在；git diff --check -- '*.md' 通过。全工作区 git diff --check 未通过，报告本轮未改的 contracts/v1/fixtures.json 与 frontend/src/App.tsx 空白/换行问题，不做顺手格式化。

## 物理清理（已执行）

M01 首次尝试时自动审批在执行前拒绝命令（blocked by policy，删除数量 0，未改用其他方式绕过）。
用户再次逐项授权后，本轮完成清理，共 6 个目标、5 个文件、10 个目录：

| 目标 | 核实结果 | 处置 |
|---|---|---|
| `.validation-t02b-rev2/` | 仅 2 个文件：preview-info.json（257B）、preview-qr.png（47245B）；被 `.gitignore` 的 `.validation-*/` 覆盖；T02b-rev2 README 第 166 行已写"预览码失效后可直接删除" | 删除 |
| `research/` | 7 个空目录、0 个文件（InvenTree 参考源码实际不在本机） | 删除 |
| `verification/` | 2 个空目录、0 个文件；T00 README 第 51 行已登记该目录为空、本地 D1 脚本不在本机 | 删除 |
| `logs/t03b-tsc-mp.log`、`t03b-tsc-mp2.log`、`t03b-tsc-web.log` | 各 0 字节 | 删除 |

执行方式：逐个确认路径存在、位于仓库内、`git ls-files` 未被追踪、内容与描述一致后，
用精确路径 `rm -f` 删文件 + `rmdir` 删空目录（非空即报错，兼作自我校验），未使用 `rm -rf`。
删除前记录了两个文件的 sha256，清单与前后校验见 inventory.json 的 `removed` 与 `cleanupAttempts`。

未清理：依赖、备份、`.wrangler`、`backend/.validation*` 本地 D1 目录、`.sync_temp_dir`、
设计原型、验证截图、非空日志（含 7 字节的 `t03b-eslint-web.log`）、旧小程序 ERP 页面。
本次磁盘收益很小（约 47KB），主要收益是缩短当前阅读入口与去掉噪音目录：
根 README 80→49 行，交接提示词 247→43 行、未决项 167→54 行。
