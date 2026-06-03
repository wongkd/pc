import { useEffect, useMemo, useRef, useState } from 'react'
import { BaseInfoSection } from './components/BaseInfoSection'
import { HardwareLibrarySection } from './components/HardwareLibrarySection'
import { LoginPanel } from './components/LoginPanel'
import { NotesSection } from './components/NotesSection'
import { QuoteCustomerView } from './components/QuoteCustomerView'
import { QuoteItemsSection } from './components/QuoteItemsSection'
import { QuotePreview } from './components/QuotePreview'
import { QuoteToolbar } from './components/QuoteToolbar'
import { useHardwareLibrary } from './hooks/useHardwareLibrary'
import { useHtml2Canvas } from './hooks/useHtml2Canvas'
import { clearToken, fetchLibrary, fetchTemplates, saveTemplateToCloud, deleteTemplateFromCloud, isLoggedIn, changePassword as apiChangePassword } from './utils/api'
import type {
  AppStorageData,
  BrandInfo,
  HardwareLibraryItem,
  MerchantTemplate,
  Orientation,
  QuoteDocument,
  QuoteItem,
  QuoteMeta,
  ViewSettings,
} from './types/quote'
import { getTodayInputValue } from './utils/date'
import { buildQuoteHtml } from './utils/exportHtml'
import { loadFromStorage, saveToStorage } from './utils/storage'
import './index.css'

const STORAGE_KEY = 'pc-quote-app'
const MERCHANT_TEMPLATE_STORAGE_KEY = 'pc-quote-app:merchant-templates'
const DEFAULT_QUOTE_NO_PREFIX = 'PC'
const DEFAULT_QUOTE_NO_SUFFIX = '001'
const STANDARD_QUOTE_NO_PATTERN = /^(.+)-(\d{8})-([A-Za-z0-9]+)$/

const DEFAULT_QUOTE_ITEM_CATEGORIES = [
  'CPU',
  '主板',
  '内存',
  '显卡',
  '硬盘',
  '电源',
  '散热器',
  '机箱',
  '风扇',
  '显示器',
] as const

function formatDateSegment(input: string) {
  return input.replaceAll('-', '').trim()
}

function buildDefaultQuoteNo(date: string) {
  return `${DEFAULT_QUOTE_NO_PREFIX}-${formatDateSegment(date)}-${DEFAULT_QUOTE_NO_SUFFIX}`
}

function isStandardQuoteNo(value: string) {
  return STANDARD_QUOTE_NO_PATTERN.test(value.trim())
}

function syncQuoteNoWithDate(quoteNo: string, quoteDate: string) {
  const normalizedQuoteNo = quoteNo.trim()
  const dateSegment = formatDateSegment(quoteDate)

  if (!dateSegment) {
    return normalizedQuoteNo || quoteNo
  }

  if (!normalizedQuoteNo) {
    return buildDefaultQuoteNo(quoteDate)
  }

  const match = normalizedQuoteNo.match(STANDARD_QUOTE_NO_PATTERN)
  if (!match) {
    return normalizedQuoteNo
  }

  const [, prefix, , suffix] = match
  return `${prefix}-${dateSegment}-${suffix}`
}

const defaultBrand: BrandInfo = {
  companyName: '企稳稳科技',
  slogan: '专业工作站与电脑配置报价服务',
  logoDataUrl: '',
  contactPerson: '黄启栋',
  contactPhone: '17620992684',
  contactWechat: '17620992684',
  contactAddress: '广东省湛江市赤坎区东园西村20号园和苑',
}

const defaultQuoteDate = getTodayInputValue()

const defaultMeta: QuoteMeta = {
  quoteNo: buildDefaultQuoteNo(defaultQuoteDate),
  quoteDate: defaultQuoteDate,
  customerName: '广州智诚贸易有限公司',
  contactName: '张经理',
  contactPhone: '13800000000',
  projectTitle: '高性能图形工作站配置方案',
}

const defaultViewSettings: ViewSettings = {
  previewMode: 'document',
  orientation: 'portrait',
}

