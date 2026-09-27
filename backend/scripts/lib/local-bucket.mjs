/**
 * R2Bucket 的本地磁盘实现（Node 运行时夹具）。
 *
 * ── 为什么走「假装成 R2」而不是改 storage.ts ──
 * `domains/storage.ts` 的 `resolveStorage(env)` 只做一件事：有 `env.BUCKET` 就用 R2，
 * 否则回落内存实现。所以只要在 Node 宿主里注入一个「长得像 R2Bucket」的对象，
 * 附件链路就自动走持久化分支 —— **生产源码一个字都不用改**。
 *
 * 这样做的好处很实在：
 *   · 不碰 `backend/src`，与并行会话（U00–U05 正在改 purchase/inventory）零冲突；
 *   · 不碰契约、迁移、`index.ts` 接线，门禁不会因为这次改动失效；
 *   · 若将来真要在生产上换对象存储，`storage.ts` 里加一个实现即可（接口不变），
 *     这份夹具的结论不会被推翻。
 *
 * ── 存储布局 ──
 * 不按 key 的目录结构落盘，而是 `sha256(key)` 做文件名：
 * 对象本体 `＜hash＞.bin`，元数据 `＜hash＞.json`（含原始 key）。
 * 理由：对象 key 由业务拼装，直接当路径用会有目录穿越风险，
 * 而「hash 文件名 + 元数据里存原始 key」既安全又能反查。
 *
 * 边界：只覆盖 `R2StorageAdapter` 实际用到的 4 个方法。
 * 其余 R2 能力（列举、分段上传、签名 URL）**没有实现，也不假装支持**。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const hashKey = (objectKey) => createHash('sha256').update(objectKey).digest('hex')

export function createLocalBucket(rootDir) {
  mkdirSync(rootDir, { recursive: true })

  const bodyPath = (objectKey) => join(rootDir, `${hashKey(objectKey)}.bin`)
  const metaPath = (objectKey) => join(rootDir, `${hashKey(objectKey)}.json`)

  const readMeta = (objectKey) => {
    const path = metaPath(objectKey)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  }

  return {
    /**
     * 对齐 R2 的 put 签名。`storage.ts` 传的是
     * `{ httpMetadata: { contentType }, customMetadata: { sha256 } }`，
     * 其中 sha256 是服务端自己算的，head 时要能原样读回来（完整性核对靠它）。
     */
    async put(objectKey, value, options = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
      writeFileSync(bodyPath(objectKey), bytes)
      writeFileSync(
        metaPath(objectKey),
        JSON.stringify({
          key: objectKey,
          size: bytes.byteLength,
          contentType: options?.httpMetadata?.contentType ?? null,
          customMetadata: options?.customMetadata ?? {},
        }),
      )
      return { key: objectKey, size: bytes.byteLength }
    },

    /** 返回 null 表示不存在 —— storage.ts 依赖这个约定判断「孤立上传」。 */
    async head(objectKey) {
      const meta = readMeta(objectKey)
      if (!meta) return null
      return {
        key: objectKey,
        size: meta.size,
        customMetadata: meta.customMetadata ?? {},
        httpMetadata: { contentType: meta.contentType ?? undefined },
      }
    },

    async get(objectKey) {
      const meta = readMeta(objectKey)
      if (!meta) return null
      const buffer = readFileSync(bodyPath(objectKey))
      return {
        key: objectKey,
        size: meta.size,
        customMetadata: meta.customMetadata ?? {},
        httpMetadata: { contentType: meta.contentType ?? undefined },
        // 必须切出精确区间：readFileSync 给的是 Buffer，其 .buffer 可能带有
        // 池化分配的多余字节，直接返回会让读回来的内容比原文件长。
        async arrayBuffer() {
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        },
      }
    },

    async delete(objectKey) {
      for (const path of [bodyPath(objectKey), metaPath(objectKey)]) {
        if (existsSync(path)) rmSync(path)
      }
    },

    /** 夹具自用：给验收脚本核对「附件确实落盘了」。不属于 R2 接口。 */
    usage() {
      const files = readdirSync(rootDir).filter((name) => name.endsWith('.bin'))
      let bytes = 0
      for (const name of files) bytes += statSync(join(rootDir, name)).size
      return { objects: files.length, bytes }
    },
  }
}
