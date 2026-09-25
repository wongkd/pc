# 网页视觉统一到顾客小程序

- 日期：2026-09-25；状态：本地样式实现与代表页面浏览器核对完成，待用户视觉评审，未发布。
- 目标：网页全局参照当前顾客四 Tab 的白底、黑字、细线、小圆角、米色选中态，保留 ERP 业务结构。
- 基准：[顾客视觉令牌](../../../miniprogram/styles/customer-tokens.wxss)，本轮不修改小程序。
- 入口：http://127.0.0.1:5188/dashboard；后端为本地 8879 内存 D1，页面中的客户、库存均为合成演示数据。

## 文件职责

- [theme.css](../../../frontend/src/styles/theme.css)：共享正文、背景、边框、焦点、圆角令牌。
- [erp-polish.css](../../../frontend/src/styles/erp-polish.css)：导航、工作台、库存、销售/采购、客户、商品、SN、设置与登录的共同视觉层；保留成功/危险/警告语义色。修正宽屏外壳的多余留白和商品弹层遮罩样式。
- [quote-editor.css](../../../frontend/src/features/workbench/quote-editor.css)：报价字段组使用同源中性色、焦点和字重。
- 只改样式；未改接口、契约、库存资金规则与打印模板；未提交或部署。

## 实际验证

- npm.cmd --prefix frontend run test：25 文件、210 项通过。
- npm.cmd --prefix frontend run build：通过；存在大于 500 kB 的构建包体提示。
- Edge 实际本地页面：工作台空态、库存 5 个商品/16 件自有在库、客户 5 条记录及选中详情、新建报价默认配置表单。
- 桌面 1440×1000；手机 390×844 检查工作台和报价表单。报价手机根页面 scrollWidth 375，小于视口 390，无页面级横向溢出；导航条独立横向滚动。
- 键盘 Tab 到客户下拉框，实际焦点外框为 2px 黑色实线。
- 截图为浏览器实际渲染，不是 AI 概念图；截图显示本地演示数据。

## 渲染图

- [工作台桌面](dashboard-desktop.png) / [工作台手机](dashboard-mobile.png)
- [库存桌面](inventory-desktop.png)
- [客户台账与详情](customers-desktop.png)
- [报价编辑器桌面](quote-editor-desktop.png) / [报价编辑器手机](quote-editor-mobile.png)

## 未验证与下一步

本轮未逐页穷举所有弹层、错误态、历史页面；未验证打印分页、微信真机或生产。登录样式已更新但未重新退出登录核对。下一步先按用户对本轮截图的意见细调，再补其余页面状态视觉回归；不自动部署。
