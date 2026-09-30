/**
 * The standing `srchunter` projection: the pure fold over logged srchunter_*
 * tool calls (the exploration graph with deterministic ids), the wire schema,
 * and the live registration through the session-projection seam (mounted
 * harness, driven by real session events).
 * @module
 */

import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applySrchunterEvent,
  srchunterInitialState,
  srchunterProjectionSchema,
  viewSrchunterState,
  ASSET_CAP,
  EDGE_CAP,
  NODE_CAP,
  PACKET_CAP,
} from '../src/projection.ts'
import type { SrchunterFoldState } from '../src/projection.ts'
import { srchunterProjectionHarness } from './harness.ts'

/** One tool/call event carrying the given srchunter tool name and raw JSON arguments. */
function toolCall(name: string, args: string, seq = 1, callId = 'c1'): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 1, step: 1, callId: CallId(callId), name, arguments: args },
  }
}

/**
 * The evidence the realized-harm gate demands of a proven finding. A folded
 * `srchunter_add_finding` without it is a call the tool rejected, so the fold
 * skips it and the graph would never show it.
 */
const EVIDENCE = {
  owner: 'XX大学（依据：ICP 备案主体）',
  impact: '共 120 条学生记录',
  rawRequest: 'GET /search?q=1%27 HTTP/1.1',
  rawResponse: 'HTTP/1.1 500 OK\nYou have an error in your SQL syntax',
}

/** One proven finding's tool/call event: the gate's evidence plus the given fields. */
function findingCall(fields: Record<string, unknown>, seq: number, callId: string): SessionEvent {
  return toolCall('srchunter_add_finding', JSON.stringify({ ...EVIDENCE, ...fields }), seq, callId)
}

/** Fold a sequence of tool calls from the initial state. */
function fold(...events: SessionEvent[]): SrchunterFoldState {
  return events.reduce(applySrchunterEvent, srchunterInitialState)
}

/** The canonical full chain: goal → spawns intent → fact → derived intent → finding. */
function fullChainEvents(): SessionEvent[] {
  return [
    toolCall('srchunter_add_goal', '{"target":"example.com","objective":"map surface","authorization":"signed"}', 1, 'g1'),
    toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"enumerate endpoints","detail":"scope /api"}', 2, 'i1'),
    toolCall('srchunter_add_fact', '{"intentId":"intent-1","kind":"port","target":"example.com","detail":"tcp/80 open","confidence":0.9}', 3, 'f1'),
    toolCall('srchunter_add_intent', '{"derivedFromFactId":"fact-1","title":"probe login"}', 4, 'i2'),
    findingCall({
      intentId: 'intent-2', title: 'sqli', severity: 'high', description: 'injectable',
      reproducibleSteps: ['curl x', 'observe 500'],
    }, 5, 'n1'),
  ]
}

