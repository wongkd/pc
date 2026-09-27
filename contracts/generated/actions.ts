// AUTO-GENERATED FROM contracts/v1.2 — DO NOT EDIT
// 生成命令：node contracts/tools/generate-dto.mjs
// 来源：contracts/v1.2/actions.json；动作码、路径、权限码的唯一来源。
import type { ActionCode } from './enums'

export interface ActionOperation {
  method: string
  path: string
  permission: string | null
}

// ── 动作 → 路径 / 权限（完整请求路径 = /api/v2 + path）──
export const ACTION_OPERATIONS: Record<ActionCode, readonly ActionOperation[]> = {
  "B01": [{ method: "POST", path: "/sales/quotes", permission: "sales/quote-edit" }],
  "B02": [{ method: "POST", path: "/sales/quotes/:id/save", permission: "sales/quote-edit" }, { method: "POST", path: "/sales/quotes/:id/issue", permission: "sales/quote-edit" }],
  "B03": [{ method: "POST", path: "/sales/quotes/:id/convert", permission: "sales/quote-convert" }],
  "B04": [{ method: "POST", path: "/sales/orders", permission: "sales/order-edit" }],
  "B05": [{ method: "POST", path: "/sales/orders/:id/confirm", permission: "sales/order-edit" }, { method: "POST", path: "/sales/orders/:id/allocate", permission: "sales/order-edit" }],
  "B06": [{ method: "POST", path: "/sales/orders/:id/start-assembly", permission: "sales/order-assembly" }],
  "B07": [{ method: "POST", path: "/sales/orders/:id/checks", permission: "sales/order-assembly" }],
  "B08": [{ method: "POST", path: "/sales/orders/:id/payments", permission: "sales/order-payment" }],
  "B09": [{ method: "POST", path: "/sales/orders/:id/credit-approval", permission: "sales/order-credit-approval" }],
  "B10": [{ method: "POST", path: "/sales/orders/:id/deliver", permission: "sales/order-deliver" }],
  "B11": [{ method: "POST", path: "/sales/orders/:id/cancel", permission: "sales/order-edit" }],
  "B12": [{ method: "POST", path: "/inventory/products", permission: "inventory/product-edit" }],
  "B13": [{ method: "POST", path: "/inventory/openings", permission: "inventory/opening" }],
  "B14": [{ method: "POST", path: "/inventory/purchases", permission: "inventory/purchase-create" }],
  "B15": [{ method: "POST", path: "/inventory/receipts", permission: "inventory/receipt" }],
  "B16": [{ method: "POST", path: "/inventory/counts", permission: "inventory/count" }, { method: "POST", path: "/inventory/counts/:id/approve", permission: "inventory/count-approve" }],
  "B17": [{ method: "POST", path: "/sales/returns", permission: "sales/return-create" }],
  "B18": [{ method: "POST", path: "/sales/orders/:id/refunds", permission: "sales/refund" }],
  "B43": [{ method: "POST", path: "/sales/returns/:id/approve-credit", permission: "sales/refund" }],
  "B19": [{ method: "POST", path: "/inventory/items/:id/inspection", permission: "inventory/inspection" }],
  "B20": [{ method: "POST", path: "/service/orders", permission: "service/edit" }],
  "B21": [{ method: "POST", path: "/service/orders/:id/diagnosis", permission: "service/edit" }, { method: "POST", path: "/service/orders/:id/proposal", permission: "service/edit" }],
  "B22": [{ method: "POST", path: "/service/orders/:id/confirm-proposal", permission: "service/edit" }],
  "B23": [{ method: "POST", path: "/service/orders/:id/replace", permission: "service/edit" }],
  "B24": [{ method: "POST", path: "/service/orders/:id/dispatch", permission: "service/edit" }, { method: "POST", path: "/service/orders/:id/receive-external", permission: "service/edit" }],
  "B25": [{ method: "POST", path: "/service/orders/:id/retest", permission: "service/edit" }, { method: "POST", path: "/service/orders/:id/return", permission: "service/edit" }],
  "B26": [{ method: "POST", path: "/recovery/orders", permission: "recovery/edit" }],
  "B27": [{ method: "POST", path: "/recovery/orders/:id/inspect", permission: "recovery/edit" }, { method: "POST", path: "/recovery/orders/:id/offer", permission: "recovery/edit" }],
  "B28": [{ method: "POST", path: "/recovery/orders/:id/acquire", permission: "recovery/acquire" }],
  "B29": [{ method: "POST", path: "/recovery/orders/:id/return", permission: "recovery/edit" }],
  "B30": [{ method: "POST", path: "/inventory/items/:id/refurbishments", permission: "inventory/refurbish" }, { method: "POST", path: "/inventory/items/:id/make-available", permission: "inventory/refurbish" }],
  "B44": [{ method: "POST", path: "/recovery/orders/:id/teardown", permission: "recovery/edit" }],
  "B31": [{ method: "POST", path: "/trade-ins", permission: "tradein/create" }, { method: "POST", path: "/trade-ins/:id/apply-offset", permission: "tradein/offset" }],
  "B32": [{ method: "POST", path: "/trade-ins/:id/reverse-offset", permission: "tradein/reverse" }],
  "B33": [{ method: "POST", path: "/finance/payments", permission: "finance/payment" }],
  "B34": [{ method: "POST", path: "/finance/entries/:id/reverse", permission: "finance/reverse" }],
  "B35": [{ method: "POST", path: "/attachments/upload-intents", permission: "attachment/upload" }, { method: "PUT", path: "/attachments/upload-intents/:id/blob", permission: "attachment/upload" }, { method: "POST", path: "/attachments/upload-intents/:id/complete", permission: "attachment/upload" }],
  "B36": [{ method: "POST", path: "/documents", permission: "document/export" }, { method: "GET", path: "/documents/:attachmentId", permission: "document/export" }],
  "B42": [{ method: "POST", path: "/sales/quotes/:id/confirm", permission: "sales/quote-edit" }],
  "B37": [{ method: "POST", path: "/inventory/purchases/:id/cancel", permission: "inventory/purchase-cancel" }],
  "B38": [{ method: "POST", path: "/inventory/supplier-returns", permission: "inventory/supplier-return" }],
  "B41": [{ method: "POST", path: "/service/orders/:id/payments", permission: "service/charge" }],
  "B45": [{ method: "POST", path: "/sales/quotes/:id/delete-draft", permission: "store/manage" }],
  "B46": [{ method: "GET", path: "/inventory/products/cleanup-candidates", permission: "store/manage" }, { method: "POST", path: "/inventory/products/:id/delete-unused", permission: "store/manage" }],
  "B47": [{ method: "POST", path: "/inventory/backfills", permission: "inventory/stock-backfill" }],
  "B48": [{ method: "POST", path: "/inventory/items/:id/inspection/rework", permission: "inventory/inspection" }],
}

