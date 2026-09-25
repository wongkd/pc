# 小程序端 · 开源代码结构对比

日期：2026-09-22
状态：**参考材料，待栋哥裁定**。只做代码结构选型，不评视觉；未修改任何小程序源码、`app.json` 或契约。

## 一句话结论

**推倒重来是净亏。** 你现有 `miniprogram/` 已经是原生 TS 里靠前的结构（分包 + 业务层 + 契约同步 + 自检脚本 + 8 个单测），只缺 `components/`、`store/`、`typings/` 三层。

## 入口

- [小程序端代码结构对比](./小程序端代码结构对比.html) —— 单文件，含 6 个开源项目的真实目录树与逐层对比表

## 前提更正（重要，先读）

本目录 15:20 曾产出一版「视觉参考板」，前提有误，**已删除**。两处错误：

1. 把 `docs/design/2026-09-17-style-exploration/` 的 A+B 方案当成了**顾客端**的视觉基准——该方案属 **ERP（店员端）**，且已被定为**废弃方案**；
2. 栋哥**不需要视觉参考**（皮肤由 ChatGPT 重做），只需要**代码结构**。

本版按更正后的目标重做：只比目录结构、分层与工程化。

## 核查结果（2026-09-22 经 GitHub API 实测）

**关键事实：「原生 TypeScript + 完整业务闭环 + 高星」的小程序项目，开源里不存在。**
按 TypeScript 筛最高仅 48★（2021 年的模板）；高星项目全是 JS（成形于 2017–2019 年 JS 时代）。

| 项目 | 技术栈 | ★ | 许可证 | 最后更新 | 结构亮点 |
|---|---|---|---|---|---|
| Tencent/tdesign-miniprogram-starter-retail | 原生 JS | 859 | MIT | 2026-09 | `services/` 按域拆 10 组 ＋ `components/` 10 个业务组件 |
| EastWorld/wechat-app-mall | 原生 JS | 21.8k | Apache-2.0 | 2026-09 | 3 个功能分包；但 `pages/` 扁平堆 50+ 个 |
| iamdarcy/hioshop-miniprogram | 原生 JS | 2.6k | MIT | 2024-05 | 最轻量，79 文件 |
| MatrixCross/Weapp-Starter | 原生 TS | 33 | MIT | 2025-05 | `store/` 状态管理 ＋ `apis/` ＋ `typings/` |
| NewFuture/miniprogram-template | 原生 TS | 48 | MIT | 2021-09 | `env/` 多环境 ＋ `.dtpl/` 页面与组件代码生成 |
| zhihuifanqiechaodan/miniprogram-template | 原生 TS | 32 | 未标注 | 2026-08 | 4 个通用组件 ＋ `typings/api-types` 分层 |

## 你现有结构缺的三层

1. **`components/` —— 组件化（最缺）。** 现在是页面直接写 WXML，无任何可复用组件。建议先补三个通用的：`custom-image`（图片占位/失败兜底）、`custom-nav-bar`（自定义导航）、`custom-broken-network`（断网态）。
2. **`store/` —— 状态管理。** `features/session.ts` 相当于手写轻量版，但没有统一 store；跨页共享登录态/当前报价单时会散。
3. **`typings/` —— 类型分层。** 现有类型只有 `contracts/generated`（协议层），缺 API 响应类型与页面数据类型的分层。

**反之，你已有而它们没有的：** `scripts/check-pages.mjs`、`check-classes.mjs`、8 个单测、契约生成物同步。这部分不要丢。

## 三条路

| 路径 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 不换底座，在现有项目补 `components/` `store/` `typings/` | 最小，且不破坏已通过的契约同步与自检链路 |
| B | 换 TDesign 零售模板作底座 | 结构最规范，但是 JS 需全量 TS 化；业务差得远要删改一半 |
| C | 换 wechat-app-mall 作底座 | 功能最全，但 `pages/` 扁平 50+、无 TS，改造量大于自建 |

## 未做 / 边界

- 未改任何小程序源码、`app.json`、契约或 `package.json`。
- 未安装任何依赖，未 clone 任何仓库到本地。
- 目录树经 GitHub API 读取各仓库实际文件树，**未逐文件核对源码内容**。
- zhihuifanqiechaodan/miniprogram-template 未标注许可证，若考虑使用须先核实。

## 下一步（待栋哥裁定）

1. 是否走 A 路线（补三层结构）。
2. 若补，先补哪一层（建议 `components/` 打头）。
