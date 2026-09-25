import { customerImageCrop, customerImageLayout } from './view'

Component({
  properties: {
    src: {
      type: String,
      value: '',
      observer(this: WechatMiniprogram.Component.TrivialInstance) {
        this.setData({ failed: false, loading: true, sourceWidth: 0, sourceHeight: 0 })
        this.updateLayout()
      },
    },
    altText: { type: String, value: '图片' },
    fitMode: { type: String, value: 'aspectFill' },
    aspectRatio: {
      type: Number,
      value: 1.5,
      observer(this: WechatMiniprogram.Component.TrivialInstance) { this.updateLayout() },
    },
    focusX: {
      type: Number,
      value: 50,
      observer(this: WechatMiniprogram.Component.TrivialInstance) { this.updateLayout() },
    },
    focusY: {
      type: Number,
      value: 50,
      observer(this: WechatMiniprogram.Component.TrivialInstance) { this.updateLayout() },
    },
  },
  data: {
    failed: false,
    loading: true,
    ratioPadding: '66.6667%',
    objectPosition: '50% 50%',
    sourceWidth: 0,
    sourceHeight: 0,
    cropStyle: 'width:100%;height:100%;left:0;top:0;',
  },
  lifetimes: {
    attached() { this.updateLayout() },
  },
  methods: {
    updateLayout() {
      const layout = customerImageLayout(this.data.aspectRatio, this.data.focusX, this.data.focusY)
      this.setData({ ...layout, cropStyle: customerImageCrop(this.data.aspectRatio, this.data.sourceWidth, this.data.sourceHeight, this.data.focusX, this.data.focusY) })
    },
    onImageLoad(event: WechatMiniprogram.CustomEvent<{ width: number; height: number }>) {
      this.setData({ loading: false, failed: false, sourceWidth: event.detail.width, sourceHeight: event.detail.height })
      this.updateLayout()
      this.triggerEvent('load')
    },
    onImageError() {
      this.setData({ loading: false, failed: true })
      this.triggerEvent('error', { altText: this.data.altText })
    },
  },
})
