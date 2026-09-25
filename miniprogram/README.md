# 微信小程序 · 顾客端「装一下机」

更新：2026-09-23。状态：顾客 4Tab 已实现，本地演示数据，未接真实交易；修复后待微信真机复验。
目标：顾客看专属报价、付款、查订单与预约/售后；内部 ERP 留在网页。

## 当前入口与职责

| 路径 | 职责 |
|---|---|
| app.json / app.ts / app.wxss | 页面注册、全局状态与样式 |
| pages/home | 首页四个服务入口 |
| pages/shop | 当前仍是公开商品演示；下一步以我的报价单为主 |
| pages/community | 商家案例展示，顾客只读 |
| pages/mine | 顾客个人入口 |
| features/demo-customer.ts | 顾客演示视图样本，不是已冻结业务契约 |
| features | 请求、错误行为、金额及视图逻辑 |
| contracts/generated | 跨端生成物，禁止手改 |
| assets | 品牌、图标与示意素材；`assets/customer` 为新顾客 4Tab 独立资源 |
| scripts / tests | 页面、样式、类型、契约与逻辑检查 |

旧店员页 `today/sales/inventory/more` 与销售、库存详情分包已从 `app.json`、源码及旧演示夹具中移除。
小程序只保留顾客四 Tab；门店经营 ERP 继续使用网页端。

## 运行与检查（仓库根）

    npm --prefix miniprogram test
    npm --prefix miniprogram run check-pages
    npm --prefix miniprogram run check-classes
    npm --prefix miniprogram run typecheck
    npm --prefix miniprogram run check-contracts

微信开发者工具导入本目录这一层，不能选仓库根。
AppID 及开发成员按当前实际配置核实；切换正式主体另行办理。
改 tabBar 必须同步 check-pages 的期望值；非 tabBar 页不能用 switchTab。
CLI preview 只证明编译/预览码生成，不能充当截图或真机验收。

## 已实现、未实现、下一步

已实现：四个顾客页、基础请求与金额工具、新 4Tab 独立图片/猫 IP/黑灰双态图标已接入；排版重做、原生截图和下一步见[当前接续入口](../docs/verification/customer-4tab/2026-09-23-layout-rework/README.md)。
未实现：我的报价单、顾客身份/归属授权、真实支付、真实订单查询。
顾客新壳历史验证见 [变更记录](../docs/2026-09-19-小程序主体与上线方案.md)；
旧底层证据见 [验证索引](../docs/verification/README.md)。
当前规划入口：[4Tab 整体规划与 65 张小任务](../docs/plans/2026-09-22-customer-miniprogram-reset/README.md)。用户已确认清爽版布局/图片 + 微调版细字体；MP00 基线与四页实现已存在，下一步从当前接续入口完成 MP15 视觉复核，不从 MP00 重开。旧 Q01 仅供报价业务追溯。
新资源清单见 [assets-manifest.json](../docs/design/2026-09-22-customer-ip/assets-manifest.json)；高清原件保留在设计交付目录，包内资源控制在内部 1.5 MiB 缓冲线以内。
当前页面结构检查不等于微信工具与 iOS/Android 真机渲染通过。
