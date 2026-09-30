/**
 * SrchunterView: the 漏洞挖掘 conversation-view tab. A pure projection-mode
 * surface — the standing `srchunter` projection (engagement goal plus the
 * exploration graph) arrives through `useProjection('srchunter')`, so the tab
 * owns no store and needs no host RPC. The view renders one engagement header
 * card (goal target, objective, authorization, a stat row, and the severity
 * distribution of the proven findings — each chip jumps to the 漏洞 sub-tab
 * pre-filtered to that severity) over a sticky sub-tab bar: 探索链路 (the chain
 * as an interactive graph), 漏洞 (findings with reproducible steps), 资产 (list
 * or graph), and 报告 (copyable Markdown). Absent projection
 * (capability or session not composed) or null (no `srchunter_add_goal` yet)
 * renders the guiding empty note.
 */

import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SrchunterProjectionNode, SrchunterSeverity } from '@deepseek-ai/dsh-srchunter/client'
// Type-only: pulls the `srchunter` SessionProjectionMap key merge.
import type {} from '@deepseek-ai/dsh-srchunter/client'
import { AssetsView } from './AssetsView.tsx'
import { ExploreView } from './ExploreView.tsx'
import { FindingsView } from './FindingsView.tsx'
import { ReportView } from './ReportView.tsx'
import type { SrchunterKey } from './locales.ts'
import css from './SrchunterView.module.css'

/** The four sub-tabs of the view. */
const TABS = ['explore', 'findings', 'assets', 'report'] as const

/** One sub-tab key. */
type ViewTab = typeof TABS[number]

/** Sub-tab label keys. */
const TAB_LABELS = {
  explore: 'view.tab.explore',
  findings: 'view.tab.findings',
  assets: 'view.tab.assets',
  report: 'view.tab.report',
} as const satisfies Record<ViewTab, SrchunterKey>

/** Severity display order, strongest first. */
const SEVERITIES: readonly SrchunterSeverity[] = ['critical', 'high', 'medium', 'low', 'info']

/** Severity badge label keys. */
const SEVERITY_LABELS: Record<SrchunterSeverity, SrchunterKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

/** Which findings one severity chip selects; `all` clears the filter. */
export type SeverityFilter = SrchunterSeverity | 'all'

/** Findings of the projection, narrowed from the discriminated node union. */
function findingsOf(nodes: readonly SrchunterProjectionNode[]): Array<SrchunterProjectionNode & { kind: 'finding' }> {
  return nodes.filter((node): node is SrchunterProjectionNode & { kind: 'finding' } => node.kind === 'finding')
}

/** Intent verdicts that still owe the engagement a conclusion. */
const PENDING_STATUSES: readonly string[] = ['open', 'working', 'deepen', 'blocked']

/** Full props of the view entry: session standard kit + the locale seat. */
export type SrchunterViewProps = PropsRuntime<'conversation.view'> & PropsLocale<'srchunter'>

export function SrchunterView({ useProjection, t }: SrchunterViewProps) {
  const srchunter = useProjection('srchunter')
  const [tab, setTab] = useState<ViewTab>('explore')
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  if (srchunter === undefined || srchunter === null) {
    return (
      <div className={css.empty} data-testid="srchunter-view">
        <span className={css.emptyText}>{t('view.empty')}</span>
      </div>
    )
  }
  const findings = findingsOf(srchunter.nodes)
  const distribution = SEVERITIES
    .map(level => ({ level, count: findings.filter(finding => finding.severity === level).length }))
    .filter(entry => entry.count > 0)
  const pending = srchunter.nodes.filter(
    node => node.kind === 'intent' && PENDING_STATUSES.includes(node.status),
  ).length
  const stats = [
    { key: 'intents', label: t('kind.intent'), value: srchunter.counts.intents },
    { key: 'facts', label: t('kind.fact'), value: srchunter.counts.facts },
    { key: 'findings', label: t('kind.finding'), value: srchunter.counts.findings },
    { key: 'assets', label: t('report.assets'), value: srchunter.counts.assets },
  ] as const
  const counts = {
    intents: srchunter.counts.intents,
    facts: srchunter.counts.facts,
    findings: srchunter.counts.findings,
    assets: srchunter.counts.assets,
  }
  return (
    <section className={css.root} data-testid="srchunter-view">
      <header className={css.card}>
        <div className={css.cardTitle}>
          <h2 className={css.target}>{srchunter.goal === null ? '' : srchunter.goal.target}</h2>
          {srchunter.goal !== null && srchunter.goal.objective !== '' && (
            <span className={css.objective}>目的：{srchunter.goal.objective}</span>
          )}
          {pending > 0 && (
            <button
              type="button"
              className={css.pending}
              data-testid="srchunter-pending"
              onClick={() => { setTab('explore') }}
            >
              {t('explore.statusLegend', { open: pending })}
            </button>
          )}
        </div>
        <div className={css.stats} role="group" aria-label={t('counts', counts)} data-testid="srchunter-stats">
          {stats.map(stat => (
            <span key={stat.key} className={css.stat} data-testid={`srchunter-stat-${stat.key}`}>
              {stat.label}
              <b className={css.statValue}>{stat.value}</b>
            </span>
          ))}
        </div>
        {distribution.length > 0 && (
          <div className={css.severities} data-testid="srchunter-severity-summary">
            {distribution.map(entry => (
              <button
                key={entry.level}
                type="button"
                className={css.severityChip}
                data-severity={entry.level}
                data-testid={`srchunter-severity-${entry.level}`}
                onClick={() => {
                  setSeverity(entry.level)
                  setTab('findings')
                }}
              >
                {t(SEVERITY_LABELS[entry.level])}
                <b className={css.statValue}>{entry.count}</b>
              </button>
            ))}
          </div>
        )}
        {srchunter.goal !== null && (
          <p className={css.authorization} data-testid="srchunter-destructive">{t('report.destructive')}：{srchunter.goal.destructive}</p>
        )}
        {srchunter.goal !== null && srchunter.goal.authorization !== '' && (
          <p className={css.authorization}>授权：{srchunter.goal.authorization}</p>
        )}
      </header>
      <nav className={css.tabs} data-testid="srchunter-tabs">
        {TABS.map(tabKey => {
          const count = tabKey === 'findings'
            ? srchunter.counts.findings
            : tabKey === 'assets'
              ? srchunter.counts.assets
              : undefined
          return (
            <button
              key={tabKey}
              type="button"
              className={css.tab}
              aria-pressed={tab === tabKey}
              data-testid={`srchunter-tab-${tabKey}`}
              onClick={() => { setTab(tabKey) }}
            >
              {t(TAB_LABELS[tabKey])}
              {count !== undefined && count > 0 && (
                <span className={css.tabCount} data-testid={`srchunter-tab-count-${tabKey}`}>{count}</span>
              )}
            </button>
          )
        })}
      </nav>
      <div className={css.content}>
        {tab === 'explore' && <ExploreView srchunter={srchunter} t={t} />}
        {tab === 'findings' && (
          <FindingsView srchunter={srchunter} t={t} severity={severity} onSeverity={setSeverity} />
        )}
        {tab === 'assets' && <AssetsView srchunter={srchunter} t={t} />}
        {tab === 'report' && <ReportView srchunter={srchunter} t={t} />}
      </div>
    </section>
  )
}
