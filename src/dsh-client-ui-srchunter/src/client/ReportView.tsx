/** Render, copy, and download the current srchunter projection as Markdown. */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SrchunterIntentStatus, SrchunterProjection, SrchunterProjectionNode, SrchunterSeverity } from '@deepseek-ai/dsh-srchunter/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SrchunterKey } from './locales.ts'
import css from './ReportView.module.css'

export interface ReportViewProps {
  readonly srchunter: SrchunterProjection
  readonly t: PropsLocale<'srchunter'>['t']
}

/** Findings of the projection, narrowed from the discriminated node union. */
type FindingNode = SrchunterProjectionNode & { kind: 'finding' }
/** Intents of the projection, narrowed from the discriminated node union. */
type IntentNode = SrchunterProjectionNode & { kind: 'intent' }

/** The verdict groups the report hands off to the human, in reading order. */
const HANDOFF_STATUSES: readonly SrchunterIntentStatus[] = ['deepen', 'blocked', 'dead_end']

/** Severity ordering, strongest first, so equal scores still read by harm. */
const SEVERITY_RANK: Record<SrchunterSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

/** Order findings the way the commander's report does: score, then severity. */
function byHarm(findings: readonly FindingNode[]): FindingNode[] {
  const seq = (id: string): number => Number(/-(\d+)$/.exec(id)?.[1] ?? 0)
  return [...findings].sort((a, b) => b.score - a.score || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || seq(a.id) - seq(b.id))
}

/** One fenced block of the report, kept verbatim (raw packets are evidence). */
function codeBlock(label: SrchunterKey, body: string, t: ReportViewProps['t']): string[] {
  if (body === '') return []
  return [`- ${t(label)}:`, '```', body, '```', '']
}

function reportOf(srchunter: SrchunterProjection, t: ReportViewProps['t']): string {
  if (srchunter.goal === null) return `# ${t('report.title')}\n\n${t('report.uninitialized')}\n`

  const intents = srchunter.nodes.filter((node): node is IntentNode => node.kind === 'intent')
  const findings = byHarm(srchunter.nodes.filter((node): node is FindingNode => node.kind === 'finding'))
  const open = intents.filter(intent => intent.status === 'open' || intent.status === 'working').length
  const chain = srchunter.nodes.map((node) => {
    const anchor = srchunter.edges.find(edge => edge.targetId === node.id)
    const relation = anchor === undefined ? '' : ` (${anchor.kind} ${anchor.sourceId})`
    if (node.kind === 'intent') {
      return `- ${t('kind.intent')} (${node.id}) ${node.title} [${t(`intent.status.${node.status}` as SrchunterKey)}]${node.detail === '' ? '' : `: ${node.detail}`}${node.disposition === '' ? '' : ` -> ${node.disposition}`}${relation}`
    }
    if (node.kind === 'fact') return `- ${t('kind.fact')} (${node.id}) [${node.factKind}] ${node.target === '' ? '' : `${node.target}: `}${node.detail}${relation}`
    return `- ${t('kind.finding')} (${node.id}) [${node.severity}/${node.score}] ${node.title}${relation}`
  })
  const findingSections = findings.flatMap((finding) => {
    const asset = finding.affectedAssetId === undefined ? undefined : srchunter.assets.find(candidate => candidate.id === finding.affectedAssetId)
    return [
      `### ${finding.id} [${finding.severity} / ${finding.score}] ${finding.title}`,
      `- ${t('finding.class')}: ${finding.vulnType === '' ? t('report.none') : finding.vulnType}`,
      `- ${t('finding.owner')}: ${finding.owner === '' ? t('finding.noAttribution') : finding.owner}`,
      `- ${t('finding.affected')}: ${asset === undefined ? t('report.unlinked') : `[${asset.type}] ${asset.value}`}`,
      `- ${t('finding.impact')}: ${finding.impact === '' ? t('report.none') : finding.impact}`,
      `- ${t('report.description')}: ${finding.description === '' ? t('report.none') : finding.description}`,
      `- ${t('finding.selfCheck')}: ${finding.strictListHit === 'none' ? t('finding.strictNone') : finding.strictListHit} · ${finding.publicInterface ? t('finding.publicHit') : t('finding.publicMiss')}`,
      ...(finding.killChain.length === 0 ? [] : [`- ${t('finding.killChain')}:`, ...finding.killChain.map((step, index) => `  ${index + 1}. ${step}`)]),
      `- ${t('finding.steps')}:`,
      ...finding.steps.map((step, index) => `  ${index + 1}. ${step}`),
      '',
      ...codeBlock('finding.poc', finding.poc, t),
      ...codeBlock('finding.rawRequest', finding.rawRequest, t),
      ...codeBlock('finding.rawResponse', finding.rawResponse, t),
    ].join('\n')
  })
  const handoff = HANDOFF_STATUSES.flatMap((status) => {
    const pending = intents.filter(intent => intent.status === status)
    if (pending.length === 0) return []
    return [
      `### ${t(`intent.status.${status}` as SrchunterKey)}`,
      ...pending.map(intent => `- ${intent.id} ${intent.title}${intent.disposition === '' ? '' : `: ${intent.disposition}`}`),
      '',
    ]
  })
  const assetLines = srchunter.assets.map((asset) => {
    const edge = srchunter.edges.find(candidate => candidate.kind === 'parent' && candidate.targetId === asset.id)
    const parent = edge === undefined ? undefined : srchunter.assets.find(candidate => candidate.id === edge.sourceId)
    return `- [${asset.type}] ${asset.value}${asset.meta === '' ? '' : ` (${asset.meta})`}${asset.owner === '' ? '' : ` - ${t('asset.owner')}: ${asset.owner}`}${parent === undefined ? '' : ` <- ${parent.value}`}`
  })
  return [
    `# ${t('report.title')}`,
    '',
    `- ${t('report.target')}: ${srchunter.goal.target}`,
    `- ${t('report.objective')}: ${srchunter.goal.objective}`,
    `- ${t('report.authorization')}: ${srchunter.goal.authorization === '' ? t('report.undeclared') : srchunter.goal.authorization}`,
    `- ${t('report.destructive')}: ${srchunter.goal.destructive}`,
    `- ${t('report.scale')}: ${t('report.scaleLine', {
      findings: findings.length,
      facts: srchunter.counts.facts,
      assets: srchunter.counts.assets,
      open,
    })}`,
    '',
    `## ${t('report.findings')}`,
    ...(findingSections.length === 0 ? [t('report.noFindings')] : findingSections),
    '',
    `## ${t('report.handoff')}`,
    ...(handoff.length === 0 ? [t('report.handoffEmpty')] : handoff),
    '',
    `## ${t('report.assets')}`,
    ...(assetLines.length === 0 ? [t('report.none')] : assetLines),
    '',
    `## ${t('report.chain')}`,
    ...(chain.length === 0 ? [t('report.chainEmpty')] : chain),
    '',
  ].join('\n')
}

