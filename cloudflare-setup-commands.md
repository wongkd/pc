# Cloudflare Worker Secrets 与 D1 Schema 操作清单

在项目后端目录执行：

```bash
cd "C:/Users/宋黄金/Nutstore/1/active/pc-quote/backend"
```

## 1. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器完成授权后，回到终端继续。

## 2. 设置 Worker Secrets

不要把密钥直接写进命令里。运行命令后，按提示粘贴值。

```bash
npx wrangler secret put DEEPSEEK_KEY
npx wrangler secret put JWT_SECRET
```

## 3. 应用 D1 schema 到远程数据库

```bash
npx wrangler d1 execute pc-db --remote --file=./schema.sql
```

## 4. 可选验证 templates 表是否存在

```bash
npx wrangler d1 execute pc-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='templates';"
```

正常应返回一行 `templates`。
