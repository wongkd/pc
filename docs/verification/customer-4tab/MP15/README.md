# MP15 · 第一轮四屏视觉放行

日期：2026-09-23。状态：`blocked`（视觉门禁未完成）。

> 后续更新：微信开发者工具已可绑定，已完成排版重做及部分原生截图验证。当前事实与剩余项以[最新接续入口](../2026-09-23-layout-rework/README.md)为准；下文保留此前执行记录，“无窗口”不再是当前阻塞原因。

## 结果

MP08、MP10、MP12、MP14 的回执、实际四个页面 WXSS 与其前置 MP03–MP06 均已复核；四 Tab 的固定演示样本、顾客专用导航和底栏、图片/空态组件及页面结构检查均仍存在。本轮重新运行小程序 M 档等价检查，111/111 测试、页面注册、样式类、类型与契约同步检查通过。

已实际查看清爽版与细字体版四屏基准图：布局、照片和图标位置以清爽版为准，细字体版只作为字形/字重基准。根据源码可做静态核对：四个页面保持规定的模块顺序、两列商城网格、社区三种图文节奏、我的档案/统计/菜单结构，以及四项固定 Tab 顺序；没有改动页面样式或公共组件。

## 未放行原因

本机当前桌面自动化会话没有可绑定的微信开发者工具窗口，无法取得原生 375、390、430 宽度的四屏截图，也无法检查 320 宽溢出、安全区和胶囊避让。因而没有原图/实图并排、50% 叠加、差异图或可量化偏差表；不能依据源码或浏览器模拟声称视觉已通过。

本卡按规范保持 `blocked`，不是 `verified`。没有修改业务源码、契约、迁移、后端入口或生产/远端状态。

## 实际检查

- `node --test "miniprogram/tests/*.test.mjs"`：通过，111/111。
- `node miniprogram/scripts/check-pages.mjs`：通过，10 个磁盘页面均已注册；顾客 custom tabBar 四项和顺序一致。
- `node miniprogram/scripts/check-classes.mjs`：通过。
- `miniprogram/node_modules/.bin/tsc.cmd -p miniprogram/tsconfig.json --noEmit`：通过。
- `node miniprogram/scripts/sync-contracts.mjs --check`：通过，6 个生成文件一致。
- `node scripts/check-doc-links.mjs`：通过，208 个 Markdown、492 个本地链接、0 损坏。

标准 `npm --prefix miniprogram ...` 命令未运行：当前 PowerShell 无法解析 `npm`；上述项目内 Node/TypeScript 等价命令已实际执行。

## 下一步

在可用的微信开发者工具会话中加载 `miniprogram`，以同一固定演示样本采集首页、商城、社区、我的在 375/390/430 的原生截图，并在 320 宽检查溢出。随后制作原图/实图并排、50% 叠加、差异图和偏差表，人工核对安全区、胶囊、字体、裁切、底栏与长内容；全部满足视觉合同后才能将本卡改为 `verified`。
