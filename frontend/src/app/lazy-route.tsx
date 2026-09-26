import { Component, Suspense, lazy, useMemo, useState, type ComponentType, type ReactNode } from 'react'

/**
 * 业务页面按需加载的薄封装（2026-09-26 P01）。
 *
 * 为什么需要它：
 *   1. `React.lazy` 只认默认导出，本项目多数页面是具名导出，需要在这里统一转换；
 *   2. 分包文件下载失败时，React 会把错误抛给最近的错误边界——没有边界就是整页白屏。
 *      这里给出可读原因和**显式**的恢复入口，不自动刷新、不吞掉页面自身的错误；
 *   3. 恢复方式分两种，因为它们的有效性不同（浏览器实测见回执）：
 *      - 分包没下载下来：同一个文档里**再点也不会重新下载**（实测连点 3 次 0 请求），
 *        只有整页重载会重新发起，所以这种错误只给「重新载入页面」；
 *      - 页面自身渲染报错：重挂载一次就可能好，所以给「重试这个页面」。
 *      给一个点了没用的按钮，比不给按钮更糟。
 *   4. 错误状态属于**某一个页面**：从失败的页面导航去别的页面时要清掉（见 `loadKey`），
 *      否则新页面顶着的还是上一页的错误，与「可以去别的页面继续」那句话自相矛盾。
 */
export type LazyPageLoader<P extends object> = () => Promise<{ default: ComponentType<P> }>

interface BoundaryProps {
  attempt: number
  /**
   * 当前页面身份（就是 `load` 本身）。
   *
   * 为什么需要它：`App.tsx` 里所有路由都写成同一位置、同一类型的 `<LazyRoute>`，
   * React 会**复用这个边界实例**、只替换 props。实例一复用，`state.error` 就跟着留下来 ——
   * 从加载失败的页面点导航去另一个正常页面，屏幕上显示的仍是上一页的错误。
   * 换页等于换了一个页面，上一个页面的错误与它无关，必须清掉。
   */
  loadKey: unknown
  onRetry: () => void
  /** 整页重载。做成 props 是为了能在测试里替换掉浏览器 API。 */
  onReload: () => void
  children: ReactNode
}

interface BoundaryState {
  error: Error | null
}

/** 浏览器加载分包失败的报错文案因内核而异，这里只做「像是没下下来」的判断。 */
function looksLikeChunkFailure(message: string): boolean {
  return /dynamically imported module|module script failed|Loading chunk|Cannot find module/i.test(message)
}

class PageLoadBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (!this.state.error) return
    // 换页：这是上一个页面的错误，不能跟着新页面一起显示。清掉后子节点是新的 lazy 实例，会自己发起加载。
    if (previous.loadKey !== this.props.loadKey) {
      this.setState({ error: null })
      return
    }
    // 重试：清掉错误状态。子节点这时已经是新的 lazy 实例，会重新发起一次加载。
    if (previous.attempt !== this.props.attempt) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const chunkFailure = looksLikeChunkFailure(error.message || '')
    return (
      <section className="wb-page-load-error" role="alert">
        <h2>这个页面没能打开</h2>
        {chunkFailure ? (
          <>
            <p>这一页需要的文件没有下载成功，通常是网络断了，或者刚更新过、文件还没下完。</p>
            <p>这一页还没打开，页面上没有你的输入；已经保存的数据不受影响。也可以先从左边的导航去别的页面继续。</p>
          </>
        ) : (
          <p>这个页面在渲染时报错了。重试一次通常就好了；如果一直这样，请把下面的原因发给管理人员。</p>
        )}
        <p className="wb-page-load-error-detail">{error.message || '未知错误'}</p>
        <div className="wb-page-load-error-actions">
          {chunkFailure ? (
            <button type="button" onClick={this.props.onReload}>
              重新载入页面
            </button>
          ) : (
            <>
              <button type="button" onClick={this.props.onRetry}>
                重试这个页面
              </button>
              <button type="button" onClick={this.props.onReload}>
                刷新整个应用
              </button>
            </>
          )}
        </div>
      </section>
    )
  }
}

interface LazyRouteProps<P extends object> {
  load: LazyPageLoader<P>
  /** 加载提示里显示的页面名，弱网下让店员知道在等哪一页。 */
  label: string
  props: P
  onReload?: () => void
}

export function LazyRoute<P extends object>({ load, label, props, onReload }: LazyRouteProps<P>) {
  const [attempt, setAttempt] = useState(0)
  // load 必须是模块级常量。每次渲染都新建函数会让 lazy 拿到新的组件类型，页面被反复卸载重建。
  const Page = useMemo(() => lazy(load), [load, attempt])
  const reload = onReload ?? (() => window.location.reload())
  return (
    <PageLoadBoundary
      attempt={attempt}
      loadKey={load}
      onRetry={() => setAttempt((count) => count + 1)}
      onReload={reload}
    >
      <Suspense fallback={<div className="settings-state">正在加载{label}…</div>}>
        <Page {...props} />
      </Suspense>
    </PageLoadBoundary>
  )
}
