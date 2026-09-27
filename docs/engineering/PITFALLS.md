# 工程踩坑记录

更新：2026-09-26。保留 P 编号供检索；按任务阅读，不必每次全文读。
来源：整理前 OPEN-ITEMS 第 4 节，正文保留历史上下文。

## 4 · 踩过的坑（下次别再踩）

| 编号 | 坑 | 表现 | 正确做法 |
|---|---|---|---|
| P-01 | **同一文件的多处 `Edit` 并行提交会互相覆盖** | 已犯 3 次（T01b / T01-rev1 / T01c），每次白花一轮排查 | 同一文件的多处编辑必须串行；一条消息里只发一个针对该文件的 `Edit` |
| P-02 | **禁止把契约 JSON 整体 `JSON.stringify(…, 2)` 重写** | 会摧毁手工紧凑排版，diff 从 145 行暴涨到 3079 行 | 用纯文本外科替换 |
| P-03 | 生成物**不能手工编辑** | `validate-contracts.mjs` 第 12 节会重建后逐字节比对；`sync-contracts.mjs --check` 也会报 | 改契约源文件 → 重新生成 → 再同步端内 |
| P-04 | **超长单行 JSX 会让 `tsc` 解析失败** | `App.tsx` 里 500+ 字符的 `<Route … element={<Comp 属性={[…嵌套对象…]} />} />` 报 `TS2657` + `TS1005`，逐字符检查无非法字符 | 嵌套数据先提为模块级常量，再 `{...props}` 展开 |
| P-05 | **生成物没做依赖过滤时，前端 `noUnusedLocals` 直接编译失败** | `objects.ts` 全量导入 36 个枚举类型 → 6 处 `TS6196` | 已修生成器：按 `\b名字\b` 过滤实际引用的类型 |
| P-06 | **CSS 变量名不要用裸名** | `index.css` 的 `:root` 已占用 `--line` / `--muted` / `--ink` / `--page-bg`，而 AppShell 会包住报价编辑器 | 新视觉变量统一加前缀（本项目为 `wb-`），作用域限定在壳内 |
| P-07 | **`@testing-library/react` 在本项目不会自动清理 DOM** | vitest 未开 `globals`，多个用例 DOM 累积 → 14 个用例报「found multiple elements」的**假失败** | 测试文件内显式 `afterEach(cleanup)` |
| P-08 | **jsdom 不加载资源，图片 `error` 不会自然触发** | 图片降级路径测不到 | `fireEvent.error(img)` 主动触发；浏览器里 `demo://` 本来就必然失败 |
| P-09 | **改函数声明行时不要把行尾换行放进 `old_string`** | 会把两行粘成一行（T02a 犯过一次，已当场修复） | 只匹配行内容本身 |
| P-10 | 负向测试的注入备份 | 曾散落在根目录 | 统一放 `.validation-*/`（已 gitignore），用完立即删 |
| P-11 | 登记缺口 / 下结论**必须钉规格原文行号** | T01b 曾凭印象把 `Purchase` 登记为缺口，T01-rev1 更正 | 校验脚本第 11 节会验证「引文逐字出现在该行」 |
| P-12 | 校验脚本自身也会写错 | 曾把「公式结果」当「输入项」判空 → 12 项连锁误报 | 依赖检查必须区分输入项与派生项 |
| P-13 | **换壳 / 搬入口时会连同「可见性条件」一起丢掉** | 旧壳对「系统设置」有 `permissions` 判断，T02a 把它移进头像菜单时差点漏掉，那样任何店员都能看到设置入口 | 迁移入口时逐条对着旧实现核对**条件**，不只核对路径；并补测试 |
| P-14 | **用设计稿对齐排版时，按稿上的示例字符数算宽度会漏掉真实渲染** | 设计稿统计条写 `¥12,800`（7 字符、不带分位），真实必须渲染 `¥12,800.00`（10 字符，02 §1 不许掩盖分）→ 等分格装不下，实测被裁（R-14） | 排版对齐时用**真实渲染文案**（含分位、含千分位、含前后缀）算宽度，不能用稿上的示例值；能算就写成约束测试 |
| P-15 | **注释里出现「星号加斜杠」会提前闭合块注释** | T04 的 `tests/lib/build.mjs` 文件头写了 `.validation-*` + `/` 形式的路径通配，注释提前结束，后续整段被当代码，报出的却是下一行的 `SyntaxError: Unexpected identifier '$'`，差点往模板字符串上排查 | 注释里不要写出「星号紧跟斜杠」的组合；写目录通配时拆开或改措辞。**看语法错误先回看前文是否提前闭合** |
| P-16 | **miniflare 的 `scriptPath` 不编译 TypeScript** | 用它托管 `worker.ts` 直接报 `Unable to parse ...: Unexpected token` —— 只有 wrangler 才走 esbuild 转译 | 测试要调 TS 代码时，先用 esbuild 打包成 `.mjs` 再 import（见 `backend/tests/lib/build.mjs`） |
| P-17 | **D1 的 `exec()` 按换行切分语句** | 多行 `CREATE TABLE` 被切成半句，报 `incomplete input`；而触发器体内自带分号，按 `;` 裸拆同样会切坏 | 自己写拆分器：跳过注释与字符串字面量，并把 `CREATE TRIGGER ... BEGIN ... END` 整体当一条语句（见 `backend/tests/lib/sql.mjs`） |
| P-18 | **`node --test` 不会因为测试跑完就退出** | 留下活动句柄（未 dispose 的 workerd）时会挂住；管道缓冲让外面看不到任何输出，表现为「跑了 4 分钟没动静」，极易误判为卡死 | 确保 `dispose()`；探测类脚本显式 `process.exit()`。日志**重定向到文件再读**，不要依赖管道 `tail` |
| P-19 | **同一个 D1 批次内，后面的语句看得见前面语句的效果** | B13 一个请求带两行时，第二行的「该商品是否已有库存」守卫命中了第一行刚建的数据，整批被自己拦下；**单行请求却完全正常**，极易误判成「约束写错了」 | 「本批之前是否已存在」类的守卫，必须**排除本次 requestId 写入的行**（按 `request_id <> ?` / 期初单号排除）。T05a 的两处守卫已按此修正并有对应用例 |
| P-20 | **UPSERT 的 INSERT 分支先校验 CHECK，再判定唯一冲突** | 把桶间转移的算术写进 `INSERT ... ON CONFLICT DO UPDATE` 的 INSERT 分支时，`available → reserved`（delta 为负）被 `available_qty >= 0` 拒绝，报错指向一个完全合法的余额 | 改为**先 `INSERT OR IGNORE` 建零行，再 `UPDATE` 累加**。此时「对不存在的余额做扣减」仍会因 CHECK 失败整批回滚（正确行为），合法转移则可通过 |
| P-21 | **`db.prepare(...).bind(...)` 本身不会执行语句** | 测试夹具漏写 `.run()`，INSERT 静默不生效；后续断言全拿到 `null`，症状看起来像「外键或约束坏了」，实际是语句从没跑过 | 构造完必须 `.run()` / `.first()` / `.all()`；夹具里统一封装成「执行并返回错误消息」的助手，不要让裸 PreparedStatement 在测试代码里传递 |
| P-22 | **Windows 下动态 `import()` 一个绝对路径（`c:/…`）报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`** | ESM loader 只接受 file / data / node 三种 scheme；POSIX 习惯的裸绝对路径在 Windows 上全是非法 URL | 一律 `pathToFileURL(p).href`（或拼 `file://` + 正斜杠）再传给 import；T03b 的跨端门禁脚本 `check-client-parity.mjs` 有现成写法 |
| P-23 | **同一个仓库里并行跑 `frontend run test` 与 `frontend run build` 会让构建失败** | V02 时两个命令同时起，`build` 以 `unwrapBindingResult` + 一长串 rolldown/vite 堆栈结束，`tail` 截断后只剩堆栈、看不到真实错误，极易误判成「刚改的 CSS 有语法错」。单独重跑同一命令即成功（`✓ built in 1.01s`） | 两个命令**串行**跑；构建失败先看完整日志（重定向到文件）再判断，不要凭堆栈猜代码问题 |

