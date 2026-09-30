/**
 * Behavior of the model-facing `srchunter_*` tools over the real store: the
 * exploration chain (goal → intent → fact → derived intent → finding), intent
 * adjudication, the realized-harm gate on both write paths, the asset graph,
 * session scoping, referential validation, deterministic ids, and the
 * non-agent rejection.
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { srchunterDomainSpec } from '../src/spec.ts'
import { srchunterHarness, SESSION_ID } from './harness.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * The evidence the realized-harm gate demands of a proven finding: both write
 * paths reject anything without a verbatim packet (or a runnable PoC), a
 * quantified impact and an attribution, so every finding fixture that is
 * expected to land spreads these fields in.
 */
const EVIDENCE = {
  owner: 'XX大学（依据：ICP 备案主体）',
  impact: '共 120 条学生记录',
  rawRequest: 'GET /search?q=1%27 HTTP/1.1',
  rawResponse: 'HTTP/1.1 500 OK\nYou have an error in your SQL syntax',
}

/** The recorded write results of one full chain. */
interface ChainWrites {
  goal: Record<string, unknown>
  intentA: Record<string, unknown>
  fact: Record<string, unknown>
  intentB: Record<string, unknown>
  finding: Record<string, unknown>
}

/** Drive one full exploration chain and return the recorded write results. */
async function fullChain(
  call: (name: string, args: unknown, sessionId: string) => Promise<unknown>,
): Promise<ChainWrites> {
  const goal = await call('srchunter_add_goal', {
    target: 'example.com', objective: 'map the web surface', authorization: 'CTO signed off',
  }, SESSION_ID) as Record<string, unknown>
  const intentA = await call('srchunter_add_intent', { goalId: goal.id, title: 'enumerate web endpoints', detail: 'scope /api' }, SESSION_ID) as Record<string, unknown>
  const fact = await call('srchunter_add_fact', {
    intentId: intentA.id, kind: 'port', target: 'example.com', detail: 'tcp/80 open', confidence: 0.9,
  }, SESSION_ID) as Record<string, unknown>
  const intentB = await call('srchunter_add_intent', { derivedFromFactId: fact.id, title: 'probe /login flow' }, SESSION_ID) as Record<string, unknown>
  const finding = await call('srchunter_add_finding', {
    intentId: intentB.id, title: 'SQL injection in /search', severity: 'high',
    reproducibleSteps: ['curl -s "http://example.com/search?q=1%27"', 'observe 500 + syntax error leak'],
    description: 'Injectable parameter', vulnType: 'sqli', score: 8,
    ...EVIDENCE,
  }, SESSION_ID) as Record<string, unknown>
  return { goal, intentA, fact, intentB, finding }
}

describe('srchunter_add_goal', () => {
  it('records the goal with a deterministic id and authorization', async () => {
    const { call } = await srchunterHarness()
    const goal = await call('srchunter_add_goal', {
      target: 'example.com', objective: 'map the web surface', authorization: 'CTO signed off',
    }, SESSION_ID) as Record<string, unknown>
    expect(goal).toMatchObject({ id: 'goal-1', target: 'example.com', objective: 'map the web surface' })
    const view = await call('srchunter_state', {}, SESSION_ID) as Record<string, unknown>
    expect(view).toMatchObject({ initialized: true })
    expect(view.goal).toMatchObject({ id: 'goal-1', authorization: 'CTO signed off' })
  })

  it('grants the destructive budget, defaulting an unspecified goal to limited', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    let view = await call('srchunter_state', {}, SESSION_ID) as { goal?: { destructive: string } }
    expect(view.goal).toMatchObject({ destructive: 'limited' })
    await call('srchunter_add_goal', {
      target: 'example.com', objective: 'o', authorization: 'CTO signed off', destructive: 'readonly',
    }, SESSION_ID)
    view = await call('srchunter_state', {}, SESSION_ID) as { goal?: { destructive: string } }
    expect(view.goal).toMatchObject({ destructive: 'readonly' })
  })

  it('migrates legacy keys without overwriting an existing session-scoped record', async () => {
    const { call, facility } = await srchunterHarness()
    const domain = await facility.open(srchunterDomainSpec)
    await domain.table('goals').put(SESSION_ID, {
      id: 'goal-1', sessionId: SESSION_ID, target: 'example.com', objective: 'o', authorization: '',
    })
    await domain.table('intents').put('intent-1', {
      id: 'intent-1', sessionId: SESSION_ID, title: 'legacy', detail: '',
    })
    await domain.table('intents').put(`${SESSION_ID}:intent-1`, {
      id: 'intent-1', sessionId: SESSION_ID, title: 'scoped', detail: '',
    })
    await domain.table('assets').put('asset-1', {
      id: 'asset-1', sessionId: SESSION_ID, type: 'root-domain', value: 'legacy.example', meta: '',
    })
    await domain.close()

    const state = await call('srchunter_state', {}, SESSION_ID) as { intents: Array<{ title: string }>; assets: Array<{ value: string }> }
    expect(state.intents).toEqual([expect.objectContaining({ title: 'scoped' })])
    expect(state.assets).toEqual([expect.objectContaining({ value: 'legacy.example' })])
  })

  it('resets the whole exploration graph when a new goal is recorded', async () => {
    const { call } = await srchunterHarness()
    const { intentA } = await fullChain(call)
    expect(intentA.id).toBe('intent-1')
    await call('srchunter_add_goal', { target: 'other.example', objective: 'fresh' }, SESSION_ID)
    const view = await call('srchunter_state', {}, SESSION_ID) as Record<string, unknown>
    expect(view).toMatchObject({ counts: { intents: 0, facts: 0, findings: 0, assets: 0 } })
    // Counters restart: the first intent of the new engagement is intent-1 again.
    const fresh = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'fresh intent' }, SESSION_ID) as Record<string, unknown>
    expect(fresh.id).toBe('intent-1')
  })
})

