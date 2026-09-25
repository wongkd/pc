import { inventoryClient } from './inventory-api'

export interface AttachmentView {
  id: string
  purpose: string
  visibility: string
  contentType: string
  byteSize: number
  width: number | null
  height: number | null
  sha256: string | null
  uploadState: string
  createdAt: string
}

type Envelope<T> = { data: T } | { error?: { message?: string } }

export interface AttachmentUploadSession {
  file: File
  ownerEntityType: 'service_order' | 'recovery_order' | 'stock_item'
  ownerEntityId: string
  intentRequestId: string
  completeRequestId: string
  intent: { entityId: string; uploadPath: string; uploadToken: string } | null
  stage: 'intent' | 'blob' | 'complete'
}

export class AttachmentUploadError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.retryable = retryable
    this.name = 'AttachmentUploadError'
  }
}

function requestId(): string {
  return `req_${crypto.randomUUID()}`
}

async function send<T>(url: string, method: string, body?: BodyInit, contentType?: string): Promise<T> {
  const token = inventoryClient.session.getToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (contentType) headers['Content-Type'] = contentType
  let response: Response
  try {
    response = await fetch(url, { method, headers, body })
  } catch {
    throw new AttachmentUploadError('网络中断，上传结果未知；请重试当前上传', true)
  }
  const text = await response.text().catch(() => '')
  let payload: Envelope<T>
  try { payload = JSON.parse(text) as Envelope<T> } catch {
    throw new AttachmentUploadError('服务器返回无法识别的响应；请重试当前上传', true)
  }
  if (!response.ok || !('data' in payload)) {
    throw new AttachmentUploadError(
      ('error' in payload ? payload.error?.message : null) || `上传失败（${response.status}）`,
      response.status === 502 || response.status === 503 || response.status === 504,
    )
  }
  return payload.data
}

export function createAttachmentUploadSession(file: File, ownerEntityType: AttachmentUploadSession['ownerEntityType'], ownerEntityId: string): AttachmentUploadSession {
  if (file.size <= 0 || file.size > 2 * 1024 * 1024) throw new Error('请选择 2MB 以内的非空图片')
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('仅支持 JPEG、PNG 或 WebP 图片')
  return { file, ownerEntityType, ownerEntityId, intentRequestId: requestId(), completeRequestId: requestId(), intent: null, stage: 'intent' }
}

export async function uploadBusinessAttachment(session: AttachmentUploadSession): Promise<AttachmentView> {
  const { file, ownerEntityType, ownerEntityId } = session
  if (!session.intent) {
    session.intent = await send<{ entityId: string; uploadPath: string; uploadToken: string }>('/api/v2/attachments/upload-intents', 'POST', JSON.stringify({
      requestId: session.intentRequestId, ownerEntityType, ownerEntityId, purpose: ownerEntityType === 'service_order' ? 'service_intake' : 'recovery_evidence',
      mime: file.type, byteSize: file.size, visibility: 'internal',
    }), 'application/json')
    session.stage = 'blob'
  }
  const intent = session.intent
  if (!intent.entityId || !intent.uploadPath || !intent.uploadToken) throw new AttachmentUploadError('服务器未返回有效上传凭证', true)
  const blobHeaders: Record<string, string> = { 'Content-Type': file.type, 'X-Upload-Token': intent.uploadToken }
  const token = inventoryClient.session.getToken()
  if (token) blobHeaders.Authorization = `Bearer ${token}`
  if (session.stage === 'blob') {
    let uploadedResponse: Response
    try {
      uploadedResponse = await fetch(intent.uploadPath, { method: 'PUT', headers: blobHeaders, body: file })
    } catch {
      throw new AttachmentUploadError('网络中断，文件写入结果未知；请重试当前上传', true)
    }
    if (!uploadedResponse.ok) {
      const body = await uploadedResponse.json().catch(() => null) as { error?: { message?: string } } | null
      const retryable = uploadedResponse.status === 502 || uploadedResponse.status === 503 || uploadedResponse.status === 504
      throw new AttachmentUploadError(body?.error?.message || `文件写入失败（${uploadedResponse.status}）`, retryable)
    }
    // Blob 重试可安全覆盖同一 intent；完成确认结果未知时则只重放确认，避免碰已关联的内容。
    session.stage = 'complete'
  }
  await send(`/api/v2/attachments/upload-intents/${encodeURIComponent(intent.entityId)}/complete`, 'POST', JSON.stringify({
    requestId: session.completeRequestId, ownerEntityType, ownerEntityId,
  }), 'application/json')
  return { id: intent.entityId, purpose: ownerEntityType === 'service_order' ? 'service_intake' : 'recovery_evidence', visibility: 'internal', contentType: file.type, byteSize: file.size, width: null, height: null, sha256: null, uploadState: 'attached', createdAt: new Date().toISOString() }
}
