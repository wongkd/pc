# 2026-10-18 独立 ERP 发布回执

- 日期：2026-10-18（Asia/Shanghai）
- 提交：`d5978fb`，分支 `codex/v2-item-flow`，已推送 `origin/codex/v2-item-flow`
- Worker：`pc-backend`
- 生产版本：`c478ef44-c0d8-4e7c-a7fa-f77c7680b727`
- 路由：`erp.huangqidong.cn/*`
- 绑定：生产 D1 `pc-db`、R2 `pc-attachments`、Assets

## 已执行

1. 远端 D1 迁移 `0035_assembly_evidence.sql` 成功应用；Wrangler 随迁移捕获备份，之后远端迁移清单无待应用项。
2. `wrangler deploy` 成功上传 21 个新增/修改静态资源并部署 Worker。
3. `https://erp.huangqidong.cn/` 返回 200。
4. `https://erp.huangqidong.cn/api/auth/me` 未登录返回 401。
5. workers.dev 首页返回 200，未登录 `/api/auth/me` 返回 401。
6. 线上 `index.html` 与本地 `frontend/dist/index.html` 逐字节一致。

## 发布前验证

- 前端测试：252/252。
- 前端 lint：0 errors / 0 warnings。
- 前端 build：通过。
- 后端测试：424/424。
- 附件/宿主专项：26/26。
- 契约自洽：3763 项通过。
- 迁移序列：0000–0035 连续。
- 文档链接：986 条本地链接，0 broken。

## 边界

本次没有创建或修改客户、订单、库存、付款或附件业务记录。普通员工页面矩阵、系统打印预览、跨实例附件、完整备份恢复、B39 报损、供应商退款/贷项、批次出库余量、旧 SN、维修耗件、配送差额和延保履约仍未作为生产验收通过；线上只读核对也不等于员工业务闭环或生产 RC 放行。
