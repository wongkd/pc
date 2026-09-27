import { useCallback, useEffect, useRef, useState } from 'react'
import { defaultRequestId } from '../../api/core'
import { CATALOG_IMAGE_PRESETS } from '../../contracts/v2/generated/catalog'
import { catalogImageUrl, listCatalog, saveCatalog, uploadCatalogImage, type CatalogProduct, type CatalogWrite } from './catalog-api'
import { ImageCropDialog } from './ImageCropDialog'
import './catalog.css'

function ProductImage({ id }: { id: string | null }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true; let objectUrl = ''; setUrl('')
    if (id) void catalogImageUrl(id).then(value => { objectUrl = value; if (active) setUrl(value); else URL.revokeObjectURL(value) }).catch(() => {})
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [id])
  return url ? <img className="catalog-image" src={url} alt="商品图片预览" /> : <span className="catalog-image-empty">{id ? '图片暂不可见，可重新上传' : '尚未上传图片'}</span>
}

export function CatalogPage({ permissions }: { permissions: string[] }) {
  const canEdit = permissions.includes('*') || permissions.includes('library/edit')
  const [items, setItems] = useState<CatalogProduct[]>([]); const [page, setPage] = useState(1); const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<CatalogProduct | null>(null); const [price, setPrice] = useState('')
  const [saving, setSaving] = useState(false); const [formError, setFormError] = useState('')
  const [cropping, setCropping] = useState<{ file: File; preset: 'cover' | 'hero' } | null>(null)
  const pending = useRef<CatalogWrite | null>(null); const inFlight = useRef(false); const generation = useRef(0)
  const load = useCallback(async () => {
    const request = ++generation.current; setLoading(true); setError('')
    try { const data = await listCatalog(page); if (request === generation.current) { setItems(data.items); setMore(data.hasMore) } }
    catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : '商品加载失败') }
    finally { if (request === generation.current) setLoading(false) }
  }, [page])
  useEffect(() => { void load(); return () => { generation.current++ } }, [load])
  const open = (item?: CatalogProduct) => {
    setDraft(item || { id: defaultRequestId(), title: '', category: '整机', description: '', priceCents: 0, coverImageId: null, heroImageId: null, status: 'draft', version: 0 })
    setPrice(item ? (item.priceCents / 100).toFixed(2) : ''); setFormError(''); pending.current = null
  }
  const save = async (status: CatalogProduct['status']) => {
    if (!draft || inFlight.current) return
    if (!draft.title.trim()) { setFormError('请填写商品名称'); return }
    if (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) > 1000000) { setFormError('请输入0至100万元的售价，最多两位小数'); return }
    const product = { ...draft, title: draft.title.trim(), priceCents: Math.round(Number(price) * 100), status }
    if (status === 'published' && !product.coverImageId) { setFormError('请先上传商品列表图'); return }
    if (!pending.current || JSON.stringify(pending.current.product) !== JSON.stringify(product)) pending.current = { product, expectedVersion: draft.version, mutationId: defaultRequestId() }
    inFlight.current = true; setSaving(true); setFormError('')
    try {
      await saveCatalog(pending.current); pending.current = null; setDraft(null)
      setNotice(status === 'published' ? '商品已上架到商城目录' : status === 'unpublished' ? '商品已下架' : '草稿已保存'); await load()
    } catch (e) { setFormError(e instanceof Error ? e.message : '保存失败，输入已保留') }
    finally { inFlight.current = false; setSaving(false) }
  }
  return <section className="wb-workbench catalog-page">
    <header className="wb-page-head"><div><p className="wb-kicker">小程序商城</p><h1>商品管理</h1><p>维护顾客看到的商品、图片、售价和上下架。实物收发与检测请到<a href="/inventory">仓库</a>。</p></div>
      {canEdit && !draft && <button className="wb-btn wb-btn--primary" onClick={() => open()}>新增商城商品</button>}</header>
    {notice && <p role="status">{notice}</p>}
    {!draft && <>
      {error && <div role="alert" className="wb-form-error">{error}<button className="wb-btn" onClick={() => void load()}>重试</button></div>}
      {loading ? <p role="status">正在加载商品…</p> : !error && items.length === 0 ? <p>还没有商城商品。仓库里的型号不会自动上架，新增商品后可保存草稿或上架。</p> : !error && <div className="catalog-grid">{items.map(item => <article className="catalog-card" key={item.id}>
        <ProductImage id={item.coverImageId} /><div><span className="catalog-tag">{item.status === 'published' ? '已上架' : item.status === 'draft' ? '草稿' : '已下架'} · {item.category}</span>
          <h2>{item.title}</h2><p>¥{(item.priceCents / 100).toFixed(2)}</p>{canEdit && <button className="wb-btn" onClick={() => open(item)}>编辑 / 上下架</button>}</div>
      </article>)}</div>}
      <div className="catalog-actions"><button className="wb-btn" disabled={loading || page === 1} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page} 页</span><button className="wb-btn" disabled={loading || !more} onClick={() => setPage(page + 1)}>下一页</button><button className="wb-btn" disabled={loading} onClick={() => void load()}>刷新列表</button></div>
    </>}
    {draft && <form className="catalog-editor" onSubmit={e => { e.preventDefault(); void save(draft.status) }}>
      <h2>{draft.version ? '编辑商品' : '新增商城商品'}</h2>
      <fieldset disabled={saving || !!cropping}>
        <div className="catalog-fields"><label>商品名称<input maxLength={100} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
          <label>商城分类<select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value as CatalogProduct['category'] })}><option>整机</option><option>配件</option></select></label>
          <label>展示售价（元）<input inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></label></div>
        <label>顾客可见说明<textarea rows={5} maxLength={5000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
        <div className="catalog-fields">{(['cover', 'hero'] as const).map(preset => {
          const size = CATALOG_IMAGE_PRESETS[preset], field = preset === 'cover' ? 'coverImageId' : 'heroImageId'
          return <div className="catalog-image-field" key={preset}><h3>{size.label}{preset === 'hero' ? '（可选）' : '（上架必填）'}</h3>
            <p>比例 {size.width / size.height}:1；输出 {size.width} × {size.height}px。建议原图至少 {size.width * 2} × {size.height * 2}px。</p>
            <p>支持 JPG、PNG、WebP，原图不超过20MB；选择后裁切，上传结果不超过2MB。</p>
            <ProductImage id={draft[field]} />
            <label className="catalog-file">选择图片并裁切<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => {
              const file = e.target.files?.[0]; e.target.value = ''; if (!file) return
              if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024 || file.size === 0) { setFormError('请选择20MB以内的 JPG、PNG 或 WebP 图片'); return }
              setFormError(''); setCropping({ file, preset })
            }} /></label>{draft[field] && <button className="wb-btn" type="button" onClick={() => setDraft({ ...draft, [field]: null })}>移除图片</button>}
          </div>
        })}</div>
      </fieldset>
      {formError && <p role="alert" className="wb-form-error">{formError}</p>}
      <p>上架只公开此处填写的资料，不自动增加、扣减或预留库存。小程序真实展示需要对应版本及环境已接通。</p>
      <div className="catalog-actions"><button type="button" className="wb-btn" disabled={saving || !!cropping} onClick={() => setDraft(null)}>取消</button>
        <button className="wb-btn" disabled={saving || !!cropping}>{saving ? '正在保存…' : draft.status === 'draft' ? '保存草稿' : '保存修改'}</button>
        {draft.status !== 'published' ? <button type="button" className="wb-btn wb-btn--primary" disabled={saving || !!cropping} onClick={() => void save('published')}>上架到商城</button> : <button type="button" className="wb-btn" disabled={saving || !!cropping} onClick={() => void save('unpublished')}>下架商品</button>}</div>
    </form>}
    {cropping && <ImageCropDialog file={cropping.file} preset={cropping.preset} onCancel={() => setCropping(null)} onSave={async file => {
      const result = await uploadCatalogImage(file)
      setDraft(current => current ? { ...current, [cropping.preset === 'cover' ? 'coverImageId' : 'heroImageId']: result.id } : null)
      if (!result.storagePersistent) setNotice('当前使用本地临时图片存储，服务重启后需重新上传。')
      setCropping(null)
    }} />}
  </section>
}