const defaultLibrary: HardwareLibraryItem[] = [
  { id: crypto.randomUUID(), category: 'CPU', description: 'Intel Core i7-14700K', price: 0, image: '' },
  { id: crypto.randomUUID(), category: 'CPU', description: 'Intel Core i5-14600KF', price: 0, image: '' },
  { id: crypto.randomUUID(), category: 'CPU', description: 'AMD Ryzen 9 7950X', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '显卡', description: 'NVIDIA RTX 4070 SUPER', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '显卡', description: 'NVIDIA RTX 4060 Ti', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '内存', description: 'Kingston Fury Beast DDR5 32GB', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '内存', description: 'Corsair Vengeance DDR5 32GB', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '硬盘', description: 'Samsung 990 EVO Plus 1TB', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '硬盘', description: 'WD Black SN850X 2TB', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '主板', description: 'MSI MAG Z790 TOMAHAWK WIFI', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '主板', description: 'ASUS ROG STRIX B760-A', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '电源', description: 'Corsair RM850e', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '散热器', description: 'DeepCool AK620', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '散热器', description: 'Noctua NH-D15', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '机箱', description: 'Lian Li Lancool 216', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '显示器', description: 'Dell U2724D', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '显示器', description: 'LG 27GP850-B', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '风扇', description: 'Arctic P12 PWM PST', price: 0, image: '' },
  { id: crypto.randomUUID(), category: '风扇', description: 'Noctua NF-A12x25', price: 0, image: '' },
]

const createQuoteSkeletonItem = (category: string): QuoteItem => ({
  id: crypto.randomUUID(),
  category,
  name: '',
  details: '',
  quantity: 1,
  unitPrice: 0,
  image: '',
})

const defaultQuoteItems: QuoteItem[] = DEFAULT_QUOTE_ITEM_CATEGORIES.map((category) =>
  createQuoteSkeletonItem(category),
)

const defaultStorageData: AppStorageData = {
  brand: defaultBrand,
  meta: defaultMeta,
  notes: [
    '1. 报价包含整机装配、基础驱动安装与常规测试。',
    '2. 以收货日为准计算质保时长，整机一年质保，续保费用为整机费用 5% 每年。',
    '3. 库存与交付时间以下单当日实际确认为准。',
  ].join('\n'),
  hardwareLibrary: defaultLibrary,
  quoteItems: defaultQuoteItems,
  viewSettings: defaultViewSettings,
}

function normalizeStoredState(raw: unknown): AppStorageData {
  const data = (raw ?? {}) as Partial<AppStorageData> & {
    meta?: Partial<QuoteMeta> & { orientation?: Orientation }
    previewMode?: ViewSettings['previewMode']
  }

  const nextMeta = { ...defaultMeta, ...data.meta }
  if (!nextMeta.quoteNo?.trim()) {
    nextMeta.quoteNo = buildDefaultQuoteNo(nextMeta.quoteDate || defaultQuoteDate)
  }

  return {
    brand: { ...defaultBrand, ...data.brand },
    meta: nextMeta,
    notes: data.notes ?? defaultStorageData.notes,
    hardwareLibrary: data.hardwareLibrary ?? defaultLibrary,
    quoteItems: Array.isArray(data.quoteItems) ? data.quoteItems : defaultQuoteItems,
    viewSettings: {
      previewMode:
        data.viewSettings?.previewMode ??
        data.previewMode ??
        defaultViewSettings.previewMode,
      orientation:
        data.viewSettings?.orientation ??
        data.meta?.orientation ??
        defaultViewSettings.orientation,
    },
  }
}

