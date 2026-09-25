/**
 * MP16 · 顾客端 API 客户端装配。
 *
 * 只做装配：把「已就绪的环境地址 + 顾客专属存储 + wx 传输」接到既有请求核心
 * （`features/api-client.ts` → `features/api-core.ts`，T03b 建的两端同构核心，本卡不改动）。
 *
 * 与员工端的三条硬隔离：
 *   1. **存储命名空间**：顾客端所有键自动带 `pc-customer:` 前缀，员工端键一律不动。
 *   2. **独立实例**：顾客端惰性单例，与员工端装配互不引用。
 *   3. **未就绪不建实例**：演示环境或缺少地址时直接抛错，不制造「已经能连」的假象。
 *
 * ⚠️ 本文件属装配层（含 `wx` 运行时依赖），不参与 `node --test`；
 *    可测规则集中在 `features/customer/environment.ts`。
 */

import { createMiniProgramApiClient } from '../../features/api-client'
import type { RequestCore } from '../../features/api-core'
import { createSessionStore, wxStorage } from '../../features/session'
import type { SessionStore } from '../../features/session'
import {
  CUSTOMER_SESSION_KEYS,
  CustomerEnvironmentError,
  createCustomerStorage,
  resolveCustomerEnvironment,
} from '../../features/customer/environment'
import type { CustomerEnvironment, CustomerEnvironmentInput } from '../../features/customer/environment'

export interface CustomerApiClient {
  readonly environment: CustomerEnvironment
  readonly client: RequestCore
  readonly session: SessionStore
}

let cached: CustomerApiClient | null = null

/**
 * 建一个顾客端客户端。演示环境不建实例 —— 顾客端的固定样本不经过网络，
 * 建出实例只会让人误以为「已经接通服务」。
 */
export function createCustomerApiClient(input: CustomerEnvironmentInput = {}): CustomerApiClient {
  const environment = resolveCustomerEnvironment(input)

  if (!environment.apiBaseUrl) {
    throw new CustomerEnvironmentError(
      '演示环境不创建 API 客户端：顾客端演示样本不经过网络。请先切换到已就绪的真实环境。',
    )
  }

  const session = createSessionStore(createCustomerStorage(wxStorage()), {
    tokenKey: CUSTOMER_SESSION_KEYS.token,
    draftsKey: CUSTOMER_SESSION_KEYS.drafts,
    targetKey: CUSTOMER_SESSION_KEYS.target,
  })
  const api = createMiniProgramApiClient({ baseUrl: environment.apiBaseUrl, session })

  return { environment, client: api.client, session: api.session }
}

/** 运行期惰性单例。环境在启动时确定（小程序版本固定），故不需要重建。 */
export function getCustomerApiClient(input: CustomerEnvironmentInput = {}): CustomerApiClient {
  if (!cached) cached = createCustomerApiClient(input)
  return cached
}

/** 清空缓存实例。环境变化或退出登录时调用。 */
export function resetCustomerApiClient(): void {
  cached = null
}
