/**
 * FindingsView: the 漏洞 sub-tab of the 漏洞挖掘 view. Lists every vulnerability
 * finding of the engagement — severity and score badge, class, attribution,
 * quantified impact, the EduSRC self-check, the kill chain, the reproducible
 * steps, and the evidence packets collapsed behind a details block with a
 * per-packet copy button. A severity filter bar (owned by the parent view, so
 * the header's severity chips can deep-link here) and a sort toggle keep a
 * long engagement readable.
 */

import { useState } from 'react'
import type { SrchunterProjection, SrchunterProjectionNode, SrchunterSeverity } from '@deepseek-ai/dsh-srchunter/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SeverityFilter } from './SrchunterView.tsx'
import type { SrchunterKey } from './locales.ts'
import css from './FindingsView.module.css'

/** Severity badge label keys. */
const SEVERITY_LABELS: Record<SrchunterSeverity, SrchunterKey> = {
  critical: 'severity.critical',
  high: 'severity.high',
  medium: 'severity.medium',
  low: 'severity.low',
  info: 'severity.info',
}

/** Filter/sort order, strongest first. */
const SEVERITIES: readonly SrchunterSeverity[] = ['critical', 'high', 'medium', 'low', 'info']

/** One finding node, narrowed from the discriminated projection union. */
type FindingNode = SrchunterProjectionNode & { kind: 'finding' }

/** The two orders the list offers. */
type FindingsSort = 'harm' | 'recent'

/** Narrow the projection nodes to findings. */
function findingsOf(projection: SrchunterProjection): FindingNode[] {
  return projection.nodes.filter((node): node is FindingNode => node.kind === 'finding')
}

/** The record order the commander wrote them in (`finding-<n>`). */
function seq(id: string): number {
  return Number(/-(\d+)$/.exec(id)?.[1] ?? 0)
}

/** One of the two list orders. */
function sortFindings(findings: readonly FindingNode[], sort: FindingsSort): FindingNode[] {
  const rank: Record<SrchunterSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
  return [...findings].sort((a, b) => sort === 'recent'
    ? seq(a.id) - seq(b.id)
    : b.score - a.score || rank[a.severity] - rank[b.severity] || seq(a.id) - seq(b.id))
}

/** One evidence packet, collapsed with its own copy affordance. */
function PacketBlock({ label, body, t }: {
  readonly label: string
  readonly body: string
  readonly t: PropsLocale<'srchunter'>['t']
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={css.packet} data-testid="srchunter-finding-packet">
      <div className={css.packetHead}>
        <span className={css.stepsLabel}>{label}</span>
        <button
          type="button"
          className={css.copy}
          data-testid="srchunter-finding-packet-copy"
          onClick={() => {
            void navigator.clipboard.writeText(body).then(
              () => { setCopied(true) },
              () => { setCopied(false) },
            )
          }}
        >
          {t(copied ? 'report.copied' : 'report.copy')}
        </button>
      </div>
      <pre className={css.packetBody}>{body}</pre>
    </div>
  )
}

/** Full props of the findings sub-tab. */
export interface FindingsViewProps {
  readonly srchunter: SrchunterProjection
  readonly t: PropsLocale<'srchunter'>['t']
  /** The active severity filter, owned by the view so header chips can set it. */
  readonly severity: SeverityFilter
  /** Move the filter (the 全部 chip resets it). */
  readonly onSeverity: (severity: SeverityFilter) => void
}

