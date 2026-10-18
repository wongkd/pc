# 手工维修接收入口

日期：2026-10-19。状态：本地验证通过，已推送并部署正式 ERP；生产业务操作未验收。

目标：店员可为到店客户直接登记维修，无需客户先在小程序下单。

## 入口与职责

- 首页「＋ 开单 → 维修接收」进入 `/after-sales?action=intake` 并打开现有接修表单；「售后 → 接修登记」继续可用。
- [今天页](../../../frontend/src/features/workbench/WorkbenchTodayPage.tsx)负责跳转；[维修页](../../../frontend/src/features/workbench/WorkbenchServicePage.tsx)复用原有 B20 接口，并说明手工接修方式。
- 客户称呼、故障描述必填；厂家 SN、随附配件、外观备注选填。无需客户档案 ID 或原销售单；SN 留空沿用服务端自动编号规则。
- 无编辑权限不打开表单，提交失败保留已填内容；未改变后端、契约、迁移或收款规则。

## 实际验证

- `npm --prefix frontend test`：28 文件、255 项通过，覆盖首页跳转、无小程序订单/客户 ID/SN 的手工提交、失败保留输入、只读员工不能打开写入表单。
- `npm --prefix frontend run build -- --outDir ../.validation-2026-10-19-manual-intake/dist`：通过，隔离输出；`npm --prefix frontend run lint`：通过。
- 发布前补验：维修真实 Worker HTTP 专项 11/11；隔离内存 D1 中无客户 ID、无原销售单、SN 留空的手工接修创建/读回均 200，自动编号与幂等重试通过，见[Worker 读回](worker-result.json)。契约自洽 3763 项、发布构建、文档链接和 diff 检查通过；远端 D1 只读迁移清单无待应用项，deploy dry-run 的生产 D1/R2/Assets 绑定正确。
- 本地生产构建 + 合成 HTTP 响应，Edge 无头浏览器验证首页点击、表单填写、Tab 顺序和失败保留；1440、390 两种宽度页面无横向溢出。[读回结果](browser-result.json)、[桌面截图](manual-intake-1440.png)、[手机宽度截图](manual-intake-390.png)已核对，说明文字和输入完整可见，沿用现有分组、按钮层级和配色，未新增视觉令牌。
- 复查脚本：仓库根 `node .validation-2026-10-19-manual-intake/browser-check.mjs`；脚本和构建位于临时验证目录，截图及 JSON 为持久证据。

## 未完成与下一步

本轮浏览器 HTTP 为合成响应，失败场景不产生持久工单；真实 Worker 保存/读回仅在本地隔离内存 D1 验证，没有验证跨进程持久性、线上员工操作、微信真机或生产业务。配件零售的新建表单缺口继续保留。

下一步：真实授权员工登录后检查手工接修入口和实际业务流程；跨进程持久性与配件零售新建表单继续保留为独立待办。

## 正式发布

- 用户明确授权推送上线；代码提交 `2f56979` 已推送 `origin/codex/v2-item-flow`，基于完整发布基线 `5e320fc`，未纳入其他未跟踪文件。
- 目标：`https://erp.huangqidong.cn/`，Worker `pc-backend`；`wrangler deploy --message "Manual repair intake 2f56979"` 成功，当前版本 `af9e1f51-5285-4136-b6a9-eee87248434c` 接管 100% 流量。
- D1 `pc-db`、R2 `pc-attachments`、Assets 绑定保持；远端迁移清单无待应用项，本轮没有执行迁移，没有创建或修改生产业务记录。
- 线上首页及手工接修深链 200，匿名身份与维修列表接口均 401。线上 HTML + JS/CSS 共 34 个文件与本次本地构建 SHA-256 一致；匹配的入口和维修 chunk 含手工接修跳转/提示。见[线上核验](release-result.json)。
- 生产核验仅覆盖部署状态、静态资源及匿名鉴权，不等于已登录员工实操或维修业务验收。国内 VPS/IP 演示站不在本次部署范围。
