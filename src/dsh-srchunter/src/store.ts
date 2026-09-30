/**
 * In-memory-forwarding, durably-backed store for srchunter exploration records.
 *
 * Reads are synchronous from the authoritative in-memory state (as served by
 * the storage-domain facility); writes are queued per-domain, persisted to the
 * routed backend first, then applied to memory and emitted via `domain/changed`.
 * The domain is opened lazily on first use and closed on plugin dispose.
 *
 * The store owns the exploration discipline: one goal per session (a new goal
 * resets the whole graph), every node/edge write validates its references
 * against the same session, and node/edge ids are deterministic (`<kind>-<n>`,
 * per-session counters) so the session projection can replicate the graph
 * purely from the logged tool calls.
 * @module @deepseek-ai/dsh-srchunter/src/store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  srchunterDomainSpec,
  type SrchunterAsset,
  type SrchunterAssetType,
  type SrchunterDestructive,
  type SrchunterEdge,
  type SrchunterEdgeKind,
  type SrchunterFact,
  type SrchunterFactKind,
  type SrchunterFinding,
  type SrchunterGoal,
  type SrchunterIntent,
  type SrchunterIntentStatus,
  type SrchunterSeverity,
  type SrchunterStrictList,
} from './spec.ts'

/** Deterministic id namespace per node/edge kind (ids read `<kind>-<n>`). */
type IdKind = 'goal' | 'intent' | 'fact' | 'finding' | 'asset' | 'edge'

/** The record table owning each id kind. */
const TABLE_OF_ID_KIND = {
  goal: 'goals',
  intent: 'intents',
  fact: 'facts',
  finding: 'findings',
  asset: 'assets',
  edge: 'edges',
} as const satisfies Record<IdKind, string>

const SESSION_SCOPED_TABLES = ['intents', 'facts', 'findings', 'assets', 'edges'] as const

/** Physical key for a session-local graph node or edge. */
function recordKey(sessionId: string, id: string): string {
  return `${sessionId}:${id}`
}

/** Copy and freeze one record before it crosses the service boundary. */
function snapshot<T extends object>(value: T): T {
  return Object.freeze({ ...value })
}

/** Options for creating (or resetting) one session's engagement goal. */
export interface GoalInput {
  readonly target: string
  readonly objective: string
  /** Declarative authorization note; empty when the caller supplied none. */
  readonly authorization: string
  /** Destructive-action budget granted to execution agents. */
  readonly destructive: SrchunterDestructive
}

/** Options for recording one exploration intent (exactly one anchor required). */
export interface IntentInput {
  readonly title: string
  readonly detail: string
  /** Anchor of a `spawns` edge: the goal the intent explores toward. */
  readonly goalId?: string
  /** Anchor of a `derived_from` edge: the fact the intent builds on. */
  readonly derivedFromFactId?: string
}

/** Options for adjudicating one intent's disposition. */
export interface IntentDispositionInput {
  readonly intentId: string
  readonly status: SrchunterIntentStatus
  /** Why the intent holds this status; the next-round directive when `deepen`. */
  readonly disposition: string
}

/** Options for recording one fact yielded by an intent. */
export interface FactInput {
  readonly intentId: string
  readonly kind: SrchunterFactKind
  readonly target: string
  readonly detail: string
  readonly confidence: number
}

/** Options for recording one vulnerability finding proved by an intent. */
export interface FindingInput {
  readonly intentId: string
  readonly title: string
  readonly severity: SrchunterSeverity
  readonly description: string
  readonly reproducibleSteps: readonly string[]
  readonly affectedAssetId?: string
  readonly vulnType: string
  readonly owner: string
  readonly impact: string
  readonly rawRequest: string
  readonly rawResponse: string
  readonly poc: string
  readonly killChain: readonly string[]
  readonly score: number
  readonly strictListHit: SrchunterStrictList
  readonly publicInterface: boolean
}

/** Options for recording one asset (optionally parented to another asset). */
export interface AssetInput {
  readonly type: SrchunterAssetType
  readonly value: string
  readonly parentId?: string
  readonly meta: string
  readonly owner: string
}

