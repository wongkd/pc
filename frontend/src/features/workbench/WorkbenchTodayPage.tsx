import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DEMO_DATE,
  DEMO_METRICS,
  DEMO_TASKS,
  TASK_CATEGORY_LABELS,
  formatCents,
  sortTasksForDemo,
  type WorkbenchAmountSummary,
  type WorkbenchTask,
} from './demoData'
import type { TaskCategory } from '../../contracts/generated/enums'
import '../../styles/workbench.css'

type ViewMode = 'list' | 'board'
type CategoryFilter = TaskCategory | 'all'

const METRIC_TILES: Array<{ key: string; label: string; value: number; filter: CategoryFilter }> = [
  { key: 'pendingDelivery', label: '待交机', value: DEMO_METRICS.pendingDelivery, filter: 'delivery' },
  { key: 'stockShortage', label: '缺货订单', value: DEMO_METRICS.stockShortage, filter: 'stock_shortage' },
  { key: 'servicePending', label: '维修待办', value: DEMO_METRICS.servicePending, filter: 'service' },
  { key: 'recoveryPending', label: '回收待验机', value: 1, filter: 'recovery' },
]

const PHOTO_KIND_LABELS: Record<string, string> = {
  product_reference: '型号示意',
  delivery_evidence: '实物照片',
  service_intake: '实物照片',
  recovery_evidence: '实物照片',
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

/** 设备摘要：图片失败或无图时必须保留设备名称（02 §7）。 */
function DevicePhoto({ task }: { task: WorkbenchTask }) {
  const [failed, setFailed] = useState(false)
  const label = task.photoKind ? PHOTO_KIND_LABELS[task.photoKind] ?? '图片' : '无图'
  const showImage = Boolean(task.photoUrl) && !failed
  return (
    <figure className="wb-device-photo">
      {showImage ? (
        <img
          src={task.photoUrl ?? ''}
          alt=""
          onError={() => setFailed(true)}
          className="wb-tabular"
        />
      ) : (
        <span className="wb-photo-placeholder">未加载图片</span>
      )}
      <figcaption>{label}</figcaption>
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
        <span className="wb-task-row-top">
          <span className="wb-task-id wb-tabular">{task.entityId}</span>
          <span className={`wb-tag wb-tag--${task.category}`}>{TASK_CATEGORY_LABELS[task.category]}</span>
        </span>
        <span className="wb-task-title">{task.title}</span>
        <span className="wb-task-line">
          {task.customerDisplay ?? '未记客户'} · {task.deviceSummary ?? '未记设备'}
        </span>
        <span className="wb-task-line wb-task-line--muted">
          {task.blockerSummary ?? '无阻塞项'}
        </span>
        <span className="wb-task-row-foot">
          <span className="wb-tabular">{task.deadlineText ?? '未约定时间'}</span>
          <span className={`wb-amount wb-amount--${amount.tone} wb-tabular`}>{amount.primary}</span>
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

  const ordered = useMemo(() => sortTasksForDemo(DEMO_TASKS), [])
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
      <header className="wb-page-head">
        <div>
          <p className="wb-kicker wb-tabular">{DEMO_DATE} · 今天</p>
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
                <button type="button" role="menuitem" onClick={() => startNewOrder('装机报价', '/quotes')}>
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

      <div className="wb-metrics">
        {METRIC_TILES.map((tile) => (
          <button
            key={tile.key}
            type="button"
            className={`wb-metric${category === tile.filter ? ' is-active' : ''}`}
            onClick={() => setCategory(tile.filter)}
          >
            <span className="wb-metric-label">{tile.label}</span>
            <strong className="wb-tabular">{tile.value}</strong>
            <span className="wb-caption">点击查看来源</span>
          </button>
        ))}
        <button type="button" className="wb-metric" onClick={() => navigate('/finance')}>
          <span className="wb-metric-label">待收款</span>
          <strong className="wb-tabular">¥{formatCents(DEMO_METRICS.receivableCents)}</strong>
          <span className="wb-caption">仅计确定应收（不含初估）</span>
        </button>
      </div>

      <div className="wb-workbench-body">
        <div className="wb-list-pane">
          <div className="wb-list-head">
            <h2>待办事项</h2>
            <span className="wb-tabular">{filtered.length} 项</span>
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

          {filtered.length === 0 ? (
            <div className="wb-empty">
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

          <p className="wb-caption wb-caption--block">
            样本数据（ID 前缀 DEMO-），固定演示日期 {DEMO_DATE}，未连接门店服务。
          </p>
        </div>

        <div className="wb-detail-pane">
          {!selected ? (
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

              <div className="wb-detail-columns">
                <section className="wb-detail-block" aria-labelledby="wb-detail-party">
                  <h3 id="wb-detail-party">客户与设备</h3>
                  <dl className="wb-def-list">
                    <div>
                      <dt>客户</dt>
                      <dd>{selected.customerDisplay ?? '未记客户'}</dd>
                    </div>
                    <div>
                      <dt>设备</dt>
                      <dd>{selected.deviceSummary ?? '未记设备'}</dd>
                    </div>
                    <div>
                      <dt>约定</dt>
                      <dd>{selected.deadlineText ?? '未约定时间'}</dd>
                    </div>
                  </dl>
                  <DevicePhoto task={selected} />
                </section>

                <section className="wb-detail-block" aria-labelledby="wb-detail-step">
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
                </section>
              </div>

              <footer className="wb-detail-foot">
                <div>
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
                    onClick={() => setNotice(`「${selected.primaryAction.label}」尚未接通（${selected.primaryAction.code}），未提交任何数据。`)}
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
              </footer>
            </article>
          )}
        </div>
      </div>
    </section>
  )
}