describe('applySrchunterEvent', () => {  it('srchunter_add_goal resets to a fresh graph with the goal', () => {
    const state = fold(...fullChainEvents())
    const reset = applySrchunterEvent(state, toolCall('srchunter_add_goal', '{"target":"other","objective":"fresh"}', 6, 'g2'))
    expect(reset).toEqual({
      goal: { id: 'goal-1', target: 'other', objective: 'fresh', authorization: '', destructive: 'limited' },
      nodes: [],
      assets: [],
      edges: [],
      counters: { intent: 0, fact: 0, finding: 0, asset: 0, edge: 0 },
    })
  })

  it('folds the destructive budget and keeps limited as the default', () => {
    const readonly = fold(toolCall('srchunter_add_goal', '{"target":"t","objective":"o","destructive":"readonly"}', 1, 'g1'))
    expect(readonly.goal).toEqual({ id: 'goal-1', target: 't', objective: 'o', authorization: '', destructive: 'readonly' })
    const full = fold(toolCall('srchunter_add_goal', '{"target":"t","objective":"o","destructive":"full"}', 1, 'g1'))
    expect(full.goal).toMatchObject({ destructive: 'full' })
    // An unknown budget is not a fifth tier: the fold lands on the tool default.
    const unknown = fold(toolCall('srchunter_add_goal', '{"target":"t","objective":"o","destructive":"nuke"}', 1, 'g1'))
    expect(unknown.goal).toMatchObject({ destructive: 'limited' })
  })

  it('skips a goal without target or objective', () => {
    const before = fold(...fullChainEvents())
    expect(applySrchunterEvent(before, toolCall('srchunter_add_goal', '{"target":""}', 6, 'g2'))).toBe(before)
    expect(applySrchunterEvent(before, toolCall('srchunter_add_goal', '{"objective":"o"}', 6, 'g2'))).toBe(before)
  })

  it('folds the full chain with deterministic ids and edges', () => {
    const state = fold(...fullChainEvents())
    expect(state.goal).toEqual({
      id: 'goal-1', target: 'example.com', objective: 'map surface', authorization: 'signed', destructive: 'limited',
    })
    expect(state.nodes).toEqual([
      { id: 'intent-1', kind: 'intent', title: 'enumerate endpoints', detail: 'scope /api', status: 'open', disposition: '' },
      { id: 'fact-1', kind: 'fact', factKind: 'port', intentId: 'intent-1', target: 'example.com', detail: 'tcp/80 open', confidence: 0.9 },
      { id: 'intent-2', kind: 'intent', title: 'probe login', detail: '', status: 'open', disposition: '' },
      {
        id: 'finding-1',
        kind: 'finding',
        intentId: 'intent-2',
        title: 'sqli',
        severity: 'high',
        description: 'injectable',
        steps: ['curl x', 'observe 500'],
        affectedAssetId: undefined,
        vulnType: '',
        owner: EVIDENCE.owner,
        impact: EVIDENCE.impact,
        rawRequest: EVIDENCE.rawRequest,
        rawResponse: EVIDENCE.rawResponse,
        poc: '',
        killChain: [],
        score: 0,
        strictListHit: 'none',
        publicInterface: false,
      },
    ])
    expect(state.edges).toEqual([
      { id: 'edge-1', kind: 'spawns', sourceId: 'goal-1', targetId: 'intent-1' },
      { id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'fact-1' },
      { id: 'edge-3', kind: 'derived_from', sourceId: 'fact-1', targetId: 'intent-2' },
      { id: 'edge-4', kind: 'proves', sourceId: 'intent-2', targetId: 'finding-1' },
    ])
  })

  it('add_intent requires exactly one resolvable anchor', () => {
    const goal = toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1')
    const afterGoal = fold(goal)
    // Empty title, no anchor, both anchors, and an unknown goal id all leave the state untouched.
    const unchanged = fold(goal)
    const emptyTitle = applySrchunterEvent(unchanged, toolCall('srchunter_add_intent', '{"title":"","goalId":"goal-1"}', 2, 'i1'))
    const noAnchor = applySrchunterEvent(emptyTitle, toolCall('srchunter_add_intent', '{"title":"x"}', 2, 'i1'))
    const both = applySrchunterEvent(noAnchor, toolCall('srchunter_add_intent', '{"title":"x","goalId":"goal-1","derivedFromFactId":"fact-1"}', 2, 'i1'))
    const badGoal = applySrchunterEvent(both, toolCall('srchunter_add_intent', '{"title":"x","goalId":"goal-9"}', 2, 'i1'))
    expect(emptyTitle).toBe(unchanged)
    expect(noAnchor).toBe(unchanged)
    expect(both).toBe(unchanged)
    expect(badGoal).toBe(unchanged)
    // Unknown fact anchor and intent without a goal: both untouched.
    const badFact = applySrchunterEvent(afterGoal, toolCall('srchunter_add_intent', '{"title":"x","derivedFromFactId":"fact-9"}', 2, 'i1'))
    expect(badFact).toBe(afterGoal)
  })

  it('add_fact yields facts with defaults and skips unknown intents or empty details', () => {
    const state = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"a"}', 2, 'i1'),
    )
    const first = applySrchunterEvent(state, toolCall('srchunter_add_fact', '{"intentId":"intent-1","detail":"bare"}', 3, 'f1'))
    expect(first.nodes).toEqual([
      { id: 'intent-1', kind: 'intent', title: 'a', detail: '', status: 'open', disposition: '' },
      { id: 'fact-1', kind: 'fact', factKind: 'info', intentId: 'intent-1', target: '', detail: 'bare', confidence: 0.5 },
    ])
    expect(first.edges.at(-1)).toEqual({ id: 'edge-2', kind: 'yields', sourceId: 'intent-1', targetId: 'fact-1' })
    // Unknown intent, unknown fact kind (falls back to info), and empty detail: skip / normalize.
    const unknownIntent = applySrchunterEvent(state, toolCall('srchunter_add_fact', '{"intentId":"intent-9","detail":"x"}', 3, 'f1'))
    expect(unknownIntent).toBe(state)
    const normalized = applySrchunterEvent(state, toolCall('srchunter_add_fact', '{"intentId":"intent-1","kind":"weird","target":"t","detail":"d","confidence":9}', 3, 'f1'))
    expect(normalized.nodes.at(-1)).toMatchObject({ kind: 'fact', factKind: 'info', confidence: 0.09 })
    const emptyDetail = applySrchunterEvent(state, toolCall('srchunter_add_fact', '{"intentId":"intent-1","detail":""}', 3, 'f1'))
    expect(emptyDetail).toBe(state)
  })

  it('add_finding proves findings with steps and skips step-less or unresolvable ones', () => {
    const state = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"a"}', 2, 'i1'),
      toolCall('srchunter_add_asset', '{"type":"endpoint","value":"/x"}', 3, 'a1'),
    )
    const finding = applySrchunterEvent(state, findingCall({
      intentId: 'intent-1', title: 'n', severity: 'weird', description: 'd',
      reproducibleSteps: ['curl x', '', 'curl y'], affectedAssetId: 'asset-1',
    }, 4, 'n1'))
    expect(finding.nodes.at(-1)).toMatchObject({ kind: 'finding', title: 'n', severity: 'info', steps: ['curl x', 'curl y'], affectedAssetId: 'asset-1' })
    // Unknown intent, empty title, no usable steps, non-array steps, unknown asset: all skip.
    const unknownIntent = applySrchunterEvent(state, findingCall({ intentId: 'intent-9', title: 'n', reproducibleSteps: ['x'] }, 4, 'n1'))
    expect(unknownIntent).toBe(state)
    const emptyTitle = applySrchunterEvent(state, findingCall({ intentId: 'intent-1', title: '', reproducibleSteps: ['x'] }, 4, 'n1'))
    expect(emptyTitle).toBe(state)
    const noSteps = applySrchunterEvent(state, findingCall({ intentId: 'intent-1', title: 'n', reproducibleSteps: [] }, 4, 'n1'))
    const blankSteps = applySrchunterEvent(state, findingCall({ intentId: 'intent-1', title: 'n', reproducibleSteps: [''] }, 4, 'n1'))
    const nonArraySteps = applySrchunterEvent(state, findingCall({ intentId: 'intent-1', title: 'n', reproducibleSteps: 'curl x' }, 4, 'n1'))
    expect(noSteps).toBe(state)
    expect(blankSteps).toBe(state)
    expect(nonArraySteps).toBe(state)
    const badAsset = applySrchunterEvent(state, findingCall({ intentId: 'intent-1', title: 'n', reproducibleSteps: ['x'], affectedAssetId: 'asset-9' }, 4, 'n1'))
    expect(badAsset).toBe(state)
  })

  it('add_finding skips every finding the realized-harm gate rejected', () => {
    const state = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"a"}', 2, 'i1'),
    )
    // A bare "200 OK means nothing" write: no packet, no impact, no attribution.
    const unproven = applySrchunterEvent(state, toolCall('srchunter_add_finding', '{"intentId":"intent-1","title":"疑似未授权","severity":"high","reproducibleSteps":["curl 一次返回 200"]}', 3, 'n1'))
    expect(unproven).toBe(state)
    // Attributed and quantified, but still no verbatim packet or PoC.
    const noPacket = applySrchunterEvent(state, toolCall('srchunter_add_finding', JSON.stringify({
      intentId: 'intent-1', title: 'n', reproducibleSteps: ['curl x'], owner: EVIDENCE.owner, impact: EVIDENCE.impact,
    }), 3, 'n2'))
    expect(noPacket).toBe(state)
    // Whitespace does not clear the gate either.
    const blankEvidence = applySrchunterEvent(state, toolCall('srchunter_add_finding', JSON.stringify({
      intentId: 'intent-1', title: 'n', reproducibleSteps: ['curl x'], owner: '   ', impact: '\n', rawRequest: ' ',
    }), 3, 'n3'))
    expect(blankEvidence).toBe(state)
    // A public display endpoint is not a vulnerability, however full its packets.
    const publicInterface = applySrchunterEvent(state, findingCall({ intentId: 'intent-1', title: 'n', reproducibleSteps: ['curl x'], publicInterface: true }, 3, 'n4'))
    expect(publicInterface).toBe(state)
    // A skipped write burns no id: the next proven finding is still finding-1.
    const proven = applySrchunterEvent(state, findingCall({ intentId: 'intent-1', title: 'proven', severity: 'high', reproducibleSteps: ['curl x'] }, 4, 'n5'))
    expect(proven.nodes.at(-1)).toMatchObject({ id: 'finding-1', kind: 'finding', title: 'proven' })
    expect(proven.edges.at(-1)).toMatchObject({ kind: 'proves', targetId: 'finding-1' })
  })

  it('folds the reported class, kill chain, score and EduSRC self-check', () => {
    const state = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"a"}', 2, 'i1'),
      findingCall({
        intentId: 'intent-1', title: '未授权接口 dump 学生身份证号', severity: 'critical',
        reproducibleSteps: ['GET /api/student/list?limit=100'],
        vulnType: 'unauthorized_access', score: 9.5, strictListHit: 'id-number',
        poc: 'curl -s "https://jwxx.example.edu.cn/api/student/list?limit=1"',
        killChain: ['审计前端 JS → 发现未挂鉴权的接口', '匿名请求 → 返回他人身份证号', ''],
      }, 3, 'n1'),
    )
    expect(state.nodes.at(-1)).toMatchObject({
      kind: 'finding',
      vulnType: 'unauthorized_access',
      owner: EVIDENCE.owner,
      impact: EVIDENCE.impact,
      rawRequest: EVIDENCE.rawRequest,
      rawResponse: EVIDENCE.rawResponse,
      poc: 'curl -s "https://jwxx.example.edu.cn/api/student/list?limit=1"',
      killChain: ['审计前端 JS → 发现未挂鉴权的接口', '匿名请求 → 返回他人身份证号'],
      score: 9.5,
      strictListHit: 'id-number',
      publicInterface: false,
    })
  })

  it('normalizes a malformed score or strict-list hit while folding the node', () => {
    const state = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"a"}', 2, 'i1'),
    )
    const malformed = applySrchunterEvent(state, findingCall({
      intentId: 'intent-1', title: 'n', reproducibleSteps: ['curl x'], score: 'high', strictListHit: 'bogus',
    }, 3, 'n1'))
    expect(malformed.nodes.at(-1)).toMatchObject({ score: 0, strictListHit: 'none' })
    // A score outside the band lands on the nearest bound instead of a bogus tier.
    const overstated = applySrchunterEvent(state, findingCall({
      intentId: 'intent-1', title: 'n', reproducibleSteps: ['curl x'], score: 12,
    }, 4, 'n2'))
    expect(overstated.nodes.at(-1)).toMatchObject({ score: 10 })
  })

  it('clamps an oversized packet at the projection cap and keeps a whole one', () => {
    const state = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"a"}', 2, 'i1'),
    )
    const longPacket = 'A'.repeat(PACKET_CAP + 1_000)
    const clamped = applySrchunterEvent(state, findingCall({
      intentId: 'intent-1', title: 'n', reproducibleSteps: ['curl x'], rawResponse: longPacket,
    }, 3, 'n1'))
    // Storage keeps the packet whole and the report renders it in full; the
    // wire payload folds it down with a marker pointing back at the report.
    expect(clamped.nodes.at(-1)).toMatchObject({
      rawResponse: `${longPacket.slice(0, PACKET_CAP)}\n…(已截断，完整包见 srchunter_report)`,
    })
    const exact = applySrchunterEvent(state, findingCall({
      intentId: 'intent-1', title: 'n', reproducibleSteps: ['curl x'], rawResponse: 'B'.repeat(PACKET_CAP),
    }, 4, 'n2'))
    expect(exact.nodes.at(-1)).toMatchObject({ rawResponse: 'B'.repeat(PACKET_CAP) })
  })

  it('srchunter_set_intent rewrites an intent node in place', () => {
    const state = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"dig the injection","detail":"scope /search"}', 2, 'i1'),
    )
    const adjudicated = applySrchunterEvent(state, toolCall('srchunter_set_intent', '{"intentId":"intent-1","status":"deepen","disposition":"遍历 userId 取他人记录"}', 3, 's1'))
    expect(adjudicated.nodes).toEqual([{
      id: 'intent-1', kind: 'intent', title: 'dig the injection', detail: 'scope /search',
      status: 'deepen', disposition: '遍历 userId 取他人记录',
    }])
    // In place: no extra node, no extra edge, no counter burned.
    expect(adjudicated.edges).toEqual(state.edges)
    expect(adjudicated.counters).toEqual(state.counters)
    // A later verdict replaces the earlier one, and an omitted disposition clears it.
    const revised = applySrchunterEvent(adjudicated, toolCall('srchunter_set_intent', '{"intentId":"intent-1","status":"working"}', 4, 's2'))
    expect(revised.nodes[0]).toMatchObject({ status: 'working', disposition: '' })
    const concluded = applySrchunterEvent(revised, toolCall('srchunter_set_intent', '{"intentId":"intent-1","status":"done","disposition":"已落 finding-1"}', 5, 's3'))
    expect(concluded.nodes[0]).toMatchObject({ status: 'done', disposition: '已落 finding-1' })
  })

  it('srchunter_set_intent leaves the state untouched for a verdict it must not fold', () => {
    const state = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"a"}', 2, 'i1'),
      toolCall('srchunter_add_fact', '{"intentId":"intent-1","detail":"tcp/80 open"}', 3, 'f1'),
    )
    // No status, `open` (only creation uses it), an unknown status, a non-string.
    for (const args of [
      '{"intentId":"intent-1"}',
      '{"intentId":"intent-1","status":"open"}',
      '{"intentId":"intent-1","status":"undecided"}',
      '{"intentId":"intent-1","status":42}',
      '{}',
    ]) {
      expect(applySrchunterEvent(state, toolCall('srchunter_set_intent', args, 4, 's1'))).toBe(state)
    }
    // An unknown intent, and a fact id: nothing to rewrite.
    expect(applySrchunterEvent(state, toolCall('srchunter_set_intent', '{"intentId":"intent-9","status":"done"}', 4, 's2'))).toBe(state)
    expect(applySrchunterEvent(state, toolCall('srchunter_set_intent', '{"intentId":"fact-1","status":"done"}', 4, 's3'))).toBe(state)
  })

  it('srchunter_set_intent skips an intent already evicted from the capped window', () => {
    const goal = toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1')
    const many = Array.from({ length: 250 }, (_, index) =>
      toolCall('srchunter_add_intent', `{"goalId":"goal-1","title":"i${index}"}`, 2 + index, `i${index}`))
    const capped = many.reduce(applySrchunterEvent, fold(goal))
    expect(capped.nodes[0]).toMatchObject({ id: `intent-${251 - NODE_CAP}`, status: 'open' })
    expect(applySrchunterEvent(capped, toolCall('srchunter_set_intent', '{"intentId":"intent-1","status":"done"}', 300, 's1'))).toBe(capped)
    // The newest intent is still inside the window, so it adjudicates.
    const adjudicated = applySrchunterEvent(capped, toolCall('srchunter_set_intent', '{"intentId":"intent-250","status":"blocked","disposition":"需要注册短信码"}', 301, 's2'))
    expect(adjudicated.nodes.at(-1)).toMatchObject({ id: 'intent-250', status: 'blocked', disposition: '需要注册短信码' })
  })

  it('add_asset records root and parented assets and skips invalid ones', () => {
    const state = fold(toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'))
    const root = applySrchunterEvent(state, toolCall('srchunter_add_asset', '{"type":"root-domain","value":"example.com","meta":"scope"}', 2, 'a1'))
    expect(root.assets).toEqual([{ id: 'asset-1', type: 'root-domain', value: 'example.com', meta: 'scope', owner: '' }])
    expect(root.edges).toEqual([])
    const child = applySrchunterEvent(root, toolCall('srchunter_add_asset', '{"type":"subdomain","value":"api.example.com","parentId":"asset-1"}', 3, 'a2'))
    expect(child.assets.at(-1)).toEqual({ id: 'asset-2', type: 'subdomain', value: 'api.example.com', meta: '', owner: '' })
    expect(child.edges.at(-1)).toEqual({ id: 'edge-1', kind: 'parent', sourceId: 'asset-1', targetId: 'asset-2' })
    const badType = applySrchunterEvent(state, toolCall('srchunter_add_asset', '{"type":"planet","value":"x"}', 2, 'a1'))
    const emptyValue = applySrchunterEvent(state, toolCall('srchunter_add_asset', '{"type":"ip","value":""}', 2, 'a1'))
    expect(badType).toBe(state)
    expect(emptyValue).toBe(state)
    const badParent = applySrchunterEvent(root, toolCall('srchunter_add_asset', '{"type":"ip","value":"10.0.0.1","parentId":"asset-9"}', 3, 'a2'))
    expect(badParent).toBe(root)
    // An empty-string parentId means a root asset: no edge is recorded.
    const emptyParent = applySrchunterEvent(root, toolCall('srchunter_add_asset', '{"type":"ip","value":"10.0.0.1","parentId":""}', 3, 'a2'))
    expect(emptyParent.assets.at(-1)).toMatchObject({ id: 'asset-2', type: 'ip', value: '10.0.0.1' })
    expect(emptyParent.edges).toEqual([])
  })

  it('folds the attribution an asset carries', () => {
    const attributed = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_asset', JSON.stringify({ type: 'root-domain', value: 'example.edu.cn', owner: EVIDENCE.owner }), 2, 'a1'),
    )
    expect(attributed.assets[0]).toMatchObject({ owner: EVIDENCE.owner })
  })

  it('caps nodes, edges, and assets at the newest', () => {
    const goal = toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1')
    const many = Array.from({ length: 250 }, (_, index) =>
      toolCall('srchunter_add_intent', `{"goalId":"goal-1","title":"i${index}"}`, 2 + index, `i${2 + index}`))
    const capped = many.reduce(applySrchunterEvent, fold(goal))
    expect(capped.nodes).toHaveLength(NODE_CAP)
    expect(capped.nodes[0]).toMatchObject({ id: `intent-${251 - NODE_CAP}` })
    expect(capped.edges).toHaveLength(EDGE_CAP)
    const assets = Array.from({ length: 250 }, (_, index) =>
      toolCall('srchunter_add_asset', `{"type":"ip","value":"10.0.0.${index}"}`, 300 + index, `a${300 + index}`))
    const cappedAssets = assets.reduce(applySrchunterEvent, fold(goal))
    expect(cappedAssets.assets).toHaveLength(ASSET_CAP)
  })

  it('does not expose edges whose capped endpoints are absent', () => {
    const goal = toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1')
    const intents = Array.from({ length: NODE_CAP }, (_, index) =>
      toolCall('srchunter_add_intent', `{"goalId":"goal-1","title":"i${index}"}`, 2 + index, `i${index}`))
    const beforeFacts = intents.reduce(applySrchunterEvent, fold(goal))
    const capped = Array.from({ length: NODE_CAP }, (_, index) =>
      toolCall('srchunter_add_fact', `{"intentId":"intent-${index + 1}","detail":"f${index}"}`, 202 + index, `f${index}`))
      .reduce(applySrchunterEvent, beforeFacts)
    const ids = new Set(['goal-1', ...capped.nodes.map(node => node.id), ...capped.assets.map(asset => asset.id)])
    expect(capped.edges.every(edge => ids.has(edge.sourceId) && ids.has(edge.targetId))).toBe(true)
  })

  it('ignores foreign events, read tools, and malformed arguments', () => {
    const goal = toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1')
    const clean = fold(goal)
    const unchanged = fold(
      goal,
      toolCall('bash', '{"command":"ls"}', 2, 'c2'),
      toolCall('srchunter_add_fact', 'not json', 3, 'c3'),
      toolCall('srchunter_add_fact', '"just a string"', 4, 'c4'),
      toolCall('srchunter_set_intent', 'not json', 5, 'c5'),
      toolCall('srchunter_set_intent', '{"intentId":"intent-1","status":"deepen","disposition":"d"}', 6, 'c6'),
      toolCall('srchunter_state', '{}', 7, 'c7'),
      toolCall('srchunter_graph', '{}', 8, 'c8'),
      toolCall('srchunter_report', '{}', 9, 'c9'),
      { type: 'tool/result', seq: 10, time: 10, data: { turn: 1, step: 1, callId: CallId('c3'), name: 'srchunter_add_fact', arguments: '{"intentId":"intent-1","detail":"d"}' } } as SessionEvent,
    )
    expect(unchanged).toEqual(clean)
  })

  it('replays a delegated submission and ignores malformed submission entries', () => {
    const state = fold(
      toolCall('srchunter_add_goal', '{"target":"t","objective":"o"}', 1, 'g1'),
      toolCall('srchunter_add_intent', '{"goalId":"goal-1","title":"probe"}', 2, 'i1'),
    )
    const submitted = applySrchunterEvent(state, {
      type: 'srchunter/submit',
      data: {
        intentId: 'intent-1',
        facts: [{ detail: 'HTTP 200', kind: 'http', confidence: 0.9 }, null, 'not-an-object'],
        assets: [{ type: 'endpoint', value: '/login', owner: EVIDENCE.owner }, null],
        // The unproven second entry is a write the tool rejected, so it folds to nothing.
        findings: [
          { title: 'confirmed issue', severity: 'high', reproducibleSteps: ['curl x'], score: 7, ...EVIDENCE },
          { title: 'half-baked lead', severity: 'medium', reproducibleSteps: ['看响应头'] },
          null,
        ],
      },
    } as unknown as SessionEvent)
    expect(submitted.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'fact-1', kind: 'fact', intentId: 'intent-1', detail: 'HTTP 200' }),
      expect.objectContaining({ id: 'finding-1', kind: 'finding', intentId: 'intent-1', title: 'confirmed issue' }),
    ]))
    expect(submitted.nodes.filter(node => node.kind === 'finding')).toHaveLength(1)
    expect(submitted.nodes.at(-1)).toMatchObject({ id: 'finding-1', score: 7, owner: EVIDENCE.owner, impact: EVIDENCE.impact })
    expect(submitted.assets).toEqual([expect.objectContaining({ id: 'asset-1', value: '/login', owner: EVIDENCE.owner })])
    expect(applySrchunterEvent(state, { type: 'srchunter/submit', data: { facts: [] } } as unknown as SessionEvent)).toBe(state)
    expect(applySrchunterEvent(state, {
      type: 'srchunter/submit', data: { intentId: 'intent-1', facts: 'bad', assets: 'bad', findings: 'bad' },
    } as unknown as SessionEvent)).toBe(state)
  })
})

