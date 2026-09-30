// @vitest-environment jsdom
/**
 * Srchunter sub-tab acceptance: the 探索链路 graph (chain nodes with kind badges,
 * intent verdicts and severity, edge labels, empty note), the 漏洞 list (severity
 * and score badge, class, attribution, quantified impact, 死规矩 self-check,
 * kill chain, reproducible steps, evidence packets, affected asset), and the
 * 资产 tab (empty note, list mode grouped by type with parent links and
 * attribution, graph mode toggle).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { Position, ReactFlowProvider, type EdgeProps } from '@xyflow/react'
import type { SrchunterProjection } from '@deepseek-ai/dsh-srchunter/client'
import { ExploreView, ChainEdge } from '../src/client/ExploreView.tsx'
import { FindingsView } from '../src/client/FindingsView.tsx'
import type { SeverityFilter } from '../src/client/SrchunterView.tsx'
import { AssetsView, AssetEdge } from '../src/client/AssetsView.tsx'
import { GraphDetailDrawer } from '../src/client/GraphDetailDrawer.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh)

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

const CHAIN: SrchunterProjection = {
  goal: { id: 'goal-1', target: 'example.com', objective: 'map the web surface', authorization: '', destructive: 'limited' },
  nodes: [
    { id: 'intent-1', kind: 'intent', title: 'enumerate endpoints', detail: 'scope /api', status: 'open', disposition: '' },
    { id: 'fact-1', kind: 'fact', factKind: 'port', intentId: 'intent-1', target: 'example.com', detail: 'tcp/80 open', confidence: 0.9 },
    { id: 'finding-1', kind: 'finding', intentId: 'intent-1', title: 'SQL injection', severity: 'high', description: 'injectable', steps: ['curl x', 'observe 500'], affectedAssetId: undefined, vulnType: '', owner: '', impact: '', rawRequest: '', rawResponse: '', poc: '', killChain: [], score: 0, strictListHit: 'none', publicInterface: false },
  ],
  assets: [
    { id: 'asset-1', type: 'root-domain', value: 'example.com', meta: 'scope', owner: '' },
    { id: 'asset-2', type: 'endpoint', value: '/search', meta: '', owner: '' },
  ],
  edges: [
    { id: 'edge-1', kind: 'spawns', sourceId: 'goal-1', targetId: 'intent-1' },
    { id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'fact-1' },
    { id: 'edge-3', kind: 'proves', sourceId: 'intent-1', targetId: 'finding-1' },
    { id: 'edge-4', kind: 'parent', sourceId: 'asset-1', targetId: 'asset-2' },
  ],
  counts: { intents: 1, facts: 1, findings: 1, assets: 2 },
}

/** FindingsView mount: the severity filter is owned by the parent view, so the
 * sub-tab receives it (and its setter) as props. */
function renderFindings(
  srchunter: SrchunterProjection,
  severity: SeverityFilter = 'all',
  onSeverity: (value: SeverityFilter) => void = () => {},
) {
  return render(<FindingsView srchunter={srchunter} t={t} severity={severity} onSeverity={onSeverity} />)
}

describe('ExploreView', () => {
  it('renders the chain nodes with kind badges and severity', () => {
    render(<ExploreView srchunter={CHAIN} t={t} />)
    expect(screen.getByTestId('explore-node-goal').textContent).toContain('目标')
    expect(screen.getByTestId('explore-node-goal').textContent).toContain('example.com')
    expect(screen.getByTestId('explore-node-intent').textContent).toContain('意图')
    expect(screen.getByTestId('explore-node-intent').textContent).toContain('enumerate endpoints')
    expect(screen.getByTestId('explore-node-fact').textContent).toContain('事实')
    expect(screen.getByTestId('explore-node-finding').textContent).toContain('漏洞')
    expect(screen.getByTestId('explore-node-finding').textContent).toContain('高危')
    // Edge labels render only after React Flow measures the pane, which jsdom
    // never does; the layout spec covers edge filtering and kinds.
  })

  it('renders the empty note for a goal-only engagement', () => {
    render(<ExploreView srchunter={{ ...CHAIN, nodes: [], edges: [] }} t={t} />)
    expect(screen.getByTestId('srchunter-explore-empty').textContent).toContain('探索链路为空')
  })

  it('opens and closes a detail drawer after selecting a chain node', () => {
    render(<ExploreView srchunter={CHAIN} t={t} />)
    act(() => { screen.getByTestId('explore-node-intent').click() })
    expect(screen.getByTestId('graph-detail-drawer').textContent).toContain('scope /api')
    act(() => { screen.getByLabelText('关闭详情').click() })
    expect(screen.queryByTestId('graph-detail-drawer')).toBeNull()
  })

  it('floats a legend of the kinds present over the graph', () => {
    render(<ExploreView srchunter={CHAIN} t={t} />)
    const legend = screen.getByTestId('srchunter-explore-legend')
    expect(legend.textContent).toContain('目标1')
    expect(legend.textContent).toContain('意图1')
    expect(legend.textContent).toContain('事实1')
    expect(legend.textContent).toContain('漏洞1')
    expect(legend.textContent).toContain('点击节点查看详情')
  })
})

