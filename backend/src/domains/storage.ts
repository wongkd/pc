/**
 * 对象存储适配器（F1 · B35）。
 *
 * ── 为什么要有这一层 ──
 * ① 测试与本地预览不能依赖真实对象存储：domains 层只依赖本接口，
 *    测试注入内存实现即可跑完整条「签发 → 上传 → 校验 → 关联」链路。
 * ② 后端终态要迁腾讯云 CloudBase（小程序 request 合法域名须 ICP 备案，CF 是境外服务商）。
 *    届时新增一个 COS 实现，业务代码一行不动。
 *
 * ⚠️ 内存实现**不是生产存储**：没有持久化、没有副本、进程退出即清空。
 *    它只用于测试与 dev:local。生产必须在 wrangler.toml 配 R2 绑定；
 *    缺绑定时会降级到内存实现，但响应里会明确标注 storagePersistent=false，
 *    绝不把它当生产存储悄悄用（见 resolveStorage）。
 *
 * ── 当前选型（2026-09-22 栋哥拍板）──
 * 生产用 Cloudflare R2。理由是此刻后端就跑在 CF Workers 上，R2 是唯一有原生绑定
 * （零密钥、零配置）的对象存储；免费额度 10GB 存储 + 100 万写 + 1000 万读 + 出网流量免费，
 * 按「每单 12 张 × 2MB」算够 400 单以上。
 * ⚠️ 但 R2 的图片域名备不了案（备案要求接入国内云资源）⇒ **顾客端（小程序）将来不能从 R2 取图**。
 *    因此 visibility=customer_shared 的附件在域名备案前不可对外，这条在 attachment 域里显式挡住。
 */

/** 对象写入后的实测结果。三项都由服务端算，不采信客户端声明。 */
export interface PutResult {
  byteSize: number
  sha256: string
  contentType: string
}

/** 对象元数据（head 结果）。 */
export interface ObjectMeta {
  byteSize: number
  sha256?: string
  contentType?: string
}

export interface StorageAdapter {
  /** 存储实现标识，会出现在响应里供验收核对。 */
  readonly kind: 'r2' | 'memory'
  /** 是否持久化。内存实现为 false，代表「数据出进程即丢」。 */
  readonly persistent: boolean
  put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<PutResult>
  head(objectKey: string): Promise<ObjectMeta | null>
  get(objectKey: string): Promise<{ bytes: Uint8Array; contentType?: string } | null>
  delete(objectKey: string): Promise<void>
}

// ────────────────────────────── 通用工具 ──────────────────────────────

/** 十六进制小写的 SHA-256。WebCrypto 在 Worker 与 Node（workerd 内）都可用。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 极简魔数嗅探：只认本系统允许的几种照片 / 文档。
 *
 * 为什么必须自己做：契约要求上传服务「校验类型」。只信客户端声明的 Content-Type
 * 等于没校验 —— 改个扩展名或请求头就能绕过。这里按文件头判断**真实**类型，
 * 再与声明比对，不一致即拒绝。
 *
 * 认不出的一律拒绝（返回 null），不做「未知类型放行」。
 */
export function sniffMime(bytes: Uint8Array): string | null {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b)

  // JPEG: FF D8 FF
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  // GIF: GIF8
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  // PDF: %PDF
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
  // WebP: RIFF....WEBP
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  // HEIC / HEIF: 第 4-8 字节是 'ftyp'，紧随的 brand 决定具体类型
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic'
    if (['mif1', 'msf1', 'heim', 'heis'].includes(brand)) return 'image/heif'
  }
  return null
}

/** 声明与实测都必须落在白名单内。 */
export const ALLOWED_MIME: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'application/pdf',
]

/** 兜底硬上限 20MB。契约的产品预算是「客户端压缩后 ≤2MB」，那是目标不是平台上限。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** 孤立上传保留期：签发后 24 小时内未完成关联即视为孤立，由清理路径回收。 */
export const UPLOAD_INTENT_TTL_MS = 24 * 60 * 60 * 1000

// ────────────────────────────── 内存实现 ──────────────────────────────

