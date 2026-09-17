# PC 配置报价系统 · 前端

电脑硬件报价与配置方案生成工具，并承载「装机店经营工作台」的网页端。

## 技术栈

- React 19 + TypeScript + Vite
- Cloudflare Pages 部署
- 后端 Cloudflare Workers + D1
- 测试 Vitest（`environment: node`；需要 DOM 的测试文件用文件级 `// @vitest-environment jsdom`）

## 开发

```bash
npm install
npm run dev        # http://localhost:5173
npm run test
npm run build
npm run lint       # 既有 39 项失败（35 error / 4 warning），非新引入
```

## 目录职责（2026-09-17 起）

| 路径 | 职责 |
|---|---|
| `src/app/` | 网页壳、导航、路由落点、登录边界 |
| `src/features/<域>/` | 按业务域组织的页面与视图模型（workbench 已建立） |
| `src/styles/` | 设计变量与页面样式，类名统一 `wb-` 前缀 |
| `src/contracts/generated/` | **契约生成物**，来自 `contracts/v1`，禁止手工编辑 |
| `src/components/` | 既有报表 / 报价 / 订单 / 管理页面（未迁移部分仍在此） |
| `src/utils/` | 请求封装、金额、日期、导出等工具 |
| `scripts/sync-contracts.mjs` | 生成物落地与三方防漂移校验 |

### 设计变量为什么带 `wb-` 前缀

`src/index.css` 的 `:root` 已经占用了 `--line`、`--muted`、`--ink`、`--page-bg` 等裸名，而新壳会同时包住既有报价编辑器。新视觉的变量一律加前缀并限定在 `.app-shell` 作用域内，**避免改壳顺带改坏报价页的分隔线与文字颜色**。

## 契约生成物

```bash
node ../contracts/tools/generate-dto.mjs            # 重生成中立产物
node scripts/sync-contracts.mjs                     # 落端内目录
node scripts/sync-contracts.mjs --check             # 防漂移复验
```

端内副本不是第二份契约。改契约后必须重新生成并同步，手工编辑任何一方都会被 `--check` 检出。

## 当前状态（2026-09-17，T02a 后）

**已实现**：六导航壳（今天 / 开单 / 库存 / 售后 / 回收置换 / 账本，设置进头像菜单）、全局搜索框（未接通，如实提示）、今天工作台的指标 / 列表 / 看板 / 详情、筛选与空状态、图片降级、离线提示条。

**未实现**：任何真实业务写入；断网 / 写超时 / 登录过期 / 冲突 / 无权限等界面状态；小程序端。

**⚠️ 数据源是演示样本**：`src/features/workbench/demoData.ts` 的 `DEMO-` 前缀样本会进入构建产物，**不得当作可用版本发布**。契约要求生产包不携带样本，处理方式待定，见 [docs/OPEN-ITEMS.md](../docs/OPEN-ITEMS.md) 的 D-E。

**⚠️ 浏览器视觉验收未运行**：本机无浏览器自动化工具，且本地登录会触达生产后端。尺寸、缩放、对比度需要人工或后续补做。

细节与证据：[T02a 验证记录](../docs/verification/2026-09-17-T02a/README.md)。
