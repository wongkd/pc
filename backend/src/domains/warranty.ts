/** D07 R1.2 顾客保修条款快照。延保费率已采纳，但选购、收费与履约仍未开放。 */
export const WARRANTY_POLICY_LINES = [
  '全新配件整机：在本店购买并全部使用全新配件组装的电脑，本店提供1年基础保修服务。',
  '新旧混合整机：本店售出的全新配件提供1年、二手配件提供1个月基础保修服务；各配件按订单标明的来源分别计算。',
  '全二手配件整机：在本店购买并全部使用二手配件组装的电脑，本店提供1个月基础保修服务。',
  '二手整机延保：服务暂未开放选购和收费。首期费率为总保障期3个月（含基础1个月、延长2个月）按纳保二手硬件净成交额5%（最低99元），或总保障期6个月（含基础1个月、延长5个月）按8%（最低159元）；比例金额向上取整到整元。未正式开售前请勿付款；未选购不影响基础保修及依法享有的权利。',
  '顾客自带配件：本店提供90天安装工艺保修，处理因本店安装工艺造成的问题；自带配件本身的原有保障不受影响。',
  '上述本店基础保修自交付验收之日起计算，月份按日历月计算。法定三包及其他权利不受上述期限限制；适用的厂家保障或本店已作出的承诺更有利于消费者的，按更有利的内容履行。依法依约应免费提供的保障，不因未购买延保而取消或另行收费。',
] as const

const EXTENSION_WARRANTY_LINE_PATTERN = /(延保|续保|延长保修|保修升级)/u
const EXTENSION_WARRANTY_COMMITMENT_PATTERN = /(?:已购|已购买|购买|选购|加购|收费|支付|收款).{0,10}(?:延保|续保)|(?:延保|续保).{0,10}(?:已购|已购买|收费|支付|收款|(?:¥|￥)?\s*\d)/u

export function isExtensionWarrantyLine(value: unknown): boolean {
  return EXTENSION_WARRANTY_LINE_PATTERN.test(typeof value === 'string' ? value : '')
}

export function containsExtensionWarrantyCommitment(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '') ?? ''
  return EXTENSION_WARRANTY_COMMITMENT_PATTERN.test(text)
}

export const EXTENSION_WARRANTY_DEFERRED_MESSAGE = '延保选购、收费和订单履约暂未开放，不能通过通用报价或零售行成交'

export interface CustomerWarrantySnapshot {
  months?: number
  note?: string
  remark?: string
}

/** 只返回明确列入顾客报价的字段，不把任意内部元数据带到顾客视图。 */
export function safeCustomerWarrantySnapshot(raw: string | null): CustomerWarrantySnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = parsed as Record<string, unknown>
    const safe: CustomerWarrantySnapshot = {}
    if (typeof value.months === 'number' && Number.isInteger(value.months) && value.months >= 0) safe.months = value.months
    if (typeof value.note === 'string') safe.note = value.note
    if (typeof value.remark === 'string') safe.remark = value.remark
    return Object.keys(safe).length ? safe : null
  } catch {
    return null
  }
}

/** 历史版本只读其自身快照；没有快照的旧版本返回 null，不用新文案伪造旧约定。 */
export function warrantyPolicyFromTermsSnapshot(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const lines = (parsed as Record<string, unknown>).warrantyPolicyLines
    if (!Array.isArray(lines) || !lines.length || lines.some((line) => typeof line !== 'string')) return null
    return [...lines] as string[]
  } catch {
    return null
  }
}