describe('srchunter_submit', () => {
  it('lets a delegated child submit a compact result into its parent intent', async () => {
    const { call, callAsChild, ctx } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID) as { id: string }
    await expect(callAsChild('srchunter_submit', {
      intentId: intent.id,
      facts: [{ kind: 'http', target: 'https://example.com/login', detail: 'HTTP 200', confidence: 0.9 }],
      assets: [{ type: 'endpoint', value: '/login', meta: 'form' }],
      findings: [],
    }, SESSION_ID)).resolves.toEqual({ facts: 1, assets: 1, findings: 0 })
    const state = await call('srchunter_state', {}, SESSION_ID) as { facts: Array<{ detail: string }>; assets: Array<{ value: string }> }
    expect(state.facts).toEqual([expect.objectContaining({ detail: 'HTTP 200' })])
    expect(state.assets).toEqual([expect.objectContaining({ value: '/login' })])
    expect(ctx.sessions.get(SESSION_ID)?.events.some(event => event.type === 'srchunter/submit')).toBe(false)
    expect(ctx.sessions.get(SESSION_ID)?.events.some(event =>
      event.type === 'tool/call' && event.data.name === 'srchunter_add_asset',
    )).toBe(true)
  })

  it('rejects a root session without a parent target', async () => {
    const { call } = await srchunterHarness()
    await expect(call('srchunter_submit', { intentId: 'intent-1', facts: [], assets: [], findings: [] }, SESSION_ID))
      .rejects.toThrow(/只有被委派、且带父会话的子 agent 才能调用/)
  })

  it('submits a proven finding with its attribution, impact and raw packets', async () => {
    const { call, callAsChild, ctx } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID) as { id: string }
    await expect(callAsChild('srchunter_submit', {
      intentId: intent.id,
      facts: [],
      assets: [{ type: 'endpoint', value: '/search', owner: EVIDENCE.owner }],
      findings: [{
        title: 'SQL injection in /search', severity: 'high', reproducibleSteps: ['curl -s "http://example.com/search?q=1%27"'],
        vulnType: 'sqli', score: 8, strictListHit: 'id-number', killChain: ['注入 → 报错回显库名'],
        poc: 'curl -s "http://example.com/search?q=1%27" --output dump', ...EVIDENCE,
      }],
    }, SESSION_ID)).resolves.toEqual({ facts: 0, assets: 1, findings: 1 })
    const state = await call('srchunter_state', {}, SESSION_ID) as {
      assets: Array<{ owner: string }>
      findings: Array<Record<string, unknown>>
    }
    expect(state.assets[0]).toMatchObject({ owner: EVIDENCE.owner })
    expect(state.findings[0]).toMatchObject({
      vulnType: 'sqli',
      owner: EVIDENCE.owner,
      impact: EVIDENCE.impact,
      rawRequest: EVIDENCE.rawRequest,
      rawResponse: EVIDENCE.rawResponse,
      score: 8,
      strictListHit: 'id-number',
      publicInterface: false,
      killChain: ['注入 → 报错回显库名'],
    })
    // The parent projection is driven by the same vocabulary the fold knows.
    expect(ctx.sessions.get(SESSION_ID)?.events.some(event =>
      event.type === 'tool/call' && event.data.name === 'srchunter_add_finding',
    )).toBe(true)
  })

  it('names the unproven item of a submission and persists nothing at all', async () => {
    const { call, callAsChild, ctx } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID) as { id: string }
    const message = await callAsChild('srchunter_submit', {
      intentId: intent.id,
      facts: [{ detail: 'HTTP 200' }],
      assets: [{ type: 'endpoint', value: '/login' }],
      findings: [
        { title: 'proven dump', severity: 'high', reproducibleSteps: ['curl x'], ...EVIDENCE },
        { title: 'CORS 宽松', severity: 'medium', reproducibleSteps: ['看响应头'], impact: '或许能跨域读取', owner: EVIDENCE.owner },
      ],
    }, SESSION_ID).then(() => '', (error: Error) => error.message)
    expect(message).toContain('srchunter_submit 的 findings[1] 不是已证实的漏洞')
    expect(message).toContain('rawRequest / rawResponse / poc（至少一份逐字原始报文，或可直接运行的 PoC）')
    const state = await call('srchunter_state', {}, SESSION_ID) as { counts: Record<string, number> }
    expect(state.counts).toEqual({ intents: 1, facts: 0, findings: 0, assets: 0 })
    expect(ctx.sessions.get(SESSION_ID)?.events).toEqual([])
  })

  it('rejects a placeholder parent intent id without writing to the parent graph', async () => {
    const { call, callAsChild } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID)
    await expect(callAsChild('srchunter_submit', {
      intentId: 'delegation-intent-id',
      facts: [{ detail: 'HTTP 200' }],
      assets: [{ type: 'endpoint', value: '/login' }],
      findings: [],
    }, SESSION_ID)).rejects.toThrow(/真实父意图 id.*占位符 "delegation-intent-id"/)
    const state = await call('srchunter_state', {}, SESSION_ID) as { facts: unknown[]; assets: unknown[] }
    expect(state.facts).toEqual([])
    expect(state.assets).toEqual([])
  })

  it('does not persist a child submission when its parent session is not live', async () => {
    const { call, callAsChildWithoutParent } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID) as { id: string }
    await expect(callAsChildWithoutParent('srchunter_submit', {
      intentId: intent.id,
      facts: [{ detail: 'HTTP 200' }],
      assets: [],
      findings: [],
    }, SESSION_ID)).rejects.toThrow(/父会话 session-a 当前不在运行中/)
    const state = await call('srchunter_state', {}, SESSION_ID) as { facts: unknown[] }
    expect(state.facts).toEqual([])
  })

  it('rolls back a mixed submission when any referenced record is invalid', async () => {
    const { call, callAsChild, ctx } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID) as { id: string }
    await expect(callAsChild('srchunter_submit', {
      intentId: intent.id,
      facts: [{ detail: 'HTTP 200' }],
      assets: [{ type: 'endpoint', value: '/login', parentId: 'asset-404' }],
      findings: [],
    }, SESSION_ID)).rejects.toThrow(/未知的 asset asset-404/)
    const state = await call('srchunter_state', {}, SESSION_ID) as { facts: unknown[]; assets: unknown[] }
    expect(state.facts).toEqual([])
    expect(state.assets).toEqual([])
    expect(ctx.sessions.get(SESSION_ID)?.events.some(event =>
      event.type === 'tool/call' && event.data.name === 'srchunter_add_fact',
    )).toBe(false)
  })

  it('normalizes percentage confidence from a delegated child', async () => {
    const { call, callAsChild } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID) as { id: string }
    await callAsChild('srchunter_submit', {
      intentId: intent.id,
      facts: [{ detail: 'HTTP 200', confidence: '90%' }],
      assets: [],
      findings: [],
    }, SESSION_ID)
    const view = await call('srchunter_state', {}, SESSION_ID) as { facts: Array<{ confidence: number }> }
    expect(view.facts[0]?.confidence).toBe(0.9)
  })

  it('validates delegated input and accepts links to an existing asset', async () => {
    const { call, callAsChild } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID) as { id: string }
    const root = await call('srchunter_add_asset', { type: 'root-domain', value: 'example.com' }, SESSION_ID) as { id: string }
    const submit = (facts: unknown, assets: unknown, findings: unknown) => callAsChild('srchunter_submit', { intentId: intent.id, facts, assets, findings }, SESSION_ID)
    await expect(submit('bad', [], [])).rejects.toThrow(/facts.*必须是对象数组/)
    await expect(submit([{}], [], [])).rejects.toThrow(/缺少必填参数 fact\.detail/)
    await expect(submit([{ detail: 'x', kind: 'invalid' }], [], [])).rejects.toThrow(/fact\.kind.*只能取以下值之一/)
    await expect(submit([{ detail: 'x', confidence: -1 }], [], [])).rejects.toThrow(/confidence 必须是/)
    await expect(submit([{ detail: 'x', confidence: 101 }], [], [])).rejects.toThrow(/confidence 必须是/)
    await expect(submit([], [], [{ title: 'x', reproducibleSteps: [], ...EVIDENCE }])).rejects.toThrow(/reproducibleSteps 必须是非空字符串数组/)
    await expect(submit([{ detail: 'linked fact' }], [{ type: 'endpoint', value: '/login', parentId: root.id }], [{ title: 'linked finding', reproducibleSteps: ['curl x'], affectedAssetId: root.id, ...EVIDENCE }]))
      .resolves.toEqual({ facts: 1, assets: 1, findings: 1 })
  })
})

