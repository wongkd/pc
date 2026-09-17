# 微信小程序端（miniprogram）

装机店经营工作台的小程序端。**独立项目**，不参与 `frontend/` 与 `backend/` 的构建。

- 日期：2026-09-17
- 状态：**骨架卡 T02b —— 只建壳**。未连接门店服务、未写任何业务数据、未部署。
- 任务卡：[05-implementation-tasks.md · T02b](../docs/plans/2026-09-17-web-wechat-plan/05-implementation-tasks.md)
- 验证记录：[docs/verification/2026-09-17-T02b](../docs/verification/2026-09-17-T02b/README.md)

---

## 1. 这个项目是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 原生小程序（WXML / WXSS / TypeScript），四个 tabBar 页面 + 一个分包详情页 | 不是 web-view 包网页，也没有手机 H5（05 §T02b「不做」） |
| 契约生成物的消费者（`contracts/generated` 的单向落地） | 不是第二份契约，端内生成物**禁止手改** |
| 演示样本的宿主（`DEMO-` 前缀，固定日期 2026-09-17） | 不是可用版本：**不得发布、不得当作业务已完成** |

## 2. 目录与文件职责

```
miniprogram/
├── project.config.json     小程序项目配置（无 AppID 模式、miniprogramRoot = 项目根、TS 编译插件）
├── app.json                页面注册、原生 tabBar 四项、分包 packages/sales
├── app.ts                  入口，globalData（演示门店 / 演示模式）
├── app.wxss                设计变量（--mp-*）与全局基础类、域落地页排版
├── sitemap.json            全部 disallow（内部经营工具，不允许被微信索引）
├── tsconfig.json           类型检查用；strict + noUnusedLocals
├── package.json            仅承载脚本与类型依赖，不参与小程序构建
├── pages/
│   ├── today/              今天：四项统计、筛选项、竖向任务列表 → 跳详情
│   ├── sales/              开单域落地页
│   ├── inventory/          库存域落地页
│   └── more/               更多域落地页（账本 / 售后 / 回收置换 / 设置）
├── packages/
│   └── sales/order-detail/ 事项详情（分包），底部固定金额与动作条
├── features/
│   ├── demo-data.ts        V1 演示样本与指标、演示排序、逾期判断
│   ├── amount-view.ts      金额格式化与呈现口径（待收 / 应付 / 已结清 / 预计 / 待确认）
│   └── display-text.ts     文案切分的纯函数（详情页主标题的设备简称）
├── templates/
│   └── landing.wxml        三个域落地页共用的排版模板
├── contracts/generated/    契约生成物（6 个，禁止手改）
├── scripts/
│   ├── sync-contracts.mjs  生成物落地 + 三方防漂移
│   ├── check-pages.mjs     结构自检：注册页面 ↔ 磁盘文件
│   └── check-classes.mjs   结构自检：wxml 引用的类名都有样式定义
└── tests/                  node --test，零依赖
```

## 3. 运行方式

```bash
cd miniprogram
npm install            # 仅类型依赖：typescript、miniprogram-api-typings

npm test               # 样本 ↔ 契约一致性、金额口径、设备简称切分（32 用例）
npm run typecheck      # tsc --noEmit，strict
npm run check-contracts # 端内生成物未被手改
npm run check-pages    # app.json 注册与磁盘文件一致
npm run check-classes  # wxml 引用的类名都有样式定义
```

生成物更新（改契约后必须执行）：

```bash
node contracts/tools/generate-dto.mjs        # 在仓库根
node miniprogram/scripts/sync-contracts.mjs
```

**微信开发者工具**：导入本目录（`D:\Software\微信web开发者工具`）。首次使用需选择「不使用 AppID」；
`project.config.json` 里已写 `"appid": "touristappid"`，若工具提示 AppID 无效，在工具内重新选择一次即可。

## 4. 已实现 / 未实现

**已实现（骨架层）**

- 原生 tabBar 四项（今天 / 开单 / 库存 / 更多），选中森林绿 `#334B42`，用系统导航栏；
- 今天页：四项统计（窄屏两行两列，不压小大金额）、事项筛选、竖向任务列表，
  每行含缩略图降级、客户与设备、卡点、时间与动作、金额方向、禁用原因；
- 列表 → 详情为**真实页面跳转**（分包页），只传 `taskId`，详情重新取数；
- 详情页：单号 / 类别 / 交期 → 客户与事项 → 设备摘要 → 当前处理 → 下一步 → 底部固定金额与动作；
- 金额口径：待收 / 应付客户 / 已结清 / 预计 / 待确认五种形态，未定价不用 ¥0 冒充；
- 返回恢复：`onShow` 刻意不重置筛选与列表，滚动位置由框架保留。

**未实现（有意为之，归后续任务卡）**

| 项 | 归属 |
|---|---|
| 身份、登录、绑定码、权限 | T03 |
| 真实服务请求层、错误码映射 | T03 |
| 库存、采购、盘点 | T05 / T06 |
| 报价与开单（小程序分步表单） | T07 |
| 成交、预留、缺件 | T08 |
| 资金与账本 | T09 / T15 |
| 售后、回收置换 | T12 / T13 / T14 |
| 阶段序列与事件记录（详情页当前留空并如实说明） | T08 / T12 / T18 |
| 组件提取（TaskRow / DeviceSummary / ProgressSteps / AmountActionBar / Feedback） | T02c |
| 售后 / 回收使用独立详情页（当前三类事项共用一个详情页） | T12 / T14 |

## 5. 硬性约束

1. **生成物禁止手改**：`contracts/generated/` 由 `sync-contracts.mjs` 写入，
   手工改动会被 `npm run check-contracts` 检出。
2. **演示数据不得进生产**：接通真实服务（T18）时必须删除 `features/demo-data.ts`，
   并禁止生产模式回退到样本。契约 `dtoGeneration.notGenerated` 明文要求。
3. **不连接生产**：`project.config.json` 关闭了域名校验仅为本地调试；
   在 T03 / T04 完成前，本端不得请求生产接口。
4. **金额一律整数分**，显示层才换算；不使用 `toLocaleString`（小程序 JSCore 的 Intl 不完整）。
5. **权限不能只靠前端隐藏**：真正的边界在后端（02 §7）。
