/**
 * 权限码与旧码兼容判定（E05）。
 *
 * ── 为什么单独成文件 ──
 * `contracts/tools/validate-contracts.mjs` 第 10.6 节会把 `backend/src/index.ts` 里所有
 * `'xx/yy'` 形态的字符串字面量当成**旧**权限码，要求它们全部出现在 actions.json 的
 * legacyPermissionMap 里。新契约权限码（`sales/*`）一旦写进入口，契约校验立刻变红 ——
 * 这正是 E04b 把库存链路拆成 `routes/inventory-v2.ts` 的同一个原因。
 * 所以入口只引用本模块导出的常量与判定函数，字面量留在这里。
 *
 * ── 兼容规则（依 actions.json permissionModel.codes 的 legacySource） ──
 *   新码                    旧码（门店现有角色行里存的就是这些）
 *   sales/quote-view    ←   quote/view, template/view
 *   sales/quote-edit    ←   quote/edit, template/view, template/edit
 *   sales/quote-convert ←   quote/edit
 *   sales/order-view    ←   quote/view
 *   sales/order-edit    ←   quote/edit
 *
 * ── 为什么要兼容旧码 ──
 * 门店角色行里存的是旧码。只认新码会让**所有店员立刻失去报价与客户权限** ——
 * 那是把权限收紧到不可用，不是安全加固。契约 legacyPermissionMap 已经声明了这层映射
 * （mapsTo / legacySource），本模块只是把它执行出来。
 *
 * ── 例外 ──
 * owner_only 的新码（如 `inventory/opening`）不得由旧宽权限自动获得，
 * 见 legacyPermissionMap.noWideningGuard（03 §8）。本模块不为它们提供旧码等价物。
 */

/** 报价单权限码（actions.json permissionModel.codes）。 */
export const QUOTE_PERMISSIONS = {
  view: 'sales/quote-view',
  edit: 'sales/quote-edit',
  convert: 'sales/quote-convert',
} as const

/**
 * 客户主数据权限码（E05 D-C 裁定）。
 *
 * 契约里客户与设备资料归 `sales/order-view` / `sales/order-edit`
 * （codes 的 desc 写明「查看销售单、客户与设备资料」）。
 * E04 曾临时复用 `quote/view` / `quote/edit`，本轮收口到正牌码，并保留旧码兼容。
 */
export const CUSTOMER_PERMISSIONS = {
  view: 'sales/order-view',
  edit: 'sales/order-edit',
} as const

/** 客户读接口接受的权限码：正牌码在前，旧码兜底。顺序不影响判定，只影响可读性。 */
export const CUSTOMER_READ_CODES: readonly string[] = [CUSTOMER_PERMISSIONS.view, 'quote/view']
export const CUSTOMER_WRITE_CODES: readonly string[] = [CUSTOMER_PERMISSIONS.edit, 'quote/edit']

/**
 * 销售单与收款权限码（E06）。
 *
 * 契约 actions.json permissionModel.codes 给出的 legacySource：
 *   sales/order-view    ← quote/view          （desc：查看销售单、客户与设备资料）
 *   sales/order-edit    ← quote/edit          （新建、确认、补分配、取消）
 *   sales/order-payment ← quote/edit          （登记销售收款，grantPolicy=explicit）
 *   sales/order-deliver ← quote/edit          （确认实物交付，grantPolicy=explicit）
 *   sales/quote-convert ← quote/edit          （报价转销售单，复用 QUOTE_PERMISSIONS.convert）
 *
 * ⚠️ grantPolicy=explicit 表示「默认角色不授予、须老板单独勾选」。它管的是**新装配角色**时
 * 的默认值（T03 的职责），不是「旧码不能等价」。门店现有角色行里存的仍是旧码，
 * 若本层不认 quote/edit，所有店员会立刻失去收款与交付能力 —— 那是把权限收紧到不可用。
 */
export const SALE_PERMISSIONS = {
  orderView: 'sales/order-view',
  orderEdit: 'sales/order-edit',
  orderPayment: 'sales/order-payment',
  orderAssembly: 'sales/order-assembly',
  orderDeliver: 'sales/order-deliver',
  returnCreate: 'sales/return-create',
  refund: 'sales/refund',
  creditApproval: 'sales/order-credit-approval',
} as const

