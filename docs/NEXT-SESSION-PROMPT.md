# 下一次从这里继续

## 当前断点：手工维修接收（2026-10-19）

用户确认到店客户不一定通过小程序下单。首页「＋ 开单 → 维修接收」已接 `/after-sales?action=intake`，直接展开原接修表单并说明手工填写；不要求小程序订单、客户档案 ID 或厂家 SN。本轮仅改今天页、维修页、对应测试和状态/回执。前端 255/255、隔离 build、lint 通过；本地合成 HTTP 浏览器 1440/390 点击、输入、失败保留和 Tab 已验并实看截图。未提交、未发布、未验证本轮真实后端持久保存；[回执](verification/2026-10-19-manual-intake/README.md)。下一步先在隔离真实后端补保存/刷新读回，发布另按授权；配件零售后端及请求函数已有、缺新建表单，不因本轮维修入口修复销案。

## 独立 ERP 执行断点（2026-10-18）

先读 [执行任务表](plans/2026-10-18-standalone-erp-completion/tasks.md)、[checkpoint](plans/2026-10-18-standalone-erp-completion/checkpoint.md) 和[本轮回执](verification/2026-10-18-standalone-erp-completion/README.md)。本轮未提交、未部署、未访问远端。

- 已完成并验证：Node 宿主正式配置拒启、预构建入口、SQLite 增量迁移记录/SHA/baseline/回滚/降级拒绝；独立宿主专项 4/4。前端 test 252/252、lint 0/0、隔离 build；契约、双端同步、D10/catalog、错误码、迁移、文档链接通过。
- 已实现待验：B09→B10 欠款批准读展/金额快照复核与 creditApprovalRef；B07 检测照片走 B35 已完成附件，sale_order/delivery_evidence、同店权限、下载字节/SHA核对；迁移 0035 和独立 ERP v2 增量契约已生成四端副本。
- 浏览器实看：同一隔离 Node/SQLite 已登录 `/dashboard`、`/inventory`，老板菜单、中文导航、空库存、登记/筛选入口可见。尚未做普通员工、窄屏键盘、真实上传下载和 QT03 系统打印。
- 后端全量已完成 422/422；f1 附件专项与新增宿主专项合计 26/26。若后续修改后端，先跑相关专项，再按需重跑全量；不要重复启动第二套全量。
- 仍需按任务表推进或记录阻塞：B39/B40、供应商真实退款/贷项、批次余量/旧 SN/维修耗件、未知成本报表与追加纠错、供应商页、配送版本/改址差额、延保收费履约、备份恢复与生产/远端附件。小程序/微信支付/真机/生产继续作为边界，不写成完成。

## 最新断点：独立网页 ERP 未完成项核查（2026-10-18）

用户本轮要求检查剩余工作，并按网页 ERP 可脱离小程序运行的范围评估。先读[独立 ERP 核查](verification/2026-10-18-standalone-erp-audit/README.md)，不要等待小程序登录或线上支付完成才推进 ERP；线下确认与已核实到账记账已有独立路径。本轮只核查并更新文档，未改功能、未提交或部署。

本轮实测：前端252/252、后端418/418、生产构建、契约/生成物/迁移门禁通过；未启动小程序的隔离 Node / SQLite 登录、合成客户保存及宿主重启后读回通过。前端 lint 为43 errors、3 warnings；未做生产或浏览器验收。

下一动作建议：确定正式宿主并补持久化/备份恢复验收；采用 Node 时须先处理测试配置与已有库增量迁移。随后衔接 B09 审批凭据到网页 B10 交付、接通装机检测照片；报损/改价/采购真实退款/批次追溯按专项推进。前端 lint 本轮未通过，不能将 test/build 通过写成全部门禁通过。生产版本、在线可达性及数据本轮未复核；旧部署信息仍按对应日期使用。

## 上轮断点：装机国内站管理员更新（2026-10-13）

