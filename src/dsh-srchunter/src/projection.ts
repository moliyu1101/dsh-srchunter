/**
 * The standing `srchunter` session-projection unit: folds the logged
 * `srchunter_*` tool calls into the engagement's current exploration graph, so
 * the UI reconstructs the same graph from the session log alone — pure
 * mathematics, replay-safe, no storage-domain reads. Node/edge ids replicate
 * the store's deterministic `<kind>-<n>` counters, so edges resolve across the
 * fold. Writes that would violate the store's referential discipline are
 * skipped, mirroring the store's rejection. Malformed or foreign events leave
 * the state untouched.
 * @module @deepseek-ai/dsh-srchunter/src/projection
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { findingEvidenceGaps } from './spec.ts'
import type {
  SrchunterAssetType,
  SrchunterDestructive,
  SrchunterEdgeKind,
  SrchunterFactKind,
  SrchunterIntentStatus,
  SrchunterSeverity,
  SrchunterStrictList,
} from './spec.ts'
import type {
  SrchunterProjection,
  SrchunterProjectionAsset,
  SrchunterProjectionEdge,
  SrchunterProjectionGoal,
  SrchunterProjectionNode,
} from './types.ts'

/** Wire payload schema of the `srchunter` projection (standing state or pre-init null). */
export const srchunterProjectionSchema: z.ZodType<SrchunterProjection | null> = z.union([
  z.object({
    goal: z.object({
      id: z.string(),
      target: z.string(),
      objective: z.string(),
      authorization: z.string(),
      destructive: z.enum(['readonly', 'limited', 'full']),
    }),
    nodes: z.array(z.union([
      z.object({
        id: z.string(),
        kind: z.literal('intent'),
        title: z.string(),
        detail: z.string(),
        status: z.enum(['open', 'working', 'done', 'deepen', 'blocked', 'dead_end']),
        disposition: z.string(),
      }),
      z.object({
        id: z.string(),
        kind: z.literal('fact'),
        factKind: z.enum(['port', 'service', 'vuln', 'finding', 'http', 'info']),
        intentId: z.string(),
        target: z.string(),
        detail: z.string(),
        confidence: z.number(),
      }),
      z.object({
        id: z.string(),
        kind: z.literal('finding'),
        intentId: z.string(),
        title: z.string(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
        description: z.string(),
        steps: z.array(z.string()),
        affectedAssetId: z.union([z.string(), z.undefined()]),
        vulnType: z.string(),
        owner: z.string(),
        impact: z.string(),
        rawRequest: z.string(),
        rawResponse: z.string(),
        poc: z.string(),
        killChain: z.array(z.string()),
        score: z.number(),
        strictListHit: z.enum(['id-card-photo', 'face-photo', 'id-number', 'password-hash', 'none']),
        publicInterface: z.boolean(),
      }),
    ])),
    assets: z.array(z.object({
      id: z.string(),
      type: z.enum(['root-domain', 'subdomain', 'ip', 'service', 'app', 'endpoint']),
      value: z.string(),
      meta: z.string(),
      owner: z.string(),
    })),
    edges: z.array(z.object({
      id: z.string(),
      kind: z.enum(['spawns', 'yields', 'derived_from', 'proves', 'parent']),
      sourceId: z.string(),
      targetId: z.string(),
    })),
    counts: z.object({
      intents: z.number().int().nonnegative(),
      facts: z.number().int().nonnegative(),
      findings: z.number().int().nonnegative(),
      assets: z.number().int().nonnegative(),
    }),
  }),
  z.null(),
])

/** How many nodes/assets/edges the standing projection retains (oldest kept). */
export const NODE_CAP = 200
export const EDGE_CAP = 200
export const ASSET_CAP = 200

/** Per-kind per-session counters replicating the store's deterministic ids. */
export interface SrchunterFoldCounters {
  intent: number
  fact: number
  finding: number
  asset: number
  edge: number
}

/** Fold state of the `srchunter` unit (the standing exploration graph). */
export interface SrchunterFoldState {
  goal: SrchunterProjectionGoal | null
  nodes: SrchunterProjectionNode[]
  assets: SrchunterProjectionAsset[]
  edges: SrchunterProjectionEdge[]
  counters: SrchunterFoldCounters
}

/** Initial state: an uninitialized engagement (view projects to null). */
export const srchunterInitialState: SrchunterFoldState = {
  goal: null,
  nodes: [],
  assets: [],
  edges: [],
  counters: { intent: 0, fact: 0, finding: 0, asset: 0, edge: 0 },
}

/** The closed enum values of the wire payloads. */
const FACT_KINDS: ReadonlySet<string> = new Set(['port', 'service', 'vuln', 'finding', 'http', 'info'])
const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low', 'info'])
const ASSET_TYPES: ReadonlySet<string> = new Set(['root-domain', 'subdomain', 'ip', 'service', 'app', 'endpoint'])
const INTENT_STATUSES: ReadonlySet<string> = new Set(['open', 'working', 'done', 'deepen', 'blocked', 'dead_end'])
const STRICT_LISTS: ReadonlySet<string> = new Set(['id-card-photo', 'face-photo', 'id-number', 'password-hash', 'none'])
const DESTRUCTIVES: ReadonlySet<string> = new Set(['readonly', 'limited', 'full'])

/**
 * Longest evidence packet the wire projection carries. The durable record keeps
 * the packet whole (and `srchunter_report` renders it in full); the browser view
 * clamps so a session of a few hundred findings cannot balloon the payload.
 */
export const PACKET_CAP = 20000

/** Read one packet argument, clamped to {@link PACKET_CAP} with a visible marker. */
function packet(value: unknown): string {
  const text = str(value)
  return text.length <= PACKET_CAP ? text : `${text.slice(0, PACKET_CAP)}\n…(已截断，完整包见 srchunter_report)`
}

/** Read a 0-10 severity score, absent or malformed at 0. */
function scoreOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : 0
}