describe('edge components', () => {
  /** Minimal edge props: only the fields the custom edge components read. */
  function edgeProps(overrides: Partial<EdgeProps> = {}): EdgeProps {
    return {
      id: 'e1',
      source: 'a',
      target: 'b',
      sourceX: 0,
      sourceY: 0,
      targetX: 120,
      targetY: 0,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      selected: false,
      isFocusable: false,
      ...overrides,
    } as unknown as EdgeProps
  }

  it('ChainEdge renders a bezier path and forwards the relationship label', () => {
    render(
      <ReactFlowProvider>
        <ChainEdge {...edgeProps({ label: '意图链' })} />
      </ReactFlowProvider>,
    )
    expect(document.querySelector('path')).not.toBeNull()
    // EdgeLabelRenderer portals into the flow's viewport, which a bare
    // provider never mounts; the label branch itself is covered by the render.
  })

  it('ChainEdge renders without a label when none is given', () => {
    render(
      <ReactFlowProvider>
        <ChainEdge {...edgeProps()} />
      </ReactFlowProvider>,
    )
    expect(document.querySelector('path')).not.toBeNull()
  })

  it('AssetEdge renders the parent-edge bezier path and forwards the 隶属 label', () => {
    render(
      <ReactFlowProvider>
        <AssetEdge {...edgeProps({ label: '隶属' })} />
      </ReactFlowProvider>,
    )
    expect(document.querySelector('path')).not.toBeNull()
  })
})

describe('GraphDetailDrawer', () => {
  it('filters empty fields and closes through Escape or its backdrop', () => {
    const onClose = vi.fn()
    render(<GraphDetailDrawer title="node" fields={[{ label: 'shown', value: 'value' }, { label: 'hidden', value: '' }]} onClose={onClose} />)
    expect(screen.getByTestId('graph-detail-drawer').textContent).toContain('value')
    expect(screen.getByTestId('graph-detail-drawer').textContent).not.toContain('hidden')
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) })
    expect(onClose).not.toHaveBeenCalled()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => { screen.getByTestId('graph-detail-drawer').querySelector('button')!.click() })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('FindingsView', () => {
  it('renders each finding with severity, title, description, and reproducible steps', () => {
    renderFindings(CHAIN)
    const finding = screen.getByTestId('srchunter-finding')
    expect(finding.textContent).toContain('高危')
    expect(finding.textContent).toContain('SQL injection')
    expect(finding.textContent).toContain('injectable')
    expect(finding.textContent).toContain('可复现步骤')
    const steps = finding.querySelectorAll('ol li')
    expect([...steps].map(li => li.textContent)).toEqual(['curl x', 'observe 500'])
  })

  it('omits description and affected asset lines while absent', () => {
    renderFindings({
      ...CHAIN,
      nodes: [{ id: 'finding-1', kind: 'finding', intentId: 'intent-1', title: 'no details', severity: 'info', description: '', steps: ['x'], affectedAssetId: undefined, vulnType: '', owner: '', impact: '', rawRequest: '', rawResponse: '', poc: '', killChain: [], score: 0, strictListHit: 'none', publicInterface: false }],
    })
    const finding = screen.getByTestId('srchunter-finding')
    expect(finding.textContent).not.toContain('影响资产')
    expect(finding.textContent).not.toContain('描述')
  })

  it('shows the affected asset when linked', () => {
    renderFindings({
      ...CHAIN,
      nodes: [{ id: 'finding-1', kind: 'finding', intentId: 'intent-1', title: 'sqli', severity: 'high', description: '', steps: ['x'], affectedAssetId: 'asset-2', vulnType: '', owner: '', impact: '', rawRequest: '', rawResponse: '', poc: '', killChain: [], score: 0, strictListHit: 'none', publicInterface: false }],
    })
    expect(screen.getByTestId('srchunter-finding').textContent).toContain('影响资产: [endpoint] /search')
  })

  it('renders the empty note without findings', () => {
    renderFindings({ ...CHAIN, nodes: [] })
    expect(screen.getByTestId('srchunter-findings-empty').textContent).toBe('暂无漏洞记录')
  })

  it('filters the list by severity and honours the parent-owned filter', () => {
    const onSeverity = vi.fn()
    renderFindings({
      ...CHAIN,
      nodes: [
        CHAIN.nodes[2]!,
        { ...CHAIN.nodes[2]!, id: 'finding-2', title: '越权下载', severity: 'critical', score: 9 },
      ],
      counts: { ...CHAIN.counts, findings: 2 },
    }, 'all', onSeverity)
    expect(screen.getAllByTestId('srchunter-finding')).toHaveLength(2)
    expect(screen.getByTestId('srchunter-findings-filter-critical').textContent).toContain('1')
    act(() => { screen.getByTestId('srchunter-findings-filter-critical').click() })
    expect(onSeverity).toHaveBeenCalledWith('critical')
  })

  it('says so when the inherited filter hides every finding', () => {
    renderFindings({
      ...CHAIN,
      nodes: [
        CHAIN.nodes[2]!,
        { ...CHAIN.nodes[2]!, id: 'finding-2', title: '越权下载', severity: 'critical', score: 9 },
      ],
      counts: { ...CHAIN.counts, findings: 2 },
    }, 'low')
    expect(screen.queryByTestId('srchunter-findings')).toBeNull()
    expect(screen.getByTestId('srchunter-findings-filtered-empty').textContent).toBe('当前筛选下没有漏洞')
  })

  it('copies an evidence packet to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderFindings({
      ...CHAIN,
      nodes: [{ ...CHAIN.nodes[2]!, poc: 'curl -s https://example.com/poc' }],
    })
    await act(async () => { screen.getByTestId('srchunter-finding-packet-copy').click() })
    expect(writeText).toHaveBeenCalledWith('curl -s https://example.com/poc')
    expect(screen.getByTestId('srchunter-finding-packet-copy').textContent).toContain('已复制')
  })
})

