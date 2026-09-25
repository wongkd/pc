# B30 整备上架与 B36 单据生成 · 本地验证

日期：2026-09-25 ｜ 状态：B30 后端已验证；B36 报价 HTML 白名单快照、附件持久化接口与同店鉴权下载已在本地 Worker 验证。R2 未配置时仍是进程内存储；其他实体模板、PDF/图片未支持。

## 本轮落地

- B30：回收件整备成本、可资本化成本累计、幂等重放、检测/成本/逐件销售事实门槛，以及 `ready_for_sale` 状态推进。
- B36：`POST /api/v2/documents` 只接收 `quote:<id>` 的 `html` 快照；客户 DTO 只读取标题、版本、有效期、销售行、金额和质保，服务端不读取成本、供应商、原卖方、SN 或内部备注；不会自动发送。
- B36 的 `pdf`、`image` 返回 `VALIDATION_ERROR`，不声称已生成文件。

## 实跑

```powershell
node --test --test-concurrency=1 backend/tests/b30-refurbishment.test.mjs
node --test --test-concurrency=1 backend/tests/b36-documents.test.mjs
node scripts/check-doc-links.mjs
```

结果：B30 4/4、B36 2/2 通过；文档链接 463 条、0 断链。

## 未验证 / 下一步

### 2026-09-25 B36 附件闭环

- 新增迁移 `0028_document_export_attachments.sql`，扩展附件用途 `document_export`，保留既有附件行并为报价/版本建立唯一附件约束。
- `POST /api/v2/documents` 仅允许报价 HTML；服务端白名单 DTO 生成文件并写入对象存储适配器，同时以 `Attachment` 元数据记录实体、版本、摘要、MIME、大小与操作人。重复导出同一报价版本复用同一附件，不自动外发。
- `GET /api/v2/documents/:attachmentId` 需要 `document/export`，按当前门店及 attached/document_export 状态读取；跨门店返回 404，不返回 objectKey。下载设置 `attachment`、`nosniff`、`private, no-store`。
- 对质保快照也只序列化 `months` 与 `note` 两个白名单字段；额外内部字段不进入文件。PDF/image 仍明确返回 `VALIDATION_ERROR`。
- 实跑：B36 + F1 附件 HTTP 测试 23/23；契约校验 3596 项通过；迁移编号 0000–0028 连续；两端生成物和 parity 通过；小程序 typecheck / check-contracts 通过。
- 后端全量测试 368 项：363 通过、5 失败。失败位于 `e04b-inventory-http` 的期初逐件行断言、`e08-fulfillment-http` 的序列号校验、`e10-service-http` 的接修幂等，以及 `t05a-opening` 的逐件期初校验（2项）；均未触及 B36 文件。前端全量测试 193 项：175 通过、16 跳过、2 失败，分别为履约阶段文案与期初逐件提示断言，均未触及 B36 文件。
- 本地 Worker 未配置 R2，响应明确 `storagePersistent=false`；因此本地进程退出后文件不保证留存。没有应用迁移到 Cloudflare 或生产环境。
- 前端最近一次 build 阻塞于已有未跟踪文件 `frontend/src/features/workbench/attachment-api.ts:29` 的参数属性语法与 `erasableSyntaxOnly` 冲突；该文件不属于 B36 改动。早先一次 build 曾通过，现以最新复验结果为准。

- 2026-09-25 临时下载阶段（后由上方附件闭环升级）：报价详情新增 B36 服务端白名单 HTML 下载入口（`exportQuoteHtml`）；隔离本地 Worker + 浏览器点击导出成功，但该阶段尚未写持久附件。
- 未跑生产、远端迁移或真实对象存储；本地测试使用 Worker + 内存 D1。
- 报价以外的销售单、采购、维修等 `entityRef` 尚未支持；需要先逐种冻结顾客白名单，不能把内部 DTO 直接复用给顾客。
- 小程序入口未做；网页目前只有报价 HTML 临时下载入口。

## 2026-09-25 B30 财务凭据与并发补验

- 整备详情在有成本读取权限且服务端返回字段时，展示已登记支出、资本化口径、付款流水编号和票据/附件引用；页面输入会随整备动作提交。组件回归验证显示及提交值。
- `paymentEntryRef` 若填写，服务端要求它指向当前门店已登记的 `direction='out'` 现金流水；不存在、跨店、冲销入账等非支出引用在任何成本/版本写入前返回 400。付款与凭据引用必须是文本编号，审计日志保存这两项。
- 本动作只关联已有支出流水，不新造现金付款；也不证明线下供应商已收到退款或款项。凭据字段是可追溯引用，不代表财务科目/付款核销系统已完成整合。
- 后端覆盖写权限拒绝无副作用、缺失/冲销入账/非文本付款引用拒绝、已有支出流水读回且无第二笔现金记录、相同 requestId 重放不重复记账、两笔并发整备成本无丢写。`b30-refurbishment.test.mjs` 当前 8 项通过；页面财务凭据定向回归通过。
- 这次补验是本地 HTTP/组件测试，不是浏览器故障注入或远端/生产验收；B19 退役分支与 R2 真实存储仍待验。