/**
 * 采购与到货权限码（E07）。
 *
 *   inventory/purchase-create  ← library/edit  （创建采购与到货计划）
 *   inventory/receipt          ← library/edit  （登记实际到货与入库，grantPolicy=explicit）
 *   inventory/purchase-cancel ← library/edit  （B37 取消采购未到部分）
 *   inventory/supplier-return  ← library/edit  （B38 退供）
 */
export const PURCHASE_PERMISSIONS = {
  create: 'inventory/purchase-create',
  receipt: 'inventory/receipt',
  cancel: 'inventory/purchase-cancel',
  supplierReturn: 'inventory/supplier-return',
} as const

/**
 * 账本权限码（E09）。
 *
 *   finance/view        ← quote/view（查看应收应付汇总与流水，default）
 *   finance/ledger-view ← null（完整账本与对账，owner_only，本刀不实现）
 *   finance/reverse     ← null（受控反冲账务分录，owner_only）
 *
 * ⚠️ finance/reverse 与 finance/ledger-view 是 owner_only，旧 quote/view / quote/edit
 * 均不得自动获得（permissionModel.noWideningGuard）。
 */
export const FINANCE_PERMISSIONS = {
  view: 'finance/view',
  ledgerView: 'finance/ledger-view',
  reverse: 'finance/reverse',
  // B33 对外付款：契约 grantPolicy=owner_only、legacySource=null（03 §8 老板专属），
  // 不登记任何旧码等价（否则 quote/edit 会自动拿到付款权，违反 noWideningGuard）。
  payment: 'finance/payment',
} as const

/**
 * 售后维修权限码（E10）。
 *
 *   service/view   ← quote/view（查看维修工单、方案与费用，default）
 *   service/edit   ← quote/edit（接修、检测、方案、换件、外送与归还，default）
 *   service/charge ← quote/edit（登记售后收费，grantPolicy=explicit，与 sales/order-payment 同套路）
 */
export const SERVICE_PERMISSIONS = {
  view: 'service/view',
  edit: 'service/edit',
  charge: 'service/charge',
} as const

/**
 * 回收权限码（E10）。
 *
 *   recovery/view    ← quote/view（查看回收单、检测与估价，default）
 *   recovery/edit    ← quote/edit（回收登记、验机、估价与归还，default）
 *   recovery/acquire ← null（确认最终价并取得所有权，owner_only，旧码不得自动获得）
 */
export const RECOVERY_PERMISSIONS = {
  view: 'recovery/view',
  edit: 'recovery/edit',
  acquire: 'recovery/acquire',
} as const

/**
 * 抵用额度（置换折抵）权限码（E12）。
 *
 *   tradein/view    ← quote/view（查看置换单据与有效折抵，default）
 *   tradein/create  ← quote/edit（建立置换关联，default）
 *   tradein/offset  ← null（确认并应用折抵，owner_only，03 §8「确认折抵」老板专属）
 *   tradein/reverse ← null（撤销折抵，owner_only，03 §8「退款冲销」老板专属）
 *
 * ⚠️ tradein/offset 与 tradein/reverse 是 owner_only，旧 quote/view / quote/edit
 * 均不得自动获得（permissionModel.noWideningGuard）。
 */
export const TRADEIN_PERMISSIONS = {
  view: 'tradein/view',
  create: 'tradein/create',
  offset: 'tradein/offset',
  reverse: 'tradein/reverse',
} as const

/**
 * 附件权限码（F1）。
 *
 *   attachment/upload ← library/edit（上传业务附件与照片，grantPolicy=default）
 *
 * ⚠️ 契约 permissionModel.codes 目前只有 attachment/upload 一个附件权限码，
 * 没有 attachment/view —— 附件的读取走业务详情（R09 / R10 之类），不另起读权限。
 * 因此这里不预留一个永远不会被守卫的 view 码。
 *
 * ⚠️ legacySource = library/edit 是**必须**登记的：门店现有角色行里存的就是
 * library/edit。不登记的话，所有店员会立刻失去上传照片的能力 —— 那是把权限
 * 收紧到不可用，不是安全加固（与 E07 采购链路同一理由）。
 */
export const ATTACHMENT_PERMISSIONS = {
  upload: 'attachment/upload',
} as const

