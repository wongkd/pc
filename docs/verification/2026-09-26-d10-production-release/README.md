# D10 与客户来源生产发布回执

- 日期：2026-09-26
- 状态：生产迁移与 Worker 发布完成；期初窗口未开启，未录入真实库存；临时完整导出清理待完成；RC 整体验收未放行。
- 目标：先单独应用客户来源迁移 0029，再应用 D10 迁移 0030，发布客户来源和正式期初代码。
- 入口：生产 Worker `pc-backend`、生产 D1 `pc-db`、ERP `https://erp.huangqidong.cn/`。
- 操作边界：只应用已有的 0029/0030 文件，没有改迁移内容、编号或手工修改 `d1_migrations`；没有开期初窗口、没有写真实库存、没有提交 Git。

## 已完成

- 生产原先停在 0028。用只含 0029 的临时迁移目录先应用 `0029_customer_source_channel.sql`，随后确认生产清单只剩 0030；再单独应用 `0030_d10_formal_openings.sql`。
- 生产迁移清单现在无待办；`customers.source_channel`、D10 窗口表、盘点行唯一索引、自动关窗触发器和成本列均已核实存在。外键检查无异常。
- 生产只读计数：期初窗口、期初单、期初明细、库存实物均为 0；本轮没有录入库存。正式模式现已随 Worker 配置上线，这只表示入口可以使用，不代表窗口已经开启。
- Worker 版本 `a9b78a73-6b17-4de5-ba82-c1dbc4858187` 已部署到 `pc-backend`，100% 流量。绑定核对为 D1 `pc-db`、R2 `pc-attachments` 与 Assets；运行变量为 `REQUIRE_PERSISTENT_STORAGE=true`、`INVENTORY_OPENING_MODE=formal`。
- Wrangler 配置只要求线上已有的 `JWT_SECRET` 与 `DEEPSEEK_KEY`；只核对了密钥名称，没有读取或记录密钥值。旧 PDD 接口仍由退役路由挡住。
- 发布前导出的完整 D1 副本已在本地隔离库恢复并通过完整性、外键检查。清理临时副本的命令被系统拦截，完整导出仍在 `C:\Users\wuerl\AppData\Local\Temp\pc-quote-d10-recovery-20260925`；另有 `C:\Users\wuerl\AppData\Local\Temp\pc-db-schema-check.sql` 待清理。Cloudflare 原位恢复和 Worker 回退仍未演练。

## 验证

- `npm.cmd --prefix backend run check:migrations`：31 个迁移 `0000–0030` 连续。
- `node contracts/tools/validate-contracts.mjs`：3602 项通过；`generate-d10-contract.mjs --check` 与 `check-client-parity.mjs` 通过。
- `node --test tests/d10-opening.test.mjs`：4/4 通过；`node --test tests/e04-customers.test.mjs`：13/13 通过，含来源值保存、回读和无效值拒绝。
- 网页客户台账与库存页定向测试：33/33 通过；`npm.cmd run build` 通过，存在大包提示。
- Worker dry-run 与版本预览通过。预览和生产首页均为 HTTP 200，页面引用的 JS/CSS 文件名与本地构建一致；未登录的 `/api/auth/me`、`/api/v2/inventory` 返回 401。
- 生产迁移清单无待办；生产 `PRAGMA foreign_key_check` 返回空结果；只读计数确认期初窗口、期初单、期初明细和库存实物均为 0。
- 本轮完整 `e04b-inventory-http.test.mjs` 没有跑完，不能记作通过。D10 隔离 HTTP/浏览器验收见[原实施回执](../2026-09-25-d10-formal-opening/README.md)。

## 未完成与下一步

- 生产登录后的员工页面、客户来源展示和库存正式入口尚未做浏览器业务验收；未使用生产账号凭据，也未写业务数据。
- 未知成本销售例外、估值毛利单列报表、关窗后追加调整仍未实现，继续作为独立事项。
- 真正开始期初建账前，需要已审核的门店盘点表，并由店主选择 1–7 天窗口期限；没有这些信息时不要开窗或录入。
- 生产备份的 Cloudflare 恢复、代码回退、完整员工权限矩阵和 RC 整体验收仍待独立完成。
- 本机临时完整数据库导出和结构检查文件仍待清理，路径见上文；系统拦截了删除命令，本轮没有绕过。
- 工作区保持原有脏状态；没有提交、清理或混入其他任务。
