/**
 * Pure graph-layout acceptance: `layoutExploration` (BFS layers from the goal
 * over chain edges only) and `layoutAssets` (parent-tree layers) produce the
 * expected columns, stacking, and edge filtering.
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { SrchunterProjection } from '@deepseek-ai/dsh-srchunter/client'
import { layoutAssets, layoutExploration } from '../src/client/graph.ts'

/** A chain projection: goal → intent → fact → derived intent → finding, plus one parent asset edge. */
function chainProjection(): SrchunterProjection {
  return {
    goal: { id: 'goal-1', target: 'example.com', objective: 'map surface', authorization: '', destructive: 'limited' },
    nodes: [
      { id: 'intent-1', kind: 'intent', title: 'enumerate', detail: 'scope /api', status: 'open', disposition: '' },
      { id: 'fact-1', kind: 'fact', factKind: 'port', intentId: 'intent-1', target: 'example.com', detail: 'tcp/80 open', confidence: 0.9 },
      { id: 'intent-2', kind: 'intent', title: 'probe login', detail: '', status: 'open', disposition: '' },
      { id: 'finding-1', kind: 'finding', intentId: 'intent-2', title: 'sqli', severity: 'high', description: 'injectable', steps: ['curl x'], affectedAssetId: undefined, vulnType: '', owner: '', impact: '', rawRequest: '', rawResponse: '', poc: '', killChain: [], score: 0, strictListHit: 'none', publicInterface: false },
    ],
    assets: [
      { id: 'asset-1', type: 'root-domain', value: 'example.com', meta: '', owner: '' },
      { id: 'asset-2', type: 'subdomain', value: 'api.example.com', meta: '', owner: '' },
    ],
    edges: [
      { id: 'edge-1', kind: 'spawns', sourceId: 'goal-1', targetId: 'intent-1' },
      { id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'fact-1' },
      { id: 'edge-3', kind: 'derived_from', sourceId: 'fact-1', targetId: 'intent-2' },
      { id: 'edge-4', kind: 'proves', sourceId: 'intent-2', targetId: 'finding-1' },
      { id: 'edge-5', kind: 'parent', sourceId: 'asset-1', targetId: 'asset-2' },
    ],
    counts: { intents: 2, facts: 1, findings: 1, assets: 2 },
  }
}

describe('layoutExploration', () => {
  it('lays a pure chain out one column per hop with the goal at the start', () => {
    const { nodes, edges } = layoutExploration(chainProjection())
    expect(edges.map(edge => edge.kind)).toEqual(['spawns', 'yields', 'derived_from', 'proves'])
    const byId = new Map(nodes.map(node => [node.id, node]))
    expect(byId.get('goal-1')).toMatchObject({ kind: 'goal', title: 'example.com', x: 0, y: 0 })
    expect(byId.get('intent-1')).toMatchObject({ kind: 'intent', title: 'enumerate', detail: 'scope /api', x: 320, y: 0, status: 'open', disposition: '' })
    expect(byId.get('fact-1')).toMatchObject({ kind: 'fact', title: 'tcp/80 open', detail: 'example.com [port] · 0.9', x: 640, y: 0 })
    expect(byId.get('intent-2')).toMatchObject({ kind: 'intent', x: 960, y: 0, status: 'open', disposition: '' })
    expect(byId.get('finding-1')).toMatchObject({ kind: 'finding', severity: 'high', title: 'sqli', x: 1280, y: 0  })
  })

  it('stacks sibling nodes of one layer vertically and excludes parent edges', () => {
    const projection: SrchunterProjection = {
      ...chainProjection(),
      nodes: [
        ...chainProjection().nodes,
        { id: 'intent-3', kind: 'intent', title: 'second intent', detail: '', status: 'open', disposition: '' },
        { id: 'fact-2', kind: 'fact', factKind: 'info', intentId: 'intent-1', target: '', detail: 'robots.txt present', confidence: 0.5 },
      ],
      edges: [
        ...chainProjection().edges,
        { id: 'edge-6', kind: 'spawns', sourceId: 'goal-1', targetId: 'intent-3' },
        { id: 'edge-7', kind: 'yields', sourceId: 'intent-1', targetId: 'fact-2' },
      ],
    }
    const { nodes, edges } = layoutExploration(projection)
    expect(edges.some(edge => edge.kind === 'parent')).toBe(false)
    const layerOne = nodes.filter(node => node.x === 320).sort((a, b) => a.y - b.y)
    expect(layerOne.map(node => node.id)).toEqual(['intent-1', 'intent-3'])
    expect(layerOne[0]!.y).toBe(0)
    expect(layerOne[1]!.y).toBe(152)
    // A target-less fact renders its detail without the target prefix.
    expect(nodes.find(node => node.id === 'fact-2')).toMatchObject({ detail: '[info] · 0.5' })
  })

  it('hangs nodes unreachable from the goal in the last column and tolerates a missing goal', () => {
    const projection: SrchunterProjection = {
      ...chainProjection(),
      nodes: [
        ...chainProjection().nodes,
        { id: 'finding-9', kind: 'finding', intentId: 'intent-9', title: 'orphan', severity: 'low', description: '', steps: ['x'], affectedAssetId: undefined, vulnType: '', owner: '', impact: '', rawRequest: '', rawResponse: '', poc: '', killChain: [], score: 0, strictListHit: 'none', publicInterface: false },
      ],
    }
    const { nodes } = layoutExploration(projection)
    const orphan = nodes.find(node => node.id === 'finding-9')!
    expect(orphan.x).toBeGreaterThan(1280) // one column past the deepest chain node
    // A null goal still yields a goal start node with empty text.
    const goalless = layoutExploration({ ...projection, goal: null })
    expect(goalless.nodes[0]).toMatchObject({ id: 'goal-1', kind: 'goal', title: '', x: 0, y: 0  })
  })
})

