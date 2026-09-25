import type { WorkspaceEntry } from './WorkspaceLandingPage'

export const SALES_WORKSPACE = {
  kicker: '报价与销售工作区',
  title: '开单',
  intro: '创建装机报价，处理销售收款、备料与交付。',
  entries: [
    { label: '装机报价', description: '新建报价、管理版本与顾客确认', to: '/sales/quotes' },
    { label: '销售订单', description: '处理收款、成交与缺件', to: '/sales/orders' },
    { label: '装机与交付', description: '备料、装机检测与交付', to: '/sales/fulfillment' },
  ] satisfies WorkspaceEntry[],
  notYet: ['线上支付尚未接通；收款登记请以实际到账为准。'],
}