describe('srchunter_add_intent', () => {
  it('rejects writes before srchunter_add_goal', async () => {
    const { call } = await srchunterHarness()
    await expect(call('srchunter_add_intent', { goalId: 'goal-1', title: 'x' }, SESSION_ID))
      .rejects.toThrow(/尚未初始化/)
  })

  it('requires exactly one anchor', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    await expect(call('srchunter_add_intent', { title: 'x' }, SESSION_ID))
      .rejects.toThrow(/必须且只能指定一个锚点/)
    await expect(call('srchunter_add_intent', { title: 'x', goalId: 'goal-1', derivedFromFactId: 'fact-1' }, SESSION_ID))
      .rejects.toThrow(/必须且只能指定一个锚点/)
  })

  it('rejects an unknown goal anchor without changing the graph', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    await expect(call('srchunter_add_intent', { goalId: 'goal-9', title: 'x' }, SESSION_ID))
      .rejects.toThrow(/未知的 goal goal-9/)
    const state = await call('srchunter_state', {}, SESSION_ID) as { counts: unknown }
    expect(state.counts).toEqual({ intents: 0, facts: 0, findings: 0, assets: 0 })
  })

  it('records a spawns intent under the goal', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const write = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'enumerate', detail: 'scope: /api' }, SESSION_ID) as Record<string, unknown>
    expect(write).toMatchObject({ id: 'intent-1', edgeId: 'edge-1', edgeKind: 'spawns', sourceId: 'goal-1' })
    // A fresh intent is never adjudicated: only srchunter_set_intent disposes it.
    const state = await call('srchunter_state', {}, SESSION_ID) as { intents: Array<Record<string, unknown>> }
    expect(state.intents[0]).toMatchObject({ title: 'enumerate', detail: 'scope: /api', status: 'open', disposition: '' })
  })

  it('records a derived_from intent under a fact and rejects unknown anchors', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    const fact = await call('srchunter_add_fact', { intentId: intent.id, detail: 'tcp/80 open' }, SESSION_ID) as Record<string, unknown>
    const derived = await call('srchunter_add_intent', { derivedFromFactId: fact.id, title: 'b' }, SESSION_ID) as Record<string, unknown>
    expect(derived).toMatchObject({ id: 'intent-2', edgeKind: 'derived_from', sourceId: fact.id })
    await expect(call('srchunter_add_intent', { derivedFromFactId: 'fact-99', title: 'c' }, SESSION_ID))
      .rejects.toThrow(/未知的 fact fact-99/)
    // IDs restart for each session. Use a second foreign fact so its bare id
    // cannot resolve to the current session's valid fact-1.
    await call('srchunter_add_goal', { target: 'other', objective: 'o' }, 'session-b')
    const foreignIntent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'b' }, 'session-b') as Record<string, unknown>
    await call('srchunter_add_fact', { intentId: foreignIntent.id, detail: 'first' }, 'session-b')
    const foreignFact = await call('srchunter_add_fact', { intentId: foreignIntent.id, detail: 'second' }, 'session-b') as Record<string, unknown>
    await expect(call('srchunter_add_intent', { derivedFromFactId: foreignFact.id, title: 'c' }, SESSION_ID))
      .rejects.toThrow(/未知的 fact fact-2/)
  })
})

describe('srchunter_set_intent', () => {
  it('adjudicates one intent in place without minting a node or an edge', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', {
      goalId: 'goal-1', title: 'verify the injection', detail: 'scope /search',
    }, SESSION_ID) as { id: string }
    const write = await call('srchunter_set_intent', {
      intentId: intent.id, status: 'deepen', disposition: '用 --technique=E 拖出 10 行学生记录并贴响应',
    }, SESSION_ID) as Record<string, unknown>
    expect(write).toEqual({
      id: 'intent-1', status: 'deepen', disposition: '用 --technique=E 拖出 10 行学生记录并贴响应',
    })
    const state = await call('srchunter_state', {}, SESSION_ID) as {
      intents: Array<Record<string, unknown>>
      edges: unknown[]
      counts: Record<string, number>
    }
    expect(state.intents).toEqual([expect.objectContaining({
      id: 'intent-1', title: 'verify the injection', detail: 'scope /search',
      status: 'deepen', disposition: '用 --technique=E 拖出 10 行学生记录并贴响应',
    })])
    expect(state.counts).toEqual({ intents: 1, facts: 0, findings: 0, assets: 0 })
    expect(state.edges).toHaveLength(1)
  })

  it('adjudicates working and done with no disposition at all', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID)
    await expect(call('srchunter_set_intent', { intentId: 'intent-1', status: 'working' }, SESSION_ID))
      .resolves.toEqual({ id: 'intent-1', status: 'working', disposition: '' })
    await expect(call('srchunter_set_intent', { intentId: 'intent-1', status: 'done', disposition: '已落 finding-1' }, SESSION_ID))
      .resolves.toEqual({ id: 'intent-1', status: 'done', disposition: '已落 finding-1' })
    await expect(call('srchunter_set_intent', { intentId: 'intent-1', status: 'done' }, SESSION_ID))
      .resolves.toEqual({ id: 'intent-1', status: 'done', disposition: '' })
  })

  it('refuses a directive-less deepen, blocked or dead_end adjudication', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID)
    for (const status of ['deepen', 'blocked', 'dead_end'] as const) {
      await expect(call('srchunter_set_intent', { intentId: 'intent-1', status }, SESSION_ID))
        .rejects.toThrow(`srchunter_set_intent 在状态为 '${status}' 时必须给出具体 disposition`)
      await expect(call('srchunter_set_intent', { intentId: 'intent-1', status, disposition: '   ' }, SESSION_ID))
        .rejects.toThrow(/必须给出具体 disposition/)
    }
    const state = await call('srchunter_state', {}, SESSION_ID) as { intents: Array<Record<string, unknown>> }
    expect(state.intents[0]).toMatchObject({ status: 'open', disposition: '' })
  })

  it('rejects an unknown intent, including one owned by another session', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    await expect(call('srchunter_set_intent', { intentId: 'intent-99', status: 'done' }, SESSION_ID))
      .rejects.toThrow(/未知的 intent intent-99/)
    await call('srchunter_add_goal', { target: 'other', objective: 'o' }, 'session-b')
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'foreign' }, 'session-b')
    await expect(call('srchunter_set_intent', { intentId: 'intent-1', status: 'done' }, SESSION_ID))
      .rejects.toThrow(/未知的 intent intent-1/)
  })

  it('stays a decision-agent tool: neither a child nor an agentless caller may adjudicate', async () => {
    const { call, callAsChild, callWithoutAgent } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID) as { id: string }
    // A child adjudicates its own (goal-less) session, never the parent graph.
    await expect(callAsChild('srchunter_set_intent', { intentId: intent.id, status: 'done' }, SESSION_ID))
      .rejects.toThrow(/尚未初始化/)
    await expect(callWithoutAgent('srchunter_set_intent', { intentId: 'intent-1', status: 'done' }))
      .rejects.toThrow(/必须由拥有会话的 agent 调用/)
    const state = await call('srchunter_state', {}, SESSION_ID) as { intents: Array<Record<string, unknown>> }
    expect(state.intents[0]).toMatchObject({ status: 'open', disposition: '' })
  })
})