IP 站管理员已改为用户本轮提供的登录信息，新凭据登录及身份查询均 200，旧凭据与旧会话均 401。用户 ID 和门店 owner 关系保留，见[账号更新回执](verification/2026-10-13-vps-admin-account/README.md)。凭据不写入交接；历史默认账号已失效。下一步使用新凭据进行浏览器业务流程验收。

## 上一版断点：装机国内站上线（2026-09-29）

已把 `erp.huangqidong.cn` 正在跑的 **09-28 版本**推到帷云 #server-2880，该站定名**装机国内站**，访问方式是
**境内 IP 直连** `https://160.202.238.156:33155/`（证书 CN 是域名，浏览器会报警需手动继续；域名入口仍不可用）。
本地 `frontend/dist` 与 erp **逐字节一致**（主 bundle `index-BJ65SuN-.js`、md5 `0476982177d7cc44c09d177079957548`），
**未重新构建**；前后端均已更新，后端迁移到 **`0034`**。部署途中排掉三个**既存缺陷**：`tests/lib` 顶层
`import 'miniflare'` 拖垮 node-host、该机 esbuild 二进制缺 `+x`、`--seed` 非幂等（后端原先一直在**重启崩溃循环**）。
详见[回执](verification/2026-09-29-zhuangji-domestic-deploy/README.md)与新踩坑 **P-72～P-74**。
⚠️ 库是**演示库（业务表 0 行）**、无真实数据；**浏览器里员工点击流程未验收**；三处代码改动**未提交 git**。
⚠️ node-host 的**迁移只在库文件不存在时应用**，追加迁移后重启**不会**自动应用。

### 上一版断点：点击无响应修复与独立商城商品

2026-09-28 已完成 ERP 生产发布，详见[本轮回执](verification/2026-09-28-catalog-navigation/README.md)。提交 `e4c6a81` 已推送 `main`，生产 D1 已应用0034，Worker `cbfd2a60-f798-4b34-8cd7-548f4032a6dd` 承接100%流量。首页与`/products`返回200、商品管理匿名请求401、线上静态资源与构建一致。网页252/252、后端418/418、小程序68/68及生产构建通过。未使用员工账号验证生产点击流程；小程序 API 域名与门店ID仍为null，未提交微信体验或审核版本。下一步需配置真实备案HTTPS域名/门店ID，再做员工只读验收和微信真机验证。以下 VPS 与上一版生产断点作为历史信息保留。

更新：2026-09-28。先读[当前状态](STATUS.md)、[未决项](OPEN-ITEMS.md)和[VPS 域名路由核验回执](verification/2026-09-28-vps-domain-routing/README.md)。

## 当前任务断点：VPS 临时入口

