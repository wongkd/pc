import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import {
  createStockBackfillReferences,
  fetchInventory,
  fetchInventoryStockItems,
  fetchStockItem,
  inspectQuarantinedItem,
  queryOperationResult,
  recordInspectionRework,
  saveProduct,
  writeStockBackfill,
} from './inventory-api'
import type {
  InventoryProductRow,
  InventoryStockItemFilters,
  StockItemDetail,
} from './inventory-api'
import type { InventoryStockItemPagePayload, InspectionStatus, StockBackfillInput } from '../../contracts/v2/generated/inventory-opening'
import type { StockCondition } from '../../contracts/generated/enums'
import { AttachmentPanel } from './AttachmentPanel'
import type { AttachmentView } from './attachment-api'
import { BUCKET_LABELS, CONDITION_LABELS, MOVEMENT_SOURCE_LABELS, costText, formatYuan } from './inventory-view'
import './InventoryPartsWorkspace.css'

const CATEGORIES = ['CPU', '显卡', '主板', '内存', '硬盘', '散热器', '电源', '机箱', '风扇', '显示器', '鼠标', '键盘', '耳机', '座椅', '线材']
const CATEGORY_OTHER = '__other__'
const PAGE_SIZE = 50
const INSPECTION_FILTERS: Array<{ value: InspectionStatus | null; label: string }> = [
  { value: null, label: '全部检测状态' },
  { value: 'pending', label: '待检测' },
  { value: 'passed', label: '已检测' },
  { value: 'failed', label: '有问题' },
  { value: 'unrecorded', label: '历史未记录' },
]
const AVAILABILITY_FILTERS = [
  { value: null, label: '全部库存' },
  { value: 'available' as const, label: '可售' },
  { value: 'reserved' as const, label: '已预留' },
  { value: 'quarantine' as const, label: '待处理' },
]

type EntryItem = { condition: StockCondition; costYuan: string; snRaw: string; remark: string }
type PendingUnknown = { action: 'product' | 'backfill'; requestId: string }

function SourceReferences({ recordId, batchRef, lineRef }: { recordId: string; batchRef?: string | null; lineRef?: string | null }) {
  return (
    <details className="wb-parts-source-refs">
      <summary>查看来源编号</summary>
      <dl>
        <div><dt>记录</dt><dd><code>{recordId}</code></dd></div>
        {batchRef ? <div><dt>批次</dt><dd><code>{batchRef}</code></dd></div> : null}
        {lineRef ? <div><dt>行</dt><dd><code>{lineRef}</code></dd></div> : null}
      </dl>
    </details>
  )
}

function inspectionLabel(value: InspectionStatus): string {
  if (value === 'pending') return '待检测'
  if (value === 'passed') return '已检测'
  if (value === 'failed') return '有问题'
  return '历史未记录'
}

function parseCost(value: string): { cents: number | null; basis: StockBackfillInput['lines'][number]['costBasis'] } | null {
  if (!value.trim()) return { cents: null, basis: 'unknown' }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.trim())) return null
  const [yuan, fraction = ''] = value.trim().split('.')
  const cents = Number(yuan) * 100 + Number((fraction + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents)) return null
  return cents === 0 ? { cents: 0, basis: 'zero_cost' } : { cents, basis: 'known_actual' }
}

function newEntryItem(): EntryItem {
  return { condition: 'used', costYuan: '', snRaw: '', remark: '' }
}