/** The model-visible state of one session's exploration. */
export interface SrchunterStateView {
  readonly initialized: boolean
  readonly goal?: SrchunterGoal
  readonly intents: SrchunterIntent[]
  readonly facts: SrchunterFact[]
  readonly findings: SrchunterFinding[]
  readonly assets: SrchunterAsset[]
  readonly edges: SrchunterEdge[]
  readonly counts: { intents: number; facts: number; findings: number; assets: number }
}

/** One newly minted node and its optional connecting edge. */
export interface NodeWrite {
  readonly nodeId: string
  /** The edge linking the anchor to the new node; absent for root assets. */
  readonly edge?: { readonly id: string; readonly kind: SrchunterEdgeKind; readonly sourceId: string; readonly targetId: string }
}

/**
 * Owning handle for the lazily opened srchunter domain. Not a Cordis service: it
 * is a private helper owned by the plugin `apply` fiber and disposed with it.
 */
export class SrchunterStore {
  private domainPromise: Promise<Domain<typeof srchunterDomainSpec>> | undefined
  private readonly sessionQueues = new Map<string, Promise<void>>()
  /** Per-session max id sequence per kind, mirroring the durable tables. */
  private readonly sessionCounters = new Map<string, Map<IdKind, number>>()

  constructor(private readonly ctx: Context) {}

  /** Resolve the opened domain, opening it lazily on first use. */
  private domain(): Promise<Domain<typeof srchunterDomainSpec>> {
    if (this.domainPromise === undefined) {
      this.domainPromise = this.ctx.storageDomain.open(srchunterDomainSpec).then(async domain => {
        await this.migrateLegacyKeys(domain)
        return domain
      })
    }
    return this.domainPromise
  }

  /** Move legacy global-id rows to the session-scoped key format once. */
  private async migrateLegacyKeys(domain: Domain<typeof srchunterDomainSpec>): Promise<void> {
    for (const name of SESSION_SCOPED_TABLES) {
      const table = domain.table(name)
      for (const [key, row] of table.entries()) {
        const record = row as { sessionId: string; id: string }
        const scopedKey = recordKey(record.sessionId, record.id)
        if (key === scopedKey) continue
        if (table.get(scopedKey) === undefined) await table.put(scopedKey, row)
        await table.delete(key)
      }
    }
  }

  /** Close the domain and release its backend unit (idempotent). */
  async dispose(): Promise<void> {
    // Drain queued writes before closing the domain. Keep domainPromise intact
    // while draining so an in-flight operation cannot reopen a second domain.
    await Promise.all([...this.sessionQueues.values()])
    const pending = this.domainPromise
    if (pending !== undefined) {
      this.domainPromise = undefined
      await (await pending).close()
    }
    this.sessionQueues.clear()
    this.sessionCounters.clear()
  }

