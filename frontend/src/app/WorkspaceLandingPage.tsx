import { useNavigate } from 'react-router-dom'
import '../styles/landing.css'

export interface WorkspaceEntry {
  label: string
  description: string
  /** 已存在的路径；为空表示该入口尚未接通，只做说明。 */
  to: string | null
  /** 未接通时显示的归属任务。 */
  owner?: string
}

interface WorkspaceLandingPageProps {
  kicker: string
  title: string
  intro: string
  entries: WorkspaceEntry[]
  compatibilityEntries?: WorkspaceEntry[]
  /** 该域当前明确不做的事，避免把骨架当成业务完成。 */
  notYet: string[]
}

/**
 * 域落地页骨架：把导航落点与「哪些已可用、哪些尚未接通」讲清楚。
 *
 * T02a 只建立入口，不实现业务写入。未接通的入口不跳转、不返回假结果，
 * 只显示归属任务；等对应业务卡替换本页。
 */
export function WorkspaceLandingPage({
  kicker,
  title,
  intro,
  entries,
  compatibilityEntries = [],
  notYet,
}: WorkspaceLandingPageProps) {
  const navigate = useNavigate()

  return (
    <section className="wb-workbench" aria-labelledby="wb-landing-title">
      <header className="wb-page-head">
        <div>
          <p className="wb-kicker">{kicker}</p>
          <h1 id="wb-landing-title">{title}</h1>
        </div>
      </header>

      <p className="wb-landing-intro">{intro}</p>

      <ul className="wb-landing-list">
        {entries.map((entry) => (
          <li key={entry.label}>
            <div className="wb-landing-card">
              <div>
                <strong>{entry.label}</strong>
                <span className="wb-caption wb-caption--block">{entry.description}</span>
              </div>
              {entry.to ? (
                <button type="button" className="wb-btn" onClick={() => navigate(entry.to as string)}>
                  进入
                </button>
              ) : (
                <span className="wb-caption">未接通{entry.owner ? `（${entry.owner}）` : ''}</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      {compatibilityEntries.length > 0 && (
        <details className="wb-landing-notes">
          <summary>历史工具与订单</summary>
          <ul>
            {compatibilityEntries.map(entry => (
              <li key={entry.label}>
                <button type="button" className="wb-btn" onClick={() => entry.to && navigate(entry.to)}>{entry.label}</button>
                <span className="wb-caption"> {entry.description}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <section className="wb-landing-notes" aria-labelledby="wb-landing-notes-title">
        <h2 id="wb-landing-notes-title">本阶段边界</h2>
        <ul>
          {notYet.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </section>
  )
}
