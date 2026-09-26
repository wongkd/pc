/**
 * E04b · 库存与商品页（网页端 ERP）。
 *
 * 本页的前身是 T05b 的演示页（数据来自 `demoInventory.ts` 的端内副本）。E04b 把它接到
 * 真实的 `/api/v2/inventory`：商品建档、期初录入、型号汇总与逐件实物都读写真实库。
 * **演示数据不再出现在这条链路上** —— 页面上的每一个数字都来自服务端响应。
 *
 * 口径依据：
 *   · 03 §4 L84  自有在库量 = 可卖 + 已订 + 待处理；在途不算在库；客户保管另列
 *   · 03 §1 R01  未知成本是 null / costKnown=false，界面写「成本未知」，不写 ¥0.00
 *   · 04 §3 L57  成本字段由服务端按权限决定是否返回；本页**不自己判权限**，
 *                只看响应里有没有这个键（`is-nocost` 列由此决定）
 *
 * 三个刻意不做的事：
 *   1. 不给「入库 / 盘点 / 采购」放点不动的按钮 —— 那些属别的卡，本卡只做商品与期初；
 *   2. 不把网络超时当作失败：写动作超时进「结果未知」，提示先用原 requestId 查询结果；
 *   3. 不伪造成功：写动作只有服务端 2xx + 契约成功信封才提示已保存。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import {
  BUCKET_LABELS,
  CONDITION_LABELS,
  LOCATION_LABELS,
  MOVEMENT_SOURCE_LABELS,
  OWNERSHIP_LABELS,
  STATUS_LABELS,
  TRACKING_LABELS,
  costText,
  formatYuan,
} from './inventory-view'
import { AttachmentPanel } from './AttachmentPanel'
import {
  fetchInventory,
  fetchStockItem,
  queryOperationResult,
  recordOpening,
  createInventoryCount,
  approveInventoryCount,
  saveProduct,
  inspectQuarantinedItem,
  recordRefurbishment,
  makeItemAvailable,
  fetchInventoryActivity,
} from './inventory-api'
import type { AttachmentView } from './attachment-api'
import type {
  InventoryItemRow,
  InventoryActivityEntry,
  InventoryListPayload,
  InventoryProductRow,
  InventoryTotals,
  OpeningLinePayload,
  OpeningCostBasis,
  OpeningWindowStatus,
  ProductWritePayload,
  StockBucketValue,
  StockConditionValue,
  StockItemDetail,
} from './inventory-api'
import '../../styles/workbench.css'
import './WorkbenchInventoryPage.css'

type AvailabilityFilter = StockBucketValue | 'all'
type ConditionFilter = StockConditionValue | 'all'

const AVAILABILITY_FILTERS: Array<{ key: AvailabilityFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'available', label: '可卖' },
  { key: 'reserved', label: '已订' },
  { key: 'quarantine', label: '待处理' },
  { key: 'in_transit', label: '在途' },
  { key: 'customer_custody', label: '客户保管' },
]

const CONDITION_FILTERS: Array<{ key: ConditionFilter; label: string }> = [
  { key: 'all', label: '全部成色' },
  { key: 'new', label: '新品' },
  { key: 'used', label: '二手' },
]

const PRODUCT_CATEGORY_OPTIONS = [
  'CPU', '主板', '内存', '显卡', '硬盘', '散热器', '电源', '机箱', '风扇',
  '显示器', '鼠标', '键盘', '耳机', '座椅', '线材',
] as const
const CUSTOM_CATEGORY_VALUE = '__custom_category__'
const WAREHOUSE_OPERATION_LABELS: Record<string, string> = {
  B12: '商品档案变更',
  B13: '现有库存登记',
  B14: '创建采购单',
  B16: '库存实盘记录或差异批准',
  B19: '库存实物检验',
  B30: '整备或上架',
  B37: '取消采购未到数量',
  B46: '清理无业务引用商品',
}

const PAGE_LIMIT = 50
/** 逐件明细一次最多拉多少件（服务端上限 100）。 */
const BREAKDOWN_LIMIT = 100

function formatInventoryActivityTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function inventoryActivityTitle(item: InventoryActivityEntry): string {
  if (item.kind === 'movement') {
    return MOVEMENT_SOURCE_LABELS[item.action as keyof typeof MOVEMENT_SOURCE_LABELS] ?? '库存变动'
  }
  return WAREHOUSE_OPERATION_LABELS[item.action] ?? '仓库操作'
}

function inventoryActivityChange(item: InventoryActivityEntry): string | null {
  if (item.kind !== 'movement' || item.qty === null) return null
  const qty = Math.abs(item.qty)
  const from = item.fromBucket ? BUCKET_LABELS[item.fromBucket as keyof typeof BUCKET_LABELS] : null
  const to = item.toBucket ? BUCKET_LABELS[item.toBucket as keyof typeof BUCKET_LABELS] : null
  if (from && to) return `${from} → ${to} · ${qty} 件`
  if (to) return `${to} +${qty} 件`
  if (from) return `${from} −${qty} 件`
  return `${qty} 件`
}

function inventoryActivityActor(item: InventoryActivityEntry): string {
  if (item.actorRole === 'system' || item.actorUserId === null) return '系统'
  return item.actorRole === 'owner' ? '店主' : `员工账号 #${item.actorUserId}`
}

interface ProductDraft {
  name: string
  sku: string
  category: string
  brand: string
  specs: string
  trackingMode: 'quantity' | 'item'
  requiresSn: boolean
  saleYuan: string
  initialQty: string
  initialCondition: StockConditionValue
  initialCostBasis: OpeningCostBasis
  initialCostYuan: string
  initialCostEvidenceRef: string
  status: 'active' | 'disabled'
}

const EMPTY_PRODUCT: ProductDraft = {
  name: '', sku: '', category: '', brand: '', specs: '',
  trackingMode: 'quantity', requiresSn: false, saleYuan: '', initialQty: '0',
  initialCondition: 'new', initialCostBasis: 'known_actual',
  initialCostYuan: '', initialCostEvidenceRef: '', status: 'active',
}

interface OpeningLineDraft {
  key: string
  productRef: string
  qty: string
  assetCode: string
  snRaw: string
  remark: string
  condition: StockConditionValue
  costYuan: string
  costBasis: OpeningCostBasis
  costEvidenceRef: string
}

function newOpeningLine(productRef = ''): OpeningLineDraft {
  return {
    key: `line-${Math.random().toString(36).slice(2, 10)}`,
    productRef, qty: '1', assetCode: '', snRaw: '', remark: '', condition: 'new', costYuan: '',
    costBasis: 'known_actual', costEvidenceRef: '',
  }
}

/** 元 → 整数分。空串返回 null（不是 0）：空是「没填」，0 是「零元」。 */
function yuanToCents(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const number = Number(trimmed)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.round(number * 100)
}