/** Read one list argument of non-empty strings. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

/** Read one tool call's raw arguments as an object, or undefined when absent/malformed. */
function argsOf(event: SessionEvent): Record<string, unknown> | undefined {
  if (event.type !== 'tool/call' || !event.data.name.startsWith('srchunter_')) return undefined
  try {
    const parsed: unknown = JSON.parse(event.data.arguments)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Read a string argument, or '' when absent/not a string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(1, Math.max(0, value > 1 ? value / 100 : value))
  if (typeof value === 'string') {
    const text = value.trim()
    const percent = text.endsWith('%')
    const parsed = Number(percent ? text.slice(0, -1) : text)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(1, Math.max(0, percent || parsed > 1 ? parsed / 100 : parsed))
  }
  return 0.5
}

/** Retain only edges whose endpoints are still present in the capped graph. */
function retainedEdges(
  state: SrchunterFoldState,
  nodes: readonly SrchunterProjectionNode[],
  assets: readonly SrchunterProjectionAsset[],
  edges: readonly SrchunterProjectionEdge[],
): SrchunterProjectionEdge[] {
  const ids = new Set([state.goal?.id, ...nodes.map(node => node.id), ...assets.map(asset => asset.id)])
  return edges.filter(edge => ids.has(edge.sourceId) && ids.has(edge.targetId))
}

/** Append a node and its edge, capped (oldest dropped). */
function withNode(
  state: SrchunterFoldState,
  edgeKind: SrchunterEdgeKind,
  sourceId: string,
  node: SrchunterProjectionNode,
  counters: SrchunterFoldCounters,
): SrchunterFoldState {
  const edge: SrchunterProjectionEdge = {
    id: `edge-${counters.edge + 1}`,
    kind: edgeKind,
    sourceId,
    targetId: node.id,
  }
  const nodes = [...state.nodes, node].slice(-NODE_CAP)
  const edges = retainedEdges(state, nodes, state.assets, [...state.edges, edge].slice(-EDGE_CAP))
  return {
    ...state,
    counters: { ...counters, edge: counters.edge + 1 },
    nodes,
    edges,
  }
}

/** Append an asset and its optional parent edge, capped (oldest dropped). */
function withAsset(
  state: SrchunterFoldState,
  asset: SrchunterProjectionAsset,
  parentId: string | undefined,
  counters: SrchunterFoldCounters,
): SrchunterFoldState {
  const assets = [...state.assets, asset].slice(-ASSET_CAP)
  if (parentId === undefined) return { ...state, counters, assets }
  const edge: SrchunterProjectionEdge = {
    id: `edge-${counters.edge + 1}`,
    kind: 'parent',
    sourceId: parentId,
    targetId: asset.id,
  }
  return {
    ...state,
    counters: { ...counters, edge: counters.edge + 1 },
    assets,
    edges: retainedEdges(state, state.nodes, assets, [...state.edges, edge].slice(-EDGE_CAP)),
  }
}

/** The next deterministic id of one node kind (the goal is fixed as `goal-1`). */
function nextNodeId(state: SrchunterFoldState, kind: 'intent' | 'fact' | 'finding' | 'asset'): {
  id: string
  counters: SrchunterFoldCounters
} {
  const counters = { ...state.counters, [kind]: state.counters[kind] + 1 }
  return { id: `${kind}-${counters[kind]}`, counters }
}

/** Look up an existing folded node by id and kind. */
function findNode(state: SrchunterFoldState, id: string, kind: 'intent' | 'fact'): SrchunterProjectionNode | undefined {
  return state.nodes.find(node => node.id === id && node.kind === kind)
}

/** Fold one session event into the standing srchunter state (pure, replay-safe). */
export function applySrchunterEvent(state: SrchunterFoldState, event: SessionEvent): SrchunterFoldState {
  const submission = event as unknown as { type: string; data: Record<string, unknown> }
  if (submission.type === 'srchunter/submit') {
    const data = submission.data
    const intentId = str(data.intentId)
    if (intentId === '') return state
    const replay = (name: string, args: Record<string, unknown>, current: SrchunterFoldState): SrchunterFoldState =>
      applySrchunterEvent(current, { type: 'tool/call', data: { name, arguments: JSON.stringify(args) } } as SessionEvent)
    let next = state
    for (const fact of Array.isArray(data.facts) ? data.facts : []) {
      if (fact !== null && typeof fact === 'object') next = replay('srchunter_add_fact', { ...(fact as Record<string, unknown>), intentId }, next)
    }
    for (const asset of Array.isArray(data.assets) ? data.assets : []) {
      if (asset !== null && typeof asset === 'object') next = replay('srchunter_add_asset', asset as Record<string, unknown>, next)
    }
    for (const finding of Array.isArray(data.findings) ? data.findings : []) {
      if (finding !== null && typeof finding === 'object') next = replay('srchunter_add_finding', { ...(finding as Record<string, unknown>), intentId }, next)
    }
    return next
  }
  if (event.type !== 'tool/call') return state
  const args = argsOf(event)
  if (args === undefined) return state
  switch (event.data.name) {
    case 'srchunter_add_goal': {
      const target = str(args.target)
      const objective = str(args.objective)
      if (target === '' || objective === '') return state
      return {
        goal: {
          id: 'goal-1',
          target,
          objective,
          authorization: str(args.authorization),
          destructive: typeof args.destructive === 'string' && DESTRUCTIVES.has(args.destructive)
            ? args.destructive as SrchunterDestructive
            : 'limited',
        },
        nodes: [],
        assets: [],
        edges: [],
        counters: { intent: 0, fact: 0, finding: 0, asset: 0, edge: 0 },
      }
    }
    case 'srchunter_add_intent': {
      const title = str(args.title)
      const detail = str(args.detail)
      if (title === '') return state
      const goalId = str(args.goalId)
      const derivedFromFactId = str(args.derivedFromFactId)
      const anchors = (goalId !== '' ? 1 : 0) + (derivedFromFactId !== '' ? 1 : 0)
      if (anchors !== 1) return state
      const disposition = { status: 'open' as const, disposition: '' }
      if (goalId !== '') {
        if (state.goal === null || goalId !== state.goal.id) return state
        const { id, counters } = nextNodeId(state, 'intent')
        return withNode(state, 'spawns', goalId, { id, kind: 'intent', title, detail, ...disposition }, counters)
      }
      if (findNode(state, derivedFromFactId, 'fact') === undefined) return state
      const { id: derivedId, counters: derivedCounters } = nextNodeId(state, 'intent')
      return withNode(state, 'derived_from', derivedFromFactId, { id: derivedId, kind: 'intent', title, detail, ...disposition }, derivedCounters)
    }
    case 'srchunter_set_intent': {
      // A disposition update rewrites the intent in place; an intent already
      // evicted from the capped window leaves the state untouched (the durable
      // record still carries the verdict, and the report reads storage).
      const intentId = str(args.intentId)
      const status = typeof args.status === 'string' && INTENT_STATUSES.has(args.status) ? args.status as SrchunterIntentStatus : undefined
      if (status === undefined || status === 'open') return state
      const index = state.nodes.findIndex(node => node.id === intentId && node.kind === 'intent')
      if (index < 0) return state
      const current = state.nodes[index]
      if (current.kind !== 'intent') return state
      const nodes = [...state.nodes]
      nodes[index] = { ...current, status, disposition: str(args.disposition) }
      return { ...state, nodes }
    }
    case 'srchunter_add_fact': {
      const intentId = str(args.intentId)
      if (findNode(state, intentId, 'intent') === undefined) return state
      const detail = str(args.detail)
      if (detail === '') return state
      const kind = typeof args.kind === 'string' && FACT_KINDS.has(args.kind) ? args.kind as SrchunterFactKind : 'info'
      const confidence = normalizeConfidence(args.confidence)
      const { id, counters } = nextNodeId(state, 'fact')
      const node: SrchunterProjectionNode = {
        id,
        kind: 'fact',
        factKind: kind,
        intentId,
        target: str(args.target),
        detail,
        confidence,
      }
      return withNode(state, 'yields', intentId, node, counters)
    }
    case 'srchunter_add_finding': {
      const intentId = str(args.intentId)
      if (findNode(state, intentId, 'intent') === undefined) return state
      const title = str(args.title)
      if (title === '') return state
      const steps = stringsOf(args.reproducibleSteps)
      if (steps.length === 0) return state
      const severity = typeof args.severity === 'string' && SEVERITIES.has(args.severity) ? args.severity as SrchunterSeverity : 'info'
      const affectedAssetId = str(args.affectedAssetId)
      if (affectedAssetId !== '' && !state.assets.some(asset => asset.id === affectedAssetId)) return state
      // Mirror the store's realized-harm gate: a write the tool rejected must
      // not appear in the folded graph either, or the UI would show a finding
      // the report never contains.
      if (findingEvidenceGaps(args).length > 0) return state
      const { id, counters } = nextNodeId(state, 'finding')
      const node: SrchunterProjectionNode = {
        id,
        kind: 'finding',
        intentId,
        title,
        severity,
        description: str(args.description),
        steps,
        affectedAssetId: affectedAssetId === '' ? undefined : affectedAssetId,
        vulnType: str(args.vulnType),
        owner: str(args.owner),
        impact: str(args.impact),
        rawRequest: packet(args.rawRequest),
        rawResponse: packet(args.rawResponse),
        poc: packet(args.poc),
        killChain: stringsOf(args.killChain),
        score: scoreOf(args.score),
        strictListHit: typeof args.strictListHit === 'string' && STRICT_LISTS.has(args.strictListHit)
          ? args.strictListHit as SrchunterStrictList
          : 'none',
        publicInterface: args.publicInterface === true,
      }
      return withNode(state, 'proves', intentId, node, counters)
    }
    case 'srchunter_add_asset': {
      const type = typeof args.type === 'string' && ASSET_TYPES.has(args.type) ? args.type as SrchunterAssetType : undefined
      if (type === undefined) return state
      const value = str(args.value)
      if (value === '') return state
      const parentId = str(args.parentId)
      if (parentId !== '' && !state.assets.some(asset => asset.id === parentId)) return state
      const { id, counters } = nextNodeId(state, 'asset')
      const asset: SrchunterProjectionAsset = { id, type, value, meta: str(args.meta), owner: str(args.owner) }
      return withAsset(state, asset, parentId === '' ? undefined : parentId, counters)
    }
    default:
      return state
  }
}

/** Project the fold state onto the wire payload (null before the first goal). */
export function viewSrchunterState(state: SrchunterFoldState): SrchunterProjection | null {
  if (state.goal === null) return null
  return {
    goal: state.goal,
    nodes: state.nodes,
    assets: state.assets,
    edges: state.edges,
    counts: {
      intents: state.nodes.filter(node => node.kind === 'intent').length,
      facts: state.nodes.filter(node => node.kind === 'fact').length,
      findings: state.nodes.filter(node => node.kind === 'finding').length,
      assets: state.assets.length,
    },
  }
}