export const ACTION_NAMES: Record<ActionCode, string> = {
  "B01": "创建报价草稿",
  "B02": "保存与发出报价",
  "B03": "报价转为销售单",
  "B04": "创建零售与直接销售单",
  "B05": "确认成交与补分配",
  "B06": "开始备料与装机",
  "B07": "保存装机检测结果",
  "B08": "登记销售收款",
  "B09": "批准欠款交付",
  "B10": "确认交付",
  "B11": "取消销售单",
  "B12": "建立与修改商品主数据",
  "B13": "录入期初库存",
  "B14": "创建采购与到货计划",
  "B15": "登记实际到货与入库",
  "B16": "盘点录入与差异批准",
  "B17": "登记退货",
  "B18": "登记现金退款",
  "B43": "批准退货贷项",
  "B19": "待检件判定",
  "B20": "接修登记",
  "B21": "录入检测与维修方案",
  "B22": "记录方案确认",
  "B23": "换件",
  "B24": "外送与返回",
  "B25": "复测与归还客户",
  "B26": "回收登记",
  "B27": "验机与估价",
  "B28": "取得所有权",
  "B29": "归还客户",
  "B30": "整备与上架",
  "B44": "拆件入库",
  "B31": "建立置换关联与应用折抵",
  "B32": "撤销折抵",
  "B33": "登记对外付款",
  "B34": "反冲账务分录",
  "B35": "附件上传",
  "B36": "生成单据文件",
  "B42": "记录顾客确认",
  "B37": "取消采购",
  "B38": "退供",
  "B41": "售后收款",
  "B45": "清理未发出报价草稿",
  "B46": "清理未引用商品档案",
  "B47": "同型号库存分批补录",
  "B48": "返修后重新待检",
}

