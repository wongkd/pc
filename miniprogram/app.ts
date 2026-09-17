/**
 * T02b · 微信小程序入口。
 *
 * 本卡只建立壳：原生 tabBar 四项、五个页面、列表与详情的真实页面跳转。
 * **不连接门店服务、不写任何业务数据、不收款**（05 §T02b「不做」）。
 *
 * 身份与权限属 T03，一致性属 T04。在那两张卡完成前，本端的所有数据都来自
 * `features/demo-data.ts` 的虚构样本，样本整体不可导入生产
 * （`contracts/v1/fixtures.json` 的 `demoPolicy.prodBlocked`）。
 */

export interface WorkbenchGlobalData {
  /** 当前门店显示名。骨架阶段无服务端身份，固定为演示门店。 */
  storeLabel: string
  /** 是否处于演示数据模式。接通真实服务前恒为 true。 */
  demoMode: boolean
}

App<{ globalData: WorkbenchGlobalData }>({
  globalData: {
    storeLabel: '演示门店',
    demoMode: true,
  },

  onLaunch() {
    console.info('[T02b] 小程序壳启动：演示数据模式，未连接门店服务。')
  },
})
