import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'
import { useCallback } from 'react'

function trimCanvasWhitespace(source: HTMLCanvasElement, padding = 12) {
  const context = source.getContext('2d')
  if (!context) return source
  const { width, height } = source
  const image = context.getImageData(0, 0, width, height)
  const data = image.data
  const threshold = 248
  let top = height, left = width, right = -1, bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      if (data[i + 3] > 0 && (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold)) {
        if (x < left) left = x; if (x > right) right = x
        if (y < top) top = y; if (y > bottom) bottom = y
      }
    }
  }
  if (right === -1) return source
  left = Math.max(0, left - padding); top = Math.max(0, top - padding)
  right = Math.min(width - 1, right + padding); bottom = Math.min(height - 1, bottom + padding)
  const c = document.createElement('canvas')
  c.width = right - left + 1; c.height = bottom - top + 1
  const ctx = c.getContext('2d')
  if (ctx) ctx.drawImage(source, left, top, c.width, c.height, 0, 0, c.width, c.height)
  return c
}

function createPdfExportNode(element: HTMLElement, orientation: 'portrait' | 'landscape') {
  const rect = element.getBoundingClientRect()
  const wrapper = document.createElement('div')
  const clone = element.cloneNode(true) as HTMLElement
  const targetWidth = orientation === 'landscape'
    ? Math.max(Math.ceil(rect.width), 1480)
    : Math.max(Math.ceil(rect.width), 980)
  wrapper.style.cssText = 'position:fixed;left:-10000px;top:0;z-index:-1;padding:0;margin:0;background:#fff'
  wrapper.style.width = `${targetWidth}px`
  clone.style.cssText = `width:${targetWidth}px;max-width:none;min-width:${targetWidth}px`
  const page = clone.querySelector<HTMLElement>('.quote-page')
  if (page) { page.style.width = `${targetWidth - 24}px`; page.style.maxWidth = 'none'; page.style.minWidth = `${targetWidth - 24}px` }
  wrapper.appendChild(clone)
  document.body.appendChild(wrapper)
  return { wrapper, node: clone }
}

function captureSafely(element: HTMLElement, isMobile: boolean) {
  // 临时解除祖先容器的高度限制
  const ancestors: Array<{ el: HTMLElement; ov: string; mh: string; h: string }> = []
  let parent = element.parentElement
  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent)
    if (style.overflow !== 'visible' || style.overflowY !== 'visible' ||
        style.maxHeight !== 'none' || style.height !== 'auto') {
      ancestors.push({
        el: parent,
        ov: parent.style.overflow || '',
        mh: parent.style.maxHeight || '',
        h: parent.style.height || '',
      })
      parent.style.overflow = 'visible'
      parent.style.maxHeight = 'none'
      parent.style.height = 'auto'
    }
    parent = parent.parentElement
  }

  const scrollH = element.scrollHeight || element.offsetHeight * 2
  const w = isMobile ? 800 : Math.max(element.scrollWidth, 980)

  return html2canvas(element, {
    backgroundColor: '#ffffff',
    scale: isMobile ? 1 : 2,
    windowWidth: w,
    windowHeight: scrollH + 100,
    scrollY: 0,
    useCORS: true,
    ignoreElements: (node) =>
      node instanceof HTMLElement && node.dataset.exportExclude === 'true',
  }).finally(() => {
    // 恢复样式
    for (const a of ancestors) {
      if (a.ov) a.el.style.overflow = a.ov; else a.el.style.removeProperty('overflow')
      if (a.mh) a.el.style.maxHeight = a.mh; else a.el.style.removeProperty('max-height')
      if (a.h) a.el.style.height = a.h; else a.el.style.removeProperty('height')
    }
  })
}

export function useHtml2Canvas() {
  const toCanvas = useCallback(async (element: HTMLElement) => {
    const isMobile = window.innerWidth < 768
    return html2canvas(element, {
      backgroundColor: '#ffffff',
      scale: isMobile ? 1 : 2,
      useCORS: true,
      ignoreElements: (node) =>
        node instanceof HTMLElement && node.dataset.exportExclude === 'true',
    })
  }, [])

  const exportPng = useCallback(
    async (element: HTMLElement, filename: string) => {
      try {
        const canvas = await toCanvas(element)
        canvas.toBlob((blob) => {
          if (!blob) { alert('生成失败'); return }
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = filename
          a.click()
        }, 'image/png')
      } catch { alert('导出失败，请用 HTML 格式代替。') }
    },
    [toCanvas],
  )

  const exportPdf = useCallback(
    async (element: HTMLElement, filename: string, orientation: 'portrait' | 'landscape') => {
      const { wrapper, node } = createPdfExportNode(element, orientation)
      const rawCanvas = await toCanvas(node)
      wrapper.remove()
      const canvas = trimCanvasWhitespace(rawCanvas, orientation === 'landscape' ? 16 : 12)
      const pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4' })
      const pw = orientation === 'landscape' ? 297 : 210
      const ph = orientation === 'landscape' ? 210 : 297
      const mx = 8, my = 8
      const r = Math.min((pw - mx * 2) / canvas.width, (ph - my * 2) / canvas.height)
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', (pw - canvas.width * r) / 2, (ph - canvas.height * r) / 2, canvas.width * r, canvas.height * r)
      pdf.save(filename)
    },
    [toCanvas],
  )

  return { exportPng, exportPdf }
}
