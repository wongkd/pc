import { useEffect, useState } from 'react'
import { AttachmentUploadError, createAttachmentUploadSession, uploadBusinessAttachment, downloadBusinessAttachment } from './attachment-api'
import type { AttachmentUploadSession, AttachmentView } from './attachment-api'

function attachmentLabel(attachment: AttachmentView, ownerType: AttachmentUploadSession['ownerEntityType']): string {
  if (ownerType === 'sale_order') return '检测照片'
  if (ownerType === 'service_order') return '接修照片'
  if (ownerType === 'recovery_order') return '回收取证'
  if (attachment.purpose === 'delivery_evidence') return '交付证据'
  return '验机证据'
}

export function AttachmentPanel({ attachments, ownerType, ownerId, canUpload, onUploaded }: {
  attachments: AttachmentView[]
  ownerType: AttachmentUploadSession['ownerEntityType']
  ownerId: string
  canUpload: boolean
  onUploaded: (attachment: AttachmentView) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryable, setRetryable] = useState(false)
  const [pendingUpload, setPendingUpload] = useState<AttachmentUploadSession | null>(null)
  const [preview, setPreview] = useState<{ url: string; id: string } | null>(null)
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])
  const read = async (item: AttachmentView, download: boolean) => {
    setError('')
    try {
      const blob = await downloadBusinessAttachment(item.id)
      const url = URL.createObjectURL(blob)
      if (download) {
        const link = document.createElement('a'); link.href = url; link.download = `${item.id}.${item.contentType.split('/')[1] || 'bin'}`; link.click(); URL.revokeObjectURL(url)
      } else setPreview({ url, id: item.id })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '附件读取失败，请重试') }
  }
  const runUpload = async (session: AttachmentUploadSession) => {
    setPendingUpload(session)
    setBusy(true); setError(''); setRetryable(false)
    try {
      onUploaded(await uploadBusinessAttachment(session))
      setPendingUpload(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败，请重试')
      setRetryable(cause instanceof AttachmentUploadError && cause.retryable)
    } finally { setBusy(false) }
  }
  const upload = async (file: File | undefined) => {
    if (!file) return
    try {
      await runUpload(createAttachmentUploadSession(file, ownerType, ownerId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败，请重试')
      setRetryable(false)
    }
  }
  return <section className="wb-inv-toolbar" aria-label="业务附件">
    <h2>附件证据</h2>
    <p className="wb-form-hint">仅店内留存；支持 JPEG、PNG、WebP，单张不超过 2MB。当前环境是否持久存储以服务端配置为准。</p>
    {attachments.length ? <ul className="wb-inv-item-list">{attachments.map((item) => <li key={item.id} className="wb-inv-item">
      <span>{attachmentLabel(item, ownerType)}</span><span>{item.contentType}</span><span>{Math.ceil(item.byteSize / 1024)} KB</span><span className="wb-caption">{new Date(item.createdAt).toLocaleString()}</span>
      <button className="wb-btn" type="button" onClick={() => void read(item, false)}>预览</button><button className="wb-btn" type="button" onClick={() => void read(item, true)}>下载</button>
    </li>)}</ul> : <p className="wb-inv-state">还没有已完成的附件。</p>}
    {canUpload ? <>
      <label className="wb-btn">{busy ? '正在上传…' : '上传图片'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || retryable} hidden onChange={(event) => { void upload(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} /></label>
      {retryable && pendingUpload ? <button type="button" className="wb-btn" disabled={busy} onClick={() => void runUpload(pendingUpload)}>重试当前上传</button> : null}
    </> : null}
    {error ? <p className="wb-inv-notice wb-inv-notice--warn">{error}</p> : null}
    {preview ? <div role="region" aria-label="附件预览"><button className="wb-btn" type="button" onClick={() => setPreview(null)}>关闭预览</button><img src={preview.url} alt="已授权业务附件" style={{ display: 'block', maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain' }} /></div> : null}
  </section>
}