/** B36 单据生成；契约 legacySource=quote/view，现有只读角色可生成其允许视角的单据。 */
export const DOCUMENT_PERMISSIONS = { export: 'document/export' } as const

/** 新码 ← 旧码。键必须是契约里存在的权限码，值为 legacyPermissionMap 已声明的来源。 */
const LEGACY_EQUIVALENT: Record<string, readonly string[]> = {
  [QUOTE_PERMISSIONS.view]: ['quote/view', 'template/view'],
  [QUOTE_PERMISSIONS.edit]: ['quote/edit', 'template/view', 'template/edit'],
  [QUOTE_PERMISSIONS.convert]: ['quote/edit'],
  [CUSTOMER_PERMISSIONS.view]: ['quote/view'],
  [CUSTOMER_PERMISSIONS.edit]: ['quote/edit'],
  // E06：销售单与收款。order-view 与 CUSTOMER_PERMISSIONS.view 是同一个码，不重复登记。
  [SALE_PERMISSIONS.orderEdit]: ['quote/edit'],
  [SALE_PERMISSIONS.orderPayment]: ['quote/edit'],
  // E08：备料、装机与检测记录（契约 legacySource = quote/edit，grantPolicy = default）。
  [SALE_PERMISSIONS.orderAssembly]: ['quote/edit'],
  [SALE_PERMISSIONS.orderDeliver]: ['quote/edit'],
  // E07：采购、到货与退供。
  [PURCHASE_PERMISSIONS.create]: ['library/edit'],
  [PURCHASE_PERMISSIONS.receipt]: ['library/edit'],
  [PURCHASE_PERMISSIONS.cancel]: ['library/edit'],
  [PURCHASE_PERMISSIONS.supplierReturn]: ['library/edit'],
  // E09：退货登记（default，旧 quote/edit 等价）；退款与欠款批准是 owner_only，不登记旧码。
  [SALE_PERMISSIONS.returnCreate]: ['quote/edit'],
  // E09：账本读接口（default，旧 quote/view 等价）；反冲与完整对账是 owner_only，不登记旧码。
  [FINANCE_PERMISSIONS.view]: ['quote/view'],
  // E10：售后维修。view/edit/charge 旧码等价（charge 契约 legacySource=quote/edit，explicit 授权）。
  [SERVICE_PERMISSIONS.view]: ['quote/view'],
  [SERVICE_PERMISSIONS.edit]: ['quote/edit'],
  [SERVICE_PERMISSIONS.charge]: ['quote/edit'],
  // E10：回收。view/edit 旧码等价；acquire 是 owner_only，不登记旧码。
  [RECOVERY_PERMISSIONS.view]: ['quote/view'],
  [RECOVERY_PERMISSIONS.edit]: ['quote/edit'],
  // E12：抵用额度。view/create 旧码等价；offset/reverse 是 owner_only，不登记旧码（noWideningGuard）。
  [TRADEIN_PERMISSIONS.view]: ['quote/view'],
  [TRADEIN_PERMISSIONS.create]: ['quote/edit'],
  // E07 的采购读接口复用库存读权限（契约 R08：权限 inventory/view）。
  // ⚠️ inventory-v2.ts（E04b）内部自带一份取值相同的局部映射；本轮不动那份已验收的代码，
  // 两处表收敛留待路由收敛卡（D-D）。
  'inventory/view': ['library/view'],
  // F1：附件上传。契约 legacySource = library/edit（grantPolicy=default），必须登记，
  // 否则现有店员会立刻失去上传照片的能力。
  [ATTACHMENT_PERMISSIONS.upload]: ['library/edit'],
  [DOCUMENT_PERMISSIONS.export]: ['quote/view'],
}

export interface PermissionHolder {
  permissions: string[]
}

/** 会话是否具备某个新权限码（含旧码等价）。`*` 表示老板。 */
export function grants(holder: PermissionHolder, code: string): boolean {
  if (holder.permissions.includes('*') || holder.permissions.includes(code)) return true
  return (LEGACY_EQUIVALENT[code] ?? []).some((legacy) => holder.permissions.includes(legacy))
}

/** 一组权限码中的任意一个命中即通过。空数组视为不通过（不做隐式放行）。 */
export function grantsAny(holder: PermissionHolder, codes: readonly string[]): boolean {
  return codes.some((code) => grants(holder, code))
}
