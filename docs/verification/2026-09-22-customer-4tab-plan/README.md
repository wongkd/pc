# 4Tab 整体规划与任务包验证

日期：2026-09-22。范围：规划、65 张提示词及离线选择器；没有实施业务卡。
入口：[整体规划](../../plans/2026-09-22-customer-miniprogram-reset/README.md)。

## 本轮事实

- 用户明确确认“清爽版布局与图片 + 字体微调版细字体”。已实际查看两张 1536×1024 四屏图。
- 只读核对 README/工程规则/STATUS/交接/未决项、四 Tab WXML、数据样本、请求/会话、app 注册、类型/结构脚本，以及后端身份、报价分享和 ERP 页面入口。
- 保留原始图片；原 M00–M11 规划保存到 `docs/archive/2026-09-22-customer-plan/README.md`。
- 新规划含产品/架构、逐屏还原规则、执行门禁、65 张独立卡、依赖表、离线 HTML、生成器与检查器。
- 更新入口和顾客专项交接，保留原有 ERP 业务断点。未提交、部署、迁移远端、改生产源码或执行真实交易。

## 实跑检查

在仓库根执行：

```text
node docs/plans/2026-09-22-customer-miniprogram-reset/build.mjs
node --check docs/plans/2026-09-22-customer-miniprogram-reset/build.mjs
node --check docs/plans/2026-09-22-customer-miniprogram-reset/task-data.mjs
node docs/plans/2026-09-22-customer-miniprogram-reset/check-plan.mjs
node scripts/check-doc-links.mjs
```

最终结果：65 张分卡编号/依赖顺序/必需字段/生成同步通过；本包 78 个文档链接、HTML 5 个资源链接通过；HTML 内 65 份提示词与 Markdown 一致，脚本语法通过。仓库入口检查 25 份文档、229 个本地链接、0 断链。
第一次链接检查发现本验证文件尚未创建造成的断链；创建后重新检查通过。
另抽查 MP00/MP17/MP58/MP64 分别对应基线、授权契约、支付核验、发布交接，卡内文件边界/检查/停止条件完整。

## 未验证与限制

- 浏览器工具尝试打开本地 `index.html` 时被 **Browser URL policy** 拒绝；未绕过该限制。
- 因此 **没有浏览器渲染截图，也没有实际点击/剪贴板成功证据**。HTML 仅做静态检查；提供“全选文本”和独立 Markdown 作为使用方式。
- 微信官方文档直连读取失败；导航说明参考了官方 WeUI Navigation 页面，其余平台能力/资质在实施卡要求现场复核。
- 未运行小程序/后端/网页业务测试；此次只改规划、文档入口与规划辅助脚本，不将历史测试数量算本轮通过。
- 未制作独立生产素材，未做小程序四屏还原、顾客业务实现、微信开发工具/真机/支付/生产验收。

当前断点：任务包已就绪。下一动作是 MP00，只做参考测量与源码基线。
