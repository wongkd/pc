/**
 * T02b · 文案切分的纯函数集合。
 *
 * 单独成模块的原因：`node --test` 用类型擦除直接加载 `.ts`，**不解析无扩展名的
 * 相对导入**，故被测试引用的模块只能含 `import type`。本模块不含任何导入，
 * 可被测试直接加载（同 `amount-view.ts` 的处理方式）。
 */

/**
 * 大标题里的设备短语。
 *
 * `deviceSummary` 形如「白色设计主机 · 设计用装机」，取「·」之前那段做标题里的设备简称；
 * 没有分隔符时整段使用。**只做这一层切分** —— 更激进的截断会把有意义的型号切掉，
 * 而型号错误比标题冗长严重得多。
 *
 * 这是呈现层处理，不改契约数据：样本仍是完整的 `deviceSummary`，详情页的设备区
 * 也照原样显示完整值，只有页面主标题取简称。
 */
export function deviceShortName(deviceSummary: string | null): string {
  if (!deviceSummary) return ''
  const [first] = deviceSummary.split(' · ')
  return first || deviceSummary
}