  /** Serialize read/allocate/write transactions for one session. */
  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve()
    const current = previous.then(operation)
    const settled = current.then(() => undefined, () => undefined)
    this.sessionQueues.set(sessionId, settled)
    return current
  }

  /** Read one session's goal row, if present. */
  async getGoal(sessionId: string): Promise<SrchunterGoal | undefined> {
    return (await this.domain()).table('goals').get(sessionId)
  }

  /** Read the goal row, failing with a guiding error when absent. */
  private async requireGoal(sessionId: string): Promise<SrchunterGoal> {
    const goal = await this.getGoal(sessionId)
    if (goal === undefined) {
      throw new Error('srchunter 会话尚未初始化：请先带 target 和 objective 调用 srchunter_add_goal')
    }
    return goal
  }

  /**
   * The next deterministic id for one kind in one session. Allocation is O(1)
   * from the in-memory max-sequence cache (the store is the domain's single
   * writer, and every allocation runs inside the session's serialized queue);
   * the cache is (re)built from the durable table on first touch of a session
   * and dropped wholesale when the session's goal resets.
   */
  private async nextId(kind: IdKind, sessionId: string): Promise<string> {
    let counters = this.sessionCounters.get(sessionId)
    if (counters === undefined) {
      counters = new Map()
      for (const name of SESSION_SCOPED_TABLES) {
        const table = (await this.domain()).table(name)
        for (const [, row] of table.entries()) {
          const record = row as { sessionId: string; id: string }
          if (record.sessionId !== sessionId) continue
          const [kindOfId, seq] = /^([a-z]+)-(\d+)$/.exec(record.id)?.slice(1) ?? []
          if (kindOfId === undefined || seq === undefined) continue
          if (kindOfId === 'intent' || kindOfId === 'fact' || kindOfId === 'finding' || kindOfId === 'asset' || kindOfId === 'edge') {
            counters.set(kindOfId, Math.max(counters.get(kindOfId) ?? 0, Number(seq)))
          }
        }
      }
      this.sessionCounters.set(sessionId, counters)
    }
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return `${kind}-${next}`
  }

  /** Delete every exploration row of one session (goal reset). */
  private async clearSession(sessionId: string): Promise<void> {
    const domain = await this.domain()
    for (const name of ['intents', 'facts', 'findings', 'assets', 'edges'] as const) {
      const table = domain.table(name)
      for (const [key, row] of table.entries()) {
        if ((row as { sessionId: string }).sessionId === sessionId) await table.delete(key)
      }
    }
  }

  /**
   * Create or reset the engagement goal. A new goal clears the whole
   * exploration graph of the session and restarts fresh counters.
   */
  async initGoal(sessionId: string, input: GoalInput): Promise<SrchunterGoal> {
    return this.enqueue(sessionId, async () => {
      const goal = snapshot<SrchunterGoal>({
        id: 'goal-1',
        sessionId,
        target: input.target,
        objective: input.objective,
        authorization: input.authorization,
        destructive: input.destructive,
      })
      await (await this.domain()).table('goals').put(sessionId, goal)
      await this.clearSession(sessionId)
      // A fresh engagement restarts every per-session counter.
      this.sessionCounters.delete(sessionId)
      return goal
    })
  }

  /** Validate a reference row (same session, expected table) or fail loud. */
  private async requireRef(
    sessionId: string,
    tableName: 'goals' | 'intents' | 'facts' | 'findings' | 'assets',
    refId: string,
    label: string,
  ): Promise<void> {
    const row = (await this.domain()).table(tableName).get(recordKey(sessionId, refId))
    if (row === undefined) {
      throw new Error(`srchunter：未知的 ${label} ${refId}`)
    }
    /* v8 ignore next -- session-scoped keys are normalized on domain open and the domain has one writer. */
    if (row.sessionId !== sessionId) {
      throw new Error(`srchunter：${label} ${refId} 属于其他会话`)
    }
  }

  /** Mint one node (and its connecting edge) in one write. */
  private async addNode(
    sessionId: string,
    edgeKind: SrchunterEdgeKind | undefined,
    sourceId: string,
    nodeKind: 'intent' | 'fact' | 'finding' | 'asset',
    node: Omit<SrchunterIntent | SrchunterFact | SrchunterFinding | SrchunterAsset, 'id' | 'sessionId'>,
  ): Promise<NodeWrite> {
    const domain = await this.domain()
    const nodeId = await this.nextId(nodeKind, sessionId)
    const record = snapshot({ id: nodeId, sessionId, ...node }) as SrchunterIntent | SrchunterFact | SrchunterFinding | SrchunterAsset
    await domain.table(TABLE_OF_ID_KIND[nodeKind]).put(recordKey(sessionId, nodeId), record)
    if (edgeKind === undefined) return { nodeId }
    const edgeId = await this.nextId('edge', sessionId)
    const edge = snapshot<SrchunterEdge>({ id: edgeId, sessionId, kind: edgeKind, sourceId, targetId: nodeId })
    try {
      await domain.table('edges').put(recordKey(sessionId, edgeId), edge)
    } catch (error) {
      await domain.table(TABLE_OF_ID_KIND[nodeKind]).delete(recordKey(sessionId, nodeId))
      throw error
    }
    return { nodeId, edge: { id: edgeId, kind: edgeKind, sourceId, targetId: nodeId } }
  }

  /** Record one intent spawned by the goal or derived from a fact. */
  async addIntent(sessionId: string, input: IntentInput): Promise<NodeWrite> {
    const anchors = (input.goalId !== undefined ? 1 : 0) + (input.derivedFromFactId !== undefined ? 1 : 0)
    if (anchors !== 1) {
      throw new Error('srchunter_add_intent 必须且只能指定一个锚点：goalId（spawns 边）或 derivedFromFactId（derived_from 边）')
    }
    return this.enqueue(sessionId, async () => {
      const goal = await this.requireGoal(sessionId)
      // A fresh intent always starts undisposed; only setIntent adjudicates it.
      const node = { title: input.title, detail: input.detail, status: 'open' as const, disposition: '' }
      if (input.goalId !== undefined) {
        if (input.goalId !== goal.id) throw new Error(`srchunter：未知的 goal ${input.goalId}`)
        return this.addNode(sessionId, 'spawns', input.goalId, 'intent', node)
      }
      const derivedFromFactId = input.derivedFromFactId ?? ''
      await this.requireRef(sessionId, 'facts', derivedFromFactId, 'fact')
      return this.addNode(sessionId, 'derived_from', derivedFromFactId, 'intent', node)
    })
  }

  /**
   * Adjudicate one intent: the reviewer verdict of the exploration chain
   * (`done` / `deepen` / `blocked` / `dead_end`), with the reasoning or the
   * concrete next-round directive recorded in `disposition`.
   */
  async setIntent(sessionId: string, input: IntentDispositionInput): Promise<SrchunterIntent> {
    return this.enqueue(sessionId, async () => {
      await this.requireGoal(sessionId)
      await this.requireRef(sessionId, 'intents', input.intentId, 'intent')
      const domain = await this.domain()
      const key = recordKey(sessionId, input.intentId)
      const current = domain.table('intents').get(key) as SrchunterIntent
      const next = snapshot<SrchunterIntent>({
        ...current,
        status: input.status,
        disposition: input.disposition,
      })
      await domain.table('intents').put(key, next)
      return next
    })
  }

  /** Record one fact yielded by an intent. */
  async addFact(sessionId: string, input: FactInput): Promise<NodeWrite> {
    return this.enqueue(sessionId, async () => {
      await this.requireGoal(sessionId)
      await this.requireRef(sessionId, 'intents', input.intentId, 'intent')
      return this.addNode(sessionId, 'yields', input.intentId, 'fact', {
        intentId: input.intentId,
        kind: input.kind,
        target: input.target,
        detail: input.detail,
        confidence: input.confidence,
      })
    })
  }

  /** Record one finding proved by an intent (with reproducible steps). */
  async addFinding(sessionId: string, input: FindingInput): Promise<NodeWrite> {
    if (input.reproducibleSteps.length === 0) {
      throw new Error('srchunter_add_finding 至少需要一条可复现步骤')
    }
    return this.enqueue(sessionId, async () => {
      await this.requireGoal(sessionId)
      await this.requireRef(sessionId, 'intents', input.intentId, 'intent')
      if (input.affectedAssetId !== undefined) await this.requireRef(sessionId, 'assets', input.affectedAssetId, 'asset')
      return this.addNode(sessionId, 'proves', input.intentId, 'finding', {
        intentId: input.intentId,
        title: input.title,
        severity: input.severity,
        description: input.description,
        reproducibleSteps: [...input.reproducibleSteps],
        ...(input.affectedAssetId !== undefined ? { affectedAssetId: input.affectedAssetId } : {}),
        vulnType: input.vulnType,
        owner: input.owner,
        impact: input.impact,
        rawRequest: input.rawRequest,
        rawResponse: input.rawResponse,
        poc: input.poc,
        killChain: [...input.killChain],
        score: input.score,
        strictListHit: input.strictListHit,
        publicInterface: input.publicInterface,
      })
    })
  }

  /** Record one asset; an optional parent links it into the asset graph. */
  async addAsset(sessionId: string, input: AssetInput): Promise<NodeWrite> {
    // An empty-string parentId means "root asset" (the model often sends the
    // field with '' instead of omitting it); only a non-empty id is a real
    // parent reference.
    const parentId = input.parentId === '' ? undefined : input.parentId
    return this.enqueue(sessionId, async () => {
      await this.requireGoal(sessionId)
      if (parentId !== undefined) await this.requireRef(sessionId, 'assets', parentId, 'asset')
      return this.addNode(sessionId, parentId === undefined ? undefined : 'parent', parentId ?? '', 'asset', {
        type: input.type,
        value: input.value,
        meta: input.meta,
        owner: input.owner,
      })
    })
  }

  /** Persist one delegated submission as an all-or-nothing session write. */
  async addSubmission(
    sessionId: string,
    intentId: string,
    facts: readonly FactInput[],
    assets: readonly AssetInput[],
    findings: readonly FindingInput[],
  ): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.requireGoal(sessionId)
      await this.requireRef(sessionId, 'intents', intentId, 'intent')
      for (const asset of assets) {
        const parentId = asset.parentId === '' ? undefined : asset.parentId
        if (parentId !== undefined) await this.requireRef(sessionId, 'assets', parentId, 'asset')
      }
      for (const finding of findings) {
        if (finding.reproducibleSteps.length === 0) throw new Error('srchunter_add_finding 至少需要一条可复现步骤')
        if (finding.affectedAssetId !== undefined) await this.requireRef(sessionId, 'assets', finding.affectedAssetId, 'asset')
      }
      const created: Array<{ readonly kind: 'fact' | 'asset' | 'finding'; readonly write: NodeWrite }> = []
      try {
        for (const fact of facts) {
          const write = await this.addNode(sessionId, 'yields', intentId, 'fact', { ...fact, intentId })
          created.push({ kind: 'fact', write })
        }
        for (const asset of assets) {
          const parentId = asset.parentId === '' ? undefined : asset.parentId
          const write = await this.addNode(sessionId, parentId === undefined ? undefined : 'parent', parentId ?? '', 'asset', asset)
          created.push({ kind: 'asset', write })
        }
        for (const finding of findings) {
          const write = await this.addNode(sessionId, 'proves', intentId, 'finding', { ...finding, intentId, reproducibleSteps: [...finding.reproducibleSteps] })
          created.push({ kind: 'finding', write })
        }
      } catch (error) {
        const domain = await this.domain()
        for (const { kind, write } of created.reverse()) {
          // Each cleanup failure is collected (not thrown) so the ORIGINAL
          // error survives and the remaining rows still get their best-effort
          // removal — a second backend failure must not strand the rest.
          try {
            if (write.edge !== undefined) await domain.table('edges').delete(recordKey(sessionId, write.edge.id))
            await domain.table(TABLE_OF_ID_KIND[kind]).delete(recordKey(sessionId, write.nodeId))
          } catch {
            // Rollback already lost the race with a failing backend; the
            // original error is the actionable one.
          }
        }
        throw error
      }
    })
  }

  /** Read all exploration rows of one session, ordered by numeric id sequence. */
  async sessionData(sessionId: string): Promise<{
    goal: SrchunterGoal | undefined
    intents: SrchunterIntent[]
    facts: SrchunterFact[]
    findings: SrchunterFinding[]
    assets: SrchunterAsset[]
    edges: SrchunterEdge[]
  }> {
    const domain = await this.domain()
    const bySession = <T extends { readonly sessionId: string; readonly id: string }>(rows: Iterable<[string, T]>): T[] =>
      [...rows].map(([, row]) => row).filter(row => row.sessionId === sessionId).sort((a, b) => {
        const aSeq = Number(/-(\d+)$/.exec(a.id)?.[1] ?? Number.MAX_SAFE_INTEGER)
        const bSeq = Number(/-(\d+)$/.exec(b.id)?.[1] ?? Number.MAX_SAFE_INTEGER)
        return aSeq - bSeq
      })
    return {
      goal: await this.getGoal(sessionId),
      intents: bySession(domain.table('intents').entries()),
      facts: bySession(domain.table('facts').entries()),
      findings: bySession(domain.table('findings').entries()),
      assets: bySession(domain.table('assets').entries()),
      edges: bySession(domain.table('edges').entries()),
    }
  }

  /** Build the model-visible summary view for one session. */
  async view(sessionId: string): Promise<SrchunterStateView> {
    const { goal, intents, facts, findings, assets, edges } = await this.sessionData(sessionId)
    if (goal === undefined) {
      return {
        initialized: false,
        intents: [],
        facts: [],
        findings: [],
        assets: [],
        edges: [],
        counts: { intents: 0, facts: 0, findings: 0, assets: 0 },
      }
    }
    return snapshot<SrchunterStateView>({
      initialized: true,
      goal,
      intents,
      facts,
      findings,
      assets,
      edges,
      counts: { intents: intents.length, facts: facts.length, findings: findings.length, assets: assets.length },
    })
  }
}
