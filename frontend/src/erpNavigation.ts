import type { ErpNavItem } from './components/ErpShell'

export const ERP_NAV_ITEMS: ErpNavItem[] = [
  { path: '/dashboard', label: '经营概览', description: '经营指标和待办事项将在后续阶段启用。' },
  { path: '/quotes', label: '报价工作台', description: '创建、编辑和导出电脑配置报价单。' },
  { path: '/orders', label: '订单', description: '查看订单、收款和履约状态。' },
  { path: '/inventory', label: '商品与库存', description: '商品档案、库存管理和 SN 查询。' },
  { path: '/sn', label: 'SN 台账', description: 'SN 码录入、绑定订单和客户过保查询。' },
  { path: '/purchases', label: '采购管理', description: '采购需求、采购单和到货入库将在后续阶段启用。' },
  { path: '/customers', label: '客户管理', description: '客户资料、历史报价和订单将在后续阶段启用。' },
  { path: '/suppliers', label: '供应商管理', description: '供应商和供货记录将在后续阶段启用。' },
  { path: '/assembly', label: '装机与交付', description: '装机任务、客供件和交付将在后续阶段启用。' },
  { path: '/after-sales', label: '售后维修', description: '售后工单和换件记录将在后续阶段启用。' },
  { path: '/finance', label: '收支与报表', description: '收款、欠款和毛利报表将在后续阶段启用。' },
  { path: '/settings', label: '系统设置', description: '门店资料、成员和权限将在后续阶段启用。' },
]

export function getErpNavItem(pathname: string) {
  return ERP_NAV_ITEMS.find((item) => item.path === pathname || (item.path === '/orders' && pathname.startsWith('/orders/')))
}
