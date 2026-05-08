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

  let top = height
  let left = width
  let right = -1
  let bottom = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      const a = data[index + 3]

      if (a > 0 && (r < threshold || g < threshold || b < threshold)) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }

  if (right === -1 || bottom === -1) return source

  left = Math.max(0, left - padding)
  top = Math.max(0, top - padding)
  right = Math.min(width - 1, right + padding)
  bottom = Math.min(height - 1, bottom + padding)

  const croppedWidth = right - left + 1
  const croppedHeight = bottom - top + 1
  const cropped = document.createElement('canvas')
  cropped.width = croppedWidth
  cropped.height = croppedHeight

  const croppedContext = cropped.getContext('2d')
  if (!croppedContext) return source

  croppedContext.drawImage(source, left, top, croppedWidth, croppedHeight, 0, 0, croppedWidth, croppedHeight)
  return cropped
}

function createPdfExportNode(element: HTMLElement, orientation: 'portrait' | 'landscape') {
  const rect = element.getBoundingClientRect()
  const wrapper = document.createElement('div')
  const clone = element.cloneNode(true) as HTMLElement
  const targetWidth =
    orientation === 'landscape'
      ? Math.max(Math.ceil(rect.width), 1480)
      : Math.max(Math.ceil(rect.width), 980)

  wrapper.style.position = 'fixed'
  wrapper.style.left = '-10000px'
  wrapper.style.top = '0'
  wrapper.style.zIndex = '-1'
  wrapper.style.width = `${targetWidth}px`
  wrapper.style.padding = '0'
  wrapper.style.margin = '0'
  wrapper.style.background = '#ffffff'
  wrapper.style.overflow = 'visible'

  clone.style.width = `${targetWidth}px`
  clone.style.maxWidth = 'none'
  clone.style.minWidth = `${targetWidth}px`
  clone.style.margin = '0'

  const previewPage = clone.querySelector<HTMLElement>('.quote-page')
  if (previewPage) {
    const pageWidth = orientation === 'landscape' ? Math.max(targetWidth - 24, 1420) : Math.max(targetWidth - 24, 920)
    previewPage.style.width = `${pageWidth}px`
    previewPage.style.maxWidth = 'none'
    previewPage.style.minWidth = `${pageWidth}px`
  }

  const customerView = clone.querySelector<HTMLElement>('.customer-view')
  if (customerView) {
    const viewWidth = orientation === 'landscape' ? Math.max(targetWidth - 24, 1420) : Math.max(targetWidth - 24, 920)
    customerView.style.width = `${viewWidth}px`
    customerView.style.maxWidth = 'none'
    customerView.style.minWidth = `${viewWidth}px`
  }

  wrapper.appendChild(clone)
  document.body.appendChild(wrapper)
  return { wrapper, node: clone }
}

export function useHtml2Canvas() {
  const toCanvas = useCallback(async (element: HTMLElement) => {
    return html2canvas(element, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      ignoreElements: (node) =>
        node instanceof HTMLElement && node.dataset.exportExclude === 'true',
    })
  }, [])

  const exportPng = useCallback(
    async (element: HTMLElement, filename: string) => {
      const canvas = await toCanvas(element)
      const link = document.createElement('a')
      link.href = canvas.toDataURL('image/png')
      link.download = filename
      link.click()
    },
    [toCanvas],
  )

  const exportPdf = useCallback(
    async (
      element: HTMLElement,
      filename: string,
      orientation: 'portrait' | 'landscape',
    ) => {
      const { wrapper, node } = createPdfExportNode(element, orientation)
      const rawCanvas = await toCanvas(node)
      wrapper.remove()
      const canvas = trimCanvasWhitespace(rawCanvas, orientation === 'landscape' ? 16 : 12)
      const imageData = canvas.toDataURL('image/png')
      const pdf = new jsPDF({
        orientation,
        unit: 'mm',
        format: 'a4',
      })
      const pageWidth = orientation === 'landscape' ? 297 : 210
      const pageHeight = orientation === 'landscape' ? 210 : 297
      const marginX = orientation === 'landscape' ? 6 : 8
      const marginY = orientation === 'landscape' ? 6 : 8
      const usableWidth = pageWidth - marginX * 2
      const usableHeight = pageHeight - marginY * 2
      const ratio = Math.min(usableWidth / canvas.width, usableHeight / canvas.height)
      const renderWidth = canvas.width * ratio
      const renderHeight = canvas.height * ratio
      const x = (pageWidth - renderWidth) / 2
      const y = (pageHeight - renderHeight) / 2
      pdf.addImage(imageData, 'PNG', x, y, renderWidth, renderHeight)
      pdf.save(filename)
    },
    [toCanvas],
  )

  return { exportPng, exportPdf }
}
