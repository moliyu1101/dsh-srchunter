// @vitest-environment jsdom
/**
 * Srchunter view tab acceptance: the 漏洞挖掘 conversation-view entry (guiding
 * empty note for absent/null projection; the engagement header card — target,
 * objective, authorization, counts; and the sub-tab bar — 探索链路 / 漏洞 /
 * 资产 / 报告 — switching the rendered sub-tab) and its live-update path through the
 * projection source.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SrchunterProjection } from '@deepseek-ai/dsh-srchunter/client'
import type { SrchunterViewProps } from '../src/client/SrchunterView.tsx'
import { SrchunterView } from '../src/client/SrchunterView.tsx'
import { zh } from '../src/client/locales.ts'

const t: SrchunterViewProps['t'] = makeTranslate(zh, commonZh)

/** jsdom has no ResizeObserver; the React Flow graphs measure through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const GOAL = { id: 'goal-1', target: 'example.com', objective: 'map the web surface', authorization: 'CTO sign-off', destructive: 'limited' }

const STANDING: SrchunterProjection = {
  goal: GOAL,
  nodes: [
    { id: 'intent-1', kind: 'intent', title: 'enumerate endpoints', detail: 'scope /api', status: 'open', disposition: '' },
    { id: 'fact-1', kind: 'fact', factKind: 'port', intentId: 'intent-1', target: 'example.com', detail: 'tcp/80 open', confidence: 0.9 },
    { id: 'finding-1', kind: 'finding', intentId: 'intent-1', title: 'SQL injection', severity: 'high', description: 'injectable', steps: ['curl x', 'observe 500'], affectedAssetId: undefined, vulnType: '', owner: '', impact: '', rawRequest: '', rawResponse: '', poc: '', killChain: [], score: 0, strictListHit: 'none', publicInterface: false },
  ],
  assets: [
    { id: 'asset-1', type: 'root-domain', value: 'example.com', meta: '', owner: '' },
  ],
  edges: [
    { id: 'edge-1', kind: 'spawns', sourceId: 'goal-1', targetId: 'intent-1' },
    { id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'fact-1' },
    { id: 'edge-3', kind: 'proves', sourceId: 'intent-1', targetId: 'finding-1' },
  ],
  counts: { intents: 1, facts: 1, findings: 1, assets: 1 },
}

/** View props stub: the view reads the 'srchunter' projection only. */
function viewProps(store: ReturnType<typeof createSnapshotStore<{ value: SrchunterProjection | null | undefined }>>): SrchunterViewProps {
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  return { useProjection, t } as unknown as SrchunterViewProps
}