export function FindingsView({ srchunter, t, severity, onSeverity }: FindingsViewProps) {
  const [sort, setSort] = useState<FindingsSort>('harm')
  const all = findingsOf(srchunter)
  if (all.length === 0) {
    return <p className={css.empty} data-testid="srchunter-findings-empty">{t('findings.empty')}</p>
  }
  const levels = SEVERITIES.filter(level => all.some(finding => finding.severity === level))
  const shown = sortFindings(severity === 'all' ? all : all.filter(finding => finding.severity === severity), sort)
  return (
    <div className={css.root} data-testid="srchunter-findings-panel">
      <div className={css.toolbar} data-testid="srchunter-findings-toolbar">
        <div className={css.filters} role="group" aria-label={t('view.tab.findings')}>
          <button
            type="button"
            className={css.filter}
            aria-pressed={severity === 'all'}
            data-testid="srchunter-findings-filter-all"
            onClick={() => { onSeverity('all') }}
          >
            {t('findings.filter.all')}
            <span className={css.filterCount}>{all.length}</span>
          </button>
          {levels.map(level => (
            <button
              key={level}
              type="button"
              className={css.filter}
              data-severity={level}
              aria-pressed={severity === level}
              data-testid={`srchunter-findings-filter-${level}`}
              onClick={() => { onSeverity(level) }}
            >
              {t(SEVERITY_LABELS[level])}
              <span className={css.filterCount}>{all.filter(finding => finding.severity === level).length}</span>
            </button>
          ))}
        </div>
        <div className={css.tools}>
          {shown.length < all.length && <span className={css.shown}>{t('findings.shown', { total: all.length, shown: shown.length })}</span>}
          <button
            type="button"
            className={css.filter}
            aria-pressed={sort === 'harm'}
            data-testid="srchunter-findings-sort-harm"
            onClick={() => { setSort('harm') }}
          >
            {t('findings.sort.harm')}
          </button>
          <button
            type="button"
            className={css.filter}
            aria-pressed={sort === 'recent'}
            data-testid="srchunter-findings-sort-recent"
            onClick={() => { setSort('recent') }}
          >
            {t('findings.sort.recent')}
          </button>
        </div>
      </div>
      {shown.length === 0
        ? <p className={css.empty} data-testid="srchunter-findings-filtered-empty">{t('findings.filter.none')}</p>
        : (
          <ul className={css.list} data-testid="srchunter-findings">
            {shown.map((finding) => {
              const asset = finding.affectedAssetId === undefined
                ? undefined
                : srchunter.assets.find(candidate => candidate.id === finding.affectedAssetId)
              const packets: Array<{ label: string, body: string }> = [
                { label: t('finding.poc'), body: finding.poc },
                { label: t('finding.rawRequest'), body: finding.rawRequest },
                { label: t('finding.rawResponse'), body: finding.rawResponse },
              ].filter(packet => packet.body !== '')
              const meta: string[] = [
                `${t('finding.class')}: ${finding.vulnType === '' ? '—' : finding.vulnType}`,
                `${t('finding.owner')}: ${finding.owner === '' ? t('finding.noAttribution') : finding.owner}`,
                `${t('finding.selfCheck')}: ${finding.strictListHit === 'none' ? t('finding.strictNone') : finding.strictListHit} · ${finding.publicInterface ? t('finding.publicHit') : t('finding.publicMiss')}`,
              ]
              return (
                <li key={finding.id} className={css.finding} data-severity={finding.severity} data-testid="srchunter-finding">
                  <header className={css.header}>
                    <span className={css.severity} data-severity={finding.severity} data-testid="srchunter-finding-severity">
                      {t(SEVERITY_LABELS[finding.severity])}
                      {finding.score > 0 && <span data-testid="srchunter-finding-score"> {finding.score}</span>}
                    </span>
                    <h4 className={css.title}>{finding.title}</h4>
                    <span className={css.id}>{finding.id}</span>
                  </header>
                  <div className={css.meta}>
                    {meta.map(row => <span key={row} className={css.metaChip}>{row}</span>)}
                    {asset !== undefined && (
                      <span className={css.metaChip} data-testid="srchunter-finding-affected">
                        {t('finding.affected')}: [{asset.type}] {asset.value}
                      </span>
                    )}
                  </div>
                  {finding.impact !== '' && (
                    <p className={css.impact} data-testid="srchunter-finding-impact">
                      <span className={css.stepsLabel}>{t('finding.impact')}</span>
                      {finding.impact}
                    </p>
                  )}
                  {finding.description !== '' && <p className={css.description}>{finding.description}</p>}
                  {finding.killChain.length > 0 && (
                    <div className={css.stepsBlock} data-testid="srchunter-finding-kill-chain">
                      <span className={css.stepsLabel}>{t('finding.killChain')}</span>
                      <ol className={css.steps}>
                        {finding.killChain.map((step, index) => <li key={index}>{step}</li>)}
                      </ol>
                    </div>
                  )}
                  <div className={css.stepsBlock}>
                    <span className={css.stepsLabel}>{t('finding.steps')}</span>
                    <ol className={css.steps}>
                      {finding.steps.map((step, index) => <li key={index}>{step}</li>)}
                    </ol>
                  </div>
                  {packets.length > 0 && (
                    <details className={css.evidence} data-testid="srchunter-finding-evidence">
                      <summary className={css.evidenceSummary}>
                        {t('finding.evidence')}
                        <span className={css.filterCount}>{packets.length}</span>
                      </summary>
                      {packets.map(packet => <PacketBlock key={packet.label} label={packet.label} body={packet.body} t={t} />)}
                    </details>
                  )}
                </li>
              )
            })}
          </ul>
        )}
    </div>
  )
}
