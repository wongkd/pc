import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TaskCategory } from '../../contracts/generated/enums'
import '../../styles/workbench.css'
import '../../styles/motion.css'
import { StateGraphic } from './StateGraphic'
import { fetchWorkbench, formatWorkbenchCents as formatCents, WORKBENCH_CATEGORY_LABELS as TASK_CATEGORY_LABELS, type WorkbenchAmountSummary, type WorkbenchMetrics, type WorkbenchTask } from './workbench-api'

type ViewMode = 'list' | 'board'
type CategoryFilter = TaskCategory | 'all'
type PhotoVariant = 'row' | 'card' | 'hero'

const METRIC_TILES: Array<{ key: 'pendingDelivery' | 'stockShortage' | 'servicePending'; label: string; filter: CategoryFilter }> = [
  { key: 'pendingDelivery', label: '待交机', filter: 'delivery' },
  { key: 'stockShortage', label: '缺货订单', filter: 'stock_shortage' },
  { key: 'servicePending', label: '维修待办', filter: 'service' },
]

const PHOTO_KIND_LABELS: Record<string, string> = {
  product_reference: '型号示意',
  delivery_evidence: '实物照片',
  service_intake: '实物照片',
  recovery_evidence: '实物照片',
}

/**
 * 缩略图尺寸按变体给（避免加载时布局跳动）：
 * row = 列表行（45×53）、card = 看板卡（88×88）、hero = 详情设备图（按列宽撑满）。
 */
const PHOTO_SIZE: Record<PhotoVariant, { width: number; height: number } | null> = {
  row: { width: 45, height: 53 },
  card: { width: 88, height: 88 },
  hero: null,
}

/** 金额区文案：欠款 / 结清 / 未定价 / 预测，不把应付写成负尾款。 */
function describeAmount(summary: WorkbenchAmountSummary | null): { primary: string; secondary: string | null; tone: 'due' | 'settled' | 'pending' } {
  if (!summary) return { primary: '无金额信息', secondary: null, tone: 'pending' }
  if (!summary.countsTowardReceivable) {
    return summary.estimateCents === null
      ? { primary: '费用待确认', secondary: summary.note, tone: 'pending' }
      : {
          primary: `预计 ¥${formatCents(summary.estimateCents)}`,
          secondary: summary.note ?? '不计确定应收',
          tone: 'pending',
        }
  }
  if (summary.balanceDirection === 'settled' || summary.balanceCents === 0) {
    return {
      primary: '已结清',
      secondary: summary.note ?? `总额 ¥${formatCents(summary.totalCents ?? 0)}`,
      tone: 'settled',
    }
  }
  return {
    primary: `待收 ¥${formatCents(summary.balanceCents ?? 0)}`,
    secondary: `总额 ¥${formatCents(summary.totalCents ?? 0)} · 已收 ¥${formatCents(summary.receivedCents ?? 0)} · 折抵 ¥${formatCents(summary.offsetCents ?? 0)}`,
    tone: 'due',
  }
}

/**
 * 设备图：图片失败或无图时必须保留设备名称（02 §7）。
 *
 * 图片只使用接口返回的附件 URL；
 * `row` 是列表行缩略图（设计稿 45×53），附件类型由 title 承载 ——
 * 行高只有 80–90px，放不下图注，但**不能因此冒充型号或验机照片**。
 * `card` 是看板卡，沿用原有尺寸与可见图注；没有附件或演示 URL 时显示占位。
 */