describe('concurrent graph writes', () => {
  it('allocates unique ids for concurrent facts in one session', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe' }, SESSION_ID) as { id: string }
    const writes = await Promise.all([
      call('srchunter_add_fact', { intentId: intent.id, detail: 'first' }, SESSION_ID),
      call('srchunter_add_fact', { intentId: intent.id, detail: 'second' }, SESSION_ID),
    ]) as Array<{ id: string }>
    expect(writes.map(write => write.id).sort()).toEqual(['fact-1', 'fact-2'])
    const state = await call('srchunter_state', {}, SESSION_ID) as { facts: Array<{ id: string }> }
    expect(state.facts.map(fact => fact.id)).toEqual(['fact-1', 'fact-2'])
  })
})

describe('srchunter_add_fact', () => {
  it('records a fact yielded by an intent with defaults and explicit values', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    const fact = await call('srchunter_add_fact', {
      intentId: intent.id, kind: 'vuln', target: 'example.com/login', detail: 'weak token', confidence: 0.9,
    }, SESSION_ID) as Record<string, unknown>
    expect(fact).toMatchObject({ id: 'fact-1', kind: 'vuln', detail: 'weak token', edgeId: 'edge-2' })
    await call('srchunter_add_fact', { intentId: intent.id, detail: 'robots.txt present' }, SESSION_ID)
    const view = await call('srchunter_state', {}, SESSION_ID) as Record<string, unknown>
    expect(view.counts).toMatchObject({ facts: 2 })
    const facts = (view.facts as Array<Record<string, unknown>>).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    expect(facts[0]).toMatchObject({ kind: 'vuln', target: 'example.com/login', confidence: 0.9 })
    expect(facts[1]).toMatchObject({ kind: 'info', target: '', confidence: 0.5 })
  })

  it('rejects unknown intent references, including ids from another session', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    await expect(call('srchunter_add_fact', { intentId: 'intent-99', detail: 'x' }, SESSION_ID))
      .rejects.toThrow(/未知的 intent intent-99/)
    await call('srchunter_add_goal', { target: 'other', objective: 'o' }, 'session-b')
    const foreign = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'b' }, 'session-b') as Record<string, unknown>
    await expect(call('srchunter_add_fact', { intentId: foreign.id, detail: 'x' }, SESSION_ID))
      .rejects.toThrow(/未知的 intent intent-1/)
  })

})

describe('srchunter_add_finding', () => {
  it('records a finding with reproducible steps proved by an intent', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe login' }, SESSION_ID) as Record<string, unknown>
    const finding = await call('srchunter_add_finding', {
      intentId: intent.id, title: 'SQL injection in /search', severity: 'high',
      reproducibleSteps: ['curl -s "http://example.com/search?q=1%27"', 'observe 500'],
      description: 'Injectable parameter',
      ...EVIDENCE,
    }, SESSION_ID) as Record<string, unknown>
    expect(finding).toMatchObject({ id: 'finding-1', title: 'SQL injection in /search', severity: 'high', edgeId: 'edge-2' })
    const view = await call('srchunter_state', {}, SESSION_ID) as Record<string, unknown>
    expect(view.counts).toMatchObject({ findings: 1 })
    expect((view.findings as Array<Record<string, unknown>>)[0]).toMatchObject({
      title: 'SQL injection in /search',
      reproducibleSteps: ['curl -s "http://example.com/search?q=1%27"', 'observe 500'],
      owner: EVIDENCE.owner,
      impact: EVIDENCE.impact,
      rawRequest: EVIDENCE.rawRequest,
      rawResponse: EVIDENCE.rawResponse,
      // Whatever the model does not report lands as an empty/none default.
      vulnType: '', poc: '', killChain: [], score: 0, strictListHit: 'none', publicInterface: false,
    })
  })

  it('persists the reported class, kill chain, score and strict-list hit', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.edu.cn', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    await call('srchunter_add_finding', {
      intentId: intent.id, title: '未授权接口 dump 学生身份证号', severity: 'critical', score: 9.5,
      reproducibleSteps: ['GET /api/student/list?limit=100'],
      vulnType: 'unauthorized_access', strictListHit: 'id-number',
      poc: 'curl -s "https://jwxx.example.edu.cn/api/student/list?limit=1"',
      killChain: ['审计前端 JS → 发现未挂鉴权的接口', '匿名请求 → 返回他人身份证号'],
      ...EVIDENCE,
    }, SESSION_ID)
    const dump = await call('srchunter_graph', {}, SESSION_ID) as {
      graph: { findings: Array<Record<string, unknown>> }
    }
    expect(dump.graph.findings[0]).toMatchObject({
      vulnType: 'unauthorized_access',
      score: 9.5,
      strictListHit: 'id-number',
      poc: 'curl -s "https://jwxx.example.edu.cn/api/student/list?limit=1"',
      killChain: ['审计前端 JS → 发现未挂鉴权的接口', '匿名请求 → 返回他人身份证号'],
    })
  })

  it('keeps an oversized evidence packet whole in the durable record', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    // The wire projection clamps packets at 20k; storage and the report do not.
    const longPacket = `HTTP/1.1 200 OK\n${'A'.repeat(30_000)}`
    await call('srchunter_add_finding', {
      intentId: intent.id, title: 'bulk export without auth', severity: 'high', score: 7,
      reproducibleSteps: ['GET /api/export'], rawResponse: longPacket,
      owner: EVIDENCE.owner, impact: EVIDENCE.impact,
    }, SESSION_ID)
    const view = await call('srchunter_state', {}, SESSION_ID) as { findings: Array<{ rawResponse: string }> }
    expect(view.findings[0]!.rawResponse).toBe(longPacket)
    const report = await call('srchunter_report', {}, SESSION_ID) as { markdown: string }
    expect(report.markdown).toContain(longPacket)
  })

  it('links an affected asset and rejects unknown asset ids', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    const asset = await call('srchunter_add_asset', { type: 'endpoint', value: '/search' }, SESSION_ID) as Record<string, unknown>
    const finding = await call('srchunter_add_finding', {
      intentId: intent.id, title: 'sqli', severity: 'high', reproducibleSteps: ['curl x'], affectedAssetId: asset.id,
      ...EVIDENCE,
    }, SESSION_ID) as Record<string, unknown>
    expect(finding.id).toBe('finding-1')
    await expect(call('srchunter_add_finding', {
      intentId: intent.id, title: 'x', severity: 'low', reproducibleSteps: ['curl x'], affectedAssetId: 'asset-99',
      ...EVIDENCE,
    }, SESSION_ID)).rejects.toThrow(/未知的 asset asset-99/)
    await call('srchunter_add_goal', { target: 'other', objective: 'o' }, 'session-b')
    await call('srchunter_add_asset', { type: 'ip', value: '10.0.0.1' }, 'session-b')
    const foreignAsset = await call('srchunter_add_asset', { type: 'ip', value: '10.0.0.2' }, 'session-b') as Record<string, unknown>
    await expect(call('srchunter_add_finding', {
      intentId: intent.id, title: 'x', severity: 'low', reproducibleSteps: ['curl x'], affectedAssetId: foreignAsset.id,
      ...EVIDENCE,
    }, SESSION_ID)).rejects.toThrow(/未知的 asset asset-2/)
  })

  it('rejects findings without reproducible steps', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    await expect(call('srchunter_add_finding', {
      intentId: intent.id, title: 'no steps', severity: 'info', reproducibleSteps: [], ...EVIDENCE,
    }, SESSION_ID)).rejects.toThrow(/reproducibleSteps 必须是非空字符串数组/)
    // The rejected write must not have landed a finding.
    const view = await call('srchunter_state', {}, SESSION_ID) as Record<string, unknown>
    expect(view.counts).toMatchObject({ findings: 0 })
  })
})