describe('layoutAssets', () => {
  it('lays the asset tree out from roots one column per parent hop', () => {
    const projection: SrchunterProjection = {
      goal: { id: 'goal-1', target: 't', objective: 'o', authorization: '', destructive: 'limited' },
      nodes: [],
      assets: [
        { id: 'asset-1', type: 'root-domain', value: 'example.com', meta: '', owner: '' },
        { id: 'asset-2', type: 'subdomain', value: 'api.example.com', meta: '', owner: '' },
        { id: 'asset-3', type: 'ip', value: '10.0.0.1', meta: '', owner: '' },
        { id: 'asset-4', type: 'service', value: 'nginx/1.24', meta: '', owner: '' },
      ],
      edges: [
        { id: 'edge-1', kind: 'parent', sourceId: 'asset-1', targetId: 'asset-2' },
        { id: 'edge-2', kind: 'parent', sourceId: 'asset-1', targetId: 'asset-3' },
        { id: 'edge-3', kind: 'parent', sourceId: 'asset-3', targetId: 'asset-4' },
      ],
      counts: { intents: 0, facts: 0, findings: 0, assets: 4 },
    }
    const { nodes, edges } = layoutAssets(projection)
    expect(edges).toEqual(projection.edges)
    const byId = new Map(nodes.map(node => [node.id, node]))
    expect(byId.get('asset-1')).toMatchObject({ x: 0, y: 0 })
    expect(byId.get('asset-2')).toMatchObject({ x: 292, y: 0 })
    expect(byId.get('asset-3')).toMatchObject({ x: 292, y: 132 })
    expect(byId.get('asset-4')).toMatchObject({ x: 584, y: 0 })
  })

  it('treats assets without parent edges as roots', () => {
    const projection: SrchunterProjection = {
      goal: { id: 'goal-1', target: 't', objective: 'o', authorization: '', destructive: 'limited' },
      nodes: [],
      assets: [
        { id: 'asset-1', type: 'app', value: 'app-a', meta: '', owner: '' },
        { id: 'asset-2', type: 'app', value: 'app-b', meta: '', owner: '' },
      ],
      edges: [],
      counts: { intents: 0, facts: 0, findings: 0, assets: 2 },
    }
    const { nodes } = layoutAssets(projection)
    expect(nodes.map(node => [node.id, node.x, node.y])).toEqual([
      ['asset-1', 0, 0],
      ['asset-2', 0, 132],
    ])
  })
})
