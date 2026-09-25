# MP06 · 图片失败与公共状态组件

日期：2026-09-23。状态：`review`。

## 结果

- 新增 `components/customer-image/`：宽高比以 CSS 百分比占位预留，图片加载前后布局不塌；可设裁切焦点、替代说明；坏图/空图显示限宽换行的回退内容，并触发 `error` 事件。
- 新增 `components/customer-state/`：提供 loading、empty、offline、error、forbidden、expired 六种状态的默认标题与说明；允许页面覆写文案。空态不显示重试；offline/error 可显示绑定真实 `retry` 事件的重试按钮；权限/过期默认不伪装为可重试网络错误。
- 重试进行中按钮禁用；`retryEventPending` 阻止请求中的重复事件，请求完成或状态改变后恢复。
- 新增纯视图测试覆盖长说明、空/错/无权/过期区别及图片焦点/比例安全边界；组件由既有 TypeScript、WXML 类名检查纳入门禁。

## 实际检查

本机 PowerShell 没有 `npm` 命令；用本地 Node 与 TypeScript CLI 跑等价命令：

| 命令 | 结果 |
|---|---|
| `npm --prefix miniprogram test` | 未运行：`npm` 不在 PATH |
| `node --test "miniprogram/tests/*.test.mjs"` | 105/105 通过 |
| `node miniprogram/scripts/check-pages.mjs` | 通过 |
| `node miniprogram/scripts/check-classes.mjs` | 通过，组件 WXSS import 与类名均纳入 |
| `miniprogram/node_modules/.bin/tsc.cmd -p miniprogram/tsconfig.json --noEmit` | 通过 |
| `node miniprogram/scripts/sync-contracts.mjs --check` | 通过 |

## 未验证与下一步

组件尚未由具体页面使用；本机当前没有微信开发者工具窗口，未取得长文本坏图、加载占位及按钮重试截图，亦未在真机检验图片裁切焦点。状态保持 review。后续页面接入组件时要把重试事件绑定到实际读取函数，不能展示无操作的重试按钮。
