// 任务目录唯一源；执行 node build.mjs 生成 Markdown 分卡、总表与离线选择器。
export const tasks = [];
const add = (title, phase, deps, gate, level, files, steps, accept) => {
  const id = `MP${String(tasks.length).padStart(2, '0')}`;
  tasks.push({id,title,phase,deps:deps.map(n=>`MP${String(n).padStart(2,'0')}`),gate,level,files,steps,accept});
};
const low='轻量 AI';
const review='实现后重点复核';
const env='需外部环境证据';

add('锁定四屏测量表与当前源码基线','一：按图做出四屏',[], 'D',review,
 ['docs/verification/customer-4tab/MP00/**'],
 ['只读核对四页、全局 WXSS、app.json、检查脚本；记录已有未提交改动和旧页面依赖。','实际查看两张原图，按清爽版确定四个内容边界与关键对齐坐标，按细字版确定字号/字重；输出 visual-baseline.json，保存文件哈希。','写清微信系统区域遮罩、我的页胶囊冲突、375 基准和各元素归一化比例；列出共享组件 props/事件建议。'],
 ['参考坐标、比例、文案、字号记录能被下一卡直接使用；无法精测的数据明确为估计。','没有改生产文件、没有重复发明新的设计方案。']);
add('建立素材清单并准备可用素材','一：按图做出四屏',[0],'D',review,
 ['miniprogram/assets/customer/**','docs/design/2026-09-22-customer-ip/assets-manifest.json','docs/verification/customer-4tab/MP01/**'],
 ['按视觉规范的素材 ID 建 manifest：路径、来源、尺寸、用途、裁切焦点、授权核实状态、ready/missing/preview_only。','复用可核对的原始资产；无独立高清图时标缺失，不用旧绿系素材或无关商品图替换。','保留全部原图；只有符合工具能力且不会改设计时准备素材，生成/编辑位图用可用 imagegen 工作流；不生成新风格。'],
 ['所有可见图片/字标/猫/图标都有清单条目；检查重复文字和透明边缘。','清单完备可以交付本卡，素材仍 missing 时写明 MP15 不可放行；不得称高清还原完成。']);
add('实现顾客专用颜色与字体令牌','一：按图做出四屏',[0],'M',low,
 ['miniprogram/styles/customer-tokens.wxss','miniprogram/app.wxss','miniprogram/pages/{home,shop,community,mine}/index.wxss'],
 ['仅把 MP00 测量值转成顾客专用变量和作用域；引入字体、黑灰色、细线、米色档案卡、小圆角。','沿用页面现有路径，为四页提供统一可引用基类；旧员工样式暂隔离保留。','避免默认粗体、绿色强调和全局巨幅改字号；金额用清晰等宽数字，保留真实文本。'],
 ['四页新样式变量可被使用，旧功能不因变量删除而损坏。','记录 iOS/Android 字体回退待验收，不把 typecheck 当字体已还原。']);
add('固定视觉样本与页面视图类型','一：按图做出四屏',[0],'M',low,
 ['miniprogram/features/customer/fixtures.ts','miniprogram/typings/customer-view.ts','miniprogram/tsconfig.json'],
 ['创建独立顾客视觉样本：画板同款商品、价格、顺序、日期、昵称及 0/3/1/0 计数，全部明确为虚构。','视图类型只描述展示，不当作正式 API 契约；提供 loading/empty/error 等明确样本状态。','tsconfig 纳入未来组件、store、services、typings、custom-tab-bar 目录；保留原有严格检查。'],
 ['没有把样本塞进 contracts/v1；价格为整数分，未知值和 0 区分。','样本入口明确演示，后续真实模式不允许默认回落样本。']);
add('顶部导航与安全区组件','一：按图做出四屏',[0,2,3],'M',review,
 ['miniprogram/components/customer-nav/**','miniprogram/features/customer/layout.ts','miniprogram/pages/{home,shop,community,mine}/index.json','miniprogram/scripts/check-classes.mjs'],
 ['按当前官方 API 与真机返回读取顶部安全区及胶囊边界，异常值提供可解释回退。','组件提供标题/门店行/返回/辅助动作插槽，内部区域避开微信胶囊，不绘制假的状态栏和胶囊。','为我的页二维码/设置留最小避让区域，记录与概念稿差异；检查脚本兼容组件样式作用域及本地 WXSS import，不以忽略类名逃避校验。'],
 ['两种顶部布局与长门店名不压胶囊，返回按钮有触控区。','新增组件被类型和样式检查覆盖；实际开发者工具证据与未做真机项分开。']);
add('四 Tab 底栏与页面导航','一：按图做出四屏',[1,2,3,4],'M',low,
 ['miniprogram/custom-tab-bar/**','miniprogram/app.json','miniprogram/features/customer/routes.ts','miniprogram/pages/{home,shop,community,mine}/index.ts','miniprogram/scripts/check-pages.mjs'],
 ['底栏固定首页/商城/社区/我的；图标在上、字在下，黑色选中、灰色未选中。','实现选中态同步与安全区；Tab 用 switchTab，详情用 navigateTo，恢复商城分类用状态参数而非伪 Tab 路由。','旧员工页本卡暂不删除；路由表禁止新顾客入口进入它们。'],
 ['四 Tab 循环切换、从详情返回、重复点当前 Tab 均正确，无双底栏。','底部内容不被遮挡，选中态在 onShow 恢复，顺序与检查脚本一致。']);
