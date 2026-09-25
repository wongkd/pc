import { customerStateView, type CustomerStateKind } from './view'

Component({
  properties: {
    status: { type: String, value: 'empty' },
    title: { type: String, value: '' },
    description: { type: String, value: '' },
    showRetry: { type: Boolean, value: false },
    retrying: { type: Boolean, value: false },
    retryText: { type: String, value: '重试' },
  },
  data: {
    view: customerStateView('empty'),
    retryEventPending: false,
  },
  observers: {
    'status, title, description': function (this: WechatMiniprogram.Component.TrivialInstance, status: CustomerStateKind, title: string, description: string) {
      this.setData({ view: customerStateView(status, title, description), retryEventPending: false })
    },
    retrying(retrying: boolean) {
      if (!retrying) this.setData({ retryEventPending: false })
    },
  },
  methods: {
    onRetryTap() {
      if (this.data.retrying || this.data.retryEventPending || !this.data.showRetry || !this.data.view.retryable) return
      this.setData({ retryEventPending: true })
      this.triggerEvent('retry', { status: this.data.status })
    },
  },
})
