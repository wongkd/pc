import { useEffect, useRef, useState } from 'react'
import ReactCrop, { centerCrop, makeAspectCrop, type PercentCrop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import { CATALOG_IMAGE_PRESETS } from '../../contracts/v2/generated/catalog'

export function ImageCropDialog({ file, preset, onCancel, onSave }: {
  file: File; preset: keyof typeof CATALOG_IMAGE_PRESETS; onCancel: () => void; onSave: (file: File) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const [src, setSrc] = useState(''); const [crop, setCrop] = useState<PercentCrop>()
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [small, setSmall] = useState(false)
  const size = CATALOG_IMAGE_PRESETS[preset]
  useEffect(() => {
    const url = URL.createObjectURL(file); setSrc(url); dialog.current?.showModal()
    return () => URL.revokeObjectURL(url)
  }, [file])
  const save = async () => {
    const img = image.current
    if (!img || !crop || crop.width <= 0 || crop.height <= 0) { setError('请先选择裁切区域'); return }
    setBusy(true); setError('')
    try {
      const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('浏览器无法处理图片，请更换浏览器后重试')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size.width, size.height)
      ctx.drawImage(img, crop.x / 100 * img.naturalWidth, crop.y / 100 * img.naturalHeight,
        crop.width / 100 * img.naturalWidth, crop.height / 100 * img.naturalHeight, 0, 0, size.width, size.height)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('裁切失败，请重试')), 'image/png'))
      if (blob.size > 2 * 1024 * 1024) throw new Error('裁切图片超过2MB，请选择较简单的图片')
      await onSave(new File([blob], `${preset}.png`, { type: 'image/png' }))
    } catch (e) { setError(e instanceof Error ? e.message : '图片处理失败') }
    finally { setBusy(false) }
  }
  return <dialog className="catalog-crop-dialog" ref={dialog} onCancel={e => { e.preventDefault(); if (!busy) onCancel() }} aria-labelledby="crop-title">
    <h2 id="crop-title">裁切{size.label}</h2>
    <p>拖动选框调整位置和大小，也可用方向键微调。输出 {size.width} × {size.height} 像素。</p>
    {small && <p role="status">原图较小，放大后可能不清晰，建议更换高清原图。</p>}
    <ReactCrop crop={crop} aspect={size.width / size.height} onChange={(_, percent) => setCrop(percent)} disabled={busy} keepSelection
      ariaLabels={{ cropArea: '使用方向键移动裁切区域', nwDragHandle: '使用方向键调整左上角', nDragHandle: '使用方向键调整上边缘', neDragHandle: '使用方向键调整右上角', eDragHandle: '使用方向键调整右边缘', seDragHandle: '使用方向键调整右下角', sDragHandle: '使用方向键调整下边缘', swDragHandle: '使用方向键调整左下角', wDragHandle: '使用方向键调整左边缘' }}>
      <img ref={image} src={src} alt="待裁切原图" onError={() => setError('图片无法解码，请选择有效的 JPG、PNG 或 WebP 图片')} onLoad={e => {
        const img = e.currentTarget
        if (img.naturalWidth * img.naturalHeight > 40000000) { setError('原图超过4000万像素，请先缩小图片'); return }
        setSmall(img.naturalWidth < size.width || img.naturalHeight < size.height)
        setCrop(centerCrop(makeAspectCrop({ unit: '%', width: 95 }, size.width / size.height, img.width, img.height), img.width, img.height))
      }} />
    </ReactCrop>
    {error && <p className="wb-form-error" role="alert">{error}</p>}
    <div className="catalog-actions"><button className="wb-btn" disabled={busy} onClick={onCancel}>取消</button>
      <button className="wb-btn wb-btn--primary" disabled={busy || !crop} onClick={() => void save()}>{busy ? '正在上传…' : '确认裁切并上传'}</button></div>
  </dialog>
}