add('图片失败与公共状态组件','一：按图做出四屏',[2,3],'M',low,
 ['miniprogram/components/customer-image/**','miniprogram/components/customer-state/**','miniprogram/scripts/check-classes.mjs'],
 ['图片组件固定宽高比与裁切焦点，加载/失败不让布局塌陷，提供替代说明。','状态组件实现加载、空、断网/失败、无权/过期的标题、说明与真实重试事件。','视觉阶段通过组件样例检查，不额外改四屏布局、不滥加弹窗。'],
 ['坏图与长错误文本不溢出；重试事件只触发一次，空态不伪装错误。']);
add('首页品牌与主视觉区域','一：按图做出四屏',[1,2,3,4,5,6],'M',low,
 ['miniprogram/pages/home/index.*'],
 ['实现门店栏、手写品牌、副句、双猫、白主机桌面主视觉，位置与比例按 MP00。','照片与字/猫分层时避免重复印字；只处理首页上部，不顺手做下方业务。'],
 ['提交首页上部 375/390 截图与参考并排；缺资产则明确 provisional。','副句一次、主机与显示器裁切一致，不能换成四个大业务卡。']);
add('首页四入口与底部横幅','一：按图做出四屏',[7],'M',low,
 ['miniprogram/pages/home/index.*'],
 ['实现同一行四个线性图标及文字、分割线、横幅与右箭头；保持原稿首屏节奏。','尚未存在的详情页点击诚实提示待接入，已有门店页面按路由表跳转；不伪造预约成功。'],
 ['四入口可触控，320 无横向溢出；横幅不被底栏遮挡。','提交完整首页对照图，预留后续表单路由位置，不加新模块。']);
add('商城分类与主推横幅','一：按图做出四屏',[1,2,3,4,5,6],'M',low,
 ['miniprogram/pages/shop/index.*'],
 ['标题下固定整机/配件/我的报价，默认整机，细底线选中。','还原主推图、文案、黑色选配置按钮与银猫；Tab 切换保存状态。','报价暂无真实接口时显示登录/待接入状态，不显示他人数据。'],
 ['375/390 分类与横幅位置对照；文字不与图内文字重复。','切回商城保持所选分类，不直接跳旧销售页。']);
add('商城两列推荐商品','一：按图做出四屏',[9],'M',low,
 ['miniprogram/pages/shop/index.*'],
 ['还原热门推荐下两列四商品、图/标题/规格/价格/小黑按钮的比例。','混合推荐保持效果图，配件分类筛选另用固定样本；选配置与查看详情事件区分。','长标题、未知价格、下架/缺图状态保留卡片宽度。'],
 ['四张商品与参考图片位置一致，长价格不挤按钮；两列不变单列。','点击商品事件携带公开商品 ID，不携带库存 SN。']);
add('社区分类与第一条案例','一：按图做出四屏',[1,2,3,4,5,6],'M',low,
 ['miniprogram/pages/community/index.*'],
 ['固定装机案例/电脑知识/门店公告；去掉旧消息/回复区。','还原第一张桌面大图、角落金猫、标题摘要日期与箭头。'],
 ['375/390 第一条图文高度与稿对照，分类可切换且保持选中。','不加发帖、评论、点赞等新功能。']);
add('社区第二条与知识图文行','一：按图做出四屏',[11],'M',low,
 ['miniprogram/pages/community/index.*'],
 ['第二条保留较矮的大横图，第三条用左图右文，补细线分隔。','文章点击保留 ID，详情未落地时如实说明；空分类与坏图使用公共状态。'],
 ['三种内容节奏均与参考相符，不能全部套同一个大卡模板。','长摘要与日期不压箭头，返回列表位置可恢复。']);
add('我的头像与装机档案卡','一：按图做出四屏',[1,2,3,4,5,6],'M',low,
 ['miniprogram/pages/mine/index.*'],
 ['还原标题辅助图标、灰猫头像、昵称、米色档案卡、猫与文件夹位置。','区分视觉样本登录态和真实未登录态；档案卡不是付费会员入口。'],
 ['375/390 上半屏对照；设置/二维码避让胶囊的偏差有记录。','头像授权未接通不宣称已登录。']);
add('我的统计与记录菜单','一：按图做出四屏',[13],'M',low,
 ['miniprogram/pages/mine/index.*'],
 ['还原报价/订单/预约/回收数字行、四条记录菜单、联系门店、页脚手写短句与金猫。','所有点击都映射到语义明确的目标；未实现目标显示待接入，不能静默无响应。'],
 ['完整我的页与参考结构相同，留白/分割线/猫贴纸位置符合规范。','未登录不把未知数量显示 0，测试样本与真实状态分离。']);
add('第一轮四屏视觉放行','一：按图做出四屏',[8,10,12,14],'M',review,
 ['docs/verification/customer-4tab/MP15/**','miniprogram/pages/{home,shop,community,mine}/index.wxss'],
 ['以固定样本生成四 Tab 的 375/390/430 对照、叠加和偏差表，320 查溢出。','逐项检查结构、照片、字体、裁切、留白与底栏；只修局部间距，公共组件问题返回其责任卡。','素材有 missing/preview_only、看不到截图或只是浏览器模拟，明确哪些门槛没过。'],
 ['业务区域关键对齐/比例/字号达到视觉规范阈值；人工已看四屏。','微信工具截图不齐不能把原生视觉标 verified；可继续独立环境卡。']);

