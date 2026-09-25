/**
 * 微信小程序入口。
 *
 * MP16 起：启动时解析**唯一的运行环境结论**（演示 / 测试 / 生产），
 * 并把结果写入 globalData 供页面区分「演示样本」与「真实数据」。
 *
 * ⚠️ 环境解析失败时**明确记录错误**，不静默回落演示样本 ——
 *    否则正式版会拿虚构商品冒充真实数据（MP16 放行条件）。
 *    解析规则见 `features/customer/environment.ts`。
 *
 * 身份与权限属 T03；一致性属 T04。在接通真实服务前，四屏仍使用
 * `features/customer/fixtures.ts` 的固定样本（`demoPolicy.prodBlocked`）。
 */

import {
  describeCustomerEnvironment,
  resolveCustomerEnvironment,
} from './features/customer/environment'

export interface WorkbenchGlobalData {
  /** 当前门店显示名。真实身份接通前固定为演示门店。 */
  storeLabel: string
  /** 是否处于演示数据模式。由环境解析结果决定，不再恒为 true。 */
  demoMode: boolean
  /** 当前环境名，供页面区分演示与真实。 */
  environmentName: 'demo' | 'test' | 'prod'
  /** 一行环境说明，供页面直接展示。 */
  environmentNote: string
  /** 环境未就绪的具体原因；null 表示已就绪。 */
  environmentError: string | null
}

App<{ globalData: WorkbenchGlobalData }>({
  globalData: {
    storeLabel: '演示门店',
    // 保守初值：解析成功前不宣称自己处于演示模式。
    demoMode: false,
    environmentName: 'demo',
    environmentNote: '正在确认运行环境',
    environmentError: null,
  },

  onLaunch() {
    try {
      const environment = resolveCustomerEnvironment()
      this.globalData.environmentName = environment.name
      this.globalData.demoMode = environment.demoData
      this.globalData.environmentNote = describeCustomerEnvironment(environment)
      this.globalData.environmentError = null
      console.info(`[MP16] 顾客端环境已就绪：${environment.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.globalData.environmentError = message
      this.globalData.environmentNote = '在线服务尚未就绪'
      console.error(`[MP16] 顾客端环境未就绪：${message}`)
    }
  },
})