// ── 页面 → 该页可发起的动作（02 §5；每页至少一个，由契约校验脚本强制）──
export const PAGE_ACTIONS: Record<string, readonly ActionCode[]> = {
  "入库": ["B15"],
  "办理交付": ["B08","B09","B10"],
  "回收": ["B26","B27","B28","B29","B44","B35"],
  "库存": ["B12","B13","B19","B30","B38","B47","B48"],
  "换件 / 返厂": ["B23","B24"],
  "接修": ["B20","B35"],
  "整备 / 上架": ["B30"],
  "新建装机报价": ["B01","B02","B42"],
  "新建零售": ["B04"],
  "盘点": ["B16"],
  "确认成交": ["B03","B05","B11"],
  "管理员数据清理": ["B45","B46"],
  "维修方案": ["B21","B22","B25","B41"],
  "缺件处理": ["B05","B14","B15","B37","B38"],
  "置换": ["B31","B32"],
  "装机检测": ["B06","B07"],
  "账本": ["B08","B33","B34","B36","B41"],
  "退货 / 退款": ["B17","B18","B43"],
  "选件": ["B01","B02"],
}

// ── 权限码──
export type PermissionCode =
  | "sales/quote-view"
  | "sales/quote-edit"
  | "sales/quote-convert"
  | "sales/order-view"
  | "sales/order-edit"
  | "sales/order-assembly"
  | "sales/order-payment"
  | "sales/order-credit-approval"
  | "sales/order-deliver"
  | "sales/return-create"
  | "sales/refund"
  | "inventory/product-view"
  | "inventory/product-edit"
  | "inventory/view"
  | "inventory/item-view"
  | "inventory/sn-view"
  | "inventory/sn-edit"
  | "inventory/opening"
  | "inventory/stock-backfill"
  | "inventory/purchase-create"
  | "inventory/purchase-cancel"
  | "inventory/supplier-return"
  | "inventory/receipt"
  | "inventory/count"
  | "inventory/count-approve"
  | "inventory/inspection"
  | "inventory/refurbish"
  | "inventory/damage"
  | "inventory/cost-view"
  | "inventory/margin-view"
  | "service/view"
  | "service/edit"
  | "service/charge"
  | "recovery/view"
  | "recovery/edit"
  | "recovery/acquire"
  | "tradein/view"
  | "tradein/create"
  | "tradein/offset"
  | "tradein/reverse"
  | "finance/view"
  | "finance/ledger-view"
  | "finance/payment"
  | "finance/reverse"
  | "store/manage"
  | "member/manage"
  | "role/view"
  | "document/export"
  | "attachment/upload"
  | "auth/binding-code"