function DevicePhoto({ task, variant = 'card' }: { task: WorkbenchTask; variant?: PhotoVariant }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const suppliedUrl = task.photoUrl?.trim() || null
  const isDemoUrl = Boolean(
    suppliedUrl?.startsWith('demo://')
    || (suppliedUrl && /(?:^|\/)assets\/workbench\/(?:gpu|laptop|monitor|tower)\.jpg(?:[?#]|$)/i.test(suppliedUrl)),
  )
  const photoUrl = isDemoUrl ? null : suppliedUrl
  const label = isDemoUrl
    ? '演示素材已禁用'
    : photoUrl
      ? task.photoKind ? PHOTO_KIND_LABELS[task.photoKind] ?? '附件图片' : '附件图片'
      : '暂无附件'
  const showImage = Boolean(photoUrl) && failedUrl !== photoUrl
  const size = PHOTO_SIZE[variant]
  return (
    <figure className={`wb-device-photo wb-device-photo--${variant}`}>
      {showImage ? (
        <img
          src={photoUrl ?? ''}
          alt=""
          title={variant === 'row' ? `${label}｜${task.deviceSummary ?? '设备'}` : undefined}
          onError={() => setFailedUrl(photoUrl)}
          loading="lazy"
          decoding="async"
          width={size?.width}
          height={size?.height}
          className="wb-tabular"
        />
      ) : (
        <span className="wb-photo-placeholder">
          <StateGraphic kind="photo" />
          {isDemoUrl ? '演示图片不可用于真实待办' : suppliedUrl ? '图片加载失败' : '暂无图片'}
        </span>
      )}
      {variant !== 'row' && <figcaption>{label}</figcaption>}
    </figure>
  )
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: WorkbenchTask
  selected: boolean
  onSelect: () => void
}) {
  const amount = describeAmount(task.amountSummary)
  return (
    <li>
      <button
        type="button"
        className={`wb-task-row${selected ? ' is-selected' : ''}`}
        aria-current={selected}
        onClick={onSelect}
      >
        <DevicePhoto task={task} variant="row" />
        <span className="wb-task-copy">
          {/* 左栏只有 288–302px 文案区约 226px，放不下「单号 + 期限 + 金额」三个元素
              （实测会把单号拆成两行、期限挤成「今天 1…」）。所以金额与类别标签同排，
              底行只留单号与期限；期限仍可能被截断，完整值由 title 与详情页提供。 */}
          <span className="wb-task-row-top">
            <span className={`wb-tag wb-tag--${task.category}`}>{TASK_CATEGORY_LABELS[task.category]}</span>
            <span className={`wb-amount wb-amount--${amount.tone} wb-tabular`}>{amount.primary}</span>
          </span>
          <span className="wb-task-title">{task.title}</span>
          <span className="wb-task-line">
            {task.customerDisplay ?? '未记客户'} · {task.deviceSummary ?? '未记设备'}
          </span>
          <span className="wb-task-line wb-task-line--muted">
            {task.blockerSummary ?? '无阻塞项'}
          </span>
          <span className="wb-task-row-foot">
            <span className="wb-task-id wb-tabular">{task.entityId}</span>
            <span className="wb-task-deadline wb-tabular" title={task.deadlineText ?? undefined}>
              {task.deadlineText ?? '未约定时间'}
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}

function BoardCard({ task, selected, onSelect }: { task: WorkbenchTask; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        className={`wb-board-card${selected ? ' is-selected' : ''}`}
        aria-current={selected}
        onClick={onSelect}
      >
        <DevicePhoto task={task} />
        <span className="wb-board-copy">
          <span className="wb-task-id wb-tabular">{task.entityId}</span>
          <strong>{task.deviceSummary ?? task.title}</strong>
          <span className="wb-task-line">{task.customerDisplay ?? '未记客户'}</span>
          <span className="wb-caption">{task.deadlineText ?? '未约定时间'}</span>
        </span>
      </button>
    </li>
  )
}

export function WorkbenchTodayPage() {
  const navigate = useNavigate()
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [view, setView] = useState<ViewMode>('list')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [openOrderMenu, setOpenOrderMenu] = useState(false)
  const [notice, setNotice] = useState('')
  const [tasks, setTasks] = useState<WorkbenchTask[]>([])
  const [metrics, setMetrics] = useState<WorkbenchMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await fetchWorkbench()
      if (result.ok) {
        setTasks(result.data.tasks)
        setMetrics(result.data.metrics)
      } else {
        setTasks([])
        setMetrics(null)
        setLoadError(result.message || '今天待办加载失败，请检查网络后重试。')
      }
    } catch (error) {
      setTasks([])
      setMetrics(null)
      setLoadError(error instanceof Error ? error.message : '今天待办加载失败，请检查网络后重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const todayDate = useMemo(() => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', day: 'numeric', month: 'long', weekday: 'long' }).formatToParts(new Date()), [])
  const datePart = (type: string) => todayDate.find((part) => part.type === type)?.value ?? ''
  const ordered = useMemo(() => tasks, [tasks])
  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    return ordered.filter((task) => {
      if (category !== 'all' && task.category !== category) return false
      if (!q) return true
      return [task.entityId, task.taskId, task.title, task.customerDisplay, task.deviceSummary]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q))
    })
  }, [ordered, category, keyword])

  // 派生选中：切换筛选后旧任务若不在结果内，自动落到首条有效任务（02 §3）
  const selected = useMemo(
    () => filtered.find((task) => task.taskId === selectedTaskId) ?? filtered[0] ?? null,
    [filtered, selectedTaskId],
  )

  const startNewOrder = (kind: string, target: string | null) => {
    setOpenOrderMenu(false)
    if (target) {
      navigate(target)
      return
    }
    setNotice(`「${kind}」尚未接通，本卡只建立入口，未提交任何数据。`)
  }

  return (
    <section className="wb-workbench" aria-labelledby="wb-today-title">
      {/* 页头：日期块 + 「今天 / 门店工作台」+ 开单（v3 设计稿桌面结构） */}
      <header className="wb-page-head wb-today-head">
        <div className="wb-date-block">
          <strong className="wb-tabular" aria-hidden="true">
            {datePart('day')}
          </strong>
          <span>
            <span>{datePart('month')}</span>
            <span>{datePart('weekday')}</span>
          </span>
          <span className="wb-visually-hidden">
            当前营业日，{datePart('month')}{datePart('day')}日 {datePart('weekday')}
          </span>
        </div>
        <div className="wb-page-title">
          <p>今天</p>
          <h1 id="wb-today-title">门店工作台</h1>
        </div>
        <div className="wb-page-head-actions">
          <div className="wb-menu-anchor">
            <button
              type="button"
              className="wb-btn wb-btn--primary"
              aria-expanded={openOrderMenu}
              onClick={() => setOpenOrderMenu((open) => !open)}
            >
              ＋ 开单
            </button>
            {openOrderMenu && (
              <div className="wb-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => startNewOrder('装机报价', '/sales/quotes')}>
                  装机报价
                  <small>进入报价编辑器（现有功能）</small>
                </button>
                <button type="button" role="menuitem" onClick={() => startNewOrder('配件零售', null)}>
                  配件零售
                  <small>未接通（T08）</small>
                </button>
                <button type="button" role="menuitem" onClick={() => startNewOrder('维修接收', null)}>
                  维修接收
                  <small>未接通（T12）</small>
                </button>
                <button type="button" role="menuitem" onClick={() => startNewOrder('回收 / 置换', '/recovery')}>
                  回收 / 置换
                  <small>进入回收置换区</small>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {notice && (
        <p className="wb-inline-notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice('')}>
            知道了
          </button>
        </p>
      )}

      {/* 统计条：紧凑横栏，标签与数值同排（02 §9 不做独立卡片；§78 数值可点开来源） */}
      <div className="wb-metrics">
        {METRIC_TILES.map((tile) => (
          <button
            key={tile.key}
            type="button"
            className={`wb-metric${category === tile.filter ? ' is-active' : ''}`}
            aria-pressed={category === tile.filter}
            title={metrics ? `${tile.label} ${metrics[tile.key].value}｜点击按类别筛选待办` : `${tile.label} 统计待获取`}
            onClick={() => setCategory(tile.filter)}
          >
            <span className="wb-metric-label">{tile.label}</span>
            <strong className="wb-tabular">{metrics ? metrics[tile.key].value : '—'}</strong>
            <span className="wb-metric-arrow" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
        <button
          type="button"
          className="wb-metric wb-metric--money"
          title={metrics ? `待收款 ¥${formatCents(metrics.receivable.valueCents)}｜进入账本` : '待收款金额尚未取得'}
          onClick={() => navigate('/finance')}
        >
          <span className="wb-metric-label">待收款</span>
          <strong className="wb-tabular">{metrics ? `¥${formatCents(metrics.receivable.valueCents)}` : '—'}</strong>
          <span className="wb-metric-note">仅计确定应收（不含初估）</span>
        </button>
      </div>

      <div className="wb-workbench-body">
        <div className="wb-list-pane">
          {loadError ? <div className="wb-inv-notice wb-inv-notice--warn">{loadError}<button type="button" className="wb-btn" disabled={loading} onClick={() => void load()}>重试</button></div> : null}
          <div className="wb-list-head">
            <h2>待办事项</h2>
            <span className="wb-tabular">{loading || loadError ? '—' : filtered.length} 项</span>
          </div>

          <div className="wb-view-switch" role="tablist" aria-label="视图切换">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'list'}
              className={view === 'list' ? 'is-active' : ''}
              onClick={() => setView('list')}
            >
              订单处理
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'board'}
              className={view === 'board' ? 'is-active' : ''}
              onClick={() => setView('board')}
            >
              设备看板
            </button>
          </div>

          <label className="wb-field">
            <span className="wb-visually-hidden">在待办中搜索</span>
            <input
              type="search"
              value={keyword}
              placeholder="搜索单号 / 客户 / 设备"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>

          <div className="wb-filter-row" role="group" aria-label="类别筛选">
            <button
              type="button"
              className={category === 'all' ? 'is-active' : ''}
              onClick={() => setCategory('all')}
            >
              全部
            </button>
            {(Object.keys(TASK_CATEGORY_LABELS) as TaskCategory[])
              .filter((key) => key !== 'collection')
              .map((key) => (
                <button
                  key={key}
                  type="button"
                  className={category === key ? 'is-active' : ''}
                  onClick={() => setCategory(key)}
                >
                  {TASK_CATEGORY_LABELS[key]}
                </button>
              ))}
          </div>

          {loading ? <div className="wb-empty"><strong>正在加载今天待办…</strong></div> : loadError ? (
            <div className="wb-empty">
              <strong>待办未能加载</strong>
              <span>重试后才能确认当前事项。</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="wb-empty">
              <StateGraphic />
              <strong>当前筛选没有事项</strong>
              <span>关键词「{keyword || '无'}」、类别「{category === 'all' ? '全部' : TASK_CATEGORY_LABELS[category]}」。</span>
              <button
                type="button"
                className="wb-btn"
                onClick={() => {
                  setKeyword('')
                  setCategory('all')
                }}
              >
                清空筛选
              </button>
            </div>
          ) : view === 'list' ? (
            <ul className="wb-task-list" aria-label="待办列表">
              {filtered.map((task) => (
                <TaskRow
                  key={task.taskId}
                  task={task}
                  selected={selected?.taskId === task.taskId}
                  onSelect={() => setSelectedTaskId(task.taskId)}
                />
              ))}
            </ul>
          ) : (
            <ul className="wb-board" aria-label="待办列表">
              {filtered.map((task) => (
                <BoardCard
                  key={task.taskId}
                  task={task}
                  selected={selected?.taskId === task.taskId}
                  onSelect={() => setSelectedTaskId(task.taskId)}
                />
              ))}
            </ul>
          )}

          <div className="wb-quick-actions">
            <button type="button" onClick={() => navigate('/after-sales')}>
              接收维修
            </button>
            <button type="button" onClick={() => navigate('/inventory')}>
              到货入库
            </button>
          </div>

          <p className="wb-caption wb-caption--block">待办、金额与卡点均来自门店服务；仅计服务端确认的应收。</p>
        </div>

        <div className="wb-detail-pane">
          {loadError ? (
            <div className="wb-empty">
              <strong>待办详情暂不可用</strong>
              <span>工作台接口恢复后，重试即可重新读取。</span>
            </div>
          ) : !selected ? (
            <div className="wb-empty">
              <strong>尚未选择事项</strong>
              <span>从左侧列表选一条，或清空筛选后重试。</span>
            </div>
          ) : (
            <article className="wb-detail">
              <header className="wb-detail-head">
                <p className="wb-kicker wb-tabular">{selected.entityId} · 版本 {selected.entityVersion}</p>
                <h2>{selected.title}</h2>
                <div className="wb-detail-tags">
                  <span className={`wb-tag wb-tag--${selected.category}`}>
                    {TASK_CATEGORY_LABELS[selected.category]}
                  </span>
                  <span className="wb-caption">{selected.deadlineText ?? '未约定时间'}</span>
                </div>
              </header>

              {/* 设备大图与处理区并列（02 §65：1366×768 照片高 220–244px、主动作首屏可见） */}
              <div className="wb-detail-columns">
                <section className="wb-device-column" aria-labelledby="wb-detail-device">
                  <DevicePhoto key={selected.taskId} task={selected} variant="hero" />
                  <div className="wb-device-caption">
                    <h3 id="wb-detail-device">{selected.deviceSummary ?? '未记设备'}</h3>
                    <dl className="wb-facts">
                      <div>
                        <dt>客户</dt>
                        <dd>{selected.customerDisplay ?? '未记客户'}</dd>
                      </div>
                      <div>
                        <dt>约定</dt>
                        <dd>{selected.deadlineText ?? '未约定时间'}</dd>
                      </div>
                    </dl>
                  </div>
                </section>

                <section className="wb-process-panel" aria-labelledby="wb-detail-step">
                  <h3 id="wb-detail-step">当前处理</h3>
                  <p className="wb-detail-blocker">
                    {selected.blockerSummary ?? '当前没有阻塞项。'}
                  </p>
                  <ol className="wb-steps">
                    {['已确认成交', '备货 / 检测', '收款与交付'].map((step, index) => (
                      <li
                        key={step}
                        className={
                          index === 0
                            ? 'is-done'
                            : index === 1 && selected.blockerSummary
                              ? 'is-blocked'
                              : index === 1
                                ? 'is-done'
                                : 'is-todo'
                        }
                      >
                        <span className="wb-tabular">{index + 1}</span>
                        {step}
                      </li>
                    ))}
                  </ol>
                  <p className="wb-caption wb-caption--block">
                    阶段仅作呈现，不可点击改状态（02 §6）。
                  </p>

                  {/* 金额与主动作随处理区走，不再横跨整宽（02 §65 首屏可见） */}
                  <div className="wb-settlement">
                    <div className="wb-settlement-amount">
                      <span className="wb-caption">金额</span>
                      <strong className={`wb-amount wb-amount--${describeAmount(selected.amountSummary).tone} wb-tabular`}>
                        {describeAmount(selected.amountSummary).primary}
                      </strong>
                      {describeAmount(selected.amountSummary).secondary && (
                        <span className="wb-caption">{describeAmount(selected.amountSummary).secondary}</span>
                      )}
                    </div>
                    <div className="wb-detail-action">
                      <button
                        type="button"
                        className="wb-btn wb-btn--primary"
                        disabled={!selected.primaryAction.enabled}
                        onClick={() => {
                          const orderNo = encodeURIComponent(selected.entityId)
                          const target = selected.category === 'delivery'
                            ? `/sales/fulfillment?orderNo=${orderNo}`
                            : selected.category === 'stock_shortage'
                              ? `/inventory/purchases?sourceOrderNo=${orderNo}`
                              : selected.entityType === 'service_order'
                                ? `/after-sales?orderNo=${orderNo}`
                                : selected.entityType === 'recovery_order'
                                  ? `/recovery?orderNo=${orderNo}`
                                  : selected.detailTarget
                          navigate(target)
                        }}
                      >
                        {selected.primaryAction.label}
                      </button>
                      {!selected.primaryAction.enabled &&
                        selected.primaryAction.blockers.map((blocker) => (
                          <span key={blocker.code} className="wb-blocker">
                            阻断：{blocker.message}
                            {blocker.targetPage ? `（去${blocker.targetPage}）` : ''}
                          </span>
                        ))}
                      <button type="button" className="wb-btn" onClick={() => navigate(selected.detailTarget)}>
                        打开完整单据
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </article>
          )}
        </div>
      </div>
    </section>
  )
}
