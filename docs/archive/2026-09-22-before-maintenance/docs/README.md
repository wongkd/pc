# 文档地图

更新：2026-09-19。目标：按任务读取；用户原始需求先于后续提案。
文档检查命令：node scripts/check-doc-links.mjs。

## 默认接手

[STATUS](../../../STATUS.md) → [当前交接](../../../NEXT-SESSION-PROMPT.md) → [ERP 规划](../../../plans/2026-09-19-erp-first/README.md) → [未决项](../../../OPEN-ITEMS.md)。

## 产品与需求

- [原始需求对照](../../../plans/2026-09-19-erp-first/00-requirements.md)：已确认规则与冲突取舍。
- [小程序主体与上线方案](../../../2026-09-19-小程序主体与上线方案.md)：第 8 节为经营需求；区分用户确认和建议，平台陈述非永久有效。
- [顾客端 4Tab 整体规划与任务包](../../../plans/2026-09-22-customer-miniprogram-reset/README.md)：已确认组合基准、逐屏还原规范、MP00–MP64 小任务、离线一键复制及分层验收；本轮仅规划。
- [报价单业务规则](../../../2026-09-19-报价单业务规则.md)：版本、确认、定金与预留。
- [早期重做规划](../../../../装机店经营工作台-重做规划-2026-09-17.md)：业务路径和验收背景，新确认覆盖旧假设。

## 设计与实施

- [ERP 整体规划](../../../plans/2026-09-19-erp-first/README.md)：当前主线，含 UI/UX、代码复用、文件清理和分步实施。
- [七图分析](../../../plans/2026-09-19-erp-first/05-reference-analysis.md)与[原图](../../../design/2026-09-19-erp-references/README.md)：新设计参考，尚未定版。
- [Q01](../../../plans/2026-09-19-quote-flow/README.md)：保留顾客报价原型和模型成果，推进顺序已由 ERP 规划覆盖。
- [旧双端方案](../../../plans/2026-09-17-web-wechat-plan/README.md)：只复用未冲突规则，不再做店员小程序。
- [旧 A+B 原型](../../../design/2026-09-17-style-exploration/v3/README.md)：历史参考，用户本轮不满意旧 UI，不作为新设计标准。

## 工程与证据

- [电脑开发进度台](../../../design/2026-09-21-prompt-launcher/README.md)：桌面启动、开发蓝图、证据检测、AI 进度回执和一键提示词。

- [工程指南](../../../engineering/README.md)、[踩坑记录](../../../engineering/PITFALLS.md)、[contracts](../../../../contracts/README.md)。
- [验证索引](../../../verification/README.md)、[本轮 E00](../../../verification/2026-09-19-E00/README.md)。
- [历史归档](../../README.md)：只供追溯，不把旧提示词当当前命令。

计划在 plans，原型/参考在 design，实测在 verification；状态和下一动作分别只写 STATUS 与交接。