export interface PermissionDefinition {
  code: PermissionCode
  domain: string
  level: "action" | "field"
  desc: string
  grantPolicy: "default" | "explicit" | "owner_only"
  legacySource: string | null
}
export const PERMISSIONS: readonly PermissionDefinition[] = [
  { code: "sales/quote-view", domain: "sales", level: "action", desc: "查看报价列表与详情", grantPolicy: "default", legacySource: "quote/view" },
  { code: "sales/quote-edit", domain: "sales", level: "action", desc: "新建、保存、发出报价；管理报价模板", grantPolicy: "default", legacySource: "quote/edit + template/view + template/edit" },
  { code: "sales/quote-convert", domain: "sales", level: "action", desc: "报价转为销售单", grantPolicy: "default", legacySource: "quote/edit" },
  { code: "sales/order-view", domain: "sales", level: "action", desc: "查看销售单、客户与设备资料（按权限分域）", grantPolicy: "default", legacySource: "quote/view" },
  { code: "sales/order-edit", domain: "sales", level: "action", desc: "新建、确认、补分配、取消销售单", grantPolicy: "default", legacySource: "quote/edit" },
  { code: "sales/order-assembly", domain: "sales", level: "action", desc: "备料、装机、检测记录", grantPolicy: "default", legacySource: "quote/edit" },
  { code: "sales/order-payment", domain: "sales", level: "action", desc: "登记销售收款", grantPolicy: "explicit", legacySource: "quote/edit" },
  { code: "sales/order-credit-approval", domain: "sales", level: "action", desc: "批准欠款交付", grantPolicy: "owner_only", legacySource: null },
  { code: "sales/order-deliver", domain: "sales", level: "action", desc: "确认实物交付与出库", grantPolicy: "explicit", legacySource: "quote/edit" },
  { code: "sales/return-create", domain: "sales", level: "action", desc: "登记退货接收与贷项", grantPolicy: "default", legacySource: "quote/edit" },
  { code: "sales/refund", domain: "sales", level: "action", desc: "登记现金退款", grantPolicy: "owner_only", legacySource: null },
  { code: "inventory/product-view", domain: "inventory", level: "action", desc: "查看商品主数据与分类品牌", grantPolicy: "default", legacySource: "library/view" },
  { code: "inventory/product-edit", domain: "inventory", level: "action", desc: "新建与修改商品主数据", grantPolicy: "default", legacySource: "library/edit" },
  { code: "inventory/view", domain: "inventory", level: "action", desc: "查看库存汇总、采购单与流水", grantPolicy: "default", legacySource: "library/view" },
  { code: "inventory/item-view", domain: "inventory", level: "action", desc: "查看逐件实物来源、占用与检验记录", grantPolicy: "default", legacySource: "library/view" },
  { code: "inventory/sn-view", domain: "inventory", level: "action", desc: "查询序列号", grantPolicy: "default", legacySource: "library/view" },
  { code: "inventory/sn-edit", domain: "inventory", level: "action", desc: "绑定与修改序列号", grantPolicy: "default", legacySource: "library/edit" },
  { code: "inventory/opening", domain: "inventory", level: "action", desc: "录入期初数量、实物与成本", grantPolicy: "owner_only", legacySource: null },
  { code: "inventory/stock-backfill", domain: "inventory", level: "action", desc: "把已有自有库存按批次补录到商品型号", grantPolicy: "default", legacySource: "library/edit" },
  { code: "inventory/purchase-create", domain: "inventory", level: "action", desc: "创建采购与到货计划", grantPolicy: "default", legacySource: "library/edit" },
  { code: "inventory/purchase-cancel", domain: "inventory", level: "action", desc: "取消采购未到部分", grantPolicy: "default", legacySource: "library/edit" },
  { code: "inventory/supplier-return", domain: "inventory", level: "action", desc: "退供", grantPolicy: "default", legacySource: "library/edit" },
  { code: "inventory/receipt", domain: "inventory", level: "action", desc: "登记实际到货与原子入库", grantPolicy: "explicit", legacySource: "library/edit" },
  { code: "inventory/count", domain: "inventory", level: "action", desc: "录入盘点实盘结果", grantPolicy: "default", legacySource: "library/edit" },
  { code: "inventory/count-approve", domain: "inventory", level: "action", desc: "批准盘点差异并生成调整", grantPolicy: "owner_only", legacySource: null },
  { code: "inventory/inspection", domain: "inventory", level: "action", desc: "待检件判定为可卖或继续隔离", grantPolicy: "default", legacySource: "library/edit" },
  { code: "inventory/refurbish", domain: "inventory", level: "action", desc: "整备成本记录与上架门槛达成", grantPolicy: "default", legacySource: "library/edit" },
  { code: "inventory/damage", domain: "inventory", level: "action", desc: "报损", grantPolicy: "owner_only", legacySource: null },
  { code: "inventory/cost-view", domain: "inventory", level: "field", desc: "响应中返回采购成本与逐件成本字段", grantPolicy: "default", legacySource: "cost/view" },
  { code: "inventory/margin-view", domain: "inventory", level: "field", desc: "响应中返回毛利字段", grantPolicy: "default", legacySource: "margin/view" },
  { code: "service/view", domain: "service", level: "action", desc: "查看维修工单、方案与费用", grantPolicy: "default", legacySource: "quote/view" },
  { code: "service/edit", domain: "service", level: "action", desc: "接修、检测、方案、换件、外送与归还", grantPolicy: "default", legacySource: "quote/edit" },
  { code: "service/charge", domain: "service", level: "action", desc: "登记售后收费", grantPolicy: "explicit", legacySource: "quote/edit" },
  { code: "recovery/view", domain: "recovery", level: "action", desc: "查看回收单、检测与估价", grantPolicy: "default", legacySource: "quote/view" },
  { code: "recovery/edit", domain: "recovery", level: "action", desc: "回收登记、验机、估价与归还", grantPolicy: "default", legacySource: "quote/edit" },
  { code: "recovery/acquire", domain: "recovery", level: "action", desc: "确认回收最终价并取得所有权", grantPolicy: "owner_only", legacySource: null },
  { code: "tradein/view", domain: "tradein", level: "action", desc: "查看置换单据与有效折抵", grantPolicy: "default", legacySource: "quote/view" },
  { code: "tradein/create", domain: "tradein", level: "action", desc: "建立置换关联", grantPolicy: "default", legacySource: "quote/edit" },
  { code: "tradein/offset", domain: "tradein", level: "action", desc: "确认并应用折抵", grantPolicy: "owner_only", legacySource: null },
  { code: "tradein/reverse", domain: "tradein", level: "action", desc: "撤销折抵（双方冲销，不搬动实物）", grantPolicy: "owner_only", legacySource: null },
  { code: "finance/view", domain: "finance", level: "action", desc: "查看应收应付汇总与流水", grantPolicy: "default", legacySource: "quote/view" },
  { code: "finance/ledger-view", domain: "finance", level: "action", desc: "查看完整账本与对账", grantPolicy: "owner_only", legacySource: null },
  { code: "finance/payment", domain: "finance", level: "action", desc: "登记采购与回收付款", grantPolicy: "owner_only", legacySource: null },
  { code: "finance/reverse", domain: "finance", level: "action", desc: "受控反冲账务分录", grantPolicy: "owner_only", legacySource: null },
  { code: "store/manage", domain: "platform", level: "action", desc: "门店设置", grantPolicy: "owner_only", legacySource: "store/manage" },
  { code: "member/manage", domain: "platform", level: "action", desc: "成员管理与邀请", grantPolicy: "owner_only", legacySource: "member/manage" },
  { code: "role/view", domain: "platform", level: "action", desc: "查看角色与权限配置", grantPolicy: "owner_only", legacySource: "role/view" },
  { code: "document/export", domain: "platform", level: "action", desc: "生成与导出单据文件", grantPolicy: "owner_only", legacySource: null },
  { code: "attachment/upload", domain: "platform", level: "action", desc: "上传业务附件与照片", grantPolicy: "default", legacySource: "library/edit" },
  { code: "auth/binding-code", domain: "platform", level: "action", desc: "生成微信绑定码", grantPolicy: "owner_only", legacySource: null },
]

