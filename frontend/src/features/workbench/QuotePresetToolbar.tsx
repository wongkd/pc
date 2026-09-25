import { quoteScenarios, type QuotePresetCategory, type QuoteScenario } from './quote-presets'

const quickAdd: QuotePresetCategory[] = ['显示器', '键鼠套装', '机箱风扇', '机械硬盘', '装机服务']

export default function QuotePresetToolbar({
  scenario,
  retainedCount,
  onScenarioChange,
  onAdd,
}: {
  scenario: QuoteScenario
  retainedCount: number
  onScenarioChange: (scenario: QuoteScenario) => void
  onAdd: (category: QuotePresetCategory) => void
}) {
  return (
    <div className="wb-quote-presets" aria-label="配置场景与快捷添加">
      <div className="wb-quote-presets__scenarios" role="group" aria-label="报价场景">
        {quoteScenarios.map((item) => (
          <button key={item.id} type="button" className={scenario === item.id ? 'wb-btn wb-btn--primary' : 'wb-btn'} aria-pressed={scenario === item.id} onClick={() => onScenarioChange(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {scenario === 'office' ? <p className="wb-form-hint">核显办公：请确认所选 CPU 支持图形输出。</p> : null}
      {scenario === 'upgrade' ? <p className="wb-form-hint">旧机升级：请核对原机配置与配件兼容性，本工具不会自动判断兼容。</p> : null}
      {retainedCount > 0 ? <p className="wb-quote-presets__retained" role="status">已保留 {retainedCount} 项原配置，请核对；保留项仍会参与校验和报价。</p> : null}
      <div className="wb-quote-presets__quick" aria-label="快捷添加配件">
        {quickAdd.map((category) => <button key={category} type="button" className="wb-btn" onClick={() => onAdd(category)}>＋{category}</button>)}
      </div>
    </div>
  )
}
