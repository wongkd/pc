# MP07 · 首页品牌与主视觉区域

日期：2026-09-23。状态：`review`。

## 结果

完成门店栏下方的透明手写字标、副句、白色主机桌面主图和双猫叠层。首页副句只渲染一次；主机与显示器来自同一张主图，未拆成不同裁切。仅实现首页上半部，没有增加四张业务大卡。

真实数据仍未接入。页面显式读取 MP03 的 `demo` 固定样本，并显示样本说明；品牌图、主图、猫贴纸来自独立资源清单。页面没有切换到旧的店员样本。

## 改动与检查

- 页面文件：[home](../../../../miniprogram/pages/home/index.wxml)、[脚本](../../../../miniprogram/pages/home/index.ts)、样式与组件注册 `miniprogram/pages/home/index.wxss/json`。
- `npm --prefix miniprogram test`：未运行，当前 PowerShell 找不到 `npm`。
- `node --test "miniprogram/tests/*.test.mjs"`：通过，109/109。
- `node miniprogram/scripts/check-pages.mjs`：通过。
- `node miniprogram/scripts/check-classes.mjs`：通过。
- `miniprogram/node_modules/.bin/tsc.cmd -p miniprogram/tsconfig.json --noEmit`：通过。
- `node miniprogram/scripts/sync-contracts.mjs --check`：通过。

## 未完成验收

已实际查看参考图和独立资产；没有取得首页 375/390 截图、并排对照或微信真机截图，因此没有验证首屏裁切、主视觉比例和跨设备字形。尝试 `cli open --project <miniprogram>`，微信开发者工具返回“服务端口已关闭”，CLI 无法控制 IDE。状态保持 review。

下一步：在微信开发者工具人工打开小程序并记录 375/390 首页截图，对照主图裁切与四个入口，再复核 MP08。
