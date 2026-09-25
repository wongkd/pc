# FE-A / FE-B / FE-C · 附件、隔离件与整备上架网页入口

日期：2026-09-24（2026-09-25 补验）。状态：**本地浏览器主链已验；退役、权限/并发/重试和财务引用已有 HTTP/页面回归；浏览器故障注入、R2 持久存储和远端/生产仍未验**。

## 实现

- E10 接修详情、E11 回收详情：显示服务端返回的已关联附件，提供图片上传；上传走 B35「签发意图 → Worker 写入字节 → 完成关联」三步，完成后重新读取详情。
- B19 库存逐件详情：隔离实物提供验机证据上传、检测发现填写、附件 ID 提交及放行 / 退役动作。放行前要求至少有一个附件 ID；服务端仍会核验门店、实物归属和附件 `attached` 状态。
- R07 实物详情补回当前实物版本和已关联附件安全元数据，刷新后可重新选择证据；没有增加附件下载地址。
- B30 库存逐件详情：回收取得实物提供整备费用登记与整备上架表单。页面提示先完成 B19 检测；售价、披露、数据清除、成色和保修期均要求明确输入，版本由实物行携带。
- 上传仅接受 JPEG / PNG / WebP，单张上限 2MB。列表仅显示安全元数据，不展示对象键或虚构的下载地址。

## 入口

- `frontend/src/features/workbench/attachment-api.ts`
- `frontend/src/features/workbench/AttachmentPanel.tsx`
- `frontend/src/features/workbench/WorkbenchServicePage.tsx`
- `frontend/src/features/workbench/WorkbenchRecoveryPage.tsx`
- `frontend/src/features/workbench/WorkbenchInventoryPage.tsx`
- `frontend/src/features/workbench/inventory-api.ts`
- `backend/src/domains/inventory.ts`（R07 详情补版本与附件元数据）

## 验证与边界

- 本地浏览器实操已完成 E10 接修附件与 E11 回收附件上传：均显示 JPEG 安全元数据，详情刷新后仍可见；当前 Worker 使用内存存储，只证明页面与真实接口链路，不证明 R2 持久化。
- B19 已实操“无检测说明前端拦截 → 有说明但无附件由服务端拒绝 → 上传附件后放行”。放行后库存汇总从可卖 15 / 待处理 1 变为可卖 16 / 待处理 0，逐件流水显示“检机放行 +1”。
- B30 已实操空表提交校验、登记 ¥50 整备支出，以及填写售价 ¥1,699、成色披露、数据清除确认后完成上架；成功后整备表单不再显示。此次未核对财务页中的整备支出凭据，也未走退役分支。
- 回收出估价浏览器验收发现并修复一处真实缺陷：输入框以服务端估价作显示回退时，未编辑直接提交曾静默发送 0 元。现提交逻辑同样回退到服务端估价，并新增 2 条单元回归；浏览器复验 ¥1,200 未编辑提交后仍为 ¥1,200。
- `WorkbenchRecoveryPage.test.ts` 与 `TradeInPanel.test.tsx` 定向回归：3/3 通过；本轮改动文件定向 ESLint 通过。

- 前端 TS/Vite 完整构建此前通过；最近一次 `npm --prefix frontend run build` 被工作树中另一页的类型错误阻塞：`WorkbenchPurchasePage.tsx` 给 `ReceiptLinePayload` 传入不存在的 `batchRemark`。直接 `vite build` 已通过，含 292 个模块。
- 已补 API 类型字段（后端与路由原已支持该备注），并修正 `purchase.ts` 收货计划周围多余的大括号后，最新 `npm --prefix frontend run build` 通过。
- 串行运行 `node --test --test-concurrency=1 backend/tests/f1-attachments.test.mjs backend/tests/f2-inspection.test.mjs backend/tests/b30-refurbishment.test.mjs`：**41 项通过**。首次并行运行造成 Miniflare `local.test` DNS 解析错误，不作为结果；串行门禁通过。
- `WorkbenchInventoryPage.test.tsx`：13/14 通过；剩余旧断言期待“逐件商品必须填写内部编号”，当前页面验证错误文案不同，未改动该业务提示或测试。
- 当前 Vite 仍提示主 bundle 超过 500KB。
- 全量前端测试：175 通过、16 跳过、2 失败；失败仍是交付页“需 SN 的已绑定”和库存期初“逐件商品必须填写内部编号”两条既有文案断言。本轮 `npm --prefix frontend run build` 通过，299 个模块。
- 预览环境尚未启用 R2 桶；上传完成不证明文件已持久保存。当前仅确认实现按服务端 `storagePersistent` 接口如实处理，界面会说明存储持久性以服务端为准。
- 既有未提交工作树保持原样；未改契约、迁移、`backend/src/index.ts` 或远端资源。

## 下一步

继续做浏览器网络故障注入和 B19 退役现场操作；另行完成隔离环境 R2 配置后验证真实对象存储读写。

## 2026-09-25 补验更新

- 已补附件权限/并发完成/未知响应重试，B16 盘点权限与并发，以及固定 `asOf` 后的失败重试；采购页新增未知操作查询与终态恢复；已补多笔付款冲销到净额归零再取消的连续链。
- B30 现可保存并读回付款流水与凭据引用，服务端校验付款引用为本店支出流水；无效引用不写入成本。整备成本并发累加、权限拒绝和幂等重放有 HTTP 回归，字段展示/提交有页面回归。
- 本地 targeted 结果：B16/B30/F1/F3 后端合并复跑 **61/61**，B19 检查后端 **18/18**；附件 API/面板、采购未知结果页面和通用幂等核心前端回归 **33/33**；盘点重试、整备凭据与退役页面回归 **3/3**；`npm --prefix frontend run build` 通过（299 模块）。
- 浏览器网络故障注入与退役现场操作、R2 持久读写和远端/生产仍未验收；整备引用不自动新建现金流水。