function openingCostBasis(amountCents: number | null, preference: OpeningCostBasis): OpeningCostBasis {
  if (amountCents === null) return 'unknown'
  if (amountCents === 0) return 'zero_cost'
  return preference === 'assessed_estimate' ? 'assessed_estimate' : 'known_actual'
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function openingCostText(
  basis: OpeningCostBasis | null | undefined,
  amount: number | null | undefined,
  legacyKnown: boolean,
  estimateAmount?: number | null,
): string {
  if (basis === 'unknown') return '成本未知'
  if (basis === 'zero_cost') return '真实零成本 · ¥0.00'
  if (basis === 'assessed_estimate') {
    const estimated = estimateAmount ?? amount
    return estimated === null || estimated === undefined ? '估值待核' : `估值 ${formatYuan(estimated)}`
  }
  if (basis === 'known_actual') return amount === null || amount === undefined ? '实际成本待核' : `实际 ${formatYuan(amount)}`
  if (legacyKnown && amount !== null && amount !== undefined) return `旧口径 ${formatYuan(amount)}`
  return '成本未知'
}

const toCentsOrZero = (value: string) => yuanToCents(value) ?? 0

interface UnknownWrite {
  what: string
  requestId: string | null
}

export interface WorkbenchInventoryPageProps {
  /** 会话权限码。只用于提前隐藏按钮，真正的判定在服务端（04 §3）。 */
  permissions?: string[]
}

function granted(permissions: string[], code: string, legacy: string[] = []): boolean {
  if (permissions.includes('*') || permissions.includes(code)) return true
  return legacy.some((item) => permissions.includes(item))
}

export function WorkbenchInventoryPage({ permissions = [] }: WorkbenchInventoryPageProps) {
  const canEditProduct = granted(permissions, 'inventory/product-edit', ['library/edit'])
  const canRecordOpening = granted(permissions, 'inventory/opening')
  const canCount = granted(permissions, 'inventory/count', ['library/edit'])
  const canApproveCount = granted(permissions, 'inventory/count-approve')
  const canInspect = granted(permissions, 'inventory/inspection', ['library/edit'])
  const canRefurbish = granted(permissions, 'inventory/refurbish', ['library/edit'])
  const canUploadAttachment = granted(permissions, 'attachment/upload', ['library/edit'])

  const [rows, setRows] = useState<InventoryProductRow[] | null>(null)
  const [totals, setTotals] = useState<InventoryTotals | null>(null)
  const [serialMatches, setSerialMatches] = useState<InventoryListPayload['lotItems']>([])
  const [batchMatches, setBatchMatches] = useState<InventoryListPayload['batches']>([])
  const [listState, setListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [listError, setListError] = useState('')
  const [unknownWrite, setUnknownWrite] = useState<UnknownWrite | null>(null)
  const [notice, setNotice] = useState('')
  const [activityOpen, setActivityOpen] = useState(false)
  const [activityItems, setActivityItems] = useState<InventoryActivityEntry[]>([])
  const [activityState, setActivityState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [activityError, setActivityError] = useState('')
  const [activityLoaded, setActivityLoaded] = useState(false)

  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [availability, setAvailability] = useState<AvailabilityFilter>('all')
  const [condition, setCondition] = useState<ConditionFilter>('all')

  const [expanded, setExpanded] = useState<string | null>(null)
  const [breakdown, setBreakdown] = useState<InventoryItemRow[]>([])
  const [batchBreakdown, setBatchBreakdown] = useState<InventoryListPayload['batches']>([])
  const [breakdownState, setBreakdownState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [breakdownTruncated, setBreakdownTruncated] = useState(false)
  const [itemDetail, setItemDetail] = useState<StockItemDetail | null>(null)
  const [itemDetailRef, setItemDetailRef] = useState<string | null>(null)
  const [itemAttachments, setItemAttachments] = useState<Record<string, AttachmentView[]>>({})
  const [inspectionFindings, setInspectionFindings] = useState('')
  const [inspectionEvidence, setInspectionEvidence] = useState('')
  const [workflowError, setWorkflowError] = useState('')
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const [listedForSale, setListedForSale] = useState<string[]>([])
  const [refurbishment, setRefurbishment] = useState({ category: '', amountYuan: '', capitalizable: true, paymentEntryRef: '', evidenceRef: '' })
  const [saleDraft, setSaleDraft] = useState({ conditionGrade: 'good' as 'brand_new' | 'like_new' | 'excellent' | 'good' | 'fair', saleYuan: '', disclosureNote: '', dataDisposed: false, warrantyTerm: '3' as '3' | '6' | '12' | '24' })

  const [productForm, setProductForm] = useState<{ mode: 'closed' } | { mode: 'create'; createdProductId?: string } | { mode: 'edit'; row: InventoryProductRow }>({ mode: 'closed' })
  const [productDraft, setProductDraft] = useState<ProductDraft>(EMPTY_PRODUCT)
  const [customCategorySelected, setCustomCategorySelected] = useState(false)
  const [savingProduct, setSavingProduct] = useState(false)
  const [productError, setProductError] = useState('')

  const [openingOpen, setOpeningOpen] = useState(false)
  const [openingRef, setOpeningRef] = useState('')
  const [openingNote, setOpeningNote] = useState('')
  const [openingLines, setOpeningLines] = useState<OpeningLineDraft[]>([newOpeningLine()])
  const [openingWindow, setOpeningWindow] = useState<OpeningWindowStatus | null>(null)
  const [openingOptions, setOpeningOptions] = useState<InventoryProductRow[]>([])
  const [openingOptionsState, setOpeningOptionsState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [savingOpening, setSavingOpening] = useState(false)
  const [openingError, setOpeningError] = useState('')
  const [countOpen, setCountOpen] = useState(false)
  const [countProductRef, setCountProductRef] = useState('')
  const [countedQty, setCountedQty] = useState('')
  const [countNote, setCountNote] = useState('')
  const [countAsOf, setCountAsOf] = useState('')
  const [countDraft, setCountDraft] = useState<{ id: string; version: number } | null>(null)
  const [countError, setCountError] = useState('')
  const [savingCount, setSavingCount] = useState(false)

  const loadActivity = useCallback(async () => {
    setActivityState('loading')
    setActivityError('')
    try {
      const result = await fetchInventoryActivity()
      if (!result.ok) {
        setActivityError(result.message || '操作日志暂时无法读取')
        setActivityState('error')
        return
      }
      setActivityItems(result.data.items)
      setActivityLoaded(true)
      setActivityState('ready')
    } catch {
      setActivityError('操作日志暂时无法读取，请稍后重试。')
      setActivityState('error')
    }
  }, [])

  const toggleActivity = () => {
    const nextOpen = !activityOpen
    setActivityOpen(nextOpen)
    if (nextOpen && (!activityLoaded || activityState === 'error')) void loadActivity()
  }

  /** 当前筛选条件用于「保存后重新加载」；依赖写在 reload 的依赖表里，不用 ref 传。 */
  const applyResult = useCallback((result: Awaited<ReturnType<typeof fetchInventory>>) => {
    if (result.ok) {
      setRows(result.data.items)
      setTotals(result.data.totals)
      setSerialMatches(result.data.lotItems)
      setBatchMatches(result.data.batches)
      setOpeningWindow(result.data.openingWindow)
      setListError('')
      setListState('ready')
      return
    }
    setRows(null)
    setListError(result.unknownResult ? '请求结果未知，请稍后重试。' : result.message)
    setListState('error')
  }, [])

  const loadBreakdown = useCallback(async (productRef: string) => {
    setBreakdownState('loading')
    const result = await fetchInventory({ productRef, limit: BREAKDOWN_LIMIT })
    if (result.ok) {
      setBreakdown(result.data.lotItems)
      setBatchBreakdown(result.data.batches ?? [])
      setBreakdownTruncated(result.data.hasMore)
      setBreakdownState('ready')
      return
    }
    setBreakdown([])
    setBatchBreakdown([])
    setBreakdownState('error')
  }, [])

  const reload = useCallback(async () => {
    const result = await fetchInventory({
      q: appliedQuery || undefined,
      availability: availability === 'all' ? undefined : availability,
      condition: condition === 'all' ? undefined : condition,
      limit: PAGE_LIMIT,
    })
    applyResult(result)
    // 展开中的那一行也要跟着刷新：写完期初/商品后型号数量会变，
    // 只刷列表会让展开区停在上一次的快照上，等于同一个页面出现两套数字。
    if (expanded) await loadBreakdown(expanded)
  }, [appliedQuery, availability, condition, applyResult, expanded, loadBreakdown])

  // 首次加载：setState 只发生在 Promise 回调里。在 effect 体内同步调用会 setState 的函数
  // 会触发级联渲染（react-hooks/set-state-in-effect），所以这里不走 reload()。
  useEffect(() => {
    let active = true
    void fetchInventory({ limit: PAGE_LIMIT })
      .then((result) => {
        if (!active) return
        if (result.ok) {
          setRows(result.data.items)
          setTotals(result.data.totals)
          setOpeningWindow(result.data.openingWindow)
          setListError('')
          setListState('ready')
        } else {
          setRows(null)
          setListError(result.unknownResult ? '请求结果未知，请稍后重试。' : result.message)
          setListState('error')
        }
      })
      .catch(() => {
        if (!active) return
        setListError('库存加载失败')
        setListState('error')
      })
    return () => { active = false }
  }, [])

  const runSearch = (keyword: string) => {
    setListState('loading')
    setNotice('')
    void fetchInventory({
      q: keyword || undefined,
      availability: availability === 'all' ? undefined : availability,
      condition: condition === 'all' ? undefined : condition,
      limit: PAGE_LIMIT,
    }).then(applyResult)
  }

  /** 成本列是否渲染：只看响应里有没有这个键，不在前端自己判权限（04 §3 L57）。 */
  const canViewCost = useMemo(() => (rows ?? []).some((row) => 'totalCostCents' in row), [rows])

  const toggleRow = (row: InventoryProductRow) => {
    if (expanded === row.id) {
      setExpanded(null)
      setBreakdown([])
      setBreakdownState('idle')
      setItemDetail(null)
      setItemDetailRef(null)
      return
    }
    setExpanded(row.id)
    setBreakdown([])
    setItemDetail(null)
    setItemDetailRef(null)
    void loadBreakdown(row.id)
  }

  const openItemDetail = (stockItemId: string) => {
    if (itemDetailRef === stockItemId) {
      setItemDetail(null)
      setItemDetailRef(null)
      return
    }
    setItemDetailRef(stockItemId)
    setWorkflowError('')
    setInspectionFindings('')
    setItemDetail(null)
    void fetchStockItem(stockItemId).then((result) => {
      if (result.ok) {
        setItemDetail(result.data)
        setItemAttachments((current) => ({ ...current, [stockItemId]: result.data.attachments ?? [] }))
        setInspectionEvidence((result.data.attachments ?? []).map((attachment) => attachment.id).join(', '))
      }
      else setItemDetail(null)
    })
  }

  const refreshItemDetail = async (id: string) => {
    const result = await fetchStockItem(id)
    if (result.ok) {
      setItemDetail(result.data)
      setItemAttachments((current) => ({ ...current, [id]: result.data.attachments ?? [] }))
    }
    await reload()
  }

  const submitInspection = async (item: InventoryItemRow, disposition: 'available' | 'retired') => {
    const evidence = inspectionEvidence.split(/[,，\n]/).map((id) => id.trim()).filter(Boolean)
    if (!inspectionFindings.trim()) { setWorkflowError('请填写检测发现'); return }
    if (disposition === 'available' && evidence.length === 0) { setWorkflowError('放行必须先上传并选择至少一张有效验机附件'); return }
    setWorkflowBusy(true); setWorkflowError('')
    const expectedVersion = itemDetail?.item.id === item.id ? itemDetail.item.version : item.version
    const result = await inspectQuarantinedItem({ itemId: item.id, expectedVersion, result: disposition === 'available' ? 'pass' : 'fail', findings: inspectionFindings.trim(), evidence, disposition })
    setWorkflowBusy(false)
    if (!result.ok) { setWorkflowError(result.unknownResult ? '操作结果未知，请刷新确认后再继续。' : result.message); return }
    setInspectionFindings(''); setInspectionEvidence(''); await refreshItemDetail(item.id)
  }

  const submitRefurbishment = async (item: InventoryItemRow) => {
    const cents = yuanToCents(refurbishment.amountYuan)
    if (!refurbishment.category.trim() || cents === null || cents <= 0) { setWorkflowError('整备项目和正数金额必填'); return }
    setWorkflowBusy(true); setWorkflowError('')
    const result = await recordRefurbishment(item.id, {
      category: refurbishment.category.trim(),
      amountCents: cents,
      capitalizable: refurbishment.capitalizable,
      paymentEntryRef: refurbishment.paymentEntryRef.trim() || null,
      evidenceRef: refurbishment.evidenceRef.trim() || null,
    })
    setWorkflowBusy(false)
    if (!result.ok) { setWorkflowError(result.unknownResult ? '操作结果未知，请刷新确认后再继续。' : result.message); return }
    setRefurbishment({ category: '', amountYuan: '', capitalizable: true, paymentEntryRef: '', evidenceRef: '' }); await refreshItemDetail(item.id)
  }

  const submitMakeAvailable = async (item: InventoryItemRow) => {
    const cents = yuanToCents(saleDraft.saleYuan)
    if (cents === null || cents <= 0 || !saleDraft.disclosureNote.trim() || !saleDraft.dataDisposed) { setWorkflowError('上架前须填正售价、成色说明，并确认数据已清除'); return }
    setWorkflowBusy(true); setWorkflowError('')
    const expectedVersion = itemDetail?.item.id === item.id ? itemDetail.item.version : item.version
    const result = await makeItemAvailable(item.id, { conditionGrade: saleDraft.conditionGrade, salePriceCents: cents, disclosureNote: saleDraft.disclosureNote.trim(), dataDisposed: saleDraft.dataDisposed, warrantyTerm: saleDraft.warrantyTerm, expectedVersion })
    setWorkflowBusy(false)
    if (!result.ok) { setWorkflowError(result.unknownResult ? '操作结果未知，请刷新确认后再继续。' : result.message); return }
    setListedForSale((current) => current.includes(item.id) ? current : [...current, item.id]); await refreshItemDetail(item.id)
  }

  const openProductCreate = () => {
    setProductDraft(EMPTY_PRODUCT)
    setCustomCategorySelected(false)
    setProductError('')
    setProductForm({ mode: 'create' })
  }

  const openProductEdit = (row: InventoryProductRow) => {
    setCustomCategorySelected(Boolean(row.category) && !PRODUCT_CATEGORY_OPTIONS.includes(row.category as (typeof PRODUCT_CATEGORY_OPTIONS)[number]))
    setProductDraft({
      name: row.name,
      sku: row.sku ?? '',
      category: row.category,
      brand: row.brand ?? '',
      specs: '',
      trackingMode: row.trackingMode,
      requiresSn: row.requiresSn,
      saleYuan: row.defaultSalePriceCents ? String(row.defaultSalePriceCents / 100) : '',
      initialQty: '0',
      initialCondition: 'new',
      initialCostBasis: 'unknown',
      initialCostYuan: '',
      initialCostEvidenceRef: '',
      status: row.status,
    })
    setProductError('')
    setProductForm({ mode: 'edit', row })
  }

  async function submitProduct(event: FormEvent) {
    event.preventDefault()
    if (productForm.mode === 'closed') return
    const creating = productForm.mode === 'create'
    const alreadyCreatedProductId = creating ? productForm.createdProductId ?? null : null
    const initialQty = creating ? Number(productDraft.initialQty) : 0
    const hasInitialStock = creating && initialQty > 0
    if (!productDraft.name.trim()) {
      setProductError('商品名称不能为空')
      return
    }
    if (creating && !productDraft.category.trim()) {
      setProductError(customCategorySelected ? '请填写自定义分类' : '请选择商品分类')
      return
    }
    if (creating && (!productDraft.initialQty.trim() || !Number.isSafeInteger(initialQty) || initialQty < 0)) {
      setProductError('请填写 0 或更大的整数数量')
      return
    }
    if (creating && productDraft.trackingMode === 'item' && initialQty > 100) {
      setProductError('逐件商品一次最多填写 100 件，请调整数量。')
      return
    }
    if (productDraft.saleYuan.trim() && yuanToCents(productDraft.saleYuan) === null) {
      setProductError('默认售价必须是不小于 0 的金额')
      return
    }
    const initialCostCents = productDraft.initialCostYuan.trim() ? yuanToCents(productDraft.initialCostYuan) : null
    if (creating && productDraft.initialCostYuan.trim() && initialCostCents === null) {
      setProductError('单件成本填写无效；不知道成本可以留空。')
      return
    }
    setSavingProduct(true)
    setProductError('')
    const payload: ProductWritePayload = {
      productRef: productForm.mode === 'edit' ? productForm.row.id : alreadyCreatedProductId,
      name: productDraft.name.trim(),
      sku: productDraft.sku.trim() || null,
      category: productDraft.category.trim() || null,
      brand: productDraft.brand.trim() || null,
      specs: productDraft.specs.trim() || null,
      ...(creating ? { defaultSalePriceCents: toCentsOrZero(productDraft.saleYuan) } : {}),
      trackingMode: productDraft.trackingMode,
      requiresSn: productDraft.trackingMode === 'item' ? true : productDraft.requiresSn,
      status: creating ? 'active' : productDraft.status,
    }
    try {
      let productId = alreadyCreatedProductId
      if (!productId) {
        const result = await saveProduct(payload, productForm.mode === 'edit' ? productForm.row.version : null)
        if (!result.ok) {
          if (result.unknownResult) {
            // 超时 ≠ 失败：先查这次建档结果，避免重复创建同一个商品。
            setUnknownWrite({ what: '商品保存', requestId: result.requestId })
            setProductError('请求结果未知：可能已经保存成功。请先点「查询结果」，不要直接重复提交。')
            return
          }
          setProductError(result.code === 'VERSION_CONFLICT'
            ? '这件商品已被别人改过，请关闭表单重新打开再改。'
            : result.message)
          return
        }
        productId = result.data.entityId
        if (!productId) {
          setProductForm({ mode: 'closed' })
          await reload()
          setNotice('商品已建立，但服务端没有返回库存关联编号；请刷新后确认商品，再单独登记库存。')
          return
        }
        if (creating && hasInitialStock) setProductForm({ mode: 'create', createdProductId: productId })
      }

      if (productForm.mode === 'edit' || !hasInitialStock) {
        setProductForm({ mode: 'closed' })
        await reload()
        setNotice(productForm.mode === 'edit' ? `商品「${payload.name}」已更新` : `已建立商品「${payload.name}」`)
        return
      }

      if (!canRecordOpening) {
        setProductError('商品已建立，库存还没登记。当前账号没有登记库存权限，请由店主或有权限的负责人处理。')
        return
      }
      if (openingWindow?.mode !== 'formal') {
        setProductError('商品已建立，库存还没登记。当前环境暂不支持登记现有库存；新进货请走采购到货。')
        return
      }
      if (!productId) {
        setProductError('商品已经建立，但没有可用的库存关联编号。请刷新库存列表后确认。')
        return
      }
      const itemCount = productDraft.trackingMode === 'item' ? initialQty : 1
      const initialLines: OpeningLinePayload[] = Array.from({ length: itemCount }, (_, index) => ({
        approvedCountLineRef: `${productId}-${index + 1}`,
        productRef: productId as string,
        qty: productDraft.trackingMode === 'item' ? 1 : initialQty,
        ...(productDraft.trackingMode === 'item' ? { condition: productDraft.initialCondition } : {}),
        ...(initialCostCents === null ? {} : { unitCostCents: initialCostCents }),
        costBasis: openingCostBasis(initialCostCents, productDraft.initialCostBasis),
        costEvidenceRef: productDraft.initialCostEvidenceRef.trim() || null,
        costAssessedAt: productDraft.initialCostBasis === 'assessed_estimate' && initialCostCents !== null && initialCostCents > 0
          ? todayIsoDate()
          : null,
      }))
      const openingResult = await recordOpening({
        approvedCountRef: `existing-stock-${productId}`,
        lines: initialLines,
      })
      if (openingResult.ok) {
        setProductForm({ mode: 'closed' })
        await reload()
        setNotice(`商品「${payload.name}」已建立，现有库存 ${initialQty} 件已登记。`)
        return
      }
      if (openingResult.unknownResult) {
        setUnknownWrite({ what: '初始库存录入', requestId: openingResult.requestId })
        setProductError('商品已建立，但现有库存登记结果未知。先查询结果，不要重复提交。')
        return
      }
      setProductError(`商品已建立，但现有库存尚未登记：${openingResult.message}`)
    } finally {
      setSavingProduct(false)
    }
  }

  const openOpening = () => {
    if (openingWindow?.mode === 'disabled' || !openingWindow) return
    setOpeningRef(`existing-stock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setOpeningNote('')
    setOpeningLines([newOpeningLine()])
    setOpeningError('')
    setOpeningOpen(true)
    setOpeningOptionsState('loading')
    void fetchInventory({ limit: 100 }).then((result) => {
      if (result.ok) {
        setOpeningOptions(result.data.items)
        setOpeningOptionsState('idle')
      } else {
        setOpeningOptionsState('error')
      }
    })
  }

  const openCount = () => {
    setCountProductRef((rows ?? [])[0]?.id ?? '')
    setCountedQty('')
    setCountNote('')
    setCountAsOf(new Date().toISOString())
    setCountDraft(null)
    setCountError('')
    setCountOpen(true)
  }

  const submitCount = async () => {
    const qty = Number(countedQty)
    if (!countProductRef || !Number.isInteger(qty) || qty < 0) { setCountError('请选择商品，并填写不小于 0 的整数实盘数。'); return }
    setSavingCount(true); setCountError('')
    try {
      const result = await createInventoryCount({ asOf: countAsOf, note: countNote.trim() || null, lines: [{ productRef: countProductRef, countedQty: qty }] })
      if (!result.ok) {
        if (result.unknownResult) {
          setUnknownWrite({ what: '保存盘点', requestId: result.requestId })
          setCountError('请求结果未知：实盘内容已保留。先查询结果；确认未记账后，不改动内容再重试会复用原请求号。')
        } else setCountError(result.message || '盘点保存失败')
        return
      }
      if (!result.data.entityId || result.data.entityVersion === null) { setCountError('盘点保存后没有返回可批准的编号'); return }
      setCountDraft({ id: result.data.entityId, version: result.data.entityVersion })
      setNotice(result.data.summary || '实盘已保存；尚未改变库存，需有批准权限的人确认差异。')
    } finally { setSavingCount(false) }
  }

  const submitCountApproval = async () => {
    if (!countDraft) return
    setSavingCount(true); setCountError('')
    try {
      const result = await approveInventoryCount(countDraft.id, countDraft.version, countNote.trim() || '核对实盘差异')
      if (!result.ok) {
        if (result.unknownResult) {
          setUnknownWrite({ what: '批准盘点差异', requestId: result.requestId })
          setCountError('请求结果未知：盘点草稿与批准原因已保留。先查询结果；确认未记账后，不改动内容再重试会复用原请求号。')
        } else setCountError(result.message || '盘点批准失败')
        return
      }
      setCountOpen(false); await reload(); setNotice(result.data.summary || '盘点差异已批准并入账')
    } finally { setSavingCount(false) }
  }

  const productOf = (ref: string) => openingOptions.find((item) => item.id === ref) ?? (rows ?? []).find((item) => item.id === ref) ?? null

  const updateLine = (key: string, patch: Partial<OpeningLineDraft>) => {
    setOpeningLines((current) => current.map((line) => {
      if (line.key !== key) return line
      const next = { ...line, ...patch }
      // 逐件商品一行只能一件：这不是前端多事，服务端的守卫同样会拒（一条事实两个地方都要拦）。
      const product = productOf(next.productRef)
      if (product && product.trackingMode === 'item') {
        next.qty = '1'
      } else if (patch.productRef !== undefined) {
        next.assetCode = ''
        next.snRaw = ''
      }
      return next
    }))
  }

  async function submitOpening(event: FormEvent) {
    event.preventDefault()
    const formal = openingWindow?.mode === 'formal'
    const lines: OpeningLinePayload[] = []
    for (const [index, line] of openingLines.entries()) {
      const at = `第 ${index + 1} 行`
      if (!line.productRef) { setOpeningError(`${at}：请选择型号`); return }
      const product = productOf(line.productRef)
      const qty = Number(line.qty)
      if (!Number.isInteger(qty) || qty < 1) { setOpeningError(`${at}：数量必须是正整数`); return }
      if (product?.trackingMode === 'item') {
        if (qty !== 1) { setOpeningError(`${at}：逐件商品一行只能一件`); return }
      } else if (line.assetCode.trim()) {
        setOpeningError(`${at}：按数量管理的型号不要填内部编号`)
        return
      }
      const cost = yuanToCents(line.costYuan)
      if (line.costYuan.trim() && cost === null) { setOpeningError(`${at}：单件成本是不小于 0 的金额`); return }
      const costBasis = openingCostBasis(cost, line.costBasis)
      if (formal) {
        if (costBasis === 'assessed_estimate' && (cost === null || cost <= 0)) {
          setOpeningError(`${at}：估算成本请填写大于 0 的单件金额`); return
        }
      }
      lines.push({
        ...(formal ? { approvedCountLineRef: line.key } : {}),
        productRef: line.productRef,
        qty: product?.trackingMode === 'item' ? 1 : qty,
        ...(product?.trackingMode === 'item'
          ? {
              condition: line.condition,
              ...(line.snRaw.trim() ? { snRaw: line.snRaw.trim() } : {}),
            }
          : {}),
        ...(line.remark.trim() ? { remark: line.remark.trim() } : {}),
        ...(cost === null ? {} : { unitCostCents: cost }),
        ...(formal ? {
          costBasis,
          costEvidenceRef: line.costEvidenceRef.trim() || null,
          costAssessedAt: costBasis === 'assessed_estimate' ? todayIsoDate() : null,
        } : {}),
      })
    }
    const allKnown = openingLines.every((line) => line.costYuan.trim() !== '')
    setSavingOpening(true)
    setOpeningError('')
    try {
      const payload = formal
        ? { approvedCountRef: openingRef, note: openingNote.trim() || null, lines }
        : {
            approvedCountRef: openingRef,
            costBasis: { kind: allKnown ? 'known' as const : 'unknown' as const },
            note: openingNote.trim() || null,
            lines,
          }
      const result = await recordOpening(payload)
      if (result.ok) {
        setOpeningOpen(false)
        await reload()
        setNotice(`现有库存已登记：${result.data.summary || `${lines.length} 行`}`)
        return
      }
      if (result.unknownResult) {
        setUnknownWrite({ what: '现有库存登记', requestId: result.requestId })
        setOpeningError('请求结果未知：可能已经登记成功。请先点「查询结果」，不要直接重复提交。')
        return
      }
      setOpeningError(result.message)
    } finally {
      setSavingOpening(false)
    }
  }

  const checkUnknownResult = async () => {
    if (!unknownWrite?.requestId) return
    const status = await queryOperationResult(unknownWrite.requestId)
    if (status.status === 'succeeded') {
      if (unknownWrite.what === '商品保存') {
        const needsInitialStock = productForm.mode === 'create' && Number(productDraft.initialQty) > 0
        if (needsInitialStock) {
          if (status.resultRef) {
            setProductForm({ mode: 'create', createdProductId: status.resultRef })
            setProductError('商品已建立；继续登记店里已有的库存。')
            setNotice('商品已建立，库存还没有登记。')
          } else {
            setProductForm({ mode: 'closed' })
            setProductError('')
            setNotice('商品已建立，但未返回商品编号，初始库存未入账。请刷新后确认商品，再办理库存登记。')
          }
        } else {
          setProductForm({ mode: 'closed' })
          setProductError('')
          setNotice(`${unknownWrite.what}：后台确认这笔已经记账，列表已刷新。`)
        }
      } else if (unknownWrite.what === '初始库存录入') {
        setProductForm({ mode: 'closed' })
        setProductError('')
        setNotice('现有库存已登记，列表已刷新。')
      } else {
        setNotice(`${unknownWrite.what}：后台确认这笔已经记账，列表已刷新。`)
      }
      setUnknownWrite(null)
      await reload()
      return
    }
    if (status.status === 'pending') {
      setNotice(`${unknownWrite.what}：后台还在处理，过一会儿再点「查询结果」。`)
      return
    }
    if (status.status === 'unknown') {
      setNotice(`${unknownWrite.what}：后台查不到这个请求编号，可以重新提交。`)
      if (unknownWrite.what === '商品保存') {
        setProductError('后台未找到建档记录，确认商品资料后可以重新提交。')
      } else if (unknownWrite.what === '初始库存录入') {
        setProductError('后台未找到库存登记记录；商品已建立，核对数量和成本后可以重新提交。')
      }
      setUnknownWrite(null)
      return
    }
    if (status.status === 'failed') {
      if (unknownWrite.what === '商品保存') {
        setProductError(`商品保存没有成功：${status.message || status.code || '原因未知'}`)
      } else if (unknownWrite.what === '初始库存录入') {
        setProductError(`商品已建立，但库存登记没有成功：${status.message || status.code || '原因未知'}`)
      }
    }
    setNotice(`${unknownWrite.what}：这次没有成功（${status.code ?? '原因未知'}）。`)
  }

  const list = rows ?? []
  const productWriteUnknown = unknownWrite?.what === '商品保存' || unknownWrite?.what === '初始库存录入'
  const productAlreadyCreated = productForm.mode === 'create' && Boolean(productForm.createdProductId)
  const hasNewStockToRecord = productForm.mode === 'create' && Number(productDraft.initialQty) > 0
  const productDraftCostCents = productDraft.initialCostYuan.trim() ? yuanToCents(productDraft.initialCostYuan) : null
  const productFormBusy = savingProduct || productWriteUnknown
  const closeProductForm = () => {
    if (productAlreadyCreated) {
      setNotice('商品已建立，但库存尚未登记；可以稍后从“登记现有库存”补录。')
    }
    setProductForm({ mode: 'closed' })
  }

  return (
    <div className="wb-page wb-inventory-page">
      <header className="wb-page-head">
        <div>
          <p className="wb-kicker">库存管理</p>
          <h1>仓库</h1>
          <p className="wb-caption">
            按型号、单件和批次查看库存。自有在库量由可卖、已订和待处理组成；在途与客户保管单独列出。
          </p>
          <p className="wb-caption">报价不会改库存；成交先预留，确认交付后才出库。采购到货、收旧和拆件按来源入库。</p>
        </div>
        <div className="wb-page-head-actions">
          {canEditProduct ? (
            <button type="button" className="wb-btn" onClick={openProductCreate}>新增商品</button>
          ) : null}
          {canRecordOpening && openingWindow?.mode === 'formal' ? (
            <button type="button" className="wb-btn wb-btn--primary" onClick={openOpening}>登记现有库存</button>
          ) : canRecordOpening && openingWindow?.mode === 'preview' ? (
            <button type="button" className="wb-btn wb-btn--primary" onClick={openOpening}>试录现有库存（隔离预览）</button>
          ) : null}
          {canCount ? <button type="button" className="wb-btn" onClick={openCount}>记录实盘数量</button> : null}
        </div>
      </header>

      {canRecordOpening && openingWindow?.mode === 'formal' ? (
        <p className="wb-form-hint">店里已有的库存可以随时登记；系统启用后的新进货请走“采购到货”。库存登记会自动记下操作人和时间。</p>
      ) : null}

      <section className="wb-item-flow-hub" aria-label="配件收发常用入口">
        <div className="wb-item-flow-hub__heading">
          <div>
            <p className="wb-kicker">从配件实际来源进入</p>
            <h2>实物收进来，或确认交出去</h2>
          </div>
          <p>库存流水由业务单据按实物收发产生。报价、估价和预留不会直接改库存数量。</p>
        </div>
        <div className="wb-item-flow-hub__groups">
          <div className="wb-item-flow-hub__group">
            <h3>入库来源</h3>
            <p>到货或确认取得所有权后，按来源登记实物。</p>
            <div className="wb-item-flow-hub__links">
              <a className="wb-btn" href="/purchases">采购到货</a>
              <a className="wb-btn" href="/recovery">收旧件</a>
            </div>
          </div>
          <div className="wb-item-flow-hub__group">
            <h3>出库去向</h3>
            <p>成交先预留；确认配件已交付时才记出库。</p>
            <div className="wb-item-flow-hub__links">
              <a className="wb-btn wb-btn--primary" href="/sales/fulfillment">备料与交付</a>
            </div>
          </div>
        </div>
      </section>

      {openingWindow?.mode === 'preview' ? (
        <p className="wb-form-hint">隔离预览只使用演示数据，不会写入正式库存。</p>
      ) : null}
      {openingWindow?.mode === 'disabled' ? (
        <p className="wb-form-hint">当前环境未启用现有库存登记。</p>
      ) : null}
      {openingError && !openingOpen ? <p className="wb-form-error">{openingError}</p> : null}

      {notice ? (
        <p className="wb-inv-notice">
          {notice}
          <button type="button" className="wb-btn" onClick={() => setNotice('')}>知道了</button>
        </p>
      ) : null}

      {unknownWrite && !productWriteUnknown ? (
        <p className="wb-inv-notice wb-inv-notice--warn">
          {unknownWrite.what}的结果未知（请求编号 {unknownWrite.requestId ?? '—'}）。
          <button type="button" className="wb-btn" onClick={() => void checkUnknownResult()}>查询结果</button>
        </p>
      ) : null}

      {totals ? (
        <div className="wb-inv-totals">
          <span>自有在库 <b className="wb-tabular">{totals.ownOnHandQty}</b> 件</span>
          <span>可卖 <b className="wb-tabular">{totals.availableQty}</b></span>
          <span>已订 <b className="wb-tabular">{totals.reservedQty}</b></span>
          <span>待处理 <b className="wb-tabular">{totals.quarantineQty}</b></span>
          <span>客户保管 <b className="wb-tabular">{totals.customerCustodyCount}</b> 件（他人财产，不计入在库）</span>
        </div>
      ) : null}

      <section className={`wb-activity-panel${activityOpen ? ' is-open' : ''}`} aria-label="仓库操作日志">
        <button
          type="button"
          className="wb-activity-toggle"
          aria-expanded={activityOpen}
          aria-controls="wb-inventory-activity-list"
          onClick={toggleActivity}
        >
          <span className="wb-activity-toggle-copy">
            <strong>操作日志</strong>
            <small>全体仓库成员可查看 · 最近 50 条</small>
          </span>
          <span className="wb-activity-toggle-state">{activityOpen ? '收起' : '展开'}</span>
          <span className="wb-activity-chevron" aria-hidden="true" />
        </button>
        {activityOpen ? (
          <div className="wb-activity-content" id="wb-inventory-activity-list" aria-live="polite">
            {activityState === 'loading' ? <p className="wb-activity-state">正在读取操作日志…</p> : null}
            {activityState === 'error' ? (
              <div className="wb-activity-state wb-activity-state--error">
                <span>{activityError}</span>
                <button type="button" className="wb-btn" onClick={() => void loadActivity()}>重试</button>
              </div>
            ) : null}
            {activityState === 'ready' && activityItems.length === 0 ? <p className="wb-activity-state">还没有仓库操作记录。</p> : null}
            {activityState === 'ready' && activityItems.length > 0 ? (
              <>
                <ol className="wb-activity-list">
                  {activityItems.map((item) => {
                    const change = inventoryActivityChange(item)
                    return (
                      <li className={`wb-activity-entry is-${item.kind}`} key={item.id}>
                        <span className="wb-activity-entry-dot" aria-hidden="true" />
                        <div className="wb-activity-entry-body">
                          <div className="wb-activity-entry-head">
                            <strong>{inventoryActivityTitle(item)}</strong>
                            <time dateTime={item.occurredAt}>{formatInventoryActivityTime(item.occurredAt)}</time>
                          </div>
                          <p>{item.productName || (item.entityType ? `${item.entityType} · ${item.entityId ?? '—'}` : '仓库操作')}</p>
                          {change ? <span className="wb-activity-change">{change}</span> : null}
                          <div className="wb-activity-entry-meta">
                            <span>{inventoryActivityActor(item)}</span>
                            {item.kind === 'operation' && item.entityId ? <span>记录号 {item.entityId}</span> : null}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ol>
                <button type="button" className="wb-activity-refresh" onClick={() => void loadActivity()}>刷新日志</button>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <form
        className="wb-inv-toolbar"
        onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()); runSearch(query.trim()) }}
      >
        <input
          className="wb-inv-search"
          type="search"
          value={query}
          placeholder="型号、SKU、内部编号、厂家 SN、备注或批次号"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索库存"
        />
        <button type="submit" className="wb-btn">搜索</button>
        {appliedQuery ? (
          <button type="button" className="wb-btn" onClick={() => { setQuery(''); setAppliedQuery(''); setAvailability('all'); setCondition('all'); setListState('loading'); void fetchInventory({ limit: PAGE_LIMIT }).then(applyResult) }}>
            清除筛选
          </button>
        ) : null}
      </form>

      {appliedQuery ? (
        <section className="wb-inv-serial-results" aria-live="polite">
          <h2>编号与批次查询</h2>
          {serialMatches.length === 0 && batchMatches.length === 0 ? (
            <p className="wb-inv-note">没有匹配的内部编号、厂家 SN、备注或批次。</p>
          ) : null}
          {serialMatches.map((item) => (
            <button key={item.id} type="button" className="wb-inv-item wb-inv-item--button" onClick={() => openItemDetail(item.id)}>
              <span className="wb-inv-item-code wb-tabular">{item.assetCode}</span>
              <span className="wb-inv-item-sn wb-tabular">{item.snRaw || '未录厂家 SN'}</span>
              <span className="wb-inv-item-state">{item.productName} · {BUCKET_LABELS[item.availability]}{item.remark ? ` · ${item.remark}` : ''}</span>
            </button>
          ))}
          {batchMatches.map((batch) => (
            <div key={batch.id} className="wb-inv-batch-row">
              <strong className="wb-tabular">{batch.batchCode}</strong>
              <span>{batch.productName} · 本批入库 {batch.receivedQty} 件</span>
              {batch.remark ? <span>{batch.remark}</span> : null}
            </div>
          ))}
        </section>
      ) : null}

      <div className="wb-filter-row">
        {AVAILABILITY_FILTERS.map((filter) => (
          <button
            key={filter.key}
            type="button"
            className={availability === filter.key ? 'is-active' : ''}
            aria-pressed={availability === filter.key}
            onClick={() => { setAvailability(filter.key); setListState('loading'); void fetchInventory({ q: appliedQuery || undefined, availability: filter.key === 'all' ? undefined : filter.key, condition: condition === 'all' ? undefined : condition, limit: PAGE_LIMIT }).then(applyResult) }}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="wb-filter-row">
        {CONDITION_FILTERS.map((filter) => (
          <button
            key={filter.key}
            type="button"
            className={condition === filter.key ? 'is-active' : ''}
            aria-pressed={condition === filter.key}
            onClick={() => { setCondition(filter.key); setListState('loading'); void fetchInventory({ q: appliedQuery || undefined, availability: availability === 'all' ? undefined : availability, condition: filter.key === 'all' ? undefined : filter.key, limit: PAGE_LIMIT }).then(applyResult) }}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {listState === 'loading' ? (
        <div className="wb-inv-state">正在读取本店库存…</div>
      ) : listState === 'error' ? (
        <div className="wb-inv-state wb-inv-state--error">
          <strong>库存没能加载出来</strong>
          <span>{listError}</span>
          <button type="button" className="wb-btn" onClick={() => { setListState('loading'); void reload() }}>重试</button>
        </div>
      ) : list.length === 0 ? (
        <div className="wb-inv-state">
          <strong>{appliedQuery ? '没有匹配的型号' : '还没有商品档案'}</strong>
          <span>
            {appliedQuery
              ? '换个型号、SKU 或品牌再试，或点「清除筛选」。'
              : openingWindow?.mode === 'formal'
                ? '先建立商品型号；店里已有的库存可以随时登记，新进货请走采购到货。'
                : openingWindow?.mode === 'preview'
                  ? '先建立商品型号；隔离预览只支持旧格式试录，不会写入正式库存。'
                  : '先建立商品型号；当前环境未启用现有库存登记。'}
          </span>
        </div>
      ) : (
        <div className={`wb-inv-table${canViewCost ? '' : ' is-nocost'}`} role="table">
          <div className="wb-inv-head" role="row">
            <span role="columnheader">型号</span>
            <span role="columnheader">管理</span>
            <span role="columnheader">分类 / 品牌</span>
            <span role="columnheader">可卖</span>
            <span role="columnheader">已订</span>
            <span role="columnheader">待处理</span>
            <span role="columnheader">默认售价</span>
            {canViewCost ? <span role="columnheader">成本</span> : null}
          </div>

          {list.map((row) => {
            const open = expanded === row.id
            const cost = canViewCost
              ? row.costKnown === true
                ? costText(row.totalCostCents ?? null, true)
                : '成本未完全按实际口径确认，查看入库明细'
              : null
            return (
              <div key={row.id} className="wb-inv-group">
                <button
                  type="button"
                  className={`wb-inv-row${open ? ' is-open' : ''}`}
                  onClick={() => toggleRow(row)}
                  aria-expanded={open}
                >
                  <span className="wb-inv-name">
                    {row.name}
                    <span className="wb-inv-meta">
                      {row.sku || '未编 SKU'}
                      {row.status === 'disabled' ? ` · ${STATUS_LABELS[row.status]}` : ''}
                      {row.requiresSn ? ' · 逐件追踪' : ''}
                    </span>
                  </span>
                  <span className="wb-inv-cell">{TRACKING_LABELS[row.trackingMode]}</span>
                  <span className="wb-inv-cell wb-inv-cell--stack">
                    {row.category}
                    <small>{row.brand || '无品牌'}</small>
                  </span>
                  <span className="wb-inv-qty wb-tabular">{row.availableQty}</span>
                  <span className="wb-inv-qty wb-tabular">{row.reservedQty}</span>
                  <span className="wb-inv-qty wb-tabular">{row.quarantineQty}</span>
                  <span className="wb-inv-cell wb-tabular">{formatYuan(row.defaultSalePriceCents)}</span>
                  {cost === null ? null : <span className="wb-inv-cost wb-tabular">{cost}</span>}
                </button>

                {open ? (
                  <div className="wb-inv-breakdown">
                    <div className="wb-inv-breakdown-head">
                      数量构成 · 自有在库 {row.ownOnHandQty} 件
                      {canEditProduct ? (
                        <button type="button" className="wb-btn" onClick={() => openProductEdit(row)}>编辑商品</button>
                      ) : null}
                    </div>

                    {breakdownState === 'loading' ? (
                      <p className="wb-inv-note">正在读取逐件实物…</p>
                    ) : breakdownState === 'error' ? (
                      <p className="wb-inv-note">逐件实物没读出来，收起这一行再点一次可重试。</p>
                    ) : row.trackingMode === 'item' ? (
                      breakdown.length === 0 ? (
                        <p className="wb-inv-note">这件型号还没有逐件实物。</p>
                      ) : (
                        <ul className="wb-inv-item-list">
                          {breakdown.map((item) => (
                            <li key={item.id}>
                              <button
                                type="button"
                                className={`wb-inv-item wb-inv-item--button${itemDetailRef === item.id ? ' is-open' : ''}`}
                                onClick={() => openItemDetail(item.id)}
                              >
                                <span className="wb-inv-item-code wb-tabular">{item.assetCode}</span>
                                <span className="wb-inv-item-sn wb-tabular">{item.snRaw ?? '无 SN'}</span>
                                <span className="wb-inv-item-state">
                                  {BUCKET_LABELS[item.availability]} · {CONDITION_LABELS[item.condition]} · {OWNERSHIP_LABELS[item.ownership]} · {LOCATION_LABELS[item.location]}{item.remark ? ` · ${item.remark}` : ''}
                                </span>
                                {canViewCost ? (
                                  <span className="wb-inv-item-cost wb-tabular">
                                    {openingCostText(item.acquisitionCostBasis, item.acquisitionCostCents, item.costKnown === true, item.assessedEstimateCents)}
                                  </span>
                                ) : null}
                              </button>
                              {itemDetailRef === item.id && itemDetail ? (
                                <div className="wb-inv-item-detail">
                                  <span>
                                    来源：
                                    {itemDetail.acquisition
                                      ? `现有库存登记（${itemDetail.acquisition.createdAt}）`
                                      : '未记来源'}
                                  </span>
                                  <span>
                                    有效占用：
                                    {itemDetail.activeReservation ? itemDetail.activeReservation.orderRef : '无'}
                                  </span>
                                  <span className="wb-inv-item-moves">
                                    流水：
                                    {itemDetail.movements.length === 0
                                      ? '无'
                                      : itemDetail.movements
                                          .slice(0, 5)
                                          .map((move) => `${MOVEMENT_SOURCE_LABELS[move.source]} ${move.qty > 0 ? `+${move.qty}` : move.qty}`)
                                          .join('；')}
                                  </span>
                                  {workflowError && itemDetailRef === item.id ? <p className="wb-inv-notice wb-inv-notice--warn">{workflowError}</p> : null}
                                  {item.availability === 'quarantine' && canInspect ? <>
                                    <AttachmentPanel attachments={itemAttachments[item.id] ?? []} ownerType="stock_item" ownerId={item.id} canUpload={canUploadAttachment} onUploaded={(attachment) => {
                                      setItemAttachments((current) => ({ ...current, [item.id]: [...(current[item.id] ?? []), attachment] }))
                                      setInspectionEvidence((current) => [current, attachment.id].filter(Boolean).join(', '))
                                    }} />
                                    <label className="wb-field"><span>检测发现</span><textarea value={inspectionFindings} onChange={(event) => setInspectionFindings(event.target.value)} placeholder="如：接口、屏幕、运行状态" /></label>
                                    <label className="wb-field"><span>验机附件 ID（上传后自动填入，可调整）</span><input value={inspectionEvidence} onChange={(event) => setInspectionEvidence(event.target.value)} /></label>
                                    <div className="wb-form-actions">
                                      <button type="button" className="wb-btn wb-btn--primary" disabled={workflowBusy} onClick={() => void submitInspection(item, 'available')}>{workflowBusy ? '处理中…' : '验机通过并放行'}</button>
                                      <button type="button" className="wb-btn" disabled={workflowBusy} onClick={() => void submitInspection(item, 'retired')}>判定报废 / 退役</button>
                                    </div>
                                  </> : null}
                                  {canRefurbish && !listedForSale.includes(item.id) && ['acquired', 'refurbishing'].includes(itemDetail.recoveryState ?? '') && itemDetail.movements.some((move) => move.source === 'recovery_acquisition') ? <>
                                    <fieldset className="wb-form"><legend>整备上架（B30）</legend>
                                      {canViewCost && itemDetail.refurbishmentCosts?.length ? <div className="wb-inv-item-list" aria-label="整备财务凭据">
                                        <strong>已登记整备支出</strong>
                                        {itemDetail.refurbishmentCosts.map((cost) => <div key={cost.id} className="wb-inv-item">
                                          <span>{cost.category} · {formatYuan(cost.amountCents)}{cost.capitalizable ? ' · 计入实物成本' : ' · 费用记录'}</span>
                                          {cost.paymentEntryRef ? <span>付款流水：{cost.paymentEntryRef}</span> : null}
                                          {cost.evidenceRef ? <span>凭据引用：{cost.evidenceRef}</span> : null}
                                        </div>)}
                                      </div> : null}
                                      <label className="wb-field"><span>整备项目</span><input value={refurbishment.category} onChange={(event) => setRefurbishment({ ...refurbishment, category: event.target.value })} placeholder="如 清洁、换电池" /></label>
                                      <label className="wb-field"><span>整备金额（元）</span><input inputMode="decimal" value={refurbishment.amountYuan} onChange={(event) => setRefurbishment({ ...refurbishment, amountYuan: event.target.value })} /></label>
                                      <label className="wb-field"><span>实际付款流水编号（可选）</span><input value={refurbishment.paymentEntryRef} onChange={(event) => setRefurbishment({ ...refurbishment, paymentEntryRef: event.target.value })} placeholder="仅记录已有账本流水，不会自动记一笔付款" /></label>
                                      <label className="wb-field"><span>票据 / 附件引用（可选）</span><input value={refurbishment.evidenceRef} onChange={(event) => setRefurbishment({ ...refurbishment, evidenceRef: event.target.value })} placeholder="如发票号或已上传附件编号" /></label>
                                      <label className="wb-check"><input type="checkbox" checked={refurbishment.capitalizable} onChange={(event) => setRefurbishment({ ...refurbishment, capitalizable: event.target.checked })} />计入实物成本</label>
                                      <button type="button" className="wb-btn" disabled={workflowBusy} onClick={() => void submitRefurbishment(item)}>登记整备支出</button>
                                      <label className="wb-field"><span>上架成色</span><select value={saleDraft.conditionGrade} onChange={(event) => setSaleDraft({ ...saleDraft, conditionGrade: event.target.value as typeof saleDraft.conditionGrade })}><option value="like_new">近全新</option><option value="excellent">优秀</option><option value="good">良好</option><option value="fair">一般</option></select></label>
                                      <label className="wb-field"><span>售价（元）</span><input inputMode="decimal" value={saleDraft.saleYuan} onChange={(event) => setSaleDraft({ ...saleDraft, saleYuan: event.target.value })} /></label>
                                      <label className="wb-field"><span>成色 / 瑕疵披露</span><textarea value={saleDraft.disclosureNote} onChange={(event) => setSaleDraft({ ...saleDraft, disclosureNote: event.target.value })} /></label>
                                      <label className="wb-check"><input type="checkbox" checked={saleDraft.dataDisposed} onChange={(event) => setSaleDraft({ ...saleDraft, dataDisposed: event.target.checked })} />已清除原机个人数据</label>
                                      <label className="wb-field"><span>保修（月）</span><select value={saleDraft.warrantyTerm} onChange={(event) => setSaleDraft({ ...saleDraft, warrantyTerm: event.target.value as typeof saleDraft.warrantyTerm })}><option value="3">3</option><option value="6">6</option><option value="12">12</option><option value="24">24</option></select></label>
                                      {!itemDetail.movements.some((move) => move.source === 'inspection_release') ? <p className="wb-form-hint">先在上方完成 B19 验机放行，再提交整备上架。</p> : <button type="button" className="wb-btn wb-btn--primary" disabled={workflowBusy} onClick={() => void submitMakeAvailable(item)}>完成整备并上架</button>}
                                    </fieldset>
                                  </> : null}
                                </div>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )
                    ) : (
                      <p className="wb-inv-note">按数量管理的型号不逐件编号，数量由流水累计。</p>
                    )}
                    {row.trackingMode === 'quantity' && batchBreakdown.length > 0 ? (
                      <div className="wb-inv-batches">
                        <strong>入库批次</strong>
                        {batchBreakdown.map((batch) => (
                          <div key={batch.id} className="wb-inv-batch-row">
                            <span className="wb-tabular">{batch.batchCode}</span>
                            <span>本批入库 {batch.receivedQty} 件</span>
                            {batch.remark ? <span>{batch.remark}</span> : null}
                            {canViewCost ? <span>{openingCostText(batch.costBasis, batch.unitCostCents, batch.unitCostCents !== null && batch.unitCostCents !== undefined, batch.estimatedUnitCostCents)}</span> : null}
                            {canViewCost && batch.costEvidenceRef ? <span>依据：{batch.costEvidenceRef}</span> : null}
                            {canViewCost && batch.costAssessedAt ? <span>估值日：{batch.costAssessedAt}</span> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {breakdownTruncated ? (
                      <p className="wb-inv-note">逐件列表只显示前 {BREAKDOWN_LIMIT} 件，更多请按编号搜索。</p>
                    ) : null}

                    <SideBuckets items={breakdown} canViewCost={canViewCost} />
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <p className="wb-inv-foot">
        在途与客户保管单列展示，不计入自有在库量；未知成本显示为「成本未知」，不用 0 代替。
        没有成本权限的账号看不到成本列 —— 那一列的数字不会从后台发过来，不是在前端藏起来。
      </p>

      {productForm.mode !== 'closed' ? (
        <div className="wb-modal" role="dialog" aria-modal="true" aria-label={productForm.mode === 'edit' ? '编辑商品' : '新增商品'}>
          <div className="wb-modal-card">
            <div className="wb-modal-head">
              <h2>{productForm.mode === 'edit' ? `编辑商品 · ${productForm.row.name}` : '新增商品'}</h2>
              <button type="button" className="wb-btn" disabled={productFormBusy} onClick={closeProductForm}>关闭</button>
            </div>
            <form className="wb-form" onSubmit={submitProduct}>
              <div className="wb-product-core-grid">
              <label className="wb-field">
                <span>分类</span>
                <select
                  name="product-category"
                  aria-label="分类"
                  required={productForm.mode === 'create'}
                  value={customCategorySelected ? CUSTOM_CATEGORY_VALUE : PRODUCT_CATEGORY_OPTIONS.includes(productDraft.category as (typeof PRODUCT_CATEGORY_OPTIONS)[number]) ? productDraft.category : ''}
                  disabled={productAlreadyCreated || productFormBusy}
                  onChange={(event) => {
                    const value = event.target.value
                    const useCustomCategory = value === CUSTOM_CATEGORY_VALUE
                    setCustomCategorySelected(useCustomCategory)
                    setProductDraft({ ...productDraft, category: useCustomCategory ? '' : value })
                  }}
                >
                  <option value="">请选择商品分类</option>
                  {PRODUCT_CATEGORY_OPTIONS.map((category) => <option key={category} value={category}>{category}</option>)}
                  <option value={CUSTOM_CATEGORY_VALUE}>其他（自定义）</option>
                </select>
              </label>
              {customCategorySelected ? (
                <label className="wb-field">
                  <span>自定义分类</span>
                  <input name="product-category-custom" aria-label="自定义分类" value={productDraft.category} disabled={productAlreadyCreated || productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, category: event.target.value })} placeholder="填写商品所属类别" />
                </label>
              ) : null}
              <label className="wb-field">
                <span>品牌</span>
                <input name="product-brand" value={productDraft.brand} disabled={productAlreadyCreated || productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, brand: event.target.value })} placeholder="如 影驰" />
              </label>
              <label className="wb-field wb-product-name">
                <span>商品名称</span>
                <input name="product-name" value={productDraft.name} disabled={productAlreadyCreated || productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, name: event.target.value })} placeholder="如 影驰 RTX 4060 Ti 金属大师" />
              </label>
              <label className="wb-field">
                <span>SKU（可留空）</span>
                <input name="product-sku" value={productDraft.sku} disabled={productAlreadyCreated || productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, sku: event.target.value })} placeholder="如 GPU-4060TI-METAL" />
              </label>
              <label className="wb-field">
                <span>{productForm.mode === 'create' ? '新建商品参考售价（元）' : '当前参考售价（元）'}</span>
                <input name="product-sale" value={productDraft.saleYuan} onChange={(event) => setProductDraft({ ...productDraft, saleYuan: event.target.value })} placeholder="留空按 0 计" disabled={productForm.mode === 'edit' || productAlreadyCreated || productFormBusy} />
                {productForm.mode === 'edit' ? <p className="wb-form-hint">B40 改价首发暂缓；通用商品编辑不能调整挂牌参考价。</p> : null}
              </label>
              <label className="wb-field">
                <span>规格说明（可留空）</span>
                <input name="product-specs" value={productDraft.specs} disabled={productAlreadyCreated || productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, specs: event.target.value })} placeholder="如 8G / GDDR6" />
              </label>
              <label className="wb-field">
                <span>管理方式</span>
                <select name="product-tracking" value={productDraft.trackingMode} disabled={productAlreadyCreated || productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, trackingMode: event.target.value as 'quantity' | 'item' })}>
                  <option value="quantity">按数量（散片、线材一类）</option>
                  <option value="item">逐件管理（每件自动生成内部编号）</option>
                </select>
              </label>
              </div>
              {productForm.mode === 'create' ? (
                <>
                  <label className="wb-field">
                    <span>店里现有数量</span>
                    <input name="product-initial-qty" inputMode="numeric" value={productDraft.initialQty} disabled={productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, initialQty: event.target.value })} placeholder="0" />
                  </label>
                  <p className="wb-form-hint">填 0 只建立商品。新进货请走“采购到货”；不知道成本就留空，填 0 表示确实没有成本。</p>
                  {Number(productDraft.initialQty) > 0 ? (
                    <>
                      {productDraft.trackingMode === 'item' ? <p className="wb-form-hint">逐件管理会为每件自动生成内部编号。</p> : null}
                      {productDraft.trackingMode === 'item' ? (
                        <label className="wb-field">
                          <span>成色</span>
                          <select name="product-initial-condition" value={productDraft.initialCondition} disabled={productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, initialCondition: event.target.value as StockConditionValue })}>
                            <option value="new">新品</option>
                            <option value="used">二手</option>
                          </select>
                        </label>
                      ) : null}
                      <label className="wb-field">
                        <span>单件成本（元，可留空）</span>
                        <input
                          name="product-initial-cost"
                          inputMode="decimal"
                          value={productDraft.initialCostYuan}
                          disabled={productFormBusy}
                          onChange={(event) => {
                            const initialCostYuan = event.target.value
                            const cents = initialCostYuan.trim() ? yuanToCents(initialCostYuan) : null
                            setProductDraft({
                              ...productDraft,
                              initialCostYuan,
                              initialCostBasis: cents === 0 ? 'zero_cost' : cents === null ? 'known_actual' : productDraft.initialCostBasis,
                            })
                          }}
                          placeholder="不知道就留空；确实零成本填 0"
                        />
                      </label>
                      {productDraftCostCents !== null && productDraftCostCents > 0 ? (
                        <label className="wb-field">
                          <span>成本类型</span>
                          <select name="product-initial-cost-kind" value={productDraft.initialCostBasis === 'assessed_estimate' ? 'assessed_estimate' : 'known_actual'} disabled={productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, initialCostBasis: event.target.value as OpeningCostBasis })}>
                            <option value="known_actual">实际成本</option>
                            <option value="assessed_estimate">估算成本</option>
                          </select>
                        </label>
                      ) : null}
                      {productDraft.initialCostYuan.trim() ? (
                        <label className="wb-field">
                          <span>成本来源或备注（可留空）</span>
                          <input name="product-initial-cost-evidence" value={productDraft.initialCostEvidenceRef} disabled={productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, initialCostEvidenceRef: event.target.value })} placeholder="如采购单号、估算说明、赠与" />
                        </label>
                      ) : null}
                      {productDraft.initialCostBasis === 'assessed_estimate' && productDraftCostCents !== null && productDraftCostCents > 0 ? (
                        <p className="wb-form-hint">估算日期会自动记为今天；成本不确定时留空即可。</p>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}
              {productForm.mode === 'edit' ? (
                <>
                  <label className="wb-field">
                    <span>商品状态</span>
                    <select name="product-status" value={productDraft.status} disabled={productFormBusy} onChange={(event) => setProductDraft({ ...productDraft, status: event.target.value as 'active' | 'disabled' })}>
                      <option value="active">启用</option>
                      <option value="disabled">停用</option>
                    </select>
                  </label>
                  <p className="wb-form-hint">这是商品档案的启用状态；停用不会删除商品档案或历史记录。新建商品默认启用。</p>
                  <label className="wb-check">
                    <input
                      name="product-needs-sn"
                      type="checkbox"
                      checked={productDraft.trackingMode === 'item' ? true : productDraft.requiresSn}
                      disabled={productDraft.trackingMode === 'item' || productFormBusy}
                      onChange={(event) => setProductDraft({ ...productDraft, requiresSn: event.target.checked })}
                    />
                    需要逐件追踪（厂家 SN 可选）
                  </label>
                </>
              ) : null}

              {productError ? (
                <p className="wb-form-error">
                  {productError}
                  {productWriteUnknown ? (
                    <button type="button" className="wb-btn" onClick={() => void checkUnknownResult()}>查询结果</button>
                  ) : null}
                </p>
              ) : null}
              {productForm.mode === 'edit' ? (
                <p className="wb-form-hint">
                  这件商品当前版本 {productForm.row.version}；保存时会带上它，别人先改了就会拦下来而不是覆盖。
                </p>
              ) : null}
              <div className="wb-form-actions">
                <button type="submit" className="wb-btn wb-btn--primary" disabled={productFormBusy}>
                  {savingProduct ? (hasNewStockToRecord ? '正在建立并登记…' : '正在保存…') : productForm.mode === 'edit' ? '保存修改' : productAlreadyCreated ? '登记现有库存' : hasNewStockToRecord ? '建立商品并登记库存' : '建立商品'}
                </button>
                <button type="button" className="wb-btn" disabled={productFormBusy} onClick={closeProductForm}>取消</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {openingOpen ? (
        <div className="wb-modal" role="dialog" aria-modal="true" aria-label="登记现有库存">
          <div className="wb-modal-card wb-modal-card--wide">
            <div className="wb-modal-head">
              <h2>{openingWindow?.mode === 'formal' ? '登记现有库存' : '隔离预览试录（旧格式）'}</h2>
              <button type="button" className="wb-btn" onClick={() => setOpeningOpen(false)}>关闭</button>
            </div>
            {openingWindow?.mode === 'formal' ? (
              <p className="wb-form-hint">
                登记店里现在已有的自有库存。数量、成本和备注按实际填写；不知道成本可以留空，确实没有成本才填 0。系统自动生成编号并记录操作人和时间；新进货请走采购到货。
              </p>
            ) : (
              <p className="wb-form-hint">
                隔离预览使用演示格式，不会写入正式库存。
              </p>
            )}
            <form className="wb-form" onSubmit={submitOpening}>
              <label className="wb-field">
                <span>备注（可留空）</span>
                <input name="opening-note" value={openingNote} onChange={(event) => setOpeningNote(event.target.value)} />
              </label>

              {openingOptionsState === 'loading' ? <p className="wb-form-hint">正在读取可选的型号…</p> : null}
              {openingOptionsState === 'error' ? <p className="wb-form-error">型号列表没读出来，关闭后重开可重试。</p> : null}

              <div className="wb-opening-lines">
                {openingLines.map((line, index) => {
                  const product = productOf(line.productRef)
                  const perItem = product?.trackingMode === 'item'
                  // 这个提示不是拦截，是提前说清楚：服务端那条守卫只带错误码回来，
                  // 光看响应文案用户会以为是字段填错了（E04b 浏览器验收实测踩到过）。
                  const alreadyHasStock = Boolean(product && (product.storeItemCount > 0 || product.ownOnHandQty > 0))
                  return (
                    <div className="wb-opening-line" key={line.key}>
                      <span className="wb-opening-index">{index + 1}</span>
                      <label className="wb-field">
                        <span>型号</span>
                        <select name="opening-product" value={line.productRef} onChange={(event) => updateLine(line.key, { productRef: event.target.value })}>
                          <option value="">请选择型号</option>
                          {openingOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}{option.sku ? `（${option.sku}）` : ''} · {TRACKING_LABELS[option.trackingMode]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="wb-field">
                        <span>{perItem ? '数量（逐件固定 1）' : '数量'}</span>
                        <input
                          name="opening-qty"
                          inputMode="numeric"
                          value={perItem ? '1' : line.qty}
                          disabled={perItem}
                          onChange={(event) => updateLine(line.key, { qty: event.target.value })}
                        />
                      </label>
                      <label className="wb-field">
                        <span>{perItem ? '内部编号' : '批次编号'}</span>
                        <input value="提交后自动生成" readOnly />
                      </label>
                      <label className="wb-field">
                        <span>厂家 SN（可选，可扫码）</span>
                        <input
                          name="opening-sn"
                          value={line.snRaw}
                          disabled={!perItem}
                          onChange={(event) => updateLine(line.key, { snRaw: event.target.value })}
                        />
                      </label>
                      <label className="wb-field">
                        <span>备注</span>
                        <input value={line.remark} onChange={(event) => updateLine(line.key, { remark: event.target.value })} placeholder="可选" />
                      </label>
                      <label className="wb-field">
                        <span>成色</span>
                        <select
                          name="opening-condition"
                          value={line.condition}
                          disabled={!perItem}
                          onChange={(event) => updateLine(line.key, { condition: event.target.value as StockConditionValue })}
                        >
                          <option value="new">新品</option>
                          <option value="used">二手</option>
                        </select>
                      </label>
                      <label className="wb-field">
                        <span>单件成本（元，可留空）</span>
                        <input
                          name="opening-cost"
                          inputMode="decimal"
                          value={line.costYuan}
                          onChange={(event) => updateLine(line.key, { costYuan: event.target.value })}
                          placeholder="不知道就留空；确实零成本填 0"
                        />
                      </label>
                      {openingWindow?.mode === 'formal' && yuanToCents(line.costYuan) !== null && (yuanToCents(line.costYuan) ?? 0) > 0 ? (
                        <label className="wb-field">
                          <span>成本类型</span>
                          <select name="opening-cost-kind" value={line.costBasis === 'assessed_estimate' ? 'assessed_estimate' : 'known_actual'} onChange={(event) => updateLine(line.key, { costBasis: event.target.value as OpeningCostBasis })}>
                            <option value="known_actual">实际成本</option>
                            <option value="assessed_estimate">估算成本</option>
                          </select>
                        </label>
                      ) : null}
                      {openingWindow?.mode === 'formal' && line.costYuan.trim() ? (
                        <label className="wb-field">
                          <span>成本来源或备注（可留空）</span>
                          <input
                            name="opening-cost-evidence"
                            value={line.costEvidenceRef}
                            onChange={(event) => updateLine(line.key, { costEvidenceRef: event.target.value })}
                            placeholder="如采购单号、估算说明、赠与"
                          />
                        </label>
                      ) : null}
                      {openingWindow?.mode === 'formal' ? <p className="wb-form-hint">成本不确定留空，系统不会按 0 元计算；估算日期自动记录为今天。</p> : null}
                      <button
                        type="button"
                        className="wb-btn"
                        disabled={openingLines.length === 1}
                        onClick={() => setOpeningLines((current) => current.filter((item) => item.key !== line.key))}
                      >
                        删除本行
                      </button>
                      {alreadyHasStock ? (
                        <p className="wb-opening-warn">
                          「{product?.name}」已经有库存事实（自有在库 {product?.ownOnHandQty} 件 / 逐件 {product?.storeItemCount} 件）。
                          现有库存每个商品只登记一次；补货走采购到货，数量差异走实盘调整。
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </div>

              <div className="wb-form-actions">
                <button type="button" className="wb-btn" onClick={() => setOpeningLines((current) => [...current, newOpeningLine()])}>加一行</button>
              </div>

              {openingError ? <p className="wb-form-error">{openingError}</p> : null}

              <div className="wb-form-actions">
                <button type="submit" className="wb-btn wb-btn--primary" disabled={savingOpening}>
                  {savingOpening ? '正在登记…' : '保存库存'}
                </button>
                <button type="button" className="wb-btn" onClick={() => setOpeningOpen(false)}>取消</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {countOpen ? (
        <div className="wb-modal" role="dialog" aria-modal="true" aria-label="记录实盘数量">
          <div className="wb-modal-card">
            <div className="wb-modal-head">
              <h2>记录实盘数量</h2>
              <button type="button" className="wb-btn" onClick={() => setCountOpen(false)}>关闭</button>
            </div>
            <p className="wb-form-hint">把现场实际数到的数量记下来，与系统账面数量对照。保存只记录实盘结果，不会直接改库存；差异要由有批准权限的人确认后才会入账。目前不能通过盘点减少账面库存。</p>
            <label className="wb-field">
              <span>商品</span>
              <select value={countProductRef} disabled={Boolean(countDraft)} onChange={(event) => setCountProductRef(event.target.value)}>
                {(rows ?? []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </label>
            <label className="wb-field">
              <span>现场实盘数量</span>
              <input inputMode="numeric" value={countedQty} disabled={Boolean(countDraft)} onChange={(event) => setCountedQty(event.target.value)} />
            </label>
            <label className="wb-field">
              <span>备注 / 批准原因</span>
              <input value={countNote} onChange={(event) => setCountNote(event.target.value)} />
            </label>
            {countError ? <p className="wb-form-error">{countError}</p> : null}
            <div className="wb-form-actions">
              {!countDraft ? <button type="button" className="wb-btn wb-btn--primary" disabled={savingCount} onClick={() => void submitCount()}>{savingCount ? '正在保存…' : '保存实盘记录'}</button>
                : canApproveCount ? <button type="button" className="wb-btn wb-btn--primary" disabled={savingCount} onClick={() => void submitCountApproval()}>{savingCount ? '正在批准…' : '批准差异入账'}</button>
                  : <p className="wb-caption">实盘已保存，当前账号没有批准差异权限。</p>}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 在途与客户保管：都不计入自有在库量（03 §4 L84），所以永远单独一区。 */
function SideBuckets({ items, canViewCost }: { items: InventoryItemRow[]; canViewCost: boolean }) {
  const groups: Array<{ key: StockBucketValue; title: string; note: string }> = [
    { key: 'in_transit', title: '在途', note: '不计入自有在库量' },
    { key: 'customer_custody', title: '客户保管', note: '他人财产，不计入自有在库量' },
  ]
  return (
    <>
      {groups.map((group) => {
        const scoped = items.filter((item) => item.availability === group.key)
        if (scoped.length === 0) return null
        return (
          <div className="wb-inv-side" key={group.key}>
            <div className="wb-inv-side-head">
              <span className="wb-inv-side-title">{group.title}</span>
              <span className="wb-inv-side-note">{group.note}</span>
            </div>
            <ul className="wb-inv-item-list">
              {scoped.map((item) => (
                <li key={item.id}>
                  <div className="wb-inv-item">
                    <span className="wb-inv-item-code wb-tabular">{item.assetCode}</span>
                    <span className="wb-inv-item-sn wb-tabular">{item.snRaw ?? '无 SN'}</span>
                    <span className="wb-inv-item-state">
                      {CONDITION_LABELS[item.condition]} · {OWNERSHIP_LABELS[item.ownership]} · {LOCATION_LABELS[item.location]}
                    </span>
                    {canViewCost ? (
                      <span className="wb-inv-item-cost wb-tabular">
                        {openingCostText(item.acquisitionCostBasis, item.acquisitionCostCents, item.costKnown === true, item.assessedEstimateCents)}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </>
  )
}

export default WorkbenchInventoryPage