export function InventoryPartsWorkspace({
  permissions,
  onMoreTools,
}: {
  permissions: string[]
  onMoreTools: () => void
}) {
  const initialInventoryQuery = new URLSearchParams(window.location.search).get('q')?.trim() ?? ''
  const initialItemId = new URLSearchParams(window.location.search).get('itemId')?.trim() ?? ''
  const canBackfill = permissions.includes('*') || permissions.includes('inventory/stock-backfill')
  const canEditProduct = permissions.includes('*') || permissions.includes('inventory/product-edit') || permissions.includes('library/edit')
  const canInspect = permissions.includes('*') || permissions.includes('inventory/inspection') || permissions.includes('library/edit')
  const canUploadAttachment = permissions.includes('*') || permissions.includes('attachment/upload') || permissions.includes('library/edit')

  const [payload, setPayload] = useState<InventoryStockItemPagePayload | null>(null)
  const payloadRef = useRef<InventoryStockItemPagePayload | null>(null)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState(initialInventoryQuery)
  const [appliedQuery, setAppliedQuery] = useState(initialInventoryQuery)
  const [category, setCategory] = useState<string | null>(null)
  const [condition, setCondition] = useState<'new' | 'used' | null>(null)
  const [availability, setAvailability] = useState<InventoryStockItemFilters['availability']>(null)
  const [inspectionStatus, setInspectionStatus] = useState<InspectionStatus | null>(null)
  const [listNotice, setListNotice] = useState('')
  const [detail, setDetail] = useState<StockItemDetail | null>(null)
  const [openDetailId, setOpenDetailId] = useState<string | null>(null)
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [detailError, setDetailError] = useState('')
  const [attachments, setAttachments] = useState<AttachmentView[]>([])
  const [inspectionFindings, setInspectionFindings] = useState('')
  const [inspectionEvidence, setInspectionEvidence] = useState<string[]>([])
  const [inspectionResult, setInspectionResult] = useState<'pass' | 'fail'>('pass')
  const [reworkFindings, setReworkFindings] = useState('')
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const [workflowError, setWorkflowError] = useState('')
  const [pendingWorkflowUnknown, setPendingWorkflowUnknown] = useState<{ action: 'inspection' | 'rework'; requestId: string; itemId: string } | null>(null)

  const [entryOpen, setEntryOpen] = useState(false)
  const [entryCategory, setEntryCategory] = useState('CPU')
  const [customCategory, setCustomCategory] = useState('')
  const [model, setModel] = useState('')
  const [brand, setBrand] = useState('')
  const [trackingMode, setTrackingMode] = useState<'item' | 'quantity'>('item')
  const [selectedProduct, setSelectedProduct] = useState<InventoryProductRow | null>(null)
  const [createdProductId, setCreatedProductId] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<InventoryProductRow[]>([])
  const [candidateState, setCandidateState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [candidateError, setCandidateError] = useState('')
  const [itemCount, setItemCount] = useState('1')
  const [entryItems, setEntryItems] = useState<EntryItem[]>([newEntryItem()])
  const [batchNote, setBatchNote] = useState('')
  const [entryBusy, setEntryBusy] = useState(false)
  const [entryError, setEntryError] = useState('')
  const [entryNotice, setEntryNotice] = useState('')
  const [pendingUnknown, setPendingUnknown] = useState<PendingUnknown | null>(null)
  const [backfillRefs, setBackfillRefs] = useState<{ batchRef: string; lineRefs: string[] } | null>(null)
  const entryDialogRef = useRef<HTMLDivElement | null>(null)
  const entryTriggerRef = useRef<HTMLButtonElement | null>(null)

  const readToken = useRef(0)
  const detailReadToken = useRef(0)

  const loadPage = useCallback(async (page: { cursor?: string | null; quantityCursor?: string | null } = {}) => {
    const token = ++readToken.current
    const extending = Boolean(page.cursor || page.quantityCursor)
    const previous = payloadRef.current
    if (extending && previous) setLoadingMore(true)
    else setListState('loading')
    setListError('')
    try {
      const result = await fetchInventoryStockItems({
        q: appliedQuery,
        category,
        condition,
        availability: availability ?? null,
        inspectionStatus,
        limit: PAGE_SIZE,
        cursor: page.cursor ?? undefined,
        quantityCursor: page.quantityCursor ?? undefined,
      })
      if (token !== readToken.current) return
      if (result.ok) {
        const next = extending && previous ? {
          ...result.data,
          items: page.cursor ? [...previous.items, ...result.data.items] : previous.items,
          quantityProducts: page.quantityCursor ? [...previous.quantityProducts, ...result.data.quantityProducts] : previous.quantityProducts,
        } : result.data
        payloadRef.current = next
        setPayload(next)
        setListState('ready')
      } else {
        if (!previous || !extending) setListState('error')
        setListError(result.message || '库存暂时无法读取，请重试。')
      }
    } catch {
      if (token !== readToken.current) return
      if (!previous || !extending) setListState('error')
      setListError('库存暂时无法读取，请重试。')
    } finally {
      if (token === readToken.current) setLoadingMore(false)
    }
  }, [appliedQuery, category, condition, availability, inspectionStatus])

  useEffect(() => { void loadPage() }, [loadPage])

  useEffect(() => {
    if (!entryOpen) return
    const dialog = entryDialogRef.current
    if (!dialog) return

    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute('hidden') && !element.closest('[aria-hidden="true"]'))
    const firstField = dialog.querySelector<HTMLElement>(
      'form input:not([type="hidden"]):not([disabled]), form select:not([disabled]), form textarea:not([disabled])',
    )
    ;(firstField ?? focusableElements()[0] ?? dialog).focus()

    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = focusableElements()
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keepFocusInDialog, true)
    return () => {
      document.removeEventListener('keydown', keepFocusInDialog, true)
      if (entryTriggerRef.current?.isConnected) entryTriggerRef.current.focus()
    }
  }, [entryOpen])

  const applySearch = (event: FormEvent) => {
    event.preventDefault()
    setAppliedQuery(query.trim())
  }

  const clearFilters = () => {
    setQuery('')
    setAppliedQuery('')
    setCategory(null)
    setCondition(null)
    setAvailability(null)
    setInspectionStatus(null)
  }

  const openDetail = async (id: string) => {
    if (openDetailId === id) {
      detailReadToken.current += 1
      setOpenDetailId(null)
      setDetail(null)
      setDetailState('idle')
      return
    }
    const token = ++detailReadToken.current
    setOpenDetailId(id)
    setDetail(null)
    setDetailError('')
    setWorkflowError('')
    setInspectionFindings('')
    setInspectionEvidence([])
    setReworkFindings('')
    setDetailState('loading')
    let result: Awaited<ReturnType<typeof fetchStockItem>>
    try {
      result = await fetchStockItem(id)
    } catch {
      if (token !== detailReadToken.current) return
      setDetailState('error')
      setDetailError('连接暂时不可用，配件详情没有读取，请重试。')
      return
    }
    if (token !== detailReadToken.current) return
    if (!result.ok) {
      setDetailState('error')
      setDetailError(result.message || '配件详情暂时无法读取。')
      return
    }
    setDetail(result.data)
    setAttachments(result.data.attachments)
    setDetailState('ready')
  }

  useEffect(() => {
    if (!initialItemId) return
    let active = true
    const token = ++detailReadToken.current
    void fetchStockItem(initialItemId).then((result) => {
      if (!active || token !== detailReadToken.current) return
      setOpenDetailId(initialItemId)
      if (!result.ok) {
        setDetailState('error')
        setDetailError(result.message || '配件详情暂时无法读取。')
        return
      }
      setDetail(result.data)
      setAttachments(result.data.attachments)
      setDetailState('ready')
      setQuery(result.data.item.assetCode)
      setAppliedQuery(result.data.item.assetCode)
    }).catch(() => {
      if (!active || token !== detailReadToken.current) return
      setOpenDetailId(initialItemId)
      setDetailState('error')
      setDetailError('连接暂时不可用，配件详情没有读取，请重试。')
    })
    return () => { active = false; detailReadToken.current += 1 }
  }, [initialItemId])

  const refreshDetail = async (id: string) => {
    const token = ++detailReadToken.current
    setDetailState('loading')
    setDetailError('')
    let result: Awaited<ReturnType<typeof fetchStockItem>>
    try {
      result = await fetchStockItem(id)
    } catch {
      if (token !== detailReadToken.current) return
      setDetailState('error')
      setDetailError('连接暂时不可用，配件详情没有读取，请重试。')
      return
    }
    if (token !== detailReadToken.current) return
    if (!result.ok) {
      setDetailState('error')
      setDetailError(result.message || '配件详情暂时无法读取。')
      return
    }
    setDetail(result.data)
    setAttachments(result.data.attachments)
    setDetailState('ready')
  }

  const runInspection = async () => {
    if (!detail || !inspectionFindings.trim()) {
      setWorkflowError('请填写检测发现。')
      return
    }
    if (inspectionResult === 'pass' && inspectionEvidence.length === 0) {
      setWorkflowError('检测通过需要至少一份检测图片作为记录。')
      return
    }
    setWorkflowBusy(true)
    setWorkflowError('')
    let result: Awaited<ReturnType<typeof inspectQuarantinedItem>>
    try {
      result = await inspectQuarantinedItem({
        itemId: detail.item.id,
        expectedVersion: detail.item.version,
        result: inspectionResult,
        findings: inspectionFindings.trim(),
        evidence: inspectionEvidence,
        disposition: inspectionResult === 'pass' ? 'available' : 'quarantine',
      })
    } catch {
      setWorkflowBusy(false)
      setWorkflowError('网络暂时不可用，检测内容已保留，请检查后重试。')
      return
    }
    setWorkflowBusy(false)
    if (!result.ok) {
      if (result.unknownResult && result.requestId) {
        setPendingWorkflowUnknown({ action: 'inspection', requestId: result.requestId, itemId: detail.item.id })
        setWorkflowError('检测请求结果暂未确认。先查询这次操作，再决定下一步。')
      } else setWorkflowError(result.message || '检测记录没有保存，请检查后重试。')
      return
    }
    setListNotice(inspectionResult === 'pass' ? '检测已记录，配件已转为可售。' : '检测已记录，配件仍在待处理。')
    await refreshDetail(detail.item.id)
    await loadPage()
  }

  const submitRework = async () => {
    if (!detail || !reworkFindings.trim()) {
      setWorkflowError('请填写返修完成情况。')
      return
    }
    setWorkflowBusy(true)
    setWorkflowError('')
    let result: Awaited<ReturnType<typeof recordInspectionRework>>
    try {
      result = await recordInspectionRework(detail.item.id, {
        expectedVersion: detail.item.version,
        findings: reworkFindings.trim(),
      })
    } catch {
      setWorkflowBusy(false)
      setWorkflowError('网络暂时不可用，返修情况已保留，请检查后重试。')
      return
    }
    setWorkflowBusy(false)
    if (!result.ok) {
      if (result.unknownResult && result.requestId) {
        setPendingWorkflowUnknown({ action: 'rework', requestId: result.requestId, itemId: detail.item.id })
        setWorkflowError('返修请求结果暂未确认。先查询这次操作，再决定下一步。')
      } else setWorkflowError(result.message || '返修记录没有保存。')
      return
    }
    setListNotice('返修完成情况已记录，接下来需要重新检测。')
    setReworkFindings('')
    await refreshDetail(detail.item.id)
    await loadPage()
  }

  const checkWorkflowUnknown = async () => {
    if (!pendingWorkflowUnknown) return
    setWorkflowBusy(true)
    setWorkflowError('')
    const pending = pendingWorkflowUnknown
    let status: Awaited<ReturnType<typeof queryOperationResult>>
    try {
      status = await queryOperationResult(pending.requestId)
    } catch {
      setWorkflowBusy(false)
      setWorkflowError('暂时无法查询操作结果，请稍后重试。')
      return
    }
    setWorkflowBusy(false)
    if (status.status === 'pending') {
      setWorkflowError('后台仍在处理，请稍后再查询。')
      return
    }
    setPendingWorkflowUnknown(null)
    if (status.status === 'succeeded') {
      setListNotice(pending.action === 'inspection' ? '检测记录已由后台确认完成。' : '返修记录已由后台确认完成。')
      await refreshDetail(pending.itemId)
      await loadPage()
      return
    }
    await refreshDetail(pending.itemId)
    setWorkflowError(status.status === 'failed'
      ? status.message || '后台确认这次操作没有完成；已重新读取当前状态。'
      : '后台没有找到这次操作；已重新读取当前状态，请核对后再继续。')
  }

  const openEntry = () => {
    setEntryOpen(true)
    setEntryError('')
    setEntryNotice('')
  }

  const searchProducts = async () => {
    const term = model.trim()
    if (!term) {
      setCandidateError('先填写型号或规格，再查找已登记型号。')
      setCandidateState('error')
      return
    }
    setCandidateState('loading')
    setCandidateError('')
    let result: Awaited<ReturnType<typeof fetchInventory>>
    try {
      result = await fetchInventory({ q: term, limit: 100 })
    } catch {
      setCandidateState('error')
      setCandidateError('网络暂时不可用，型号查询内容已保留，请重试。')
      return
    }
    if (!result.ok) {
      setCandidateState('error')
      setCandidateError(result.message || '型号查询失败，请稍后重试。')
      return
    }
    setCandidates(result.data.items.filter((item) => item.status === 'active'))
    setCandidateState('ready')
  }

  const chooseProduct = (product: InventoryProductRow) => {
    setSelectedProduct(product)
    setCreatedProductId(null)
    setEntryCategory(product.category)
    setModel(product.name)
    setBrand(product.brand ?? '')
    setTrackingMode(product.trackingMode)
    setCandidates([])
    setCandidateState('idle')
    setEntryError('')
  }

  const updateItemCount = (value: string) => {
    setItemCount(value)
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) return
    setEntryItems((current) => Array.from({ length: parsed }, (_, index) => current[index] ?? newEntryItem()))
  }

  const updateEntryItem = (index: number, patch: Partial<EntryItem>) => {
    setEntryItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  }

  const ensureDraftProduct = async (): Promise<string | null> => {
    if (selectedProduct) return selectedProduct.id
    if (createdProductId) return createdProductId
    const actualCategory = entryCategory === CATEGORY_OTHER ? customCategory.trim() : entryCategory.trim()
    const actualModel = model.trim()
    if (!actualCategory || !actualModel) {
      setEntryError('先填写配件类别和型号 / 规格。')
      return null
    }
    if (!canEditProduct) {
      setEntryError('当前账号不能新建型号资料，请先从更多中选择已登记型号，或联系负责人。')
      return null
    }
    setEntryBusy(true)
    setEntryError('')
    try {
      const created = await saveProduct({
        name: actualModel,
        sku: null,
        category: actualCategory,
        brand: brand.trim() || null,
        specs: null,
        defaultSalePriceCents: 0,
        trackingMode,
        requiresSn: false,
        status: 'active',
      })
      if (!created.ok) {
        if (created.unknownResult && created.requestId) {
          setPendingUnknown({ action: 'product', requestId: created.requestId })
          setEntryError('型号资料保存结果暂未确认。先查询结果，再继续办理。')
          return null
        }
        setEntryError(created.message || '型号资料没有保存。')
        return null
      }
      const productId = created.data.entityId
      if (!productId) {
        setEntryError('型号资料已保存，但没有返回可用编号。请重新查找后继续。')
        return null
      }
      setCreatedProductId(productId)
      setEntryNotice('型号资料已保存；尚未登记库存。')
      return productId
    } catch {
      setEntryError('网络暂时不可用，登记内容已保留，请检查后重试。')
      return null
    } finally {
      setEntryBusy(false)
    }
  }

  const openPurchaseDraft = async () => {
    setEntryError('')
    const count = Number(itemCount)
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      setEntryError('数量须为 1 至 50 的整数。')
      return
    }
    const sourceItems = trackingMode === 'item' ? entryItems.slice(0, count) : [entryItems[0] ?? newEntryItem()]
    if (trackingMode === 'item' && sourceItems.some((item) => item.costYuan.trim() !== (sourceItems[0]?.costYuan ?? '').trim())) {
      setEntryError('采购单按型号填写统一的单位成本；这批配件成本不同，请分开转采购，或在到货时逐件核对。')
      return
    }
    if (trackingMode === 'item' && sourceItems.some((item) => item.condition !== sourceItems[0]?.condition)) {
      setEntryError('同一笔到货只能登记一种成色；请分开办理新品和二手配件。')
      return
    }
    if (trackingMode === 'item' && sourceItems.some((item) => item.remark.trim() !== (sourceItems[0]?.remark ?? '').trim())) {
      setEntryError('同一笔到货目前共用一条状况说明；请整理为相同说明后转入，或分开办理。')
      return
    }
    const productId = await ensureDraftProduct()
    if (!productId) return
    const params = new URLSearchParams({ new: '1', productRef: productId, qty: String(count) })
    const productCategory = selectedProduct?.category ?? (entryCategory === CATEGORY_OTHER ? customCategory.trim() : entryCategory.trim())
    const productName = selectedProduct?.name ?? model.trim()
    params.set('productLabel', `${productCategory} · ${productName}`)
    const costYuan = (entryItems[0]?.costYuan ?? '').trim()
    if (costYuan) params.set('costYuan', costYuan)
    params.set('receiptCondition', sourceItems[0]?.condition ?? 'used')
    if (trackingMode === 'item') params.set('receiptSerials', JSON.stringify(sourceItems.map((item) => item.snRaw.trim())))
    if (sourceItems[0]?.remark.trim()) params.set('receiptItemRemark', sourceItems[0].remark.trim())
    if (batchNote.trim()) params.set('receiptBatchRemark', batchNote.trim())
    window.location.assign('/purchases?' + params.toString())
  }

  const openRecoveryDraft = () => {
    setEntryError('')
    if (trackingMode !== 'item' || Number(itemCount) !== 1) {
      setEntryError('回收草稿目前按单件录入，请先将数量设为 1，并选择逐件记录。')
      return
    }
    const actualCategory = selectedProduct?.category ?? (entryCategory === CATEGORY_OTHER ? customCategory.trim() : entryCategory.trim())
    const actualModel = selectedProduct?.name ?? model.trim()
    if (!actualCategory || !actualModel) {
      setEntryError('先填写配件类别和型号 / 规格。')
      return
    }
    const item = entryItems[0] ?? newEntryItem()
    const params = new URLSearchParams({
      create: '1',
      draftDescription: actualCategory + ' · ' + actualModel,
      draftSn: item.snRaw.trim(),
      draftNote: [item.condition === 'new' ? '申报成色：新品' : '申报成色：二手', item.remark.trim()].filter(Boolean).join('；'),
    })
    window.location.assign('/recovery?' + params.toString())
  }

  const submitEntry = async (event: FormEvent) => {
    event.preventDefault()
    setEntryError('')
    setEntryNotice('')
    if (!canBackfill) {
      setEntryError('当前账号没有登记库存的权限，请联系负责人。')
      return
    }
    const actualCategory = selectedProduct?.category ?? (entryCategory === CATEGORY_OTHER ? customCategory.trim() : entryCategory.trim())
    const actualModel = selectedProduct?.name ?? model.trim()
    if (!actualCategory) { setEntryError('请选择配件类别。'); return }
    if (!actualModel) { setEntryError('请填写型号或规格。'); return }
    const count = trackingMode === 'item' ? Number(itemCount) : Number(itemCount)
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      setEntryError('数量须为 1 至 50 的整数。')
      return
    }
    if (trackingMode === 'item' && entryItems.length !== count) {
      setEntryError('请检查每件配件的明细。')
      return
    }
    const sourceItems = trackingMode === 'item' ? entryItems : [entryItems[0] ?? newEntryItem()]
    const parsedCosts = sourceItems.map((item) => parseCost(item.costYuan))
    if (parsedCosts.some((cost) => cost === null)) {
      setEntryError('成本金额格式无效；未知成本可以留空。')
      return
    }
    if (trackingMode === 'item' && selectedProduct?.requiresSn && sourceItems.some((item) => !item.snRaw.trim())) {
      setEntryError('该型号要求填写厂家编号，请补全后再登记。')
      return
    }

    setEntryBusy(true)
    try {
      let productId = createdProductId ?? selectedProduct?.id ?? null
      if (!selectedProduct && !productId) {
        if (!canEditProduct) {
          setEntryError('当前账号不能新建型号资料，请联系负责人。')
          return
        }
        const created = await saveProduct({
          name: actualModel,
          sku: null,
          category: actualCategory,
          brand: brand.trim() || null,
          specs: null,
          defaultSalePriceCents: 0,
          trackingMode,
          requiresSn: false,
          status: 'active',
        })
        if (!created.ok) {
          if (created.unknownResult && created.requestId) {
            setPendingUnknown({ action: 'product', requestId: created.requestId })
            setEntryError('型号资料保存结果暂未确认。先查询结果，确认后再登记库存。')
            return
          }
          setEntryError(created.message || '型号资料没有保存。')
          return
        }
        productId = created.data.entityId
        if (!productId) {
          setEntryError('型号资料已保存，但未返回可用编号。请重新查找型号后继续登记。')
          return
        }
        setCreatedProductId(productId)
        setEntryNotice('型号资料已保存。库存还未登记，核对下面的信息后继续。')
      }
      if (!productId) {
        setEntryError('没有找到可登记的型号，请重试。')
        return
      }

      const lineCount = trackingMode === 'item' ? count : 1
      const refs = backfillRefs?.lineRefs.length === lineCount
        ? backfillRefs
        : createStockBackfillReferences(lineCount)
      setBackfillRefs(refs)
      const lines: StockBackfillInput['lines'] = sourceItems.map((item, index) => {
        const cost = parsedCosts[index] as NonNullable<(typeof parsedCosts)[number]>
        return {
          lineRef: refs.lineRefs[index],
          productRef: productId as string,
          qty: trackingMode === 'item' ? 1 : count,
          ...(trackingMode === 'item' ? { condition: item.condition } : {}),
          ...(trackingMode === 'item' && item.snRaw.trim() ? { snRaw: item.snRaw.trim() } : {}),
          ...(item.remark.trim() ? { remark: item.remark.trim() } : {}),
          costBasis: cost.basis,
          ...(cost.cents === null ? {} : { unitCostCents: cost.cents }),
        }
      })
      const result = await writeStockBackfill({
        batchRef: refs.batchRef,
        note: batchNote.trim() || null,
        lines,
      })
      if (!result.ok) {
        if (result.unknownResult && result.requestId) {
          setPendingUnknown({ action: 'backfill', requestId: result.requestId })
          setEntryError('库存登记结果暂未确认。先查询结果，确认后再尝试。')
          return
        }
        setEntryError(result.message || '库存没有登记，请检查信息后重试。')
        return
      }
      const summary = '已登记 ' + count + ' 件 ' + actualCategory + ' · ' + actualModel
      setEntryOpen(false)
      setCreatedProductId(null)
      setSelectedProduct(null)
      setBackfillRefs(null)
      setEntryItems([newEntryItem()])
      setItemCount('1')
      setBatchNote('')
      setModel('')
      setBrand('')
      setEntryCategory('CPU')
      setTrackingMode('item')
      setListNotice(summary)
      await loadPage()
    } catch {
      setEntryError('网络暂时不可用，登记内容已保留；如型号资料已保存，可继续登记库存。')
    } finally {
      setEntryBusy(false)
    }
  }

  const checkUnknown = async () => {
    if (!pendingUnknown) return
    setEntryBusy(true)
    let status: Awaited<ReturnType<typeof queryOperationResult>>
    try {
      status = await queryOperationResult(pendingUnknown.requestId)
    } catch {
      setEntryBusy(false)
      setEntryError('暂时无法查询操作结果，请稍后重试。')
      return
    }
    setEntryBusy(false)
    if (status.status === 'pending') {
      setEntryError('后台仍在处理，请稍后再查询。')
      return
    }
    if (status.status === 'unknown') {
      setPendingUnknown(null)
      setEntryError('后台没有找到这次请求。当前输入和补录编号已保留，可以重新提交。')
      return
    }
    if (status.status === 'failed') {
      setPendingUnknown(null)
      setEntryError(status.message || '这次请求没有完成，检查信息后可以重试。')
      return
    }
    if (pendingUnknown.action === 'product') {
      if (!status.resultRef) {
        setPendingUnknown(null)
        setEntryError('后台确认型号资料已保存，但未返回编号。请重新查询型号后继续登记。')
        return
      }
      setCreatedProductId(status.resultRef)
      setPendingUnknown(null)
      setEntryError('')
      setEntryNotice('型号资料已保存。库存还未登记，请核对后继续。')
      return
    }
    setPendingUnknown(null)
    setEntryOpen(false)
    setBackfillRefs(null)
    setEntryItems([newEntryItem()])
    setItemCount('1')
    setBatchNote('')
    setListNotice(status.message || '库存登记已确认完成。')
    await loadPage()
  }

  const usedRows = payload?.items ?? []
  const quantityRows = payload?.quantityProducts ?? []
  const categoryRows = payload?.categoryCounts ?? []
  const inspectionCounts = new Map((payload?.inspectionCounts ?? []).map((item) => [item.inspectionStatus, item.itemCount]))
  const totalOwned = payload?.totals.ownOnHandQty ?? 0
  return (
    <div className="wb-page wb-parts-workspace">
      <header className="wb-page-head wb-parts-head">
        <div>
          <p className="wb-kicker">配件库存</p>
          <h1>仓库</h1>
          <p className="wb-caption">按配件类别找货，逐件查看成色、检测情况和成本。</p>
        </div>
        <div className="wb-page-head-actions">
          {canBackfill ? <button ref={entryTriggerRef} type="button" className="wb-btn wb-btn--primary" onClick={openEntry}>登记配件</button> : null}
          <button type="button" className="wb-btn" onClick={onMoreTools}>更多</button>
        </div>
      </header>
      <nav className="wb-parts-source-links" aria-label="按业务来源登记">
        <span>按来源办理</span>
        <a href="/purchases?new=1">新买到货</a>
        <a href="/recovery?create=1">回收 / 置换</a>
        <a href="/recovery">查看回收 / 拆件单</a>
      </nav>

      {listNotice ? <p className="wb-inv-notice">{listNotice}<button type="button" className="wb-btn" onClick={() => setListNotice('')}>知道了</button></p> : null}
      {payload ? (
        <div className="wb-parts-summary">
          <span>自有在库 <b>{totalOwned}</b> 件</span>
          <span>可售 <b>{payload.totals.availableQty}</b></span>
          <span>已预留 <b>{payload.totals.reservedQty}</b></span>
          <span>待处理 <b>{payload.totals.quarantineQty}</b></span>
          <span>待检测 <b>{inspectionCounts.get('pending') ?? 0}</b> 件</span>
        </div>
      ) : null}

      <nav className="wb-parts-categories" aria-label="配件类别">
        <button type="button" className={!category ? 'is-selected' : ''} onClick={() => setCategory(null)}>全部配件</button>
        {categoryRows.map((item) => {
          const count = item.metrics.itemCount + item.metrics.quantityTrackedQty
          return <button key={item.category} type="button" className={category === item.category ? 'is-selected' : ''} onClick={() => setCategory(item.category)}>{item.category}<span>{count}</span></button>
        })}
      </nav>

      <form className="wb-parts-search" onSubmit={applySearch}>
        <label className="wb-field">
          <span>查找配件</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="型号、规格、内部编号或厂家编号" />
        </label>
        <button className="wb-btn wb-btn--primary" type="submit">搜索</button>
        <button className="wb-btn" type="button" onClick={clearFilters}>清除筛选</button>
      </form>

      <div className="wb-parts-filters">
        <label className="wb-field"><span>库存状态</span><select value={availability ?? ''} onChange={(event) => setAvailability((event.target.value || null) as InventoryStockItemFilters['availability'])}>{AVAILABILITY_FILTERS.map((item) => <option key={item.label} value={item.value ?? ''}>{item.label}</option>)}</select></label>
        <label className="wb-field"><span>检测情况</span><select value={inspectionStatus ?? ''} onChange={(event) => setInspectionStatus((event.target.value || null) as InspectionStatus | null)}>{INSPECTION_FILTERS.map((item) => <option key={item.label} value={item.value ?? ''}>{item.label}{item.value ? ' · ' + (inspectionCounts.get(item.value) ?? 0) : ''}</option>)}</select></label>
        <label className="wb-field"><span>成色</span><select value={condition ?? ''} onChange={(event) => setCondition((event.target.value || null) as 'new' | 'used' | null)}><option value="">全部成色</option><option value="used">二手</option><option value="new">新品</option></select></label>
      </div>

      {listState === 'loading' ? <p className="wb-parts-state" role="status">正在读取库存…</p> : null}
      {listState === 'error' ? <div className="wb-parts-state wb-parts-state--error"><p>{listError}</p><button type="button" className="wb-btn" onClick={() => void loadPage()}>重试</button></div> : null}
      {listState === 'ready' && payload ? (
        <section className="wb-parts-results" aria-label="配件库存列表">
          {listError ? <p className="wb-form-error" role="alert">{listError}</p> : null}
          {usedRows.length === 0 && quantityRows.length === 0 ? (
            <div className="wb-parts-empty">
              <h2>{appliedQuery || category ? '没有找到符合条件的配件' : '还没有登记配件'}</h2>
              <p>{appliedQuery || category ? '调整搜索内容或筛选条件后再试。' : '登记店里已有的配件，库存会按类别显示在这里。'}</p>
              {appliedQuery || category ? <button type="button" className="wb-btn" onClick={clearFilters}>清除筛选</button> : canBackfill ? <button type="button" className="wb-btn wb-btn--primary" onClick={openEntry}>登记第一件配件</button> : null}
            </div>
          ) : (
            <>
              {usedRows.map((item) => (
                <article className={'wb-parts-item' + (openDetailId === item.id ? ' is-open' : '')} key={item.id}>
          <button type="button" className="wb-parts-item-main" aria-expanded={openDetailId === item.id} onClick={() => void openDetail(item.id)}>
                    <span className="wb-parts-item-copy"><span className="wb-parts-item-category">{item.category}</span><strong>{item.productName}</strong><small>{item.brand ? item.brand + ' · ' : ''}{item.assetCode} · {item.remark || '暂无状况说明'}</small></span>
                    <span className="wb-parts-item-meta"><b>{CONDITION_LABELS[item.condition]}</b><span>{inspectionLabel(item.inspectionStatus)}</span><span>{BUCKET_LABELS[item.availability]}</span></span>
                    {'acquisitionCostCents' in item ? <span className="wb-parts-item-cost">{item.costKnown ? costText(item.acquisitionCostCents ?? null, true) : item.assessedEstimateCents != null ? '估值 ' + formatYuan(item.assessedEstimateCents) : '待确认'}</span> : null}
                  </button>
                  {openDetailId === item.id ? (
                    <div className="wb-parts-detail">
                      {detailState === 'loading' ? <p>正在读取详情…</p> : null}
                      {detailState === 'error' ? <p className="wb-form-error">{detailError}<button type="button" className="wb-btn" onClick={() => void refreshDetail(item.id)}>重试</button></p> : null}
                      {detailState === 'ready' && detail ? (
                        <>
                          <dl className="wb-parts-detail-grid">
                            <div><dt>内部编号</dt><dd>{detail.item.assetCode}</dd></div>
                            <div><dt>厂家编号</dt><dd>{detail.item.snRaw || '未填写'}</dd></div>
                            <div><dt>成色</dt><dd>{CONDITION_LABELS[detail.item.condition]}</dd></div>
                            <div><dt>库存状态</dt><dd>{BUCKET_LABELS[detail.item.availability]}</dd></div>
                            <div><dt>检测情况</dt><dd>{inspectionLabel(detail.item.inspectionStatus)}</dd></div>
                            <div><dt>登记来源</dt><dd>
                              {detail.sourceRecord?.kind === 'purchase_order' ? <><a href={'/purchases?purchaseId=' + encodeURIComponent(detail.sourceRecord.recordId)}>采购单 {detail.sourceRecord.displayCode || detail.sourceRecord.recordId}</a><SourceReferences recordId={detail.sourceRecord.recordId} /></>
                                : detail.sourceRecord?.kind === 'quick_purchase' ? <>快速采购到货 · {detail.sourceRecord.displayCode || '来源记录'}<SourceReferences recordId={detail.sourceRecord.recordId} /></>
                                  : detail.sourceRecord?.kind === 'recovery_order' ? <><a href={'/recovery?orderId=' + encodeURIComponent(detail.sourceRecord.recordId)}>回收 / 拆件单 {detail.sourceRecord.displayCode || detail.sourceRecord.recordId}</a><SourceReferences recordId={detail.sourceRecord.recordId} /></>
                                    : detail.sourceRecord?.kind === 'stock_backfill' ? <>店里已有配件补录<SourceReferences recordId={detail.sourceRecord.recordId} batchRef={detail.backfill?.batchRef ?? detail.sourceRecord.displayCode} lineRef={detail.backfill?.lineRef} /></>
                                      : detail.sourceRecord?.kind === 'opening' ? <>期初登记 · {detail.sourceRecord.displayCode || '来源记录'}<SourceReferences recordId={detail.sourceRecord.recordId} /></>
                                        : detail.sourceRecord?.kind === 'unresolved' ? <>来源记录<SourceReferences recordId={detail.sourceRecord.recordId} /></>
                                          : '未记录来源'}
                            </dd></div>
                            {'acquisitionCostCents' in detail.item ? <div><dt>单件成本</dt><dd>{detail.item.costKnown ? costText(detail.item.acquisitionCostCents ?? null, true) : detail.item.assessedEstimateCents != null ? '估值 ' + formatYuan(detail.item.assessedEstimateCents) : '待确认'}</dd></div> : null}
                          </dl>
                          <p className="wb-parts-detail-movements">库存记录：{detail.movements.length ? detail.movements.slice(0, 5).map((move) => MOVEMENT_SOURCE_LABELS[move.source] + ' ' + (move.qty > 0 ? '+' : '') + move.qty).join('；') : '暂无流水'}</p>
                          {detail.inspectionEvents.length ? <ol className="wb-parts-events">{detail.inspectionEvents.map((event) => <li key={event.id}><b>{event.eventType === 'rework' ? '返修完成' : event.result === 'pass' ? '检测通过' : '检测未通过'}</b><span>{event.findings}</span><time>{new Date(event.recordedAt).toLocaleString('zh-CN')}</time></li>)}</ol> : <p className="wb-form-hint">这件配件还没有检测记录。</p>}
                          {workflowError && !pendingWorkflowUnknown ? <p className="wb-form-error">{workflowError}</p> : null}
                          {pendingWorkflowUnknown ? <p className="wb-inv-notice wb-inv-notice--warn">{workflowError}<button type="button" className="wb-btn" disabled={workflowBusy} onClick={() => void checkWorkflowUnknown()}>{workflowBusy ? '正在查询…' : '查询这次操作'}</button></p> : null}
                          {detail.item.availability === 'available'
                            ? <p className="wb-parts-next">这件配件已可售。{detail.item.condition === 'used'
                              ? <a href={'/sales/quotes?stockItemId=' + encodeURIComponent(detail.item.id) + '&stockCode=' + encodeURIComponent(detail.item.assetCode)}>在报价中使用这件配件</a>
                              : <a href="/sales/quotes">在报价中选择</a>}</p>
                            : detail.item.availability === 'reserved'
                              ? <p className="wb-parts-next">这件配件已预留，关联单据：{detail.activeReservation?.orderRef || '待查看销售记录'}</p>
                              : detail.item.availability === 'quarantine' && (detail.item.inspectionStatus === 'pending' || detail.item.inspectionStatus === 'unrecorded')
                                ? <p className="wb-parts-next">下一步：完成检测后才能转为可售。</p>
                                : detail.item.availability === 'quarantine' && detail.item.inspectionStatus === 'failed'
                                  ? <p className="wb-parts-next">下一步：记录返修完成，再重新检测。</p>
                                  : null}
                          <p className="wb-parts-next"><a href={'/purchases?' + new URLSearchParams({ new: '1', productRef: detail.product.id, productLabel: `${item.category} · ${item.productName}` }).toString()}>新购同型号配件</a></p>
                          {detail.item.availability === 'quarantine' && canInspect && detail.item.inspectionStatus !== 'failed' ? (
                            <div className="wb-parts-workflow">
                              <h3>记录检测</h3>
                              <label className="wb-field"><span>检测结论</span><select value={inspectionResult} onChange={(event) => setInspectionResult(event.target.value as 'pass' | 'fail')}><option value="pass">检测正常</option><option value="fail">发现问题，继续待处理</option></select></label>
                              <label className="wb-field"><span>检测发现</span><textarea value={inspectionFindings} onChange={(event) => setInspectionFindings(event.target.value)} placeholder="写下实际检查到的情况" /></label>
                              <AttachmentPanel attachments={attachments} ownerType="stock_item" ownerId={detail.item.id} canUpload={canUploadAttachment} onUploaded={(attachment) => { setAttachments((current) => [...current, attachment]); setInspectionEvidence((current) => [...current, attachment.id]) }} />
                              <div className="wb-parts-actions"><button type="button" className="wb-btn wb-btn--primary" disabled={workflowBusy} onClick={() => void runInspection()}>{workflowBusy ? '正在保存…' : inspectionResult === 'pass' ? '保存检测并转为可售' : '保存检测并留在待处理'}</button></div>
                            </div>
                          ) : null}
                          {detail.item.availability === 'quarantine' && canInspect && detail.item.inspectionStatus === 'failed' ? (
                            <div className="wb-parts-workflow">
                              <h3>返修后重新检测</h3>
                              <p className="wb-form-hint">先记录已完成的返修，再重新检查；这件配件完成复检前仍不可售。</p>
                              <label className="wb-field"><span>返修完成情况</span><textarea value={reworkFindings} onChange={(event) => setReworkFindings(event.target.value)} placeholder="填写实际完成的维修内容" /></label>
                              <button type="button" className="wb-btn wb-btn--primary" disabled={workflowBusy} onClick={() => void submitRework()}>{workflowBusy ? '正在保存…' : '记录返修完成'}</button>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
              {quantityRows.map((item) => (
                <article className="wb-parts-item wb-parts-item--quantity" key={'quantity-' + item.id}>
                  <div>
                    <div className="wb-parts-item-main">
                      <span className="wb-parts-item-copy"><span className="wb-parts-item-category">{item.category} · 按数量</span><strong>{item.name}</strong><small>{item.brand ? item.brand + ' · ' : ''}{item.sku || '未设置编号'}</small></span>
                      <span className="wb-parts-item-meta"><b>在库 {item.ownOnHandQty}</b><span>可售 {item.availableQty}</span><span>待处理 {item.quarantineQty}</span></span>
                      {'totalCostCents' in item ? <span className="wb-parts-item-cost">{item.costKnown ? costText(item.totalCostCents ?? null, true) : '待确认'}</span> : null}
                    </div>
                    <p className="wb-parts-next wb-parts-quantity-action"><a href={'/purchases?' + new URLSearchParams({ new: '1', productRef: item.id, productLabel: `${item.category} · ${item.name}` }).toString()}>新购同型号配件</a></p>
                  </div>
                </article>
              ))}
              <div className="wb-parts-pagination">
                <span>逐件配件 {payload.totals.itemCount} 件 · 数量型号 {payload.totals.quantityTrackedQty} 件</span>
                <div>
                  {loadingMore ? <span role="status">正在继续读取…</span> : null}
                  {payload.hasMore ? <button type="button" className="wb-btn" disabled={loadingMore} onClick={() => void loadPage({ cursor: payload.nextCursor })}>更多逐件配件</button> : null}
                  {payload.quantityHasMore ? <button type="button" className="wb-btn" disabled={loadingMore} onClick={() => void loadPage({ quantityCursor: payload.quantityNextCursor })}>更多数量型号</button> : null}
                </div>
              </div>
            </>
          )}
        </section>
      ) : null}

      {entryOpen ? (
        <div ref={entryDialogRef} className="wb-modal" role="dialog" aria-modal="true" aria-label="登记配件" tabIndex={-1}>
          <div className="wb-modal-card wb-modal-card--wide wb-parts-entry">
            <div className="wb-modal-head"><div><p className="wb-kicker">店里已有</p><h2>登记配件</h2></div><button type="button" className="wb-btn" disabled={entryBusy || Boolean(pendingUnknown)} onClick={() => setEntryOpen(false)}>关闭</button></div>
            <p className="wb-form-hint">登记已有库存会进入待检测状态。新买到货、回收和拆件请从对应单据登记，来源会自动保留。</p>
            <form className="wb-form" onSubmit={submitEntry}>
              {!selectedProduct && !createdProductId ? (
                <>
                  <label className="wb-field"><span>配件类别</span><select value={entryCategory} onChange={(event) => setEntryCategory(event.target.value)}>{CATEGORIES.map((item) => <option key={item}>{item}</option>)}<option value={CATEGORY_OTHER}>其他</option></select></label>
                  {entryCategory === CATEGORY_OTHER ? <label className="wb-field"><span>自定义类别</span><input value={customCategory} onChange={(event) => setCustomCategory(event.target.value)} /></label> : null}
                  <label className="wb-field"><span>型号 / 规格</span><input value={model} onChange={(event) => { setModel(event.target.value); setSelectedProduct(null); setCandidates([]); setCandidateState('idle') }} placeholder="例如：i5-12400F、RTX 3060 12G" required /></label>
                  <label className="wb-field"><span>品牌（选填）</span><input value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="不清楚可以留空" /></label>
                  <div className="wb-parts-candidate-actions"><button type="button" className="wb-btn" disabled={candidateState === 'loading'} onClick={() => void searchProducts()}>{candidateState === 'loading' ? '正在查找…' : '查找已登记型号'}</button>{candidateState === 'ready' && candidates.length === 0 ? <span>没有找到匹配型号，可直接建立资料。</span> : null}</div>
                  {candidateState === 'error' ? <p className="wb-form-error">{candidateError}</p> : null}
                  {candidates.length ? <fieldset className="wb-parts-candidates"><legend>选择已有型号</legend>{candidates.map((product) => <button type="button" key={product.id} className="wb-parts-candidate" onClick={() => chooseProduct(product)}><strong>{product.category} · {product.name}</strong><span>{product.brand || '未填品牌'} · {product.trackingMode === 'item' ? '逐件记录' : '按数量记录'}</span></button>)}<button type="button" className="wb-btn" onClick={() => { setSelectedProduct(null); setCandidates([]); setTrackingMode('item'); setCandidateState('idle') }}>建立新型号资料</button></fieldset> : null}
                  {!selectedProduct ? <fieldset className="wb-parts-track"><legend>库存怎么记录</legend><label><input type="radio" name="tracking-mode" value="item" checked={trackingMode === 'item'} onChange={() => setTrackingMode('item')} /> 每件单独记录 <small>适合 CPU、显卡、主板等独立配件</small></label><label><input type="radio" name="tracking-mode" value="quantity" checked={trackingMode === 'quantity'} onChange={() => setTrackingMode('quantity')} /> 按数量登记 <small>适合线材等不需要逐件编号的配件</small></label></fieldset> : null}
                </>
              ) : (
                <div className="wb-parts-selected-product"><span>{selectedProduct?.category ?? (entryCategory === CATEGORY_OTHER ? customCategory : entryCategory)} · {selectedProduct?.name ?? model}</span><small>{selectedProduct ? '使用已登记型号' : '型号资料已保存'} · {trackingMode === 'item' ? '逐件记录' : '按数量记录'}</small>{selectedProduct ? <button type="button" className="wb-btn" onClick={() => { setSelectedProduct(null); setCandidates([]); setCandidateState('idle'); setModel(''); setCreatedProductId(null) }}>更换型号</button> : null}</div>
              )}
              <label className="wb-field"><span>数量</span><input type="number" min="1" max="50" step="1" value={itemCount} onChange={(event) => updateItemCount(event.target.value)} disabled={entryBusy} /></label>
              {trackingMode === 'item' ? (
                <div className="wb-parts-entry-items"><h3>每件配件</h3>{entryItems.map((item, index) => <fieldset className="wb-parts-entry-item" key={index}><legend>第 {index + 1} 件 · 二手默认</legend><label className="wb-field"><span>成色</span><select value={item.condition} onChange={(event) => updateEntryItem(index, { condition: event.target.value as StockCondition })}><option value="used">二手</option><option value="new">新品</option></select></label><label className="wb-field"><span>单件成本（元）</span><input inputMode="decimal" value={item.costYuan} onChange={(event) => updateEntryItem(index, { costYuan: event.target.value })} placeholder="不知道可以留空" /></label><label className="wb-field"><span>厂家编号（选填）</span><input value={item.snRaw} onChange={(event) => updateEntryItem(index, { snRaw: event.target.value })} /></label><label className="wb-field"><span>状况说明</span><input value={item.remark} onChange={(event) => updateEntryItem(index, { remark: event.target.value })} placeholder="如：散片、接口正常" /></label></fieldset>)}</div>
              ) : <><label className="wb-field"><span>单件成本（元）</span><input inputMode="decimal" value={entryItems[0]?.costYuan ?? ''} onChange={(event) => updateEntryItem(0, { costYuan: event.target.value })} placeholder="不知道可以留空" /></label><label className="wb-field"><span>状况说明</span><input value={entryItems[0]?.remark ?? ''} onChange={(event) => updateEntryItem(0, { remark: event.target.value })} /></label><p className="wb-form-hint">按数量管理的型号不记录逐件成色、检测状态或厂家编号。</p></>}
              <label className="wb-field"><span>整批备注（选填）</span><textarea value={batchNote} onChange={(event) => setBatchNote(event.target.value)} /></label>
              {entryNotice ? <p className="wb-inv-notice">{entryNotice}</p> : null}
              {entryError ? <p className="wb-form-error">{entryError}</p> : null}
              {pendingUnknown ? <p className="wb-inv-notice wb-inv-notice--warn">请求结果暂未确认。<button type="button" className="wb-btn" disabled={entryBusy} onClick={() => void checkUnknown()}>查询结果</button></p> : null}
              <div className="wb-parts-entry-related">
                <p className="wb-form-hint">如果配件来自新购或回收，可把型号、数量及已有编号带到对应单据继续办理。转采购时只保存型号资料，不会登记库存；回收登记会保留在客户暂存，确认收购前不计入库存。</p>
                <div className="wb-form-actions">
                  <button type="button" className="wb-btn" disabled={entryBusy || Boolean(pendingUnknown)} onClick={() => void openPurchaseDraft()}>转到新购到货</button>
                  <button type="button" className="wb-btn" disabled={entryBusy || Boolean(pendingUnknown)} onClick={openRecoveryDraft}>转到回收登记</button>
                </div>
              </div>
              <div className="wb-form-actions"><button type="submit" className="wb-btn wb-btn--primary" disabled={entryBusy || Boolean(pendingUnknown)}>{entryBusy ? '正在保存…' : createdProductId ? '继续登记库存' : selectedProduct ? '登记库存' : '建立型号并登记库存'}</button><button type="button" className="wb-btn" disabled={entryBusy} onClick={() => setEntryOpen(false)}>稍后再登记</button></div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  )
}
