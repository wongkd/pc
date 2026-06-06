import { useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import type { HardwareLibraryItem } from '../types/quote'
import {
  HARDWARE_LIBRARY_COLUMNS,
  normalizeHardwareLibraryRows,
} from '../utils/hardwareLibraryExcel'
import { addLibraryItems, updateLibraryItem as apiUpdateLibraryItem, deleteLibraryItem as apiDeleteLibraryItem } from '../utils/api'

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function useHardwareLibrary(
  library: HardwareLibraryItem[],
  setLibrary: React.Dispatch<React.SetStateAction<HardwareLibraryItem[]>>,
  addQuoteItemFromLibrary: (item: HardwareLibraryItem) => void,
  /** 云端同步回调（可选，已登录时传入） */
  cloudSync?: boolean,
) {
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('全部')

  const categories = useMemo(() => {
    const values = new Set(library.map((item) => item.category).filter(Boolean))
    return ['全部', ...Array.from(values)]
  }, [library])

  const filteredLibrary = useMemo(() => {
    return library.filter((item) => {
      const matchesCategory = categoryFilter === '全部' || item.category === categoryFilter
      const keyword = search.trim().toLowerCase()
      const matchesSearch =
        keyword === '' ||
        item.category.toLowerCase().includes(keyword) ||
        item.description.toLowerCase().includes(keyword)
      return matchesCategory && matchesSearch
    })
  }, [categoryFilter, library, search])

  const addLibraryItem = () => {
    setLibrary((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        category: '',
        description: '',
        price: 0,
        image: '',
      },
    ])
  }

  /** 带云端同步的添加 */
  const addLibraryItemWithCloud = async (category: string, description: string, price: number, image = '') => {
    const localId = crypto.randomUUID()
    setLibrary((current) => [...current, { id: localId, category, description, price, image }])
    if (!cloudSync) return
    try {
      const res = await addLibraryItems([{ category, name: description, price, image }])
      if (res.ok && res.items?.length > 0) {
        const cloudId = String(res.items[0].id)
        setLibrary((current) =>
          current.map((item) => item.id === localId ? { ...item, id: cloudId } : item)
        )
      }
    } catch {}
  }

  const updateLibraryItem = (
    id: string,
    field: keyof HardwareLibraryItem,
    value: string | number,
  ) => {
    setLibrary((current) =>
      current.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    )
    const numId = Number(id)
    if (cloudSync && Number.isFinite(numId)) {
      apiUpdateLibraryItem(numId, { [field]: value }).catch(() => {})
    }
  }

  const deleteLibraryItem = (id: string) => {
    setLibrary((current) => current.filter((item) => item.id !== id))
    const numId = Number(id)
    if (cloudSync && Number.isFinite(numId)) {
      apiDeleteLibraryItem(numId).catch(() => {})
    }
  }

  const exportJson = () => {
    downloadBlob(
      new Blob([JSON.stringify(library, null, 2)], { type: 'application/json' }),
      'hardware-library.json',
    )
  }

  const importJson = async (file: File) => {
    const raw = await file.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('JSON 文件解析失败，请检查文件内容。')
    }

    if (!Array.isArray(parsed)) {
      throw new Error('JSON 文件格式无效，必须是数组。')
    }

    const nextLibrary = parsed
      .map((item) => {
        const entry = item as Partial<HardwareLibraryItem>
        return {
          id: crypto.randomUUID(),
          category: String(entry.category ?? '').trim(),
          description: String(entry.description ?? '').trim(),
          price: Number(entry.price ?? 0),
          image: String(entry.image ?? '').trim(),
        }
      })
      .filter((item) => item.category && item.description)

    setLibrary(nextLibrary)
    setCategoryFilter('全部')
    setSearch('')
  }

  const exportExcel = () => {
    const rows = [
      [...HARDWARE_LIBRARY_COLUMNS],
      ...library.map((item) => [item.category, item.description, item.price, item.image ?? '']),
    ]
    const workbook = XLSX.utils.book_new()
    const worksheet = XLSX.utils.aoa_to_sheet(rows)
    XLSX.utils.book_append_sheet(workbook, worksheet, '硬件库')
    XLSX.writeFile(workbook, 'hardware-library.xlsx')
  }

  const importExcel = async (file: File) => {
    const data = await file.arrayBuffer()
    const workbook = XLSX.read(data, { type: 'array' })
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
    if (!firstSheet) {
      throw new Error('Excel 文件中没有可读取的工作表。')
    }

    const rows = XLSX.utils.sheet_to_json(firstSheet, {
      header: 1,
      defval: '',
      raw: false,
    }) as unknown[][]

    const result = normalizeHardwareLibraryRows(rows)
    if (result.errors.length > 0) {
      throw new Error(result.errors.join('\n'))
    }

    setLibrary(result.items)
    setCategoryFilter('全部')
    setSearch('')
  }

  const handleAddToQuote = (item: HardwareLibraryItem) => {
    addQuoteItemFromLibrary(item)
  }

  return {
    categories,
    filteredLibrary,
    search,
    setSearch,
    categoryFilter,
    setCategoryFilter,
    addLibraryItem,
    addLibraryItemWithCloud,
    updateLibraryItem,
    deleteLibraryItem,
    exportJson,
    importJson,
    exportExcel,
    importExcel,
    handleAddToQuote,
  }
}