// 字段级权限不守卫动作，只决定响应是否返回受限字段；不得当按钮权限使用。
export const FIELD_LEVEL_PERMISSIONS: readonly PermissionCode[] = [
  "inventory/cost-view", "inventory/margin-view"
]

// ── 补充动作（reserved 的不得由两端自行取名；specified 的路径已冻结）──
export interface SupplementaryAction {
  code: string
  name: string
  status: "reserved" | "specified"
  path: string | null
  permission: string | null
  owner: string | null
}
export const SUPPLEMENTARY_ACTIONS: readonly SupplementaryAction[] = [
  { code: "B39", name: "报损", status: "reserved", path: null, permission: "inventory/damage", owner: "T06c" },
  { code: "B40", name: "普通价格调整", status: "reserved", path: null, permission: null, owner: null },
]

// ── 动作编号全集（含补充动作）──
export const ALL_ACTION_CODES: readonly string[] = ["B01","B02","B03","B04","B05","B06","B07","B08","B09","B10","B11","B12","B13","B14","B15","B16","B17","B18","B43","B19","B20","B21","B22","B23","B24","B25","B26","B27","B28","B29","B30","B44","B31","B32","B33","B34","B35","B36","B42","B37","B38","B41","B45","B46","B47","B48","B39","B40"]