function filenameOf(target: string): string {
  const name = target.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `srchunter-report-${name === '' ? 'session' : name}.md`
}

/** Render the report's small, fixed Markdown subset without interpreting HTML. */
function MarkdownPreview({ markdown }: { readonly markdown: string }) {
  const rows: ReactNode[] = []
  const lines = markdown.split('\n')
  // Evidence packets ride in fenced blocks: collect them whole rather than
  // turning every header line into its own paragraph.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (line === '') continue
    if (line.startsWith('```')) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] as string).startsWith('```')) {
        body.push(lines[index] as string)
        index += 1
      }
      rows.push(<pre key={index} className={css.code} data-testid="srchunter-report-code">{body.join('\n')}</pre>)
      continue
    }
    if (line.startsWith('### ')) {
      rows.push(<h3 key={index}>{line.slice(4)}</h3>)
    } else if (line.startsWith('## ')) {
      rows.push(<h2 key={index}>{line.slice(3)}</h2>)
    } else if (line.startsWith('# ')) {
      rows.push(<h1 key={index}>{line.slice(2)}</h1>)
    } else if (line.startsWith('- ')) {
      rows.push(<p key={index} className={css.bullet}>{line.slice(2)}</p>)
    } else if (/^  \d+\. /.test(line)) {
      rows.push(<p key={index} className={css.step}>{line.trim()}</p>)
    } else {
      rows.push(<p key={index}>{line}</p>)
    }
  }
  return <article className={css.markdown} data-testid="srchunter-report-markdown">{rows}</article>
}

export function ReportView({ srchunter, t }: ReportViewProps) {
  const markdown = reportOf(srchunter, t)
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyState('done')
    } catch {
      setCopyState('failed')
    }
  }

  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filenameOf(srchunter.goal?.target ?? '')
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className={css.root} data-testid="srchunter-report">
      <header className={css.toolbar}>
        <p className={css.hint}>{t('report.hint')}</p>
        <div className={css.actions}>
          <button type="button" className={css.action} onClick={() => { void copy() }} data-testid="srchunter-report-copy">
            {t(copyState === 'done' ? 'report.copied' : 'report.copy')}
          </button>
          <button type="button" className={css.action} onClick={download} data-testid="srchunter-report-download">
            {t('report.download')}
          </button>
        </div>
      </header>
      {copyState === 'failed' && <p className={css.error} role="status">{t('report.copyFailed')}</p>}
      <MarkdownPreview markdown={markdown} />
    </section>
  )
}