function normalizeMerchantTemplates(raw: unknown): MerchantTemplate[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw
    .map((item) => {
      const template = item as Partial<MerchantTemplate>
      return {
        id: template.id ?? crypto.randomUUID(),
        name: template.name ?? '未命名模板',
        brand: { ...defaultBrand, ...template.brand },
        updatedAt: template.updatedAt ?? new Date().toISOString(),
      }
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

function downloadText(filename: string, content: string, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function App() {
  const initialState = useMemo(
    () => normalizeStoredState(loadFromStorage<unknown>(STORAGE_KEY, defaultStorageData)),
    [],
  )

  const initialTemplates = useMemo(
    () =>
      normalizeMerchantTemplates(
        loadFromStorage<unknown>(MERCHANT_TEMPLATE_STORAGE_KEY, []),
      ),
    [],
  )

  const [brand, setBrand] = useState(initialState.brand)
  const [meta, setMeta] = useState(initialState.meta)
  const [notes, setNotes] = useState(initialState.notes)
  const [hardwareLibrary, setHardwareLibrary] = useState(initialState.hardwareLibrary)
  const [quoteItems, setQuoteItems] = useState(initialState.quoteItems)
  const [viewSettings, setViewSettings] = useState(initialState.viewSettings)
  const [merchantTemplates, setMerchantTemplates] = useState(initialTemplates)
  const [hardwareLibraryExpanded, setHardwareLibraryExpanded] = useState(false)
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null)
  const [loggedIn, setLoggedIn] = useState(isLoggedIn())
  const [cloudLoading, setCloudLoading] = useState(false)
  const [showPwdModal, setShowPwdModal] = useState(false)
  const [pwdOld, setPwdOld] = useState('')
  const [pwdNew, setPwdNew] = useState('')
  const [pwdMsg, setPwdMsg] = useState('')
  const previewRef = useRef<HTMLDivElement>(null)
  const { exportPng, exportPdf } = useHtml2Canvas()

  // 登录后从云端加载硬件库和模板
  useEffect(() => {
    if (!loggedIn) return
    setCloudLoading(true)
    Promise.all([
      fetchLibrary(),
      fetchTemplates(),
    ]).then(([libItems, tmplItems]) => {
      if (libItems.length > 0) {
        const mapped = libItems.map((i: any) => ({
          id: String(i.id), category: i.category || '', description: i.name || i.description || '',
          price: Number(i.price) || 0, image: i.image || '', lastRefreshed: i.refreshed_at || '', sourcePlatform: i.platform || '',
        }))
        setHardwareLibrary(mapped)
      }
      if (tmplItems.length > 0) {
        const templates = tmplItems.map((t: any) => {
          let data = { brand: {}, meta: {} }
          try { data = JSON.parse(t.data) } catch {}
          return { id: String(t.id), name: t.name, brand: data.brand || {}, updatedAt: t.updated_at || '' }
        })
        setMerchantTemplates(templates)
      }
    }).catch(() => {}).finally(() => setCloudLoading(false))
  }, [loggedIn])

  const handleLogout = () => { clearToken(); setLoggedIn(false); setHardwareLibrary([]) }
  const handleChangePwd = async () => {
    setPwdMsg('')
    if (!pwdOld || !pwdNew || pwdNew.length < 6) { setPwdMsg('新密码至少6位'); return }
    const r = await apiChangePassword(pwdOld, pwdNew)
    if (r.ok) { setPwdMsg('修改成功'); setTimeout(() => { setShowPwdModal(false); setPwdOld(''); setPwdNew(''); setPwdMsg('') }, 1500) }
    else setPwdMsg(r.error || '修改失败')
  }

  useEffect(() => {
    saveToStorage<AppStorageData>(STORAGE_KEY, {
      brand,
      meta,
      notes,
      hardwareLibrary,
      quoteItems,
      viewSettings,
    })
  }, [brand, meta, notes, hardwareLibrary, quoteItems, viewSettings])

  useEffect(() => {
    saveToStorage<MerchantTemplate[]>(MERCHANT_TEMPLATE_STORAGE_KEY, merchantTemplates)
  }, [merchantTemplates])

  useEffect(() => {
    document.title = `${meta.projectTitle || '电脑配置报价单'} - ${brand.companyName || '未命名品牌'}`
  }, [brand.companyName, meta.projectTitle])

  useEffect(() => {
    const styleId = 'print-orientation-style'
    let style = document.getElementById(styleId)
    if (!style) {
      style = document.createElement('style')
      style.id = styleId
      document.head.appendChild(style)
    }
    style.textContent = `@page { size: A4 ${viewSettings.orientation}; margin: 10mm; }`
  }, [viewSettings.orientation])

  useEffect(() => {
    if (!highlightedItemId) {
      return
    }

    const timer = window.setTimeout(() => setHighlightedItemId(null), 2200)
    return () => window.clearTimeout(timer)
  }, [highlightedItemId])

  const addQuoteItemFromLibrary = (item: HardwareLibraryItem) => {
    const nextItem: QuoteItem = {
      id: crypto.randomUUID(),
      category: item.category,
      name: item.description,
      details: '',
      quantity: 1,
      unitPrice: item.price,
      image: item.image ?? '',
      libraryItemId: item.id,
    }

    setQuoteItems((current) => [...current, nextItem])
    setHighlightedItemId(nextItem.id)
  }

  const library = useHardwareLibrary(
    hardwareLibrary,
    setHardwareLibrary,
    addQuoteItemFromLibrary,
  )

  const handleBrandChange = (field: keyof BrandInfo, value: string) => {
    setBrand((current) => ({ ...current, [field]: value }))
  }

  const handleMetaChange = (field: keyof QuoteMeta, value: string) => {
    setMeta((current) => {
      if (field !== 'quoteDate') {
        return { ...current, [field]: value }
      }

      const nextQuoteDate = value
      const nextQuoteNo =
        !current.quoteNo.trim() || isStandardQuoteNo(current.quoteNo)
          ? syncQuoteNoWithDate(current.quoteNo, nextQuoteDate)
          : current.quoteNo

      return {
        ...current,
        quoteDate: nextQuoteDate,
        quoteNo: nextQuoteNo,
      }
    })
  }

  const handleViewSettingsChange = (patch: Partial<ViewSettings>) => {
    setViewSettings((current) => ({ ...current, ...patch }))
  }

  const handleSaveMerchantTemplate = (name: string) => {
    const nextTemplate: MerchantTemplate = {
      id: crypto.randomUUID(),
      name,
      brand: { ...brand },
      updatedAt: new Date().toISOString(),
    }
    setMerchantTemplates((current) => [nextTemplate, ...current])
    if (loggedIn) saveTemplateToCloud(name, { brand }).catch(() => {})
  }

  const handleApplyMerchantTemplate = (id: string) => {
    setMerchantTemplates((current) => {
      const template = current.find((item) => item.id === id)
      if (!template) {
        return current
      }

      setBrand({ ...template.brand })
      return current
    })
  }

  const handleDeleteMerchantTemplate = (id: string) => {
    setMerchantTemplates((current) => current.filter((item) => item.id !== id))
    if (loggedIn) deleteTemplateFromCloud(Number(id)).catch(() => {})
  }

  const handleLogoUpload = (file: File | null) => {
    if (!file) {
      setBrand((current) => ({ ...current, logoDataUrl: '' }))
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      setBrand((current) => ({
        ...current,
        logoDataUrl: typeof reader.result === 'string' ? reader.result : '',
      }))
    }
    reader.readAsDataURL(file)
  }

  const addQuoteItem = (category = '其他') => {
    const nextItem = createQuoteSkeletonItem(category)
    setQuoteItems((current) => [...current, nextItem])
    setHighlightedItemId(nextItem.id)
  }

  const updateQuoteItem = (id: string, field: keyof QuoteItem, value: string | number) => {
    setQuoteItems((current) =>
      current.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    )
  }

  const deleteQuoteItem = (id: string) => {
    setQuoteItems((current) => current.filter((item) => item.id !== id))
    setHighlightedItemId((current) => (current === id ? null : current))
  }

  const handleExportHtml = () => {
    const document: QuoteDocument = { brand, meta, notes, hardwareLibrary, quoteItems }
    downloadText('quote-preview.html', buildQuoteHtml(document), 'text/html;charset=utf-8')
  }

  const handleExportPng = async () => {
    if (previewRef.current) {
      await exportPng(previewRef.current, 'quote-preview.png')
    }
  }

  const handleExportPdf = async () => {
    if (previewRef.current) {
      await exportPdf(previewRef.current, 'quote-preview.pdf', viewSettings.orientation)
    }
  }

  const handleImportJson = async (file: File) => {
    try {
      await library.importJson(file)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'JSON 导入失败。')
    }
  }

  const handleImportExcel = async (file: File) => {
    try {
      await library.importExcel(file)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Excel 导入失败。')
    }
  }

  return (
    <div className="shell">
      {!loggedIn ? (
        <LoginPanel onLogin={() => setLoggedIn(true)} />
      ) : (
      <div className="app-shell">
      <div className="auth-btns no-print">
        <button onClick={() => setShowPwdModal(true)}>改密</button>
        <button onClick={handleLogout}>注销</button>
      </div>
      {showPwdModal && (
        <div className="pwd-overlay" onClick={() => setShowPwdModal(false)}>
          <div className="pwd-card" onClick={(e) => e.stopPropagation()}>
            <h3>修改密码</h3>
            <input type="password" placeholder="旧密码" value={pwdOld} onChange={(e) => setPwdOld(e.target.value)} />
            <input type="password" placeholder="新密码（至少6位）" value={pwdNew} onChange={(e) => setPwdNew(e.target.value)} />
            {pwdMsg && <p className="pwd-msg" style={{ color: pwdMsg.includes('成功') ? '#16a34a' : '#ef4444' }}>{pwdMsg}</p>}
            <button onClick={handleChangePwd}>确认修改</button>
          </div>
        </div>
      )}
      <div className="layout">
        <section className="panel editor-panel">
          {cloudLoading ? (
            <div className="panel-section" style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>正在加载云端硬件库…</div>
          ) : (
          <>
          <QuoteItemsSection
            title={meta.projectTitle}
            items={quoteItems}
            libraryItems={hardwareLibrary}
            highlightedItemId={highlightedItemId}
            onTitleChange={(value) => handleMetaChange('projectTitle', value)}
            onAddItem={addQuoteItem}
            onDeleteItem={deleteQuoteItem}
            onChangeItem={updateQuoteItem}
            onClearAll={() => setQuoteItems([])}
          />

          <BaseInfoSection
            brand={brand}
            meta={meta}
            templates={merchantTemplates}
            onBrandChange={handleBrandChange}
            onMetaChange={handleMetaChange}
            onLogoUpload={handleLogoUpload}
            onSaveTemplate={handleSaveMerchantTemplate}
            onApplyTemplate={handleApplyMerchantTemplate}
            onDeleteTemplate={handleDeleteMerchantTemplate}
          />

          <NotesSection notes={notes} onChange={setNotes} />

          <details
            className="editor-library-shell"
            open={hardwareLibraryExpanded}
            onToggle={(event) =>
              setHardwareLibraryExpanded((event.currentTarget as HTMLDetailsElement).open)
            }
          >
            <summary>硬件库</summary>
            <HardwareLibrarySection
              items={library.filteredLibrary}
              search={library.search}
              categoryFilter={library.categoryFilter}
              onSearchChange={library.setSearch}
              onCategoryFilterChange={library.setCategoryFilter}
              onAddItem={(cat, desc, price) => {
                setHardwareLibrary((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    category: cat,
                    description: desc,
                    price,
                    image: '',
                  },
                ])
              }}
              onUpdateItem={library.updateLibraryItem}
              onDeleteItem={library.deleteLibraryItem}
            />
          </details>
          </>
          )}
        </section>

        <section className="panel preview-workbench">
          <div className="preview-workbench-head">
            <div className="section-head-copy">
              <h2>报价单预览</h2>
            </div>
          </div>

          <QuoteToolbar
            previewMode={viewSettings.previewMode}
            orientation={viewSettings.orientation}
            onPreviewModeChange={(previewMode) => handleViewSettingsChange({ previewMode })}
            onOrientationChange={(orientation) => handleViewSettingsChange({ orientation })}
            onPrint={() => window.print()}
            onExportPng={handleExportPng}
            onExportPdf={handleExportPdf}
            onExportHtml={handleExportHtml}
          />

          <div className="preview-workbench-body">
            <div className="preview-stage" ref={previewRef} tabIndex={-1}>
              {viewSettings.previewMode === 'document' ? (
                <QuotePreview
                  brand={brand}
                  meta={meta}
                  notes={notes}
                  items={quoteItems}
                  orientation={viewSettings.orientation}
                />
              ) : (
                <QuoteCustomerView
                  brand={brand}
                  meta={meta}
                  items={quoteItems}
                  orientation={viewSettings.orientation}
                />
              )}
            </div>
          </div>
        </section>
      </div>
      </div>
      )}
    </div>
  )
}

export default App