add('隔离环境与演示开关','二：身份与公开内容',[3,5],'M',review,
 ['miniprogram/features/customer/environment.ts','miniprogram/services/customer/client.ts','miniprogram/app.ts','docs/verification/customer-4tab/MP16/**'],
 ['核对现有 HTTPS 请求限制、本地 Worker 入口与测试域名；环境清单不写密钥。','装配 demo/test/prod 配置和公共 API 客户端；真实模式缺配置立即失败，不能自动降级演示数据。','确认顾客与员工 token/草稿键隔离方案，保留既有请求核心。'],
 ['能证明目标环境不会误打生产；无可用 HTTPS 环境时明确微信实连阻塞。','断网真实模式不会出现虚构订单/付款成功。']);
add('顾客身份与归属契约','二：身份与公开内容',[16],'C',review,
 ['contracts/v1/**','backend/migrations/新增四位迁移.sql','docs/verification/customer-4tab/MP17/**'],
 ['读员工 identity/session 和客户模型，定义独立顾客主体、会话、客户关联、匿名公开范围。','冻结登录交换、会话失效、旧客户认领、拒绝授权返回原页的输入输出与错误语义。','定义不凭自填手机号认领的安全流程及测试样本；迁移仅追加，再生成同步两端。'],
 ['A/B 顾客、同店/跨店、员工混用的授权矩阵明确。','共享门禁全绿，契约不能把员工成员 ID 等同顾客 ID。']);
add('顾客登录服务端','二：身份与公开内容',[17],'B C',review,
 ['backend/src/domains/customer-identity.ts','backend/src/routes/customer-auth.ts','backend/src/index.ts 接线','backend/tests/customer-identity*.mjs'],
 ['按契约在服务端交换微信 code，创建独立顾客会话，旧客户认领只按已冻结流程。','凭证仅使用环境变量；限制重复 code/无效凭证，退出/撤权失效，不泄漏上游敏感响应。','复用会话基础但不颁发员工权限；接线只认领本前缀。'],
 ['伪造身份、员工 token、错误 AppID/跨店认领、过期会话均被拒绝。','本地上游替身测试与真实微信交换分别记录，不能互称通过。']);
