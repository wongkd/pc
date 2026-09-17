// AUTO-GENERATED FROM contracts/v1 — DO NOT EDIT
// 生成命令：node contracts/tools/generate-dto.mjs
// 来源：contracts/v1/money-rules.json、conventions.json；只导出公式编号与单位口径，不生成计算实现。
import type { Cents } from './enums'

// 金额一律整数分，禁止浮点；界面按元显示，运算与传输只用分。
export type Money = Cents
export const CURRENCY = "CNY" as const
export const CURRENCY_SYMBOL = "¥" as const
export const MONEY_UNIT = "cent" as const

export const MONEY_FORMULA_IDS = {
  SALESNETACCRUEDCENTS: "salesNetAccruedCents",
  CASHNETRECEIVEDCENTS: "cashNetReceivedCents",
  OFFSETNETCENTS: "offsetNetCents",
  SALESBALANCECENTS: "salesBalanceCents",
  BALANCEDIRECTION: "balanceDirection",
  RECOVERYPAYABLEREMAININGCENTS: "recoveryPayableRemainingCents",
  OFFSETAMOUNTCENTS: "offsetAmountCents",
  REFUNDABLECASHCENTS: "refundableCashCents",
  COLLECTABLECENTS: "collectableCents",
} as const
export type MoneyFormulaId = (typeof MONEY_FORMULA_IDS)[keyof typeof MONEY_FORMULA_IDS]

export interface MoneyFormula {
  id: MoneyFormulaId
  definition: string
  expression: string
  objectFields: readonly string[]
  derivedTerms: readonly string[]
  note: string
}
export const MONEY_FORMULAS: readonly MoneyFormula[] = [
  { id: "salesNetAccruedCents", definition: "销售净应计金额", expression: "confirmedTotalCents + approvedIncreaseCents - approvedDecreaseCents - returnCreditCents", objectFields: ["SaleOrder.totalCents","SaleOrder.adjustmentCents","ReturnRecord.creditCents"], derivedTerms: ["confirmedTotalCents","approvedIncreaseCents","approvedDecreaseCents","returnCreditCents"], note: "加价与减价调整必须是已批准记录；未批准的调整不进入净应计。" },
  { id: "cashNetReceivedCents", definition: "现金净已收", expression: "validReceiptsCents - validRefundsCents", objectFields: ["CashEntry.amountCents","CashEntry.direction","Refund.amountCents"], derivedTerms: ["validReceiptsCents","validRefundsCents"], note: "只统计有效流水；被冲销的原笔仍留在净和中，同时计入等额反向记录。" },
  { id: "offsetNetCents", definition: "折抵净额", expression: "appliedOffsetsCents - reversedOffsetsCents", objectFields: ["Offset.amountCents","Offset.state"], derivedTerms: ["appliedOffsetsCents","reversedOffsetsCents"], note: "折抵是非现金事件，不得生成虚构现金收 / 付记录。" },
  { id: "salesBalanceCents", definition: "销售余额", expression: "salesNetAccruedCents - cashNetReceivedCents - offsetNetCents", objectFields: ["SaleOrder.balanceCents","SaleOrder.cashNetCents","SaleOrder.offsetNetCents"], derivedTerms: ["salesNetAccruedCents","cashNetReceivedCents","offsetNetCents"], note: "服务端维护并可重算；客户端计算结果不作为权威值。" },
  { id: "balanceDirection", definition: "余额方向", expression: "salesBalanceCents > 0 → client_due; salesBalanceCents == 0 → settled; salesBalanceCents < 0 → store_due", objectFields: ["SaleOrder.balanceCents","SaleOrder.balanceDirection"], derivedTerms: [], note: "小于 0 为门店待退，界面不得显示为负尾款。" },
  { id: "recoveryPayableRemainingCents", definition: "回收剩余应付", expression: "finalAcquisitionCents + lawfulAdjustmentCents - validOffsetsCents - cashNetPaidCents", objectFields: ["Recovery.finalAcquisitionCents","Offset.amountCents","CashEntry.amountCents"], derivedTerms: ["lawfulAdjustmentCents","validOffsetsCents","cashNetPaidCents"], note: "最终收购以后的变价走调整，不覆盖原价。" },
  { id: "offsetAmountCents", definition: "首版折抵金额", expression: "min(max(salesBalanceCents, 0), max(recoveryPayableRemainingCents, 0))", objectFields: ["Offset.amountCents","SaleOrder.balanceCents","Recovery.finalAcquisitionCents"], derivedTerms: ["salesBalanceCents","recoveryPayableRemainingCents"], note: "同一回收应付可部分折抵但累计不得超额；双方当前交易主体须相同，不同主体代付首版不支持。" },
  { id: "refundableCashCents", definition: "可现金退款上限", expression: "min(-salesBalanceCents, refundableCashNetCents)", objectFields: ["SaleOrder.balanceCents","Refund.amountCents","ReturnRecord.creditCents"], derivedTerms: ["refundableCashNetCents"], note: "仅在销售余额为负时适用；需要把折抵权益退给客户时先明确关联结算处理，不凭空当原收款退。" },
  { id: "collectableCents", definition: "可收款上限", expression: "max(salesBalanceCents, 0)", objectFields: ["SaleOrder.balanceCents","CashEntry.amountCents"], derivedTerms: ["salesBalanceCents"], note: "已有的数据库级防超收触发器继续保留，但它不等于幂等；同载荷重发仍可能形成两笔。" },
]

// 计算结果以服务端重算为准；客户端算出的值只作展示，不作为权威值。
export const MONEY_SERVER_AUTHORITY = true as const