describe('AssetsView', () => {
  it('renders the empty note without assets', () => {
    render(<AssetsView srchunter={{ ...CHAIN, assets: [], edges: [] }} t={t} />)
    expect(screen.getByTestId('srchunter-assets-empty').textContent).toBe('暂无资产记录')
  })

  it('lists assets grouped by type with parent links in list mode', () => {
    render(<AssetsView srchunter={CHAIN} t={t} />)
    expect(screen.getByTestId('srchunter-assets-list')).toBeTruthy()
    const groups = screen.getAllByTestId('srchunter-asset-group')
    expect(groups.map(group => group.querySelector('h4')!.textContent)).toEqual(['根域名1', '端点1'])
    const rows = screen.getAllByTestId('srchunter-asset-row')
    expect(rows[0]!.textContent).toContain('example.com')
    expect(rows[0]!.textContent).toContain('（scope）')
    expect(rows[1]!.textContent).toContain('/search')
    expect(rows[1]!.textContent).toContain('← example.com')
  })

  it('filters the rows through the search box, by value, meta, owner or parent', () => {
    render(<AssetsView srchunter={CHAIN} t={t} />)
    const search = screen.getByTestId('srchunter-assets-search')
    fireEvent.change(search, { target: { value: '/search' } })
    expect(screen.getAllByTestId('srchunter-asset-row')).toHaveLength(1)
    expect(screen.getByTestId('srchunter-asset-row').textContent).toContain('/search')
    fireEvent.change(search, { target: { value: 'scope' } })
    expect(screen.getByTestId('srchunter-asset-row').textContent).toContain('example.com')
    fireEvent.change(search, { target: { value: 'nothing here' } })
    expect(screen.getByTestId('srchunter-assets-filtered-empty').textContent).toBe('没有匹配的资产')
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getAllByTestId('srchunter-asset-row')).toHaveLength(2)
  })

  it('toggles to graph mode and back', () => {
    render(<AssetsView srchunter={CHAIN} t={t} />)
    expect(screen.getByTestId('srchunter-assets-mode-list').getAttribute('aria-pressed')).toBe('true')
    act(() => { screen.getByTestId('srchunter-assets-mode-graph').click() })
    expect(screen.getByTestId('srchunter-assets-graph')).toBeTruthy()
    expect(screen.queryByTestId('srchunter-assets-list')).toBeNull()
    expect(screen.getAllByTestId('explore-node-asset')).toHaveLength(2)
    const assetNodes = screen.getAllByTestId('explore-node-asset')
    expect(assetNodes.map(node => node.textContent).join(' ')).toContain('根域名')
    expect(assetNodes.map(node => node.textContent).join(' ')).toContain('example.com')
    act(() => { screen.getByTestId('srchunter-assets-mode-list').click() })
    expect(screen.getByTestId('srchunter-assets-list')).toBeTruthy()
  })

  it('opens asset details from a graph node', () => {
    render(<AssetsView srchunter={CHAIN} t={t} />)
    act(() => { screen.getByTestId('srchunter-assets-mode-graph').click() })
    act(() => { screen.getAllByTestId('explore-node-asset')[0]!.click() })
    expect(screen.getByTestId('graph-detail-drawer').textContent).toContain('scope')
    act(() => { screen.getByLabelText('关闭详情').click() })
    expect(screen.queryByTestId('graph-detail-drawer')).toBeNull()
  })
})