## 5 · 补充踩坑（自项目记忆迁入，此前只存在于记忆文件）

| 编号 | 坑 | 表现 | 正确做法 |
|---|---|---|---|
| P-24 | **看不到截图就明说看不到** | 曾把凭文件路径脑补的截图细节写进记忆并当作验收依据 | 没有实际看到图就不能说"界面已验收"；"文件存在"≠"界面通过" |
| P-25 | **验收断言要打在承载该字段的容器上** | 报价详情页 `¥NaN`（接口漏字段）是被截图抓到的，而此前 33 项全绿的**整页文本断言**没照出来 | 断言定位到承载该值的元素，不要用整页文本包含式断言 |
| P-26 | **`actions.json` 的 `evidence` 是 `backend/src/index.ts` 的绝对行号** | 改入口后证据行整体失效；且校验器只验"该行含 `requirePermission`"，**指错路由的行也能静默通过**（曾修掉 2 条） | 改入口必重跑 `validate-contracts.mjs`；入口顶部插 N 行 ⇒ 所有证据行整体 +N |
| P-27 | **后端 `handle*` 里对空 body 请求调 `req.json()` 会抛错** | DELETE 走 body 解析分支，把正常删除报成 400 | DELETE 分支必须排在 body 解析之前 |
| P-28 | **SQLite / D1 不支持 `ALTER TABLE` 加约束** | 想直接补外键，无语法可用 | 整表重建（建新表 → 拷数据 → DROP → RENAME）；引用它的子表外键同时受影响；表为空时才有代价优势 |
| P-29 | **样本不得发明契约外字段** | T05c 曾自造 `acquiredAt`，后被自我纠正 | 样本字段只从契约取；缺字段先补契约再写样本 |
| P-30 | **小程序 `toLocaleString` 不完整** | 金额格式化在真机上行为不一致 | 金额用纯字符串运算；改完 wxml/wxss 必跑 `npm --prefix miniprogram run check-classes` |
| P-31 | **前端 CSS 别用 `subgrid`** | 兼容性不足 | 表头与行各写一份 grid 列定义 |
| P-32 | **未定义的 CSS 变量会让整条声明失效** | 无回退值的 `var()` 不是取空值，是整条属性被丢弃。E04b 实测：`workbench.css` 引用 `--wb-accent`/`--wb-radius-btn`/`--wb-radius-card`/`--wb-surface-sunken`，`theme.css` 一个都没定义 ⇒ 焦点轮廓、hover 底色、圆角**全部静默失效**（键盘焦点不可见） | 改了 CSS 变量名要 grep 定义；新增变量必须落到 `theme.css` |
| P-33 | **全局 `input{width:100%}` 会把复选框拉成整行** | `index.css` 的全局规则命中 checkbox，文字被推到最右 | 复选框所在容器写 `.xxx-check input{width:auto}` |
| P-34 | **窄屏按钮会被压成一行一个字** | `wb-btn` 在窄容器里逐字换行 | 按钮加 `white-space:nowrap` |
| P-35 | **写完动作的顺序：先刷数据、再弹成功提示** | 反过来会出现"提示已成功、表格还是旧数字"的窗口期 | 数据刷新完成后再提示 |
| P-36 | **浏览器验收的两个坑** | ① `fullPage` 长图遇 `overflow:auto` 容器会被截断；② favicon 404 会被记成运行时错误 | ① 临时解开高度/overflow 再截；② 补内联 SVG，**不要**给断言加白名单；③ **先写 verification.json 再 assert** |
| P-37 | **`react-hooks/set-state-in-effect`** | effect 体内同步调用会 setState 的函数就报错（即使函数第一句是 `await`） | 把 setState 放进 Promise 回调，或让"正在加载"由发起动作的事件处理设置 |
| P-38 | **Vite 改了 `vite.config.ts` 会重建依赖缓存** | 重建时沙箱批量删除守卫（≥50 项）会拦住删除 | 把 `node_modules/.vite` **改名挪走**即可（可逆），不要强删 |
| P-39 | **清理无用文件的口径** | 用 `rm -rf` 风险不可控 | `rm -f 精确文件` + `rmdir 目录`（非空即报错，自带校验）；删前 `realpath` → `git ls-files` → grep 确认引用 |
| P-40 | **同一文件并行编辑会互相覆盖** | 在**一条消息里**对同一个文件发多个编辑，后写覆盖先写：曾把 import 与状态声明一并丢掉，还误以为是并行会话在抢文件（时间戳证明不是） | 同一文件的编辑**串行**发；改完 **grep 复验目标文本真的在文件里**，别只信工具返回的「成功」 |
| P-41 | **重建表时别顺手去掉原列的 DEFAULT** | 重建 `stock_reservations` 时把 `qty INTEGER NOT NULL DEFAULT 1` 写成 `NOT NULL`，打断两条既有测试（它们 INSERT 时不给 qty）⇒ `NOT NULL constraint failed` | 重建表逐列对照原定义：**约束可以改，默认值要照抄**；改完跑一遍受影响的既有用例 |
| P-42 | **哈希取 hex 前必须 `>>> 0`** | `^=` 的结果是**有符号** 32 位，为负时 `toString(16)` 带一个 `-`：订单号生成成 `SO-20260921--7687B199`（不匹配格式断言） | 一律 `(hash >>> 0).toString(16)` |
| P-43 | **条件化写的两张相关表，第二张不能再判同一条件** | 先按 `WHERE EXISTS (… available_qty >= n)` 写库存流水（这一步已经把量扣掉），第二张表若再判 `available_qty >= n` 必然为假、**永远写不进去** | 第二张表改判「流水是否已插入」（用确定的流水 id），或把两张表的条件绑在同一个前置状态上 |
| P-44 | **`guidanceFor` 会把 `VALIDATION_ERROR` 换成通用话术（已修）** | 2026-09-22 T-11 已让新版 v2 写响应附上数据库真因；用户仍看到通用业务说明，但同时能看到「订单号已存在」等具体原因 | 新写域复用 `appendReadableDiagnostic`；程序分支仍只看 `code`，不要匹配中文文案 |

