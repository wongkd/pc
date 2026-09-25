# 文档地图

更新：2026-09-19。目标：让 AI 按任务读取，避免每次读完整个历史目录。
文档无需运行；链接检查命令：node scripts/check-doc-links.mjs。

## 日常接手只读

| 文件 | 唯一职责 |
|---|---|
| [STATUS](STATUS.md) | 当前实现状态与证据，不抄完整验证日志 |
| [NEXT-SESSION-PROMPT](NEXT-SESSION-PROMPT.md) | 当前断点、下一动作、恢复条件 |
| [OPEN-ITEMS](OPEN-ITEMS.md) | 尚未解决的问题，保留编号便于追踪 |
| [工程指南](engineering/README.md) | 目录、代码、Git、验证、文档维护标准 |

## 按任务读取

- 当前任务：[Q01 专属报价流程](plans/2026-09-19-quote-flow/README.md)。
- 产品决策：[顾客端与业务方案](2026-09-19-小程序主体与上线方案.md)。最新确认覆盖早期讨论；平台与条款陈述不等于本轮核验。
- 业务背景：[重做规划](../装机店经营工作台-重做规划-2026-09-17.md)。
- 旧实施卡与业务规格：[2026-09-17 方案](plans/2026-09-17-web-wechat-plan/README.md)。其中“小程序做店员 ERP”等旧方向已被覆盖。
- 数据协议：[contracts](../contracts/README.md)。界面视图类型不自动成为业务契约。
- 桌面视觉：[v3 原型](design/2026-09-17-style-exploration/v3/README.md)。
- 验证证据：[验证索引](verification/README.md)；每卡以自己的 README 和日志为准。
- 已知工程问题：[踩坑记录](engineering/PITFALLS.md)。
- 历史材料：[归档索引](archive/README.md)，仅追溯时读取。

## 文档生命周期

计划写在 plans；界面提案写在 design；实跑结果写在 verification。
STATUS 只链接这些证据；交接文件每次覆盖当前断点，不追加历代提示词。
旧方案不删除证据、不继续充当现行规则。发现冲突，先区分“用户意图、建议、实现事实、平台核验”。

已完成：入口分层、历史归档、当前任务登记。
未完成：Q01 原型与后续真实业务接入。下一步见交接文件。