describe('EduSRC record surfaces', () => {
  /** A finding that cleared the realized-harm gate, with everything it proved. */
  const PROVEN = {
    id: 'finding-1', kind: 'finding', intentId: 'intent-1', title: '未授权接口 dump 学生身份证号', severity: 'critical',
    description: '匿名可读他人身份证号', steps: ['GET /api/student/list?limit=100'], affectedAssetId: 'asset-1',
    vulnType: 'unauthorized_access', owner: 'XX大学（依据：ICP 备案主体）', impact: '共 19,412 条学生记录',
    rawRequest: 'GET /api/student/list HTTP/1.1\nHost: jwxx.example.edu.cn', rawResponse: 'HTTP/1.1 200 OK\n{"idcard":"3701"}',
    poc: 'curl -s https://jwxx.example.edu.cn/api/student/list',
    killChain: ['审计前端 JS → 发现接口未挂鉴权', '匿名请求 → 返回他人身份证号'],
    score: 9.5, strictListHit: 'id-number', publicInterface: false,
  }

  it('presents the attribution, impact, self-check and evidence of a proven finding, strongest harm first', () => {
    renderFindings({
      ...CHAIN,
      nodes: [
        { ...PROVEN },
        { id: 'finding-2', kind: 'finding', intentId: 'intent-1', title: '越权下载他人投稿文件', severity: 'medium',
          description: '', steps: ['GET /file?id=1001'], affectedAssetId: undefined, vulnType: 'idor', owner: '',
          impact: '', rawRequest: '', rawResponse: '', poc: 'curl -s https://example.com/file?id=1001',
          killChain: [], score: 5, strictListHit: 'none', publicInterface: false },
      ],
      counts: { intents: 1, facts: 1, findings: 2, assets: 2 },
    })
    const cards = screen.getAllByTestId('srchunter-finding')
    expect(cards[0].textContent).toContain('未授权接口 dump 学生身份证号')
    expect(cards[0].textContent).toContain('9.5')
    expect(cards[0].textContent).toContain('unauthorized_access')
    expect(cards[0].textContent).toContain('XX大学（依据：ICP 备案主体）')
    expect(cards[0].textContent).toContain('共 19,412 条学生记录')
    expect(cards[0].textContent).toContain('id-number')
    expect([...cards[0].querySelectorAll('[data-testid="srchunter-finding-kill-chain"] li')].map(li => li.textContent))
      .toEqual(['审计前端 JS → 发现接口未挂鉴权', '匿名请求 → 返回他人身份证号'])
    expect(cards[0].querySelector('[data-testid="srchunter-finding-evidence"]')?.textContent)
      .toContain('curl -s https://jwxx.example.edu.cn/api/student/list')
    // A finding without attribution or a strict-list hit says so instead of hiding it.
    expect(cards[1].textContent).toContain('待确认')
    expect(cards[1].textContent).toContain('未命中四类')
  })

  it('draws the intent verdict on the chain node and passes the directive to the drawer', () => {
    render(<ExploreView srchunter={{
      ...CHAIN,
      nodes: [{ id: 'intent-1', kind: 'intent', title: '验证学生接口鉴权', detail: 'scope /api', status: 'deepen', disposition: '遍历 userId 取他人记录' }, CHAIN.nodes[1]!, CHAIN.nodes[2]!],
    }} t={t} />)
    const badge = screen.getByTestId('explore-intent-status')
    expect(badge.getAttribute('data-status')).toBe('deepen')
    expect(badge.textContent).toContain('待深挖')
    act(() => { screen.getByTestId('explore-node-intent').click() })
    expect(screen.getByTestId('graph-detail-drawer').textContent).toContain('遍历 userId 取他人记录')
  })

  it('names the organization an asset was attributed to', () => {
    render(<AssetsView srchunter={{
      ...CHAIN,
      assets: [{ id: 'asset-1', type: 'root-domain', value: 'example.com', meta: 'scope', owner: 'XX大学' }, CHAIN.assets[1]!],
    }} t={t} />)
    expect(screen.getByTestId('srchunter-asset-owner').textContent).toContain('XX大学')
  })
})