| P-45 | **跨前缀客户端的 `baseUrl` 传 `'/'` 会拼出协议相对 URL** | `createWebApiClient({ baseUrl: '/' })` 把 `'/api/x'` 拼成 `'//api/x'`（协议相对），请求会打到意料之外的 host；单测跑不出来（jsdom 不解析） | 跨前缀客户端的 `baseUrl` 一律用**空串**；只在本端前缀确定时才写前缀 |
| P-46 | **服务端把超期的 `issued` 直接算成 `expired`** | 服务端判过期后把状态当 expired 用；前端若按 `status === 'issued'` 决定「该不该提示续期」，提醒**永远不触发** | 前端判续期/提醒用服务端给的 `expired` 标志，**不要**用状态字符串推断 |
| P-47 | **幂等重放保护必须放在业务预读之前** | 放在预读之后时，重放会用「已经变化过的预读值」重算载荷摘要，摘要在正常重放里对不上，幂等形同失效 | 幂等检查前置；载荷摘要**只含客户端输入**，不含任何预读/派生值 |
| P-48 | **`/api/v2` 下多链路共存要各自认领前缀** | 库存 `/inventory*`、报价与销售 `/sales*`；某个 v2 模块的兜底 404 若盖住整段 `/api/v2`，**后接的链路永远不会被调用** | 每个 v2 模块只在自己认领的前缀内兜底 404，越界一律放行给下一个模块 |
| P-49 | **新权限码不能写进后端入口 `src/index.ts`** | 契约校验器（10.6 节）把入口文件里所有 `'xx/yy'` 当作旧权限码核对，新增码会让校验失败 | 新链路的权限映射写在 `src/domains/access.ts`；入口只留 import 与分发。另：**无成本权限时服务端根本不查那几列**，前端只能用 `'totalCostCents' in row` 判断字段是否存在 |
| P-50 | **`for (const [i,v] of arr ?? [])` 三件套（解构 + 数组 + `??`）在 V8/workerd 抛 `.for is not iterable`** | E11 拆件损耗循环：`input.scrapLines ?? []` 打印出来就是普通数组（isArray true、length 对），照样 500；加括号 `of (arr ?? [])` 也会被 esbuild 转译时省略括号、照样炸；同一函数里 `of arr.entries()` 却正常 | 先取成变量再迭代：`const xs = arr ?? []; for (const [i,v] of xs)`。这是 V8 的解析怪癖，别用 `??` 直接出现在 for-of 头部（尤其带解构时） |
| P-51 | **`guardStatement` 的第三参只收布尔条件，别写 `SELECT 1 WHERE …`** | 它会拼成 `INSERT INTO assertion_guards(code) SELECT ? WHERE <你的串>`，写 `SELECT 1 WHERE ?<>?` 就变成嵌套 SELECT、SQL 语法错误（E11 守恒守卫实测） | 只写裸条件，如 `'? <> ?'`；要表达「某子查询不存在」才用 `NOT EXISTS (…)` |
| P-52 | **SQL 查出来的列名是下划线，plan 读的是驼峰字段** | E11 拆件：`SELECT … si.product_id` 出来的行直接传 plan，plan 里读 `source.productId` 恒 undefined，绑 D1 报 `D1_TYPE_ERROR: Type 'undefined' not supported` | 在入口处把下划线行显式映射成驼峰对象再传 plan；别把 SQL 行对象直接透传 |
| P-53 | **`vite build` 清 `dist` 会被 safe-delete 垫片卡住（看起来像构建失败）** | 2026-09-26 P01：报 `[safe-delete] 操作失败: spawnSync … genie-trash\win32-x64.exe ETIMEDOUT`，栈顶是 `vite:prepare-out-dir → emptyDir`，其实代码没问题、删除环节超时 | 构建前**先把 `dist` 改名挪走**（顺带当基线快照），再跑 build；不关安全机制。垫片开关是 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，非必要不用 |
| P-54 | **失败的分包，在同一个文档里再 `import()` 一次不会重新下载** | 2026-09-26 P01：拦截某分包后点「重试」连点 3 次，**0 个网络请求**、页面始终打不开；`React.lazy` 重建实例也救不回来（浏览器缓存了失败的模块记录） | 分包类失败的恢复入口**只能做整页重载**；不要给用户一个点了没用的「重试」按钮。判断「重试是否真的有效」必须看网络请求，不能只看界面有没有变化 |
| P-55 | **判定「页面渲染成功」别用宽泛选择器** | 2026-09-26 P01 浏览器实测：业务页根容器是 `div.wb-page.wb-xxx-page`，用 `.wb-content section/h2` 判会假失败；而用太宽的 `.wb-content > *` 会把**加载态和错误兜底页**也算成成功 | 每个页面用源码里真实的根类名做探针，并显式排除 `.settings-state`（加载态）与错误卡片 |
| P-56 | **页面只读写入缺「我还算不算当前请求」的判断 ⇒ 晚到的旧响应覆盖新结果** | 2026-09-26 P02 浏览器实测（库存页）：`fetchInventory().then(setState)` 谁的响应最后到谁说了算。把「华硕 B760M」的明细请求按住不放、先展开「影驰 4060 Ti」，界面正确；再放行旧响应，**影驰行下面变成华硕的入库批次与件数**（`C54F214265 / 本批入库 3 件`，而该行自己的数是 2 件）。同一根因还让连点筛选白读一次列表 | 每个只读写入都配一个**页面级代次**：发起时取号、响应回来先比对、不是最新就整条丢弃（列表/展开明细/详情各用一个代次，互不牵连，刷新列表不该作废正在读的明细）。收起/换行时把对应代次推进一格。**新增任何只读入口都要取号**，否则缺口会重新打开。验证方法：用 CDP `Fetch` 域按住旧请求，放行后看界面认了谁的数据（`inventory-request-probe.mjs` 场景 6） |
| P-57 | **`rm -rf <目录>` 在本机 Git Bash 下会静默挂住，不报错** | 2026-09-26 P02：`mv … && rm -rf .validation-…/dist-after-p02 && npm run build` 卡了 3 分 24 秒无任何输出，整条链被拖死（P-53 记的是构建时 ETIMEDOUT 报错，这次是**挂起**，表现不同） | 别把 `rm -rf` 放在长命令链中间；要清构建快照就**改名挪走**，或单独一条命令执行并留意是否卡住。已卡住时用后台任务列表终止，不要干等 |
| P-58 | **`wmic` 在 Windows 11 已不可用；`tasklist` 的内存字段不能按逗号切** | 2026-09-26 P05：`wmic process … /format:csv` 直接 `command not found`（该工具已被微软移除）。`tasklist /FO CSV` 能跑，但内存字段是 `"117,648 K"`（含千分位逗号且被引号包住），`awk -F,` 会把它切成两段 | 查进程内存别用 wmic。要么 PowerShell `Get-CimInstance Win32_Process`（**带 `ParentProcessId`**，能定位 dev-server spawn 的 `workerd.exe` 子进程），要么 `Get-Process -Id … | Select WorkingSet64`。要采「负载峰值」就在 PowerShell 里写 `for` 循环 + `Start-Sleep` 落盘 CSV，并与负载命令**并行发**（单条命令会阻塞十几秒） |
| P-59 | **重启 `dev:local` 后立刻发请求会 `ECONNREFUSED`** | 2026-09-26 P05：杀进程后 `sleep 4` 再跑探针，报 `connect ECONNREFUSED 127.0.0.1:8787`；后台日志其实还在启动阶段——`dev-server.mjs` 要用**真实 HTTP 路由**播种演示数据（B12/B13），约需 5～6 秒 | 重启后**看日志出现「本地预览后端已启动」再发请求**，或探针里加登录重试；别用固定 `sleep 3` 赌它 |
| P-60 | **响应体里没有某个字段 ≠ 服务端没生效（误把「没给 `reused`」判成幂等失效）** | 2026-09-26 P05 幂等探针第一版：断言 `data.reused === true`，B12/B13（商品创建、期初入库）**响应体根本没有 `reused` 字段**（只有附件 B35 有），于是 3 项报「失败」；可实际库存重放后是 **3 件而不是 6 件**，幂等是好的。另外「换 requestId 再做第二次期初」返回 400，也不是幂等失效，而是业务规则「**期初只能建一次，补货走采购、差异走盘点**」 | 判幂等要看**副作用**：同一实体 id + 该实体只落一行 / 数量只加一次。**先核响应真有什么字段，再写断言**；看到「失败」先分清是「断言写错」还是「产品缺陷」。顺带记住：B12/B13 不返回 `reused`，客户端拿不到「本次是否重放」的显式信号（附件 B35 有）——这是接口表现不一致，不是缺陷 |
| P-61 | **`node --test` 的汇总行只在进程退出时输出** | 2026-09-26 P05：跑到一半 `grep '^# (tests\|pass\|fail)'` 一无所获，差点误判「没跑完/没有汇总」；实际是 TAP 汇总（`# tests 393` / `# pass 393`）在结束时才落盘 | 判断长测试是否跑完，看**最后一行用例 + 进程是否退出**（或直接等后台任务完成通知），别只 grep 汇总行 |