/** 仅测试与 dev:local。没有持久化，进程退出即清空。 */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly kind = 'memory' as const
  readonly persistent = false
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string; sha256: string }>()

  async put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<PutResult> {
    const sha256 = await sha256Hex(bytes)
    // 复制一份，避免调用方后续复用同一 buffer 造成「存进去的内容被改掉」。
    this.objects.set(objectKey, { bytes: bytes.slice(), contentType, sha256 })
    return { byteSize: bytes.byteLength, sha256, contentType }
  }

  async head(objectKey: string): Promise<ObjectMeta | null> {
    const found = this.objects.get(objectKey)
    if (!found) return null
    return { byteSize: found.bytes.byteLength, sha256: found.sha256, contentType: found.contentType }
  }

  async get(objectKey: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
    const found = this.objects.get(objectKey)
    if (!found) return null
    return { bytes: found.bytes.slice(), contentType: found.contentType }
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey)
  }
}

// ────────────────────────────── R2 实现（生产）──────────────────────────────

export class R2StorageAdapter implements StorageAdapter {
  readonly kind = 'r2' as const
  readonly persistent = true
  constructor(private readonly bucket: R2Bucket) {}

  async put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<PutResult> {
    const sha256 = await sha256Hex(bytes)
    // sha256 同时也写进对象自定义元数据：head 时不必把整个对象读回来就能核对完整性。
    await this.bucket.put(objectKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { sha256 },
    })
    return { byteSize: bytes.byteLength, sha256, contentType }
  }

  async head(objectKey: string): Promise<ObjectMeta | null> {
    const object = await this.bucket.head(objectKey)
    if (!object) return null
    return {
      byteSize: object.size,
      sha256: object.customMetadata?.sha256,
      contentType: object.httpMetadata?.contentType,
    }
  }

  async get(objectKey: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
    const object = await this.bucket.get(objectKey)
    if (!object) return null
    return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType }
  }

  async delete(objectKey: string): Promise<void> {
    await this.bucket.delete(objectKey)
  }
}

// ────────────────────────────── 选择器 ──────────────────────────────

/** 只声明本模块用到的绑定，避免与入口的 Env 定义互相耦合。 */
export interface StorageEnv {
  BUCKET?: R2Bucket
  /** 生产环境必须显式启用 fail-closed；测试和本地演示保持 memory fallback。 */
  REQUIRE_PERSISTENT_STORAGE?: string
}

/**
 * 内存实现在 Worker isolate 内共享。
 *
 * ⚠️ 这里必须是模块级单例，否则「签发（请求 A）→ 写字节（请求 B）」会各自拿到一个
 * 空 Map，第二步永远找不到第一步写的对象。但即便共享，它也只覆盖**同一个 isolate**：
 * Cloudflare 可能起多个 isolate，且 isolate 会被回收 —— 所以内存实现天然只适合
 * 测试与 dev:local（单 isolate 长驻）。这正是「测试适配器不能当生产存储」的实质。
 */
let memorySingleton: MemoryStorageAdapter | null = null

/**
 * 有 R2 绑定就用 R2，否则回落到共享的内存实现。
 *
 * 回落是有意的：dev:local 与测试都不配对象存储，链路要能整条跑通。
 * 但调用方必须把 `persistent` 透出到响应里 —— 让「当前跑在临时存储上」这件事可见，
 * 而不是靠人记得。
 */
export function resolveStorage(env: StorageEnv): StorageAdapter {
  if (env.BUCKET) return new R2StorageAdapter(env.BUCKET)
  if (env.REQUIRE_PERSISTENT_STORAGE === 'true') {
    throw new Error('持久附件存储未配置：缺少 BUCKET R2 绑定')
  }
  memorySingleton ??= new MemoryStorageAdapter()
  return memorySingleton
}

/** Catch-all handler mapping a missing required production binding to a stable service error. */
export function requiredStorageFailure(env: StorageEnv): Response | null {
  if (env.REQUIRE_PERSISTENT_STORAGE !== 'true' || env.BUCKET) return null
  return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '正式附件存储未配置' } }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  })
}