describe('realized-harm gate', () => {
  /** Try one decision-agent finding write and return its rejection text. */
  async function rejection(
    call: (name: string, args: unknown, sessionId: string) => Promise<unknown>,
    intentId: string,
    fields: Record<string, unknown>,
  ): Promise<string> {
    return await call('srchunter_add_finding', {
      intentId, title: '疑似未授权', severity: 'high', reproducibleSteps: ['curl 一次返回 200'], ...fields,
    }, SESSION_ID).then(() => '', (error: Error) => error.message)
  }

  it('rejects a half-baked finding and lists every gap it has to close', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as { id: string }
    const message = await rejection(call, intent.id, {})
    expect(message).toContain('srchunter_add_finding 的 finding 不是已证实的漏洞')
    expect(message).toContain('rawRequest / rawResponse / poc（至少一份逐字原始报文，或可直接运行的 PoC）')
    expect(message).toContain('impact（量化危害面：多少条记录、多少用户、哪些系统）')
    expect(message).toContain('owner（归属单位')
    expect(message).toContain('Record it as a fact and set the intent to deepen')
    const view = await call('srchunter_state', {}, SESSION_ID) as { counts: Record<string, number> }
    expect(view.counts).toMatchObject({ findings: 0 })
  })

  it('rejects an attributed finding that carries no packet and names only that gap', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as { id: string }
    const message = await rejection(call, intent.id, { owner: EVIDENCE.owner, impact: EVIDENCE.impact })
    expect(message).toContain('rawRequest / rawResponse / poc')
    expect(message).not.toContain('impact（量化危害面')
    expect(message).not.toContain('owner（归属单位')
  })

  it('rejects a finding with no quantified impact', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as { id: string }
    const message = await rejection(call, intent.id, { owner: EVIDENCE.owner, rawRequest: EVIDENCE.rawRequest })
    expect(message).toContain('impact（量化危害面：多少条记录、多少用户、哪些系统）')
  })

  it('rejects a finding with no owner attribution', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as { id: string }
    const message = await rejection(call, intent.id, { impact: EVIDENCE.impact, poc: 'curl -s http://example.com/search?q=1%27' })
    expect(message).toContain('owner（归属单位')
  })

  it('counts a whitespace-only packet, impact or owner as no evidence at all', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as { id: string }
    const message = await rejection(call, intent.id, { owner: '   ', impact: ' \n', rawRequest: ' ', rawResponse: '\t', poc: '' })
    expect(message).toContain('rawRequest / rawResponse / poc')
    expect(message).toContain('impact（量化危害面')
    expect(message).toContain('owner（归属单位')
  })

  it('rejects a finding self-reported as a public display interface', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as { id: string }
    const message = await rejection(call, intent.id, { ...EVIDENCE, publicInterface: true })
    expect(message).toContain('publicInterface 为 true：匿名可访问的展示型接口不算漏洞')
    const view = await call('srchunter_state', {}, SESSION_ID) as { counts: Record<string, number> }
    expect(view.counts).toMatchObject({ findings: 0 })
  })

  it('accepts a finding proven by a runnable PoC alone', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as { id: string }
    await expect(call('srchunter_add_finding', {
      intentId: intent.id, title: 'command injection in export', severity: 'high', score: 8,
      reproducibleSteps: ['run the PoC'], poc: 'curl -s -d "id=;sleep 5" http://example.com/export',
      owner: EVIDENCE.owner, impact: EVIDENCE.impact,
    }, SESSION_ID)).resolves.toMatchObject({ id: 'finding-1' })
  })
})

describe('srchunter_add_asset', () => {
  it('records a root asset without an edge and a parented asset with a parent edge', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const root = await call('srchunter_add_asset', {
      type: 'root-domain', value: 'example.com', meta: 'scope', owner: EVIDENCE.owner,
    }, SESSION_ID) as Record<string, unknown>
    expect(root).toMatchObject({ id: 'asset-1', type: 'root-domain', value: 'example.com' })
    expect(root.edgeId).toBeUndefined()
    const sub = await call('srchunter_add_asset', { type: 'subdomain', value: 'api.example.com', parentId: root.id }, SESSION_ID) as Record<string, unknown>
    expect(sub).toMatchObject({ id: 'asset-2', edgeId: 'edge-1' })
    const graph = await call('srchunter_graph', {}, SESSION_ID) as Record<string, unknown>
    expect((graph.graph as Record<string, unknown>).edges).toEqual([
      { id: 'edge-1', sessionId: SESSION_ID, kind: 'parent', sourceId: 'asset-1', targetId: 'asset-2' },
    ])
    // Attribution rides on the asset row; an unattributed one stays empty.
    const assets = (graph.graph as { assets: Array<Record<string, unknown>> }).assets
    expect(assets[0]).toMatchObject({ owner: EVIDENCE.owner })
    expect(assets[1]).toMatchObject({ owner: '' })
  })

  it('rejects unknown parent references, including ids from another session', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    await expect(call('srchunter_add_asset', { type: 'ip', value: '10.0.0.1', parentId: 'asset-99' }, SESSION_ID))
      .rejects.toThrow(/未知的 asset asset-99/)
    await call('srchunter_add_goal', { target: 'other', objective: 'o' }, 'session-b')
    const foreign = await call('srchunter_add_asset', { type: 'ip', value: '10.0.0.2' }, 'session-b') as Record<string, unknown>
    await expect(call('srchunter_add_asset', { type: 'ip', value: '10.0.0.3', parentId: foreign.id }, SESSION_ID))
      .rejects.toThrow(/未知的 asset asset-1/)
  })

  it('accepts an empty-string parentId as a root asset', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const root = await call('srchunter_add_asset', {
      type: 'root-domain', value: 'example.com', parentId: '',
    }, SESSION_ID) as Record<string, unknown>
    expect(root).toMatchObject({ id: 'asset-1', type: 'root-domain', value: 'example.com' })
    expect(root.edgeId).toBeUndefined()
    const graph = await call('srchunter_graph', {}, SESSION_ID) as Record<string, unknown>
    expect((graph.graph as Record<string, unknown>).edges).toEqual([])
  })
})