add('小程序登录与返回原页','二：身份与公开内容',[18],'M',low,
 ['miniprogram/packages/customer/login/**','miniprogram/store/customer-session.ts','miniprogram/services/customer/auth.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['实现主动登录、拒绝授权仍可看公开页面、失败重试。','保存并恢复原报价/订单目标，按白名单路由恢复；切账号时清前一人的私人缓存。','接既有请求核心 AUTH_REQUIRED/SESSION_REVOKED 行为，不另写第二套重试。'],
 ['公开页不强制登录；登录取消、失效后登录、退出再进均可复现。','目标参数不能跳员工路由或任意外部地址。']);
add('公开商品与内容契约','二：身份与公开内容',[17],'C',review,
 ['contracts/v1/**','backend/migrations/新增四位迁移.sql','docs/verification/customer-4tab/MP20/**'],
 ['定义门店/横幅、公开商品/方案、文章的白名单 DTO、列表分页与草稿/发布/下架语义。','公开商品价、可售提示、新旧披露与内部 Product/StockItem 区分；照片标示意或实拍。','约定 ERP 写权限和读图规则，不把“公开”扩展到私人附件。'],
 ['表结构、读写路径、版本/发布规则与样本明确；生成物一致。','匿名响应字段集合不含成本/供应商/SN/内部备注。']);
add('公开内容存储与读写接口','二：身份与公开内容',[20],'B C',review,
 ['backend/src/domains/customer-content.ts','backend/src/routes/customer-content.ts','backend/src/index.ts 接线','backend/tests/customer-content*.mjs'],
 ['实现契约规定的门店、公开商品和文章读写；ERP 写接口必须验员工权限与同店。','匿名只读已发布白名单字段，分页稳定；下架、草稿、坏图片均有明确状态。','不复用库存原始 JSON 作商城响应；图片内容与上传归属检查不能省略。'],
 ['匿名可读已发布，猜草稿 ID/跨店写/私图地址被拒；分页无重复漏项。','真实隔离 HTTP 验证，接口缺失不能用常量假装落库。']);
add('ERP 门店与首页内容维护','二：身份与公开内容',[21],'W',low,
 ['frontend/src/features/customer-content/StoreContentPanel.*','frontend/src/features/customer-content/api.ts','frontend/src/components/SystemSettingsPage.tsx'],
 ['先定位实际设置页，再加小范围顾客展示面板，不重做 ERP 导航。','编辑门店信息、首页/商城横幅与跳转目标；预览/保存/发布明确区分，失败保留输入。'],
 ['ERP 保存发布后公开接口可读，草稿不覆盖已发布内容。','没有编造电话/营业时间，网页 test/build 串行通过并看图。']);
add('ERP 商品对外展示维护','二：身份与公开内容',[21,22],'W',low,
 ['frontend/src/features/customer-content/ProductPublicationPanel.*','frontend/src/features/customer-content/api.ts','frontend/src/components/ProductManagementPage.tsx'],
 ['在现有商品入口添加对外展示面板：标题、规格、公开价、图片、新旧/披露/质保、推荐排序与上下架。','不改变 G-20 全库商品页职责，不让顾客拿到编辑接口；公开价与成本分开。'],
 ['发布/下架立即体现在商城接口；取消编辑与保存失败不丢输入。','无同字段混写成本/售价，页面看图不破版。']);
add('ERP 案例知识公告发布','二：身份与公开内容',[21,22],'W',low,
 ['frontend/src/features/customer-content/ArticlePanel.*','frontend/src/features/customer-content/api.ts','frontend/src/components/SystemSettingsPage.tsx'],
 ['实现小型文章列表与编辑：类型、标题、摘要、正文、图片、日期、排序、草稿/发布。','采用受限内容结构与已授权图片，不允许任意脚本 HTML；编辑内容预览后发布。'],
 ['三类型在公开列表正确分流；下架详情不可继续公开读取。','无顾客发帖权限，输入失败可恢复。']);
add('四屏公开区域接真实内容','二：身份与公开内容',[15,16,21,23,24],'M',low,
 ['miniprogram/services/customer/content.ts','miniprogram/features/customer/content-view.ts','miniprogram/pages/{home,shop,community}/index.ts'],
 ['把首页、商城公开区、社区的数据源切为已冻结 API，保留原 WXML/WXSS 布局。','处理加载、刷新、分类分页、坏图、空内容与失败；真实模式不回落样本。'],
 ['ERP 发布修改后顾客可见；三类文章与商品筛选正常。','用真实接口数据验证后补固定样本截图，业务接入未改变四屏设计。']);
add('商品与整机方案详情','三：顾客详情与报价',[19,25],'M',low,
 ['miniprogram/packages/customer/product-detail/**','miniprogram/services/customer/content.ts','miniprogram/features/customer/routes.ts','miniprogram/pages/shop/index.ts','miniprogram/app.json'],
 ['一页呈现公开图/规格/售价/新旧披露/质保与门店说明，复用公共图像状态。','选配置仅选择公开方案并把方案 ID 带到装机意向；表单未完成前如实提示。','下架、失效 ID、面议与暂缺货单独显示。'],
 ['不展示成本/SN，不能自行改价/产生库存动作。','二级页标为风格延展页；返回商城分类/位置保留。']);
add('社区文章详情','三：顾客详情与报价',[25],'M',low,
 ['miniprogram/packages/customer/article-detail/**','miniprogram/features/customer/routes.ts','miniprogram/pages/community/index.ts','miniprogram/app.json'],
 ['按受限内容模型渲染标题、日期、图片与段落，图片加载保持比例。','处理下架、不存在、无网络，返回原分类与列表位置；不添加社交入口。'],
 ['恶意内容不能执行脚本/跳任意内部路径；长文不溢出。','文章图片与示意说明可读，页面看图。']);
add('门店详情与联系能力','三：顾客详情与报价',[25],'M',env,
 ['miniprogram/packages/customer/store/**','miniprogram/features/customer/contact.ts','miniprogram/features/customer/routes.ts','miniprogram/pages/{home,mine}/index.ts','miniprogram/app.json'],
 ['展示服务端真实门店资料，按当前平台能力接电话/地图/客服。','缺号码、缺地址或客服未配置时显示不可用原因和已验证替代方式，不用演示号码拨号。','不为导航默认申请不需要的持续定位权限。'],
 ['触发能力前核对目标；取消操作不报成功，失效信息有反馈。','开发工具替身、微信能力实测与真机结果分别记录。']);
add('专属报价与分享授权契约','三：顾客详情与报价',[17],'C',review,
 ['contracts/v1/**','backend/migrations/新增四位迁移.sql（确有需要才加）','docs/verification/customer-4tab/MP29/**'],
 ['复用已存在 quote_shares 签发与 B42，定义顾客分享消费/归属、报价列表详情与确认端点。','冻结当前版本、过期/撤回/已更新/无权、幂等重复确认语义；明确令牌转发不能认领别人报价。','报价匿名阶段只返回安全提示，不返回私人配置/联系人。'],
 ['顾客与员工调用边界明确；不重建一套金额或分享凭证机制。','契约负面样本覆盖猜 ID、转发、旧版本与跨店。']);
add('分享令牌校验与归属守卫','三：顾客详情与报价',[18,29],'B C',review,
 ['backend/src/domains/customer-quote-access.ts','backend/src/routes/customer-quotes.ts','backend/src/index.ts 接线','backend/tests/customer-quote-access*.mjs'],
 ['校验令牌摘要、有效期/撤回、报价版本和顾客归属；原始令牌不写日志。','按契约实现登录后返回与安全认领，不允许仅凭 customerId/手机号参数认领。','拒绝响应避免泄漏他人报价是否存在。'],
 ['A 的链接转给 B、同店/跨店、过期/撤回/猜 ID、重复访问均有测试。','只持有令牌不足以越权取详情；真实 HTTP 验证。']);
add('顾客报价列表与详情读模型','三：顾客详情与报价',[30],'B',review,
 ['backend/src/domains/customer-quotes.ts','backend/src/routes/customer-quotes.ts','backend/tests/customer-quotes*.mjs'],
 ['输出本人报价列表与指定快照详情，只 SELECT 顾客需要的字段。','金额明细/服务费/优惠/总价/有效期/质保/交付口径来自 ERP 快照。','未登录、空列表、新旧版、失效单据返回契约规定状态。'],
 ['对响应字段白名单做断言，没有成本/供应商/SN/内部备注/他人手机号。','金额核对整数分，分页和版本切换可复现。']);
add('顾客确认报价服务端','三：顾客详情与报价',[31],'B',review,
 ['backend/src/domains/customer-quotes.ts','backend/src/routes/customer-quotes.ts','backend/tests/customer-quote-confirm*.mjs'],
 ['通过顾客守卫调用 B42，来源 miniprogram 固定在服务端，不允许客户端冒充员工。','确认前重读版本与有效期，沿用 requestId 幂等；重复提交返回同一结果。','记录审计但不创建收款、预留或采购。'],
 ['版本变化/撤回/过期拒绝，双击/网络重试只有一次确认事件。','数据库断言确认前后收款和库存不变，ERP 可读确认事实。']);
add('我的报价列表','三：顾客详情与报价',[19,31],'M',low,
 ['miniprogram/packages/customer/quotes/**','miniprogram/services/customer/quotes.ts','miniprogram/pages/{shop,mine}/index.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['实现一个报价列表页，并让商城我的报价/我的报价单两个入口复用同一数据逻辑。','呈现未登录、无报价、多报价、有效/已更新/过期/撤回；进详情携带 ID 和版本。'],
 ['只见本人，刷新/分页/返回保留状态；未知状态不会显示可付款。','主商城三分类和首屏结构保持原稿。']);
add('顾客报价详情页面','三：顾客详情与报价',[33],'M',low,
 ['miniprogram/packages/customer/quote-detail/**','miniprogram/services/customer/quotes.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['呈现配置明细/来源/数量/单价/小计、费用优惠总价、交付/质保与有效期。','正确区分过期/撤回/版本变化/无权，提供查看当前版或联系门店；不允许编辑报价价格。'],
 ['长配置、最大金额、客供件、缺图和断网不破版。','回到列表状态正确；页面数据与服务端快照逐项一致。']);
add('报价确认与结果恢复','三：顾客详情与报价',[32,34],'M',review,
 ['miniprogram/packages/customer/quote-detail/**','miniprogram/services/customer/quotes.ts'],
 ['确认前明确当前版本，调用真实确认接口；连续点击禁重，未知结果走原请求核对。','确认成功后刷新真实状态；付款入口此时仅说明待接入，不把确认当下单/收款。'],
 ['超时后核对、重复确认、版本冲突、重新登录不丢目标均通过。','ERP 确认状态变化可核验，库存与收款无变化。']);

add('个人订单档案与服务读模型契约','四：订单与服务意向',[29],'C',review,
 ['contracts/v1/**','docs/verification/customer-4tab/MP36/**'],
 ['冻结顾客订单摘要/详情/时间线、售后/回收进度、四项计数和装机档案白名单 DTO。','把 ERP 状态映射成顾客可理解的说明，保留资金事实；不要从某个按钮推测进度。','档案仅已交付设备、售后变化与质保快照；回收估价不等于收购完成。'],
 ['状态映射覆盖取消/退款/未付/部分收款/待门店处理。','不含采购细节、SN、内部备注；未查到与空列表语义区分。']);
add('顾客订单读接口','四：订单与服务意向',[18,36],'B C',review,
 ['backend/src/domains/customer-orders.ts','backend/src/routes/customer-orders.ts','backend/src/index.ts 接线','backend/tests/customer-orders*.mjs'],
 ['本人范围读取订单列表/详情、配置快照、资金汇总与公开时间线。','复用销售/退款账口径，不在顾客端重新推导应收；给出可做动作但不颁发员工能力。'],
 ['跨顾客/跨店修改 ID 均拒绝，退款/取消/欠款显示与 ERP 一致。','服务端字段白名单测试及真实隔离 HTTP 通过。']);
add('我的订单列表','四：订单与服务意向',[19,37],'M',low,
 ['miniprogram/packages/customer/orders/**','miniprogram/services/customer/orders.ts','miniprogram/pages/mine/index.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['实现本人订单列表、状态筛选、空/失败/加载；计数来自服务端。','点击进详情，未知支付结果不在列表里直接写已付款。'],
 ['订单多页、状态变化、退出再进不串顾客数据；实际看图。']);
add('订单详情与进度时间线','四：订单与服务意向',[38],'M',low,
 ['miniprogram/packages/customer/order-detail/**','miniprogram/services/customer/orders.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['展示顾客时间线、配置摘要、真实已收/待付/待退、交付说明与客服。','正在备货/装机/检测/可交付等仅按后端公开状态，取消退款不画成正常完成。'],
 ['部分付款、缺货等待、取消/退款、长配置、无网络均有证据。','原员工 packages/sales/order-detail 不作为顾客详情复用。']);
add('三类服务意向契约','四：订单与服务意向',[17,36],'C',review,
 ['contracts/v1/**','backend/migrations/新增四位迁移.sql','docs/verification/customer-4tab/MP40/**'],
 ['冻结装机/回收/维修意向的公共身份、内容、附件引用、预约偏好、幂等与状态。','字段按类别分开：预算用途/设备披露/故障；时间是偏好，非保证预约档期。','定义店员处理与关联实单的同顾客同店守卫，不把意向提交直接映射 B04/B20/B26。'],
 ['最小必填、长度上限、草稿保存、重复提交、等待门店确认语义明确。','没有自动估价/自动采购/直接确认维修或回收付款副作用。']);
add('服务意向保存列表与处理接口','四：订单与服务意向',[18,40],'B C',review,
 ['backend/src/domains/customer-intents.ts','backend/src/routes/customer-intents.ts','backend/src/index.ts 接线','backend/tests/customer-intents*.mjs'],
 ['实现三类意向统一的创建/本人读取和受权员工处理接口，关联实际报价/服务/回收单时核归属。','沿用幂等层和分页；未知提交结果可查询，不自动执行任何库存/资金动作。'],
 ['重复提交只一条，跨顾客关联/篡改分类/越权处理被拒。','数据库断言提交仅写意向；ERP 能通过受权接口读取。']);
add('ERP 顾客意向待办与关联','四：订单与服务意向',[41],'W',low,
 ['frontend/src/features/customer-content/IntentInbox.*','frontend/src/features/customer-content/api.ts','frontend/src/components/SystemSettingsPage.tsx'],
 ['增加按类别/状态查看意向、打开详情、记录处理、关联已有实单的最小入口。','复用现有报价/维修/回收建单页面；关联前核对同顾客，不绕领域规则自动建单。'],
 ['一条意向能从 ERP 看见并关联，重复处理/接口失败有提示。','顾客能读取门店处理结果，内部备注不回传顾客。']);
add('顾客附件上传与读取契约','四：订单与服务意向',[40],'C',review,
 ['contracts/v1/**','backend/migrations/新增四位迁移.sql（确有需要才加）','docs/verification/customer-4tab/MP43/**'],
 ['复用 F1/B35 的字节校验流程，定义顾客权限、意向草稿关联、可传类型/大小/数量与私有读取。','区分公开商品图片和顾客故障照片；拒绝引用他人附件或通过 owner 参数越权。'],
 ['先上传后提交失败的孤立清理与重试语义明确。','限制参数在协议内可核验，不写未经核实的平台数值。']);
add('顾客附件服务端授权','四：订单与服务意向',[41,43],'B C',review,
 ['backend/src/domains/customer-attachments.ts','backend/src/routes/customer-attachments.ts','backend/src/index.ts 接线','backend/tests/customer-attachments*.mjs'],
 ['在既有存储适配器前加顾客归属与私有读守卫，复用服务端 sha256/mime/字节数核验。','实现上传意图、真实字节、完成关联与授权读取；实际对象存储不可用时禁止生产退回内存。'],
 ['A 无法读/关联 B 的照片；假 mime、超限、重复完成和孤立上传有测试。','内存替身与真实存储结果分开记录；未建桶不算生产可用。']);
add('顾客表单照片上传组件','四：订单与服务意向',[19,44],'M',low,
 ['miniprogram/components/customer-photo-picker/**','miniprogram/services/customer/attachments.ts'],
 ['实现选择/预览/移除、上传进度、失败重试；只把已完成附件 ID 提交给表单。','取消选图不报错，断网保持安全草稿，遵守协议数量/大小限制。'],
 ['坏图、重复选、上传超时、退出切用户不串图；真机能力待验收明确记录。']);
add('我要装机意向表单','四：订单与服务意向',[26,41,45],'M',low,
 ['miniprogram/packages/customer/build-request/**','miniprogram/services/customer/intents.ts','miniprogram/pages/home/index.ts','miniprogram/packages/customer/product-detail/index.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['预算、用途、偏好、交付偏好、联系方式；从商品详情进来预填公开方案 ID 和名称。','校验并保存草稿，真实提交后展示等待门店确认；不生成假报价、不保证兼容/价格。'],
 ['输入失败/返回/键盘均保留，双击只一条意向；ERP 收到同一数据。']);
add('回收置换意向表单','四：订单与服务意向',[41,45,46],'M',low,
 ['miniprogram/packages/customer/recovery-request/**','miniprogram/pages/home/index.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['设备型号、状况、故障、照片、到店偏好与联系人；复用提交客户端和照片组件。','提交后仅等待检测/门店联系，不在线自动估价或取得所有权。'],
 ['照片/文字重试不重复，失败输入保留；ERP 看见回收意向且库存未变化。']);
add('预约维修意向表单','四：订单与服务意向',[41,45,46],'M',low,
 ['miniprogram/packages/customer/repair-request/**','miniprogram/pages/home/index.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['设备、故障现象、照片、时间/到店偏好、联系方式；明确实际档期待门店确认。','故障与联系信息按最少必要采集；不预设固定维修价或宣称已接修。'],
 ['缺必填、长描述、选图取消、超时和重复提交均正确；ERP 意向可核对。']);
add('我的预约与意向记录','四：订单与服务意向',[46,47,48],'M',low,
 ['miniprogram/packages/customer/requests/**','miniprogram/services/customer/intents.ts','miniprogram/pages/mine/index.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['一页用列表/展开详情显示本人三类意向、待确认/处理结果和已关联单据入口。','只读已提交内容；不增加未定义撤单接口或直接把意向当正式订单。'],
 ['ERP 关联报价/维修/回收后顾客看到正确入口；别人 ID 不可读。']);
add('顾客售后与回收进度读接口','四：订单与服务意向',[18,36,41],'B C',review,
 ['backend/src/domains/customer-service.ts','backend/src/routes/customer-service.ts','backend/src/index.ts 接线','backend/tests/customer-service*.mjs'],
 ['给本人售后/回收列表详情投影公开诊断、对外方案/报价、进度和客户可见图片。','过滤内部诊断备注/备件成本/供应商/实物 SN；价格不等于收付款完成。'],
 ['跨顾客、跨店、私有图泄漏负测通过；拒绝/归还/已完成状态均正确。']);
add('售后进度页面','四：订单与服务意向',[49,50],'M',low,
 ['miniprogram/packages/customer/service-progress/**','miniprogram/services/customer/service.ts','miniprogram/pages/mine/index.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['同页提供本人售后列表与选中工单详情，显示公开方案、费用/收款和进度。','待顾客决定先联系门店；不擅自给顾客直接调用员工 B22 权限。'],
 ['未诊断/报价中/维修/待归还/已完成/无权均有状态；金额和 ERP 一致。']);
add('回收进度与折抵说明页面','四：订单与服务意向',[49,50],'M',low,
 ['miniprogram/packages/customer/recovery-progress/**','miniprogram/services/customer/service.ts','miniprogram/pages/mine/index.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['展示回收意向/实单、检测与估价、公开成交/付款/折抵结果，区分所有权和付款。','只读进度与联系门店，不自助确认收购或提现，沿用已冻结业务范围。'],
 ['估价拒绝归还、已收购未付款、部分折抵显示准确；无成本/SN 泄漏。']);
add('我的计数与装机档案读接口','四：订单与服务意向',[36,37,41,50],'B C',review,
 ['backend/src/domains/customer-profile.ts','backend/src/routes/customer-profile.ts','backend/src/index.ts 接线','backend/tests/customer-profile*.mjs'],
 ['一次公开口径返回本人报价/订单/预约/回收计数与档案摘要，计数定义与列表一致。','档案来自已交付配置与质保快照，售后变化可追溯；无数据返回空，不返回演示 0/3/1/0。'],
 ['四计数与列表对账，不因分页长度算错；他人档案与客户设备内部字段不泄漏。']);
add('我的真实聚合与装机档案页','四：订单与服务意向',[14,19,33,38,49,51,52,53],'M',low,
 ['miniprogram/pages/mine/index.ts','miniprogram/packages/customer/archive/**','miniprogram/services/customer/profile.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['保持原稿 WXML/WXSS，将昵称、四数字与所有记录入口接真实数据；无权/未登录单独显示。','档案二级页显示设备、配置、质保与订单/售后入口；切用户清前用户缓存。'],
 ['我的每个菜单均可达真实功能，返回恢复；真实数据和固定视觉样本都看图。']);
add('设置与门店公开二维码','四：订单与服务意向',[19,28,54],'M',env,
 ['miniprogram/packages/customer/settings/**','miniprogram/pages/mine/index.ts','miniprogram/features/customer/contact.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['设置提供授权/隐私说明、退出、联系门店申请资料处理，不虚构已删除账号。','二维码语义暂定门店公开入口：核实已有生成能力与合法路径后展示；无实际码时明确待配置。','绝不把 token、OpenID、用户资料编码成展示码；未配置状态不算最终功能完成。'],
 ['退出后私人页不可读；二维码实扫去正确公开页，不能只检验图片存在。']);

add('支付前置与交易契约','五：真实支付',[32,37],'C',review,
 ['contracts/v1/**','backend/migrations/新增四位迁移.sql','docs/verification/customer-4tab/MP56/**'],
 ['只核实主体/AppID/商户关联/测试环境/密钥配置是否就绪，不读取或输出秘密值。','冻结定金/全款应付、支付单状态、过期、回调/主动查询、对账、ERP 收款与重复入账保护。','明确支付前报价版本与归属、支付成功后库存冲突的待处理路径；退款展示复用 ERP，不自行加自动退款。'],
 ['当前官方文档与控制台前置留证；行政未就绪标阻塞而非假通过。','到账确认、会计入账、预留三者语义清楚，金额/权限复核后才实施。']);
add('预支付与服务端应付核验','五：真实支付',[35,39,56],'B C',review,
 ['backend/src/domains/customer-payments.ts','backend/src/routes/customer-payments.ts','backend/src/index.ts 接线','backend/tests/customer-prepay*.mjs'],
 ['服务端重读报价/订单/版本/归属/剩余应付，创建可幂等重试的支付单，返回仅供客户端拉起的必要字段。','客户端不可指定最终金额或商户收款人；配置缺失时真实失败，不降级假支付。'],
 ['错金额/版本/归属、重复下单、部分已付、支付单过期都有测试。','预支付不记到账、不预留、不触发采购。']);
add('支付通知核验与主动对账','五：真实支付',[57],'B',review,
 ['backend/src/domains/customer-payments.ts','backend/src/routes/customer-payments.ts','backend/tests/customer-payment-notify*.mjs'],
 ['按当前支付官方协议验签解密并核对商户/AppID/订单/金额/币种；仅服务端可信事实入账。','重复通知/乱序/主动查询统一幂等入账，沿用 ERP 收款业务闸门；入账后库存冲突保留收款进待处理。','实现结果未知查询与差错记录，不让客户端 success 直接改成 paid。'],
 ['伪通知、重复通知、金额不符、超时后成功、重复查询只入账一次。','本地替身/受控支付平台测试/真实到账分别列证据；无真实授权不发起交易。']);
add('付款确认与结果页','五：真实支付',[35,39,58],'M',review,
 ['miniprogram/packages/customer/payment/**','miniprogram/services/customer/payments.ts','miniprogram/packages/customer/{quote-detail,order-detail}/index.ts','miniprogram/features/customer/routes.ts','miniprogram/app.json'],
 ['展示服务端定金/全款与订单信息，拉起平台支付后回查服务端结果。','区分用户取消、失败、处理中、已到账、需门店处理；未知结果保持查询入口。','未接通时明确提示，不显示付款成功动画或虚构余额。'],
 ['客户端回调成功但后端待确认时不能显示到账；重复点击、重启/返回核对同支付单。','支付链路完整证据不足时保持 review/blocked。']);

add('演示资源与旧员工路由发布隔离','六：整体验收',[25,54,55,59],'M',review,
 ['miniprogram/app.json','miniprogram/project.config.json 打包范围','miniprogram/scripts/check-pages.mjs','miniprogram/features/customer/environment.ts','docs/verification/customer-4tab/MP60/**'],
 ['复核旧 today/sales/inventory/more 与员工分包依赖，退出顾客注册和发布包；源文件保留或按已核实迁移方案归档，不删除用户数据。','检查页面脚本能区分明确退役源码与意外漏注册；不能一概忽略 packages。','正式构建排除虚构样本、调试入口、备用 token 与无用大图；核对资源包预算与真实图片域名。'],
 ['顾客不能通过深链进入员工页，正式包无演示数据/调试模式。','包体以当前微信工具扫描为证，未经查依赖不能凭旧/大删除文件。']);
add('微信开发工具全屏视觉回归','六：整体验收',[60],'M',review,
 ['docs/verification/customer-4tab/MP61/**','miniprogram/pages/{home,shop,community,mine}/index.wxss','miniprogram/packages/customer/*/index.wxss'],
 ['固定参考样本复跑四屏 375/390/430 和 320 溢出；再看真实测试数据的长文本/金额/图片失败。','保存并排/叠加/偏差表，所有二级页看加载/空/错/正常状态；只修有定位证据的样式。'],
 ['MP15 阈值保持，新增业务没有挤坏原四屏；胶囊/安全区差异有记录。','不能用浏览器截图替代本卡微信工具截图。']);
add('安全与 ERP 顾客全链路验收','六：整体验收',[42,49,51,52,54,58,59,60],'B M',review,
 ['docs/verification/customer-4tab/MP62/**','backend/tests/customer-e2e*.mjs'],
 ['用隔离双顾客数据跑发布内容、发报价/查看/确认、付款/订单进度、意向/ERP 关联/售后回收更新闭环。','覆盖篡改 ID、分享转发/撤回、私图、金额错/重复通知、断网未知结果、退出切账号。','检查 API 真响应白名单、DB 库存资金副作用与幂等，不只看页面文案。'],
 ['每条链路有步骤、实际接口与断言、截图、未验证范围；缺一链不得总验收通过。','发现业务问题回责任卡修复后定向复验，不在本卡顺手重写领域。']);
add('iOS 与 Android 真机验收','六：整体验收',[61,62],'M',env,
 ['docs/verification/customer-4tab/MP63/**'],
 ['实际两类设备记录机型/系统/微信版本/基础库，查看四屏及主要二级流程。','测安全区/中文字体/大字模式/键盘/图片/上传/返回/网络切换/登录支付回查；不清顾客缓存掩盖问题。','收集照片或录屏，缺设备明确 not_run；真实支付需既有明确授权与受控条件。'],
 ['四屏视觉与关键流程两平台有实证，微信工具通过不替代真机。','任何阻断错误或未验证平台均保持未完成。']);
add('发布候选清单与最终交接','六：整体验收',[63],'D',review,
 ['docs/verification/customer-4tab/MP64/**','docs/STATUS.md 顾客专项段','docs/NEXT-SESSION-PROMPT.md 顾客专项段','miniprogram/README.md'],
 ['逐卡核对证据及变更失效情况，汇总四屏还原/业务/真机/支付/素材/域名前置与剩余阻塞。','核实当前平台隐私、类目、主体、包体和审核材料；旧文档政策不当现行凭据。','准备具体版本、环境、回退与发布步骤；只形成可审查候选，不自动提交代码/上传发布/远端迁移。'],
 ['最终结果入口、全部实际检查、未验证范围、当前断点和下一动作清楚。','只有各层验收都通过才称完整成品；待支付/缺图/缺真机不能改口成已完成。']);