- Cloudflare 区域中 `zhuangji.huangqidong.cn` 无 DNS 记录；VPS 当前公网映射 `160.202.238.156:33155` → 内部 HTTP 8080，`/healthz` 和 `/dashboard` 实测 200，未登录 API 实测 401。
- 帷云面板确认 NAT 为 `160.202.238.156:33155` → 内部 8080、`160.202.238.156:42465` → 内部 22（⚠️ 公网 **22 端口是别人的机器**，OpenSSH 8.0，不能用）。**2026-09-28 已完成 SSH 密钥接管**：本机私钥 `~/.ssh/pcq_vps2880` 已写入 VPS 的 `/root/.ssh/authorized_keys`；`/etc/ssh/sshd_config` 的 `PubkeyAuthentication` 由 `no` 改为 `yes`（备份 `sshd_config.bak-2026-09-27-2206`，`sshd -t` 通过后 reload）。执行入口是 `deploy/nat-test/vps-ssh.mjs`，用法见其文件头注释。
- ⚠️ **凭据卫生**：用户已在对话中提供过 root 密码（该对话记录会落盘）。密码认证目前仍开启，**建议用户在面板改一次密码**；此后一律走密钥。
- `pcq-backend.service` 与 `pcq-gateway.service` active，Node 监听 8080/8790；cloudflared 2026.9.3 已安装。程序目录 755/644，SQLite 私有目录 700、文件 600；权限变更后 `/healthz` 仍为 200。禁止盲目重跑 `deploy/nat-test/setup-server.sh`。
- SQLite 只读行数显示 customers、报价、销售、库存等业务表均为 0；stores、store_members、users 各 1 行。未读取或导出客户字段。
- VPS host firewall OUTPUT=ACCEPT；Cloudflare 区域 DNS 正常，UDP 7844 至 Cloudflare 区域 1/2 成功，TCP 7844 与 443 超时。QUIC 可用；VPS 出站下载不通，cloudflared Linux 包从官方源在本机下载后经 SSH 传输安装。
- Cloudflare 控制台显示 `erp.huangqidong.cn/*` 当前由生产 Worker `pc-backend` 接管，并绑定生产 D1 `pc-db` / R2 `pc-attachments`。不要向 `erp` 部署或改生产路由/绑定来伪造隔离；未来测试部署先落实独立数据资源。
- Cloudflare Dashboard 安全验证已通过；区域授权成功。旧 Tunnel“家里的飞牛”仍 down 且未复用。已创建独立 `pcquote-server-2880-temp-vps` Tunnel；本地账户证书与单 Tunnel 凭据均限制访问并置于仓库外。VPS connector 尚未配置或启动，DNS 尚未发布。
- 用户已确认公开发布。**SSH 会话条件已满足**（2026-09-28 密钥接管完成，`deploy/nat-test/vps-ssh.mjs` 可直接执行远程命令）：可将单 Tunnel 凭据安全传至 VPS，配置 `http://127.0.0.1:8080` 与 QUIC 服务；确认 connector healthy 后再添加 `zhuangji.huangqidong.cn` CNAME。`erp` 不动。不要把凭据放进源码、文档、命令历史、截图或对话。
- **2026-09-28 已完成容量压测**（[回执](verification/2026-09-28-vps-load-test/README.md)）：只读接口饱和 **146 RPS**，登录吞吐卡在 **7 次/秒**（单核被密码哈希占满）；内存全程 375–385 MiB、**swap 零使用**；7,510 请求 **0 错误**。⇒ **内存与磁盘有余，单核是唯一瓶颈**；测试与小团队够用，「同一秒多人登录」会排队（8 并发 P95 1.56 s）。未测并发写入、TLS/Nginx、真机弱网。部署版本与仓库 HEAD `b7b7e62` 逐文件一致。
- ⚠️ **2026-09-28 查清：该机没有国际出口 ⇒ Cloudflare Tunnel 不可用**（实测 Google / GitHub / api.cloudflare.com 全不通、无全局 IPv6；cloudflared 配置全对仍连不上边缘 —— QUIC 超时、HTTP/2 blocked，属**网络层限制**）。已 `stop + disable cloudflared`，配置留在 `/etc/cloudflared/`，将来有国际出口可直接启。
  ⇒ **HTTPS 入口改走「橙云代理 + Origin Rules 改回源端口到 33155」**（Origin Rules 的 Destination port 免费版可用，1–65535）。脚本已备：`deploy/nat-test/cf-publish-https.mjs`（幂等，带 `--dry-run`）；服务器侧已验证能响应带自定义 Host 的请求（200 + ERP 首页）。
  **🔴 当前阻塞：本机没有 Cloudflare 写权限**（无 API Token；`~/.cloudflared/cert.pem` 只能管 Tunnel，加不了 A 记录、配不了 Rules）。需用户提供 API Token（Zone:DNS:Edit + Zone:Config Rules:Edit）或授权接管浏览器。
  另：该机 DNS 对 `.argotunnel.com` 的 **SRV 做了过滤**（53 端口所有公共 DNS 均 ENODATA），**DoH/DoT 能绕过**；已落 `/etc/systemd/resolved.conf.d/99-dot.conf` 走 `223.5.5.5#dns.alidns.com` + `DNSOverTLS=yes`。
- 本轮已收紧 VPS 文件权限、安装 cloudflared、完成 Cloudflare 区域授权并创建一个专用 Tunnel。没有改 DNS、Worker、迁移、应用源码或业务数据，无提交。

## 当前断点