describe('srchunter_state', () => {
  it('reports an uninitialized session without throwing', async () => {
    const { call } = await srchunterHarness()
    await expect(call('srchunter_state', {}, SESSION_ID)).resolves.toMatchObject({
      initialized: false, counts: { intents: 0, facts: 0, findings: 0, assets: 0 },
    })
  })

  it('declares every field returned by the state view', async () => {
    const { ctx, call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const tool = ctx.tools.get('srchunter_state') as unknown as {
      output: { schema: { properties: Record<string, unknown> } }
    }
    expect(Object.keys(tool.output.schema.properties)).toEqual(expect.arrayContaining([
      'initialized', 'goal', 'counts', 'intents', 'facts', 'findings', 'assets', 'edges',
    ]))
  })

  it('shows the destructive budget, the adjudicated intents and the scored findings', async () => {
    const { call, render } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.edu.cn', objective: '挖透 Web 攻击面', destructive: 'readonly' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'verify sqli' }, SESSION_ID) as { id: string }
    await call('srchunter_set_intent', { intentId: intent.id, status: 'deepen', disposition: 'dump 10 rows with --technique=E' }, SESSION_ID)
    await call('srchunter_add_finding', {
      intentId: intent.id, title: 'SQL injection in /search', severity: 'critical', score: 9.5,
      reproducibleSteps: ['curl x'], ...EVIDENCE,
    }, SESSION_ID)
    const state = await call('srchunter_state', {}, SESSION_ID) as Record<string, unknown>
    expect(state.counts).toEqual({ intents: 1, facts: 0, findings: 1, assets: 0 })
    const line = (render('srchunter_state', {}, state) as Array<{ text: string }>)[0]!.text
    expect(line).toContain('目标：example.edu.cn | 目的：挖透 Web 攻击面 | 破坏性档位：readonly | 意图 1 条、事实 0 条、漏洞 1 条、资产 0 项。')
    expect(line).toContain('intent-1「verify sqli」[deepen：dump 10 rows with --technique=E]')
    expect(line).toContain('finding-1 [critical/9.5] SQL injection in /search')
  })

  it('keeps sessions isolated: a fresh session sees none of another session\'s records', async () => {
    const { call } = await srchunterHarness()
    await fullChain(call)
    await expect(call('srchunter_state', {}, 'session-b')).resolves.toMatchObject({ initialized: false })
    // A subagent session cannot write records before its own goal either.
    await expect(call('srchunter_add_fact', { intentId: 'intent-1', detail: 'x' }, 'session-b'))
      .rejects.toThrow(/尚未初始化/)
  })

  it('keeps same-named records from separate sessions under distinct storage keys', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'one.example', objective: 'one' }, SESSION_ID)
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'first' }, SESSION_ID)
    await call('srchunter_add_goal', { target: 'two.example', objective: 'two' }, 'session-b')
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'second' }, 'session-b')
    const first = await call('srchunter_state', {}, SESSION_ID) as { goal?: { target: string }; intents: Array<{ title: string }> }
    const second = await call('srchunter_state', {}, 'session-b') as { goal?: { target: string }; intents: Array<{ title: string }> }
    expect(first).toMatchObject({ goal: { target: 'one.example' }, intents: [{ title: 'first' }] })
    expect(second).toMatchObject({ goal: { target: 'two.example' }, intents: [{ title: 'second' }] })
  })
})

