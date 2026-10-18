# 当前断点

2026-10-18，执行中。

- 已按顺序读取接手入口、核查、OPEN-ITEMS、代码地图与工程规则。Git HEAD `5f9de30`；原有三个后端文件和文档脏改保留。
- 原始tracked补丁、状态和node-host备份在根 `.validation-2026-10-18-erp-completion/before/`。
- A01/A02：已改为独立 Node 构建、环境配置、持久库/附件路径；正式模式缺 JWT_SECRET/持久路径/预构建入口拒启，禁 seed/fresh。`host-migrations.mjs` 事务记录 SHA、拒绝降级/篡改，旧无记录库必须显式 baseline。`node-host-runtime.test.mjs` 4/4 通过。
- A03：前端 lint 0 errors/0 warnings；前端 test 252/252，build 输出到隔离目录通过。
- B01：B09 批准列表进入装机看板，B10 提交 `creditApprovalRef`，服务端事务复核同店、订单和余额快照；错误引用/金额变化守卫保留。
- B02：B35 附件支持 `sale_order` / `delivery_evidence`；B07 只接受同店 attached 图片引用，检测版本保存 JSON；业务权限下载核对字节与 SHA。
- 0035 迁移追加 `sale_checklists.result_evidence_json`；独立增量契约和四端生成物已生成，契约/同步/错误码/迁移门禁通过。
- 后端全量已完成 424/424（含 B40 新增 2 项；修复 f1 附件迁移数量硬编码后，附件/宿主专项 26/26）；E08/E09、B30/B36、F1、P2 和新增宿主专项均通过。未连远端、未执行生产或真实付款。
- 本轮继续：普通员工回环权限矩阵脚本 30/30 通过；B40 正式契约、`inventory/price-adjust` 老板权限、挂牌价调整领域与幂等/版本冲突专项 2/2 通过；契约自洽 3763 项、前端 build 通过。QT03 配置详情页已在本地浏览器实看，页面键盘焦点可读；系统打印预览未弹出，保持未放行。
- 任务总表已映射全部适用独立ERP范围，所有未验项保持未验。