2026-10-18 已发布：B40 商品挂牌价调整已提升为正式老板专属动作，`PATCH /api/v2/inventory/products/:id/price` 使用 `expectedVersion`、`requestId`、审计与历史快照边界；B40 专项 2/2、后端全量 424/424、前端 252/252、契约自洽 3763 项通过。提交 `d5978fb` 已推送 `origin/codex/v2-item-flow`；远端 D1 `0035` 已应用，Worker 版本 `c478ef44-c0d8-4e7c-a7fa-f77c7680b727` 已部署，首页 200、匿名 `/api/auth/me` 401、线上 index 与本地 build 一致。普通员工权限回环矩阵 30/30 通过；QT03 配置详情页与键盘焦点已实看，但系统打印预览未弹出。下一轮优先做 B40 商品管理 UI/浏览器动作、B39 报损、供应商退款/贷项、批次出库余量、旧 SN、维修耗件、配送差额和延保履约；不把只读线上核对写成员工业务或生产 RC 验收。

- 仓库 V2 与客户查询发布提交为 `463895c`，0032 外键修复为 `3874cfe`；两者已推送 `origin/main`，未强推。
- 生产 Worker `pc-backend` 当前版本 `3d9ad66b-5609-4a7e-bd5a-27f789b54a26`，100% 流量；D1 已应用 0000–0033 共 34 条迁移，无待迁移，`foreign_key_check` 为空。
- 0032 重建后保留了库存流水、盘点行的外键和余额 / 期初触发器；0033 客户台账与订单汇总索引已存在。迁移前 Time Travel 书签、行数与验证细节见发布回执。
- 前端全量 247/247、生产构建与契约/迁移门禁通过。后端完整套件首次运行 413 项通过、1 项旧迁移计数断言失败；该断言已更新并单独重跑通过。迁移修复后的客户、库存、期初与 B47 专项 42/42 通过，附件 R2 标记测试 1/1 通过。
- 线上首页 HTTP 200，构建资源名与本地一致；匿名客户和工作台 API 均返回 401。没有创建或修改生产客户、订单、库存等业务记录。
- 本地客户查询基准和 1/3 Mbps 弱网结果使用 Vite 开发模块、隔离 Worker 与合成数据；目标低配服务器、共享出口、真实移动网络和已登录页面尚未验收。
- 工作区仍留有历史日志、截图和文档索引改动；未清理。提交时只纳入本次发布代码、测试和对应方案/回执。

## 下一动作

1. `zhuangji` 入口已查到底（[2026-09-29 回执](verification/2026-09-29-vps-gateway-https/README.md)）：网关缺陷已修复，**境内按 IP 访问 `https://160.202.238.156:33155/` 为 200**；但**按域名无解**——灰云直连撞未备案拦截（403 拦截页 / TLS 被 RST），橙云代理撞该机**对境外不可达**（check-host.net 境外多节点含中国香港、日本全超时 ⇒ CF 回源失败 522）。⇒ 除非帷云控制台能放开入站来源 IP，否则 `zhuangji` **不能作为域名入口**。要真正上线域名，应转向「国内轻量机 + 域名过户/备案 + 灰云直连」主线，不要再在这台临时机上投入（它现在只承载**装机国内站**——一个境内 IP 直连、演示数据的站）。
2. 由真实授权员工只读验收客户台账分页、报价选客搜索、仓库分类、库存详情和登记入口；不为了验收新建生产单据或库存。
3. 另行演练生产备份恢复与 Worker 代码回退；数据库迁移后的恢复要明确时间点和数据影响，不能把本地测试当作生产恢复演练。
4. **单核 1 GB 容量已复测**（2026-09-28：146 RPS 饱和 / CPU 打满 / 内存有余 / swap 未用）；仍差共享出口带宽、TLS 形态与真实手机网络的验收。
5. 员工权限矩阵、真并发写入、微信真机和应用层 R2 canary 仍是独立验收；RC 整体不放行。
6. 抽象数据访问层和附件分流实现明确暂缓；耗材批次出库余量、旧 SN 台账及维修耗件映射按独立任务推进。