describe('srchunter_graph and srchunter_report', () => {
  it('dumps the full exploration graph', async () => {
    const { call } = await srchunterHarness()
    const { goal, intentA, intentB, fact, finding } = await fullChain(call)
    const dump = await call('srchunter_graph', {}, SESSION_ID) as Record<string, unknown>
    const graph = dump.graph as Record<string, unknown>
    expect(graph.goal).toMatchObject({ id: 'goal-1', target: 'example.com', destructive: 'limited' })
    expect(graph.intents).toHaveLength(2)
    expect(graph.facts).toHaveLength(1)
    expect(graph.findings).toHaveLength(1)
    expect(graph.edges).toEqual([
      { id: 'edge-1', sessionId: SESSION_ID, kind: 'spawns', sourceId: goal.id, targetId: intentA.id },
      { id: 'edge-2', sessionId: SESSION_ID, kind: 'yields', sourceId: intentA.id, targetId: fact.id },
      { id: 'edge-3', sessionId: SESSION_ID, kind: 'derived_from', sourceId: fact.id, targetId: intentB.id },
      { id: 'edge-4', sessionId: SESSION_ID, kind: 'proves', sourceId: intentB.id, targetId: finding.id },
    ])
  })

  it('dumps a null goal for an uninitialized session', async () => {
    const { call } = await srchunterHarness()
    const dump = await call('srchunter_graph', {}, SESSION_ID) as Record<string, unknown>
    expect((dump.graph as Record<string, unknown>).goal).toBeNull()
  })

  it('builds a report with the chain, finding evidence, and assets', async () => {
    const { call } = await srchunterHarness()
    const { intentA } = await fullChain(call)
    await call('srchunter_add_fact', { intentId: intentA.id, detail: 'robots.txt present' }, SESSION_ID)
    await call('srchunter_add_asset', { type: 'root-domain', value: 'example.com', meta: 'scope', owner: EVIDENCE.owner }, SESSION_ID)
    await call('srchunter_add_asset', { type: 'endpoint', value: '/search', parentId: 'asset-1' }, SESSION_ID)
    const report = await call('srchunter_report', {}, SESSION_ID) as Record<string, unknown>
    const markdown = report.markdown as string
    expect(markdown).toContain('- 授权 (authorization): CTO signed off')
    expect(markdown).toContain('- 破坏性档位 (destructive): limited')
    expect(markdown).toContain('## 漏洞发现（按危害排序）')
    expect(markdown).toContain('目标 (goal goal-1)「example.com」')
    expect(markdown).toContain('意图 (intent intent-1)「enumerate web endpoints」(spawns goal-1) [待委派] scope /api')
    expect(markdown).toContain('事实 (fact fact-1) [port] example.com: tcp/80 open (yields intent-1)')
    expect(markdown).toContain('事实 (fact fact-2) [info] robots.txt present (yields intent-1)')
    expect(markdown).toContain('漏洞 (finding finding-1) [high/8] SQL injection in /search (proves intent-2)')
    expect(markdown).toContain('### finding-1 [high / 8] SQL injection in /search')
    expect(markdown).toContain('- 类型: sqli')
    expect(markdown).toContain(`- 归属单位: ${EVIDENCE.owner}`)
    expect(markdown).toContain(`- 危害量化: ${EVIDENCE.impact}`)
    expect(markdown).toContain('- 影响资产: （未关联）')
    expect(markdown).toContain('- 死规矩自检: 敏感数据类别 none；公开接口 否')
    // Nothing recorded a chain for, so the section says so instead of guessing.
    expect(markdown).toContain('- 攻击链路: （未记录）')
    expect(markdown).toContain('1. curl -s "http://example.com/search?q=1%27"')
    expect(markdown).toContain('2. observe 500 + syntax error leak')
    // The verbatim packets land fenced; an unreported PoC is not printed at all.
    expect(markdown).toContain(`- 原始请求包:\n\n\`\`\`\n${EVIDENCE.rawRequest}\n\`\``)
    expect(markdown).toContain(EVIDENCE.rawResponse)
    expect(markdown).not.toContain('- PoC:')
    expect(markdown).toContain(`- [root-domain] example.com（scope） — 归属: ${EVIDENCE.owner}`)
    expect(markdown).toContain('- [endpoint] /search ← example.com')
  })

  it('orders findings by harm and hands off intents by their disposition', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.edu.cn', objective: 'o', destructive: 'limited' }, SESSION_ID)
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'dig the injection' }, SESSION_ID)
    await call('srchunter_set_intent', { intentId: 'intent-1', status: 'deepen', disposition: '用 --technique=E 拖出 10 行学生记录' }, SESSION_ID)
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'register a student account' }, SESSION_ID)
    await call('srchunter_set_intent', { intentId: 'intent-2', status: 'blocked', disposition: '需要注册短信验证码' }, SESSION_ID)
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'guess the admin password' }, SESSION_ID)
    await call('srchunter_set_intent', { intentId: 'intent-3', status: 'dead_end', disposition: '锁定策略生效，十次尝试全部 401' }, SESSION_ID)
    await call('srchunter_add_finding', {
      intentId: 'intent-1', title: 'shallow but noisy read', severity: 'high', score: 6,
      reproducibleSteps: ['curl y'], ...EVIDENCE,
    }, SESSION_ID)
    await call('srchunter_add_finding', {
      intentId: 'intent-1', title: 'massive dump of id numbers', severity: 'medium', score: 9,
      reproducibleSteps: ['GET /api/student/list?limit=100'], strictListHit: 'id-number',
      killChain: ['审计前端 JS → 发现未挂鉴权的接口', '匿名请求 → 返回他人身份证号'],
      ...EVIDENCE,
    }, SESSION_ID)
    const report = await call('srchunter_report', {}, SESSION_ID) as { markdown: string }
    const markdown = report.markdown
    // A medium that took 120 id numbers is submitted before a high with a
    // shallower read: the list is ordered by realized harm, not by the label.
    expect(markdown).toContain('### finding-2 [medium / 9] massive dump of id numbers')
    expect(markdown).toContain('### finding-1 [high / 6] shallow but noisy read')
    expect(markdown.indexOf('### finding-2 [medium / 9] massive dump of id numbers'))
      .toBeLessThan(markdown.indexOf('### finding-1 [high / 6] shallow but noisy read'))
    expect(markdown).toContain('- 死规矩自检: 敏感数据类别 id-number；公开接口 否')
    expect(markdown).toContain('- 攻击链路:\n  1. 审计前端 JS → 发现未挂鉴权的接口\n  2. 匿名请求 → 返回他人身份证号')
    expect(markdown).toContain('- 规模: 2 个已证实漏洞，0 条事实，0 项资产，0 个意图尚未收口')
    expect(markdown).toContain('## 交棒清单')
    expect(markdown).toContain('### 待深挖\n- intent intent-1「dig the injection」：用 --technique=E 拖出 10 行学生记录')
    expect(markdown).toContain('### 需人介入\n- intent intent-2「register a student account」：需要注册短信验证码')
    expect(markdown).toContain('### 已否证\n- intent intent-3「guess the admin password」：锁定策略生效，十次尝试全部 401')
    expect(markdown.indexOf('### 待深挖')).toBeLessThan(markdown.indexOf('### 需人介入'))
    expect(markdown.indexOf('### 需人介入')).toBeLessThan(markdown.indexOf('### 已否证'))
    // The chain dump reads the same verdicts the handoff list groups.
    expect(markdown).toContain('意图 (intent intent-1)「dig the injection」(spawns goal-1) [待深挖] → 用 --technique=E 拖出 10 行学生记录')
  })

  it('builds a report for a goal-only engagement and for a linked finding', async () => {
    const { call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    const goalOnly = await call('srchunter_report', {}, SESSION_ID) as Record<string, unknown>
    expect(goalOnly.markdown).toContain('（仅目标，尚未展开）')
    expect(goalOnly.markdown).toContain('## 漏洞发现（按危害排序）\n（无已证实漏洞：结论为未发现可提交的实锤危害，或相关线索仍在待深挖清单中）')
    expect(goalOnly.markdown).toContain('## 交棒清单\n（无待深挖、需人介入或已否证的意图）')
    await call('srchunter_add_asset', { type: 'root-domain', value: 'example.com' }, SESSION_ID)
    const intent = await call('srchunter_add_intent', { goalId: 'goal-1', title: 'a' }, SESSION_ID) as Record<string, unknown>
    await call('srchunter_add_finding', {
      intentId: intent.id, title: 'n', severity: 'critical', reproducibleSteps: ['curl x'], affectedAssetId: 'asset-1',
      poc: 'curl -s "http://example.com/leak"', ...EVIDENCE,
    }, SESSION_ID)
    const linked = await call('srchunter_report', {}, SESSION_ID) as Record<string, unknown>
    expect(linked.markdown).toContain('- 影响资产: [root-domain] example.com')
    expect(linked.markdown).toContain('- 类型: （未分类）')
    expect(linked.markdown).toContain('- 描述: （无）')
    expect(linked.markdown).toContain('- PoC:\n\n```\ncurl -s "http://example.com/leak"\n```')
  })

  it('reports an uninitialized session', async () => {
    const { call } = await srchunterHarness()
    const report = await call('srchunter_report', {}, SESSION_ID) as Record<string, unknown>
    expect(report.markdown).toContain('未初始化')
  })
})

describe('caller authority', () => {
  it('rejects tool calls without an owning agent session', async () => {
    const { callWithoutAgent } = await srchunterHarness()
    await expect(callWithoutAgent('srchunter_add_goal', { target: 't', objective: 'o' }))
      .rejects.toThrow(/必须由拥有会话的 agent 调用/)
  })
})

