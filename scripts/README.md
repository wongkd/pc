# 仓库维护工具

日期：2026-09-22。状态：现行。目标：只读检查、按需输出，避免反复全库读取。

| 命令（仓库根） | 职责 |
|---|---|
| node scripts/audit-repository.mjs | 目录数量、默认入口长度、源码大文件；不读取依赖、凭据、备份或数据库 |
| node scripts/audit-repository.mjs --json | 输出逐文件分类、大小、热点与备份候选，可保存到 .validation-任务名/；候选不等于授权删除 |
| node scripts/check-web-release.mjs https://erp.huangqidong.cn/ | 只读比对本地 dist 与线上 JS/CSS 引用；不一致退出 1，不自动发布 |
| node scripts/check-doc-links.mjs | 自动发现现行 Markdown，相对文件链接检查，跳过历史归档 |
| node scripts/check-doc-links.mjs --all | 加上历史归档；不会验证外部 URL、锚点、代码块与裸路径 |

脚本不删除文件、不更新业务状态、不访问生产。依赖/迁移/业务检查见[工程指南](../docs/engineering/README.md)。
已完成：盘点与现行文档链接检查。未覆盖：动态引用、无用代码语义判定和外部网址可用性。
下一步：文件变化后重跑检查，按证据决定清理，不按大小或年份自动删。
