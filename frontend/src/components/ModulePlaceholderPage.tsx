interface ModulePlaceholderPageProps {
  title: string
  description: string
}

export function ModulePlaceholderPage({ title, description }: ModulePlaceholderPageProps) {
  return (
    <section className="module-placeholder" aria-labelledby="module-placeholder-title">
      <div className="module-placeholder-index">ERP</div>
      <p>后续阶段模块</p>
      <h2 id="module-placeholder-title">{title}</h2>
      <span>{description}</span>
      <div className="module-placeholder-rule" />
      <strong>本阶段仅建立导航入口，不产生业务数据。</strong>
    </section>
  )
}