describe('tool renders', () => {
  it('renders each write tool result as model-visible text carrying the ids', async () => {
    const { render } = await srchunterHarness()
    expect(render('srchunter_add_goal', {}, { id: 'goal-1', target: 'example.com', objective: 'o' })).toEqual(
      [{ type: 'text', text: '已记录目标 goal-1 → example.com。' }],
    )
    expect(render('srchunter_add_intent', {}, {
      id: 'intent-1', title: 'enumerate', edgeId: 'edge-1', edgeKind: 'spawns', sourceId: 'goal-1',
    })).toEqual(
      [{ type: 'text', text: '已记录意图 intent-1「enumerate」（spawns goal-1 → intent-1，边 edge-1）。' }],
    )
    expect(render('srchunter_add_fact', {}, { id: 'fact-1', kind: 'port', detail: 'tcp/80 open', edgeId: 'edge-2' })).toEqual(
      [{ type: 'text', text: '已记录事实 fact-1 [port] tcp/80 open（边 edge-2）。' }],
    )
    expect(render('srchunter_set_intent', {}, {
      id: 'intent-1', status: 'deepen', disposition: '遍历 userId 取他人身份证号',
    })).toEqual(
      [{ type: 'text', text: '已裁决意图 intent-1 → deepen：遍历 userId 取他人身份证号' }],
    )
    expect(render('srchunter_set_intent', {}, { id: 'intent-2', status: 'done', disposition: '' })).toEqual(
      [{ type: 'text', text: '已裁决意图 intent-2 → done' }],
    )
    expect(render('srchunter_add_finding', {}, {
      id: 'finding-1', title: 'sqli', severity: 'high', edgeId: 'edge-4',
    })).toEqual(
      [{ type: 'text', text: '已记录漏洞 finding-1 [high] sqli（边 edge-4）。' }],
    )
    expect(render('srchunter_add_asset', {}, { id: 'asset-1', type: 'root-domain', value: 'example.com' })).toEqual(
      [{ type: 'text', text: '已记录资产 asset-1 [root-domain] example.com。' }],
    )
    expect(render('srchunter_add_asset', {}, { id: 'asset-2', type: 'ip', value: '10.0.0.1', edgeId: 'edge-2' })).toEqual(
      [{ type: 'text', text: '已记录资产 asset-2 [ip] 10.0.0.1（父边 edge-2）。' }],
    )
    expect(render('srchunter_submit', {}, { facts: 1, assets: 2, findings: 3 })).toEqual(
      [{ type: 'text', text: '已向父会话提交 1 条事实、2 项资产、3 条漏洞。' }],
    )
    expect(render('srchunter_graph', {}, { graph: {} })).toEqual([{ type: 'text', text: '{}' }])
    expect(render('srchunter_report', {}, { markdown: 'md' })).toEqual([{ type: 'text', text: 'md' }])
  })

  it('renders srchunter_state for initialized, empty, and uninitialized views', async () => {
    const { render } = await srchunterHarness()
    const initialized = render('srchunter_state', {}, {
      initialized: true, goal: { id: 'goal-1', target: 'example.com', objective: 'o', authorization: '', destructive: 'readonly' },
      intents: [{ id: 'intent-1', sessionId: SESSION_ID, title: 'enumerate', detail: '', status: 'deepen', disposition: '遍历 userId 取他人记录' }],
      facts: [{ id: 'fact-1', sessionId: SESSION_ID, intentId: 'intent-1', kind: 'port', target: 'example.com', detail: 'tcp/80 open', confidence: 0.9 }],
      findings: [{ id: 'finding-1', sessionId: SESSION_ID, intentId: 'intent-1', title: 'sqli', severity: 'high', score: 9.5, description: '', reproducibleSteps: ['x'] }],
      assets: [{ id: 'asset-1', sessionId: SESSION_ID, type: 'root-domain', value: 'example.com', meta: '', owner: '' }],
      edges: [],
      counts: { intents: 1, facts: 1, findings: 1, assets: 1 },
    }) as Array<{ text: string }>
    expect(initialized[0]!.text).toContain('目标：example.com | 目的：o | 破坏性档位：readonly | 意图 1 条、事实 1 条')
    expect(initialized[0]!.text).toContain('intent-1「enumerate」[deepen：遍历 userId 取他人记录]')
    expect(initialized[0]!.text).toContain('fact-1 [port] tcp/80 open')
    expect(initialized[0]!.text).toContain('finding-1 [high/9.5] sqli')
    expect(initialized[0]!.text).toContain('asset-1 [root-domain] example.com')
    const empty = render('srchunter_state', {}, {
      initialized: true, goal: { id: 'goal-1', target: 'example.com', objective: 'o', authorization: '', destructive: 'limited' },
      intents: [], facts: [], findings: [], assets: [], edges: [],
      counts: { intents: 0, facts: 0, findings: 0, assets: 0 },
    }) as Array<{ text: string }>
    expect(empty[0]!.text).toContain('破坏性档位：limited | 意图 0 条、事实 0 条、漏洞 0 条、资产 0 项。意图：无。')
    const uninitialized = render('srchunter_state', {}, {
      initialized: false, intents: [], facts: [], findings: [], assets: [], edges: [],
      counts: { intents: 0, facts: 0, findings: 0, assets: 0 },
    }) as Array<{ text: string }>
    expect(uninitialized[0]!.text).toBe('尚未初始化：请带上 target 和 objective 调用 srchunter_add_goal。')
  })
})

describe('tool result cards', () => {
  it('presents the read-only projections as titled generic cards, errors excluded', async () => {
    const { ctx } = await srchunterHarness()
    const content = [{ type: 'text' as const, text: 'md' }]
    const cards = [
      ['srchunter_state', '漏洞挖掘状态'],
      ['srchunter_graph', '漏洞挖掘探索图'],
      ['srchunter_report', '漏洞挖掘报告'],
    ] as const
    for (const [name, title] of cards) {
      const tool = ctx.tools.get(name)
      expect(tool).toBeDefined()
      expect(tool!.presentResult?.({}, { content, isError: false })).toEqual({ card: 'generic', title, content })
      expect(tool!.presentResult?.({}, { content, isError: true })).toBeUndefined()
    }
  })
})

describe('plugin lifecycle', () => {
  it('disposes without an opened domain', async () => {
    const { ctx } = await srchunterHarness()
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
  })

  it('closes the opened domain on dispose', async () => {
    const { ctx, facility, call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    expect(facility.get('srchunter')).toBeDefined()
    await ctx.fiber.dispose()
    expect(facility.get('srchunter')).toBeUndefined()
  })

  it('drains queued writes before closing the domain', async () => {
    const { ctx, call } = await srchunterHarness()
    await call('srchunter_add_goal', { target: 'example.com', objective: 'o' }, SESSION_ID)
    await call('srchunter_add_intent', { goalId: 'goal-1', title: 'probe' }, SESSION_ID)
    const writes = Promise.all([
      call('srchunter_add_fact', { intentId: 'intent-1', detail: 'a' }, SESSION_ID),
      call('srchunter_add_fact', { intentId: 'intent-1', detail: 'b' }, SESSION_ID),
    ])
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
    await expect(writes).resolves.toHaveLength(2)
  })

  it('contributes the protocol section to the assembled system prompt', async () => {
    const { ctx } = await srchunterHarness()
    const assembly = await ctx.systemPrompt.assemble()
    const prompt = renderPrompt(assembly)
    expect(prompt).toContain('你是 EduSRC（教育行业 SRC）漏洞挖掘指挥官（决策 agent）')
    // The adjudication tool and the realized-harm gate are part of the protocol.
    expect(prompt).toContain('srchunter_set_intent')
    expect(prompt).toContain('只认「实际可利用 + 实锤危害」')
  })
})