describe('SrchunterView', () => {
  it('renders the guiding empty note while the projection is absent or null', () => {
    const absent = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({ value: undefined })
    const first = render(<SrchunterView {...viewProps(absent)} />)
    expect(first.getByTestId('srchunter-view')).toBeTruthy()
    expect(first.getByText(/还没有漏洞挖掘记录/)).toBeTruthy()
    cleanup()

    const none = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({ value: null })
    const second = render(<SrchunterView {...viewProps(none)} />)
    expect(second.getByText(/还没有漏洞挖掘记录/)).toBeTruthy()
  })

  it('renders the engagement card: target, objective, authorization, budget, counts', () => {
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({
      value: { ...STANDING, goal: { ...GOAL, destructive: 'readonly' } },
    })
    render(<SrchunterView {...viewProps(store)} />)
    // The target also appears on the goal graph node, so match the header line
    // through its label peers.
    expect(screen.getAllByText('example.com').length).toBeGreaterThan(0)
    expect(screen.getByText('目的：map the web surface')).toBeTruthy()
    expect(screen.getByText('授权：CTO sign-off')).toBeTruthy()
    expect(screen.getByText('破坏性档位：readonly')).toBeTruthy()
    // The stat row is a chip group: the sentence lives in its accessible name so
    // screen readers still get the whole counts line.
    const stats = screen.getByTestId('srchunter-stats')
    expect(stats.getAttribute('aria-label')).toBe('意图 1 · 事实 1 · 漏洞 1 · 资产 1')
    expect(['intents', 'facts', 'findings', 'assets'].map(key => screen.getByTestId(`srchunter-stat-${key}`).textContent))
      .toEqual(['意图1', '事实1', '漏洞1', '资产1'])
  })

  it('counts the intents that still owe a conclusion', () => {
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({ value: STANDING })
    render(<SrchunterView {...viewProps(store)} />)
    // `open` is one of the pending verdicts, so the note appears beside the target.
    expect(screen.getByTestId('srchunter-pending').textContent).toBe('待收口意图：1')
    act(() => {
      store.set({
        value: {
          ...STANDING,
          nodes: STANDING.nodes.map(node => (node.kind === 'intent' ? { ...node, status: 'done' as const } : node)),
        },
      })
    })
    expect(screen.queryByTestId('srchunter-pending')).toBeNull()
  })

  it('summarises the findings by severity and jumps to the filtered list', () => {
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({
      value: {
        ...STANDING,
        nodes: [
          ...STANDING.nodes,
          { ...STANDING.nodes[2]!, id: 'finding-2', severity: 'critical', score: 9 },
        ],
        counts: { intents: 1, facts: 1, findings: 2, assets: 1 },
      },
    })
    render(<SrchunterView {...viewProps(store)} />)
    expect(screen.queryByTestId('srchunter-severity-medium')).toBeNull()
    expect(screen.getByTestId('srchunter-severity-high').textContent).toBe('高危1')
    expect(screen.getByTestId('srchunter-severity-critical').textContent).toBe('严重1')
    act(() => { screen.getByTestId('srchunter-severity-critical').click() })
    // The chip lands on the 漏洞 sub-tab with that severity already filtered.
    expect(screen.getByTestId('srchunter-findings-filter-critical').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getAllByTestId('srchunter-finding')).toHaveLength(1)
    act(() => { screen.getByTestId('srchunter-findings-filter-all').click() })
    expect(screen.getAllByTestId('srchunter-finding')).toHaveLength(2)
  })

  it('states the budget when the engagement declared none', () => {
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({
      value: { ...STANDING, goal: { ...GOAL, authorization: '' } },
    })
    render(<SrchunterView {...viewProps(store)} />)
    // The budget line always speaks: it bounds what an execution agent may do.
    expect(screen.getByTestId('srchunter-destructive').textContent).toContain('limited')
    expect(screen.queryByText(/授权：/)).toBeNull()
  })

  it('omits the objective and authorization lines while they are empty', () => {
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({
      value: { ...STANDING, goal: { ...GOAL, objective: '', authorization: '' } },
    })
    render(<SrchunterView {...viewProps(store)} />)
    expect(screen.queryByText(/目的：/)).toBeNull()
    expect(screen.queryByText(/授权：/)).toBeNull()
  })

  it('renders an empty header while the projection goal is null', () => {
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({
      value: { ...STANDING, goal: null, nodes: [], edges: [], counts: { intents: 0, facts: 0, findings: 0, assets: 0 } },
    })
    render(<SrchunterView {...viewProps(store)} />)
    expect(screen.getByTestId('srchunter-stats').getAttribute('aria-label')).toBe('意图 0 · 事实 0 · 漏洞 0 · 资产 0')
    expect(screen.queryByTestId('srchunter-severity-summary')).toBeNull()
    // A zero count never shows as a pill.
    expect(screen.queryByTestId('srchunter-tab-count-findings')).toBeNull()
    expect(screen.queryByTestId('srchunter-tab-count-assets')).toBeNull()
    expect(screen.queryByText(/目的：/)).toBeNull()
    expect(screen.queryByText(/授权：/)).toBeNull()
  })

  it('renders the sub-tab bar with counts and switches the sub-tab content', () => {
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({ value: STANDING })
    render(<SrchunterView {...viewProps(store)} />)
    // Explore is the default sub-tab: the chain graph is mounted.
    expect(screen.getByTestId('srchunter-explore')).toBeTruthy()
    expect(screen.getByTestId('explore-node-goal')).toBeTruthy()

    expect(screen.getByTestId('srchunter-tab-explore').textContent).toBe('探索链路')
    expect(screen.getByTestId('srchunter-tab-report').textContent).toBe('报告')
    // The live counts ride on the sub-tab pills, not in the label text.
    expect(screen.getByTestId('srchunter-tab-findings').textContent).toBe('漏洞1')
    expect(screen.getByTestId('srchunter-tab-assets').textContent).toBe('资产1')
    expect(screen.getByTestId('srchunter-tab-count-findings').textContent).toBe('1')
    expect(screen.getByTestId('srchunter-tab-count-assets').textContent).toBe('1')

    act(() => { screen.getByTestId('srchunter-tab-findings').click() })
    expect(screen.getByTestId('srchunter-findings')).toBeTruthy()
    expect(screen.queryByTestId('srchunter-explore')).toBeNull()

    act(() => { screen.getByTestId('srchunter-tab-assets').click() })
    expect(screen.getByTestId('srchunter-assets')).toBeTruthy()
    expect(screen.queryByTestId('srchunter-findings')).toBeNull()

    act(() => { screen.getByTestId('srchunter-tab-report').click() })
    expect(screen.getByTestId('srchunter-report')).toBeTruthy()
    expect(screen.getByTestId('srchunter-report-markdown').textContent).toContain('漏洞挖掘报告')
  })

  it('copies the rendered report and reports clipboard failures', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({ value: STANDING })
    render(<SrchunterView {...viewProps(store)} />)
    act(() => { screen.getByTestId('srchunter-tab-report').click() })
    await act(async () => { screen.getByTestId('srchunter-report-copy').click() })
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('# 漏洞挖掘报告'))
    expect(screen.getByTestId('srchunter-report-copy').textContent).toContain('已复制')

    writeText.mockRejectedValueOnce(new Error('denied'))
    await act(async () => { screen.getByTestId('srchunter-report-copy').click() })
    expect(screen.getByRole('status').textContent).toContain('复制失败')
  })

  it('downloads the report with a sanitized target filename', () => {
    const createObjectURL = vi.fn(() => 'blob:report')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({
      value: { ...STANDING, goal: { ...GOAL, target: 'https://api.example.com/a path' } },
    })
    render(<SrchunterView {...viewProps(store)} />)
    act(() => { screen.getByTestId('srchunter-tab-report').click() })
    act(() => { screen.getByTestId('srchunter-report-download').click() })
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report')
  })

  it('shows the explore empty note for a goal-only engagement', () => {
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({
      value: { ...STANDING, nodes: [], edges: [], counts: { intents: 0, facts: 0, findings: 0, assets: 0 } },
    })
    render(<SrchunterView {...viewProps(store)} />)
    expect(screen.getByTestId('srchunter-explore-empty').textContent).toBe('探索链路为空。先调用 srchunter_add_goal 记录目标与目的。')
  })

  it('follows projection changes through the same source', () => {
    const store = createSnapshotStore<{ value: SrchunterProjection | null | undefined }>({ value: null })
    render(<SrchunterView {...viewProps(store)} />)
    expect(screen.getByText(/还没有漏洞挖掘记录/)).toBeTruthy()
    act(() => { store.set({ value: STANDING }) })
    expect(screen.getAllByText('example.com').length).toBeGreaterThan(0)
    expect(screen.getByTestId('explore-node-goal')).toBeTruthy()
  })
})