describe('viewSrchunterState / srchunterProjectionSchema', () => {
  it('projects null before the first goal and the standing state afterwards', () => {
    expect(viewSrchunterState(srchunterInitialState)).toBeNull()
    const state = fold(...fullChainEvents())
    const view = viewSrchunterState(state)
    expect(srchunterProjectionSchema.parse(view)).toEqual(view)
    expect(view).toMatchObject({
      goal: { id: 'goal-1', target: 'example.com', destructive: 'limited' },
      counts: { intents: 2, facts: 1, findings: 1, assets: 0 },
    })
    expect(view?.nodes[0]).toMatchObject({ kind: 'intent', status: 'open', disposition: '' })
    expect(view?.nodes.at(-1)).toMatchObject({
      kind: 'finding', owner: EVIDENCE.owner, impact: EVIDENCE.impact,
      rawRequest: EVIDENCE.rawRequest, rawResponse: EVIDENCE.rawResponse,
    })
    expect(srchunterProjectionSchema.parse(null)).toBeNull()
  })

  it('rejects a stale wire payload that dropped the budget, verdict or evidence', () => {
    const view = viewSrchunterState(fold(...fullChainEvents()))
    if (view === null) throw new Error('the full chain must project a standing state')
    expect(() => srchunterProjectionSchema.parse({
      ...view, goal: { id: 'goal-1', target: 't', objective: 'o', authorization: '' },
    })).toThrow()
    expect(() => srchunterProjectionSchema.parse({
      ...view,
      nodes: [{ id: 'intent-1', kind: 'intent', title: 'a', detail: '' }, ...view.nodes.slice(1)],
    })).toThrow()
    expect(() => srchunterProjectionSchema.parse({
      ...view,
      nodes: view.nodes.map(node => node.kind === 'finding' ? { ...node, owner: undefined } : node),
    })).toThrow()
  })
})

