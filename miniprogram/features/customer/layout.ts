import type { CustomerNavigationLayout } from '../../typings/customer-view'

export interface SystemWindowMetrics {
  statusBarHeight?: number
  windowWidth?: number
  safeArea?: { top?: number; bottom?: number; left?: number; right?: number }
}

export interface CapsuleMetrics {
  top?: number
  bottom?: number
  /** ClientRect.right: 胶囊右边缘在窗口内的 x 坐标(px)，不是距屏幕右侧的距离。 */
  right?: number
  width?: number
  height?: number
}

const FALLBACK_STATUS_BAR = 20
const FALLBACK_CAPSULE = { top: 26, bottom: 58, rightInset: 10, width: 87, height: 32 }
const MIN_TOUCH_TARGET = 44
const CONTENT_GAP = 8

function validPositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 以屏幕坐标(px)计算自定义导航区。胶囊测量无效或与状态栏冲突时，
 * 使用有界回退；ClientRect.right 是窗口内坐标，因此先用窗口宽度换算屏幕右边距。
 * 右侧内容区始终至少让出胶囊宽度 + 触控间距。
 */
export function getCustomerNavigationLayout(
  system: SystemWindowMetrics,
  capsule: CapsuleMetrics,
  hasRightAction = false
): CustomerNavigationLayout {
  const statusBarHeight = validPositive(system.statusBarHeight)
    ? system.statusBarHeight
    : validPositive(system.safeArea?.top)
      ? system.safeArea.top
      : FALLBACK_STATUS_BAR

  const capsuleValid =
    validPositive(capsule.top) &&
    validPositive(capsule.bottom) &&
    validPositive(capsule.width) &&
    validPositive(capsule.height) &&
    validPositive(capsule.right) &&
    validPositive(system.windowWidth) &&
    capsule.bottom > capsule.top &&
    capsule.top >= statusBarHeight - 2 &&
    capsule.right <= system.windowWidth + 1 &&
    capsule.right - capsule.width > 0

  const top = capsuleValid ? (capsule.top as number) : FALLBACK_CAPSULE.top
  const bottom = capsuleValid ? (capsule.bottom as number) : FALLBACK_CAPSULE.bottom
  const width = capsuleValid ? (capsule.width as number) : FALLBACK_CAPSULE.width
  const height = capsuleValid ? (capsule.height as number) : FALLBACK_CAPSULE.height
  const rightInset = capsuleValid
    ? Math.max(0, (system.windowWidth as number) - (capsule.right as number))
    : FALLBACK_CAPSULE.rightInset
  const navigationHeight = Math.max(bottom + CONTENT_GAP, statusBarHeight + MIN_TOUCH_TARGET)
  const contentRightInset = Math.max(
    rightInset + width + CONTENT_GAP,
    hasRightAction ? MIN_TOUCH_TARGET + CONTENT_GAP : 0
  )

  return {
    statusBarHeight,
    navigationHeight,
    capsuleTop: top,
    capsuleBottom: bottom,
    capsuleRightInset: rightInset,
    capsuleWidth: width,
    capsuleHeight: height,
    leftInset: CONTENT_GAP,
    rightInset: contentRightInset,
    contentHeight: navigationHeight - statusBarHeight,
  }
}

export function getCustomerPageRightInset(layout: CustomerNavigationLayout): number {
  return Math.max(layout.rightInset, layout.capsuleRightInset + layout.capsuleWidth + CONTENT_GAP)
}
