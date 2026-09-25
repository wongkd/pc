# MP08 · 首页四入口与底部横幅

日期：2026-09-23。状态：`review`。

## 结果

首页增加同一行四个黑灰线性服务入口与细分割线，并接入横向推荐横幅、文案和箭头。入口触控区域覆盖图标与文字；三项未接通服务只显示说明，门店入口说明当前为虚构样本；横幅切换到商城并恢复“整机”分类，不伪造预约或提交成功。

## 改动与检查

与 MP07 共用 `miniprogram/pages/home/index.*`，并新增页面结构回归检查 `miniprogram/tests/customer-home-shop.test.mjs`。M 档等价命令全部通过：`node --test "miniprogram/tests/*.test.mjs"` 109/109、`node miniprogram/scripts/check-pages.mjs`、`node miniprogram/scripts/check-classes.mjs`、TypeScript `tsc.cmd`、`node miniprogram/scripts/sync-contracts.mjs --check`。标准 npm 命令未运行，因为 PowerShell 找不到 npm。

## 未完成验收

没有取得完整首页截图，也未验证 320 宽无溢出和横幅相对底栏的位置。微信开发者工具 CLI 打开项目失败，原因是工具服务端口关闭；没有微信工具或真机视觉结论。状态保持 review。

下一步：在微信开发者工具以 320/375/390 宽检查四入口、横幅与底栏，并与清爽版参考图并排复核。