describe('srchunter projection registration', () => {
  it('folds real session events into the snapshot through the projection seam', async () => {
    const { ctx, session } = await srchunterProjectionHarness()
    expect(ctx.sessionProjections.snapshot(session).values['srchunter']).toBeNull()
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('goal-1'), name: 'srchunter_add_goal',
      arguments: '{"target":"example.com","objective":"map surface","destructive":"readonly"}',
    })
    session.append('tool/call', {
      turn: 1, step: 2, callId: CallId('intent-1'), name: 'srchunter_add_intent',
      arguments: '{"goalId":"goal-1","title":"enumerate"}',
    })
    session.append('tool/call', {
      turn: 1, step: 3, callId: CallId('fact-1'), name: 'srchunter_add_fact',
      arguments: '{"intentId":"intent-1","kind":"port","detail":"tcp/80 open"}',
    })
    session.append('tool/call', {
      turn: 1, step: 4, callId: CallId('set-intent-1'), name: 'srchunter_set_intent',
      arguments: '{"intentId":"intent-1","status":"deepen","disposition":"遍历 userId 取他人记录"}',
    })
    const standing = ctx.sessionProjections.snapshot(session).values['srchunter']
    expect(standing).toMatchObject({
      goal: { id: 'goal-1', target: 'example.com', objective: 'map surface', authorization: '', destructive: 'readonly' },
      counts: { intents: 1, facts: 1, findings: 0, assets: 0 },
    })
    // The adjudication rewrites the intent the same session already showed.
    expect(standing?.nodes[0]).toMatchObject({ id: 'intent-1', status: 'deepen', disposition: '遍历 userId 取他人记录' })
  })

  it('replays the full parent log in seq order: turn-0 synthetic submissions fold after their anchors', async () => {
    // The projection registry folds the log strictly by seq (append order),
    // not by (turn, step): a delegated submission's synthetic tool/call events
    // carry turn 0 but land AFTER the parent's own turn-1 events, so a full-log
    // refold (replay/refresh) sees the goal and intent before the submission
    // and reproduces the live snapshot exactly.
    const { ctx, session } = await srchunterProjectionHarness()
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('goal-1'), name: 'srchunter_add_goal',
      arguments: '{"target":"example.com","objective":"map surface"}',
    })
    session.append('tool/call', {
      turn: 1, step: 2, callId: CallId('intent-1'), name: 'srchunter_add_intent',
      arguments: '{"goalId":"goal-1","title":"delegate port scan"}',
    })
    session.append('tool/call', {
      turn: 1, step: 3, callId: CallId('set-intent-1'), name: 'srchunter_set_intent',
      arguments: '{"intentId":"intent-1","status":"working"}',
    })
    // The synthetic events a child submission appends: turn 0, steps after the
    // module counter (mirroring appendSubmissionProjection).
    session.append('tool/call', {
      turn: 0, step: 1, callId: CallId('srchunter-submit-1'), name: 'srchunter_add_fact',
      arguments: '{"intentId":"intent-1","kind":"port","target":"example.com","detail":"tcp/443 open","confidence":0.9}',
    })
    session.append('tool/call', {
      turn: 0, step: 2, callId: CallId('srchunter-submit-2'), name: 'srchunter_add_asset',
      arguments: '{"type":"endpoint","value":"/login","meta":"form"}',
    })
    session.append('tool/call', {
      turn: 0, step: 3, callId: CallId('srchunter-submit-3'), name: 'srchunter_add_finding',
      arguments: JSON.stringify({
        intentId: 'intent-1', title: 'unauthenticated student dump', severity: 'critical', score: 9.5,
        reproducibleSteps: ['GET /api/student/list?limit=100'], strictListHit: 'id-number', ...EVIDENCE,
      }),
    })
    const live = ctx.sessionProjections.snapshot(session).values['srchunter']
    expect(live).toMatchObject({
      goal: { id: 'goal-1', target: 'example.com' },
      counts: { intents: 1, facts: 1, findings: 1, assets: 1 },
    })
    expect(live?.nodes.find(node => node.kind === 'intent')).toMatchObject({ status: 'working' })
    expect(live?.nodes.find(node => node.kind === 'finding')).toMatchObject({ score: 9.5, strictListHit: 'id-number' })
    // Full-log refold from init over the same events (the replay a refresh or
    // a cold restore performs): the fold result must equal the live snapshot.
    const replayed = session.events.reduce(applySrchunterEvent, srchunterInitialState)
    expect(viewSrchunterState(replayed)).toEqual(live)
  })
})
