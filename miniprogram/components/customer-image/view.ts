export interface CustomerImageLayout {
  ratioPadding: string
  objectPosition: string
}

function boundedPercent(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50
  return Math.min(100, Math.max(0, value))
}

/** aspectRatio is width / height; percent padding preserves the frame before image load. */
export function customerImageLayout(
  aspectRatio: number,
  focusX = 50,
  focusY = 50
): CustomerImageLayout {
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1
  return {
    ratioPadding: `${(100 / safeRatio).toFixed(4)}%`,
    objectPosition: `${boundedPercent(focusX)}% ${boundedPercent(focusY)}%`,
  }
}

/** 原生 image 的内部图片不保证响应 object-position；用容器内尺寸和偏移明确裁切。 */
export function customerImageCrop(aspectRatio: number, width: number, height: number, focusX = 50, focusY = 50): string {
  if (![aspectRatio, width, height].every((value) => Number.isFinite(value) && value > 0)) {
    return 'width:100%;height:100%;left:0;top:0;'
  }
  const sourceRatio = width / height
  const widthPercent = Math.max(100, sourceRatio / aspectRatio * 100)
  const heightPercent = Math.max(100, aspectRatio / sourceRatio * 100)
  const left = -(widthPercent - 100) * boundedPercent(focusX) / 100
  const top = -(heightPercent - 100) * boundedPercent(focusY) / 100
  return `width:${widthPercent.toFixed(4)}%;height:${heightPercent.toFixed(4)}%;left:${left.toFixed(4)}%;top:${top.toFixed(4)}%;`
}
