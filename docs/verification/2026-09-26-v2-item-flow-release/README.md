# V2 配件收发主线简化发布回执

- 日期：2026-09-26
- 状态：网页 V2 已发布到生产 Worker；无数据库迁移或业务数据写入。员工真实业务闭环与 RC 整体验收仍待完成。
- 目标：让员工先按配件真实入库/出库方向进入正确来源单，缩短回收置换和报价的理解路径。
- 入口：ERP `https://erp.huangqidong.cn/`；Worker `pc-backend`；本地 V2 分支 `codex/v2-item-flow`。
- V1 基线：标签 `v1-backup-2026-09-26`，提交 `7a56cf4f5426f388d219172a92ab9ea835b4c361`。
- V2 标签：`v2-2026-09-26`（随本回执与代码提交创建）。

## V2 改动

- 主导航由六个项目收敛为五个工作区；库存、采购、收旧件与 SN 深链归入“实物流转”。
- 配件台账首屏按“入库来源 / 出库去向”提供采购到货、收旧件和销售交付入口，并明确报价、估价、预留都不直接改库存数。
- 报价编辑页解释预留与真实出库边界。
- 回收详情优先显示当前库存影响和实物明细；结算、附件与完整规则收起。
- 置换由选同客户销售单、填金额、启动关联与折抵组成一个主要操作。底层仍是两个既有幂等请求，不是服务端原子事务；折抵失败会刷新关联和可抵金额，让员工续办而不重复建关联。
- 页面继续由原有来源业务写入库存流水。本次没有更改 `contracts`、generated、`backend/src/index.ts` 接线、迁移、D1 或 R2 数据。

## 验证

- `npm.cmd --prefix frontend run test`：25 个测试文件、215 项通过。
- `npm.cmd --prefix frontend run build`：TypeScript 与 Vite 构建通过；JS chunk 为 577.74 kB，超过 500 kB 提示阈值，构建输出给出拆包建议。
- 本轮 9 个修改的 TS/TSX 文件定向 ESLint 通过。全仓 ESLint 仍报 8 个既存问题，位于本轮未修改的旧页面和今天页；本轮改动文件定向无错误。
- `node scripts/check-doc-links.mjs`：257 个 Markdown 文件、681 个本地链接、0 个损坏链接。
- `wrangler deploy --dry-run`：读取 16 个 Assets 文件；绑定指向生产 D1 `pc-db`、R2 `pc-attachments` 和 Assets。
- 生产 Worker `pc-backend` 版本 `60c49e51-6cce-474a-a5c7-4c9534c3c6ae` 已部署并显示 100% 流量；D1/R2/Assets 绑定及 `REQUIRE_PERSISTENT_STORAGE=true`、`INVENTORY_OPENING_MODE=formal` 保持配置。
- `curl.exe` 生产首页返回 HTTP 200；`node scripts/check-web-release.mjs https://erp.huangqidong.cn/` 返回 200 且本地与生产 JS/CSS 文件名完全匹配。
- Edge 生产页 `/inventory` 已实看 V2 导航、入库来源、出库去向和配件台账首屏。只读查看，没有提交收货、折抵或出库动作；这不代表员工真实业务验收。

## 未验证与后续缺口

- 尚未以真实业务单据实测收货、置换、交付与库存流水逐项只记一次；不使用伪造交易做生产验收。
- 耗材批次出库余量、旧 SN 与新实物台账合并、维修耗件到批次/单件的映射、拆件成本链仍需单独后端核查与改造。
- 本轮没有验证手机视口、员工权限矩阵、R2 canary、生产备份恢复或 Worker 回退演练。V2 部署不代表 RC 全面放行。
- D1 migration 清单未执行任何变更；期初窗口和真实库存未动。

## 交接

下一步按[主方案](../../plans/2026-09-26-item-flow-simplification/README.md)先做员工生产页面验收，只查看必要页面，不创建或修改真实业务交易。批次余量、SN 台账、维修耗件和生产恢复/回退分别开独立后端或运维卡。
