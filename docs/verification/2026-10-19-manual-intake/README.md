# 手工维修接收入口

日期：2026-10-19。状态：本地实现、回归和合成浏览器检查通过；未发布。

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

用户已授权推送上线，下一步从当前完整基线提交并推送、部署正式 ERP，核对线上资源与版本；发布前线上仍显示旧入口。