| P-62 | **本地 workerd 的每次 D1 往返有固定地板（18～77ms），会把要测的 SQL 差异盖住** | 2026-09-26 P03：同一条语句在前一轮跑 30ms、后一轮 76ms，只因机器上还有别的会话在占 CPU；直接拿「改前 220ms → 改后 401ms」相减，会得出「越改越慢」的假结论 | ①要结论就在**同一时刻做 A/B**（本轮索引实验是同一次运行内只差一条索引，最硬）；②用 9 次 `SELECT 1` 的**最小值**当地板，报「扣地板后的纯 SQL 估计」；③看 `EXPLAIN QUERY PLAN` 的访问路径有没有变。**本机绝对耗时只在同一进程、同一时刻可比，跨轮不可相减** |
| P-63 | **`stock_reservations` 没有 `line_ref` 索引，「每一行占了多少」就退化成全店范围扫描** | 2026-09-26 P03：谓词 `line_ref=? AND status='active' AND quantity_bucket_ref IS NOT NULL`，既有索引只有 `(store_id, order_ref)` 与 `(store_id, quantity_bucket_ref, created_at)`，计划退化成 `SEARCH r USING INDEX idx_stock_reservations_bucket (store_id=? AND quantity_bucket_ref>?)` —— **每查一行就扫一遍全店占用**，复杂度是「行数 × 店内占用行数」。400 单/约 1.5k 行的店里，这段子查询的纯 SQL 从约 60ms 压到约 4ms（加 `0031` 的局部索引后） | join 子查询里看到「前缀等值 + 另一列范围」的计划（`store_id=? AND xxx>?`），先怀疑缺的是**连接列**索引而不是过滤列索引。顺带记住：miniflare 的 D1 **可以**直接 `prepare('EXPLAIN QUERY PLAN ' + sql).all()` 看计划，但 `sqlite_version()` 会被 D1 拒绝（未授权函数） |
| P-64 | **基准脚本里的破坏性实验（建/删索引）不在下次测量前恢复，就会把「有索引」测成「无索引」** | 2026-09-26 P03 实测：索引实验为了对比会 `DROP` 掉真实迁移里的同名索引，实验结尾漏了恢复；之后每个场景的「改动后」测量都落在无索引状态，得出「统计修正让工作台从 220ms 变 462ms」的假结论（真因是统计语句本身在无索引下要 200ms） | 测量前后都恢复（`CREATE INDEX IF NOT EXISTS …`），并在结果 JSON 里记下「本次测量时这条索引是否存在」，便于复核。破坏性实验要么放最后，要么包在恢复里 |
| P-65 | **追加迁移会让 `f1-attachments.test.mjs` 里硬编码的 `migrations.length === 31` 断言失败（`32 !== 31`）** | 2026-09-26 P03：新增 `0031` 后后端全量套件 398 用例里恰好失败这 1 条，报错只有 `32 !== 31`，不看断言位置会以为是附件逻辑坏了 | 每次追加迁移同步改这个数字（其余测试用的是 `>= N`，只有这一条是精确值）。它拦的是「迁移被漏掉/删掉」，不是可以随手改的噪音 |
| P-66 | **测试脚本里「分批提交」必须同步取出待提交区，否则重叠的 flush 会重复提交同一批** | 2026-09-26 P03：`const flush = async () => { if (!pending.length) return; await db.batch(pending); pending = [] }` —— `pending = []` 在 `await` 之后，两次 flush 抢到同一批语句，报 `UNIQUE constraint failed: stock_items.store_id, stock_items.asset_code`，看着像「数据造重了」，其实是「提交重了」 | 先同步取出再提交：`const batch = pending; pending = []; chain = chain.then(() => db.batch(batch))` |
| P-67 | **核对「按 `created_at` 取前 N 条」的口径时，合成数据的 `created_at` 必须唯一** | 2026-09-26 P03：造样本时用「120 天循环」导致大量时间戳撞车，截断窗口里到底留下哪 200 条由 SQLite 的隐含顺序决定，JS 侧复现不出来 —— 独立预期与实现「差 5 条」，其实是核对方法不可复现 | 让每单的 `created_at` 互不相同（每单差 1 小时，或加自增序号列），顺序才是确定的；否则「差几条」的结论不可信 |
| P-68 | **复跑探针时，判据本身会过期（硬编码了「当天生成」的数据）** | 2026-09-26 P06：`inventory-request-probe.mjs` 场景 6 把演示数据的批次码硬编码成 `BT-0001-20260926-EFD70860E9`，而批次码形如 `BT-0001-<生成当天日期>-<哈希>`，跨零点整串就变（09-27 实测变成 `BT-0001-20260927-F5C83A6D86`）⇒ 「界面显示的是不是这个型号的批次」被判成「否」。**同一份界面在修正前后文本完全相同，变的只是判据** | 期望值运行时向后端读，别硬编码「当天生成」的数据；读不到就退回常量**并在输出里标注「结论不可信」**，不要静默给出「否」。看到「以前正常、复跑突然判否」的现象，先怀疑判据过期，再怀疑代码回归。同理适用任何带日期/随机段的业务编号（单号、批次号、内部编号） |
| P-69 | **`npm run build` 会失败在 Vite 清空 `dist`：本机 safe-delete 垫片 `ETIMEDOUT`** | 2026-09-26 P06：`vite:prepare-out-dir` → `emptyDir` → `fs.rmSync` 被垫片接管 → 尝试送回收站时 `spawnSync …genie-trash\win32-x64.exe ETIMEDOUT`。`tsc -b` 此时**已通过**，看着像构建坏了，其实与代码无关 | 把旧 `dist` **改名挪出仓库**再构建（Vite 看不到 outDir 就不需要清空），别用 `rm -rf` 清 `dist` —— 本机 `rm -rf <目录>` 另有静默挂住的毛病。见用户级记忆里的同类记录 |

> 注：P-02（契约 JSON 禁整体 `JSON.stringify` 重写）同样适用于任何手工排版的 JSON 契约文件。

---
