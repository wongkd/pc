import { useState } from 'react'
import { AttachmentUploadError, createAttachmentUploadSession, uploadBusinessAttachment } from './attachment-api'
import type { AttachmentUploadSession, AttachmentView } from './attachment-api'

function attachmentLabel(attachment: AttachmentView, ownerType: 'service_order' | 'recovery_order' | 'stock_item'): string {
  if (ownerType === 'service_order') return '接修照片'
  if (ownerType === 'recovery_order') return '回收取证'
  if (attachment.purpose === 'delivery_evidence') return '交付证据'
  return '验机证据'
}

export function AttachmentPanel({ attachments, ownerType, ownerId, canUpload, onUploaded }: {
  attachments: AttachmentView[]
  ownerType: 'service_order' | 'recovery_order' | 'stock_item'
  ownerId: string
  canUpload: boolean
  onUploaded: (attachment: AttachmentView) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryable, setRetryable] = useState(false)
  const [pendingUpload, setPendingUpload] = useState<AttachmentUploadSession | null>(null)
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
    </li>)}</ul> : <p className="wb-inv-state">还没有已完成的附件。</p>}
    {canUpload ? <>
      <label className="wb-btn">{busy ? '正在上传…' : '上传图片'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || retryable} hidden onChange={(event) => { void upload(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} /></label>
      {retryable && pendingUpload ? <button type="button" className="wb-btn" disabled={busy} onClick={() => void runUpload(pendingUpload)}>重试当前上传</button> : null}
    </> : null}
    {error ? <p className="wb-inv-notice wb-inv-notice--warn">{error}</p> : null}
  </section>
}
