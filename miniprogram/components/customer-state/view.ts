export type CustomerStateKind = 'loading' | 'empty' | 'offline' | 'error' | 'forbidden' | 'expired'

export interface CustomerStateView {
  title: string
  description: string
  retryable: boolean
}

const CUSTOMER_STATE_COPY: Record<CustomerStateKind, CustomerStateView> = {
  loading: { title: '正在加载', description: '请稍候', retryable: false },
  empty: { title: '这里暂时没有内容', description: '', retryable: false },
  offline: { title: '网络连接失败', description: '请检查网络后重试', retryable: true },
  error: { title: '内容暂时不可用', description: '请稍后重试', retryable: true },
  forbidden: { title: '暂时无法查看', description: '请联系门店确认访问权限', retryable: false },
  expired: { title: '访问已过期', description: '请重新打开门店发来的有效入口', retryable: false },
}

export function customerStateView(
  status: CustomerStateKind,
  title = '',
  description = ''
): CustomerStateView {
  const fallback = CUSTOMER_STATE_COPY[status] ?? CUSTOMER_STATE_COPY.error
  return {
    title: title || fallback.title,
    description: description || fallback.description,
    retryable: fallback.retryable,
  }
}
