# MP13 · 我的头像与装机档案卡

状态：review。页面结构与交互已实现，未登录态不显示虚构昵称或登录成功。

## 结果

- 使用灰猫头像、登录提示、米色档案卡和独立猫/文件夹素材；档案点击说明登录能力未接入。
- 四项统计与真实登录态分离，未登录时统一显示“—”，不把未知数显示为 0。
- 二维码和设置通过 `customer-nav` 的胶囊避让插槽放置，各有 44×44px 点击区，使用真实存在的大小写敏感资源路径；点击均反馈当前未配置/未接入状态。
- 改动：`miniprogram/pages/mine/index.ts/.wxml/.wxss/.json`。

## 验证

- `node --test "miniprogram/tests/*.test.mjs"`：111/111 通过；新增我的页未知统计/菜单不变量回归检查。
- `node miniprogram/scripts/check-pages.mjs`、`check-classes.mjs`、TypeScript `tsc --noEmit`、`sync-contracts.mjs --check`：通过。
- 截图：未运行；375/390 上半屏和二维码/设置胶囊避让尚未视觉核对。

## 未验证 / 下一步

MP03–06 源码与回执已存在，但其微信截图门禁仍为 review；DevTools 进程存在但桌面控制接口无可绑定窗口，未取得本卡微信工具/真机截图。剩余验收为 375/390 上半屏、头像/档案猫裁切与胶囊避让视觉核对。
