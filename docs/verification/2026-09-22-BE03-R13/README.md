# BE-03 附件详情与 R13 读路径核查

日期：2026-09-22。状态：BE-03 已完成本地 HTTP 验证；R13 v2 客户/设备读模型已完成本地 HTTP 验证。

## BE-03 · 接修 / 回收详情附件

R09 维修详情与 R10 回收详情现在都带 `attachments` 数组。列表复用 F1 的 `listAttachedForOwner`，仅取 `upload_state='attached'`、当前 `store_id`、当前实体类型与 ID 完全匹配的记录。响应不返回 `objectKey` 或公开读取地址；列表页与业务列表响应未扩展。

契约已有 `Attachment` 对象，但 R09/R10 的 `readActions.result` 是概述文字，没有枚举具体响应字段。本次只扩展两个详情读模型，没有修改冻结契约、生成物、迁移或 Worker 入口。前端上传、展示与失败重试仍属于 FE-06；R2 真实读写未验证。

新增 HTTP 断言覆盖：同单 attached 附件可见；pending、其他实体、其他门店附件不可见。接修响应的字段位于 `data.order.attachments`，回收响应位于 `data.attachments`。

## R13 · v2 客户 / 设备读模型

契约 `conventions.api.prefix` 为 `/api/v2`，R13 读路径是 `/customers/:id` 与 `/devices/:id`。`legacyPrefix` `/api` 明确保留旧接口，但保留旧接口不等于实现了新 R13。

当前 `GET /api/customers/:id` 返回客户联系方式、订单与 `customer_devices` 轻量设备列表；`GET /api/customers/:id/devices/:did` 的 GET 分支查询该客户的整份设备列表，并不按 `:did` 读单台设备。仓库没有 `/api/v2/devices/:id` 路由。`customer_devices` 也不是契约 `CustomerDevice` 的保管模型；`device_configurations` / `device_changes` 没有 R13 详情读接口。

因此旧路径继续保留兼容，但不再被当作 R13 等价实现。现新增 `/api/v2/customers/:id` 与 `/api/v2/devices/:id`：前者读取同店客户联系信息、销售单索引和 `customer_device_custody` 保管设备；后者读取同店的契约 `CustomerDevice`。两条路均要求 `sales/order-view`（旧 `quote/view` 兼容）。配置版本/变更是售后域资料，仅 `service/view`（或老板）可读；无此权限时 `configurationHistory` 为 `null`。组件 DTO 只保留数量、收费类型、旧件去向与是否记录换件，不返回成本、库存件引用、SN、内部诊断、附件 object key 或原始 JSON。跨店统一返回 404。

实现放在 `backend/src/routes/customer-device-v2.ts`，入口只做分发；契约、迁移与旧 `/api` 未改。因契约门禁反读 `index.ts` 的绝对行号，R13 分发采用延迟载入，避免移动既有证据行。

## 本轮验证

| 检查 | 结果 |
|---|---|
| R09 / R10 / F1 专项 HTTP 测试 | 42 项通过，0 失败 |
| R13 专项 HTTP 测试 | 2 项通过，覆盖 v2 DTO、售后域配置历史隔离、跨店 404、无权限 403 和成本/SN/备件引用脱敏 |
| 后端全量测试（`node --test --test-concurrency=1 "tests/*.test.mjs"`，工作目录 `backend`） | 357 项通过，0 失败 |
| `node docs/plans/2026-09-22-erp-remaining-tasks/audit-action-coverage.mjs` | 读接口 13/14；R13 缺 `/devices/:id` 证据 |
| `node contracts/tools/validate-contracts.mjs` | 3506 项通过；9 条非阻断提示。未改契约、迁移或入口代码 |
| `node scripts/check-doc-links.mjs` | 188 个 Markdown、468 个本地链接，0 断链 |
| 迁移编号、生产、真实对象存储、浏览器 / 前端 | 迁移编号本轮未单独运行（无迁移改动）；其余未验证 |

当前 PowerShell 找不到 `npm`，因此用 `backend/package.json` 中相同的 Node 测试脚本直接执行；结果为 357/357 通过。
