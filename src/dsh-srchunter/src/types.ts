/**
 * Pure types of the srchunter projection domain: the ONE home of the `srchunter`
 * projection-key declaration plus its payload types, free of this package's
 * host-side value imports (zod, dsh-tools). Two namespace projections serve
 * it — `./types` for host consumers, `./client` (the client-namespace
 * re-export) for client aggregates — with zero content duplication.
 *
 * @module @deepseek-ai/dsh-srchunter/types
 */

import type { SrchunterAssetType, SrchunterDestructive, SrchunterEdgeKind, SrchunterFactKind, SrchunterIntentStatus, SrchunterSeverity, SrchunterStrictList } from './spec.ts'

// Client consumers need the closed enum types of the payloads; re-export them
// type-only so the `./client` outlet carries the full vocabulary.
export type {
  SrchunterAssetType,
  SrchunterDestructive,
  SrchunterEdgeKind,
  SrchunterFactKind,
  SrchunterIntentStatus,
  SrchunterSeverity,
  SrchunterStrictList,
} from './spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The engagement's current exploration graph, folded from the logged
     * `srchunter_*` tool calls (goal plus goal/intent/fact/finding nodes, the
     * asset graph, and every edge); `null` before the first
     * `srchunter_add_goal` of the session.
     */
    srchunter: SrchunterProjection | null
  }
}

/** The engagement goal (one per session; its node id is `goal-1`). */
export interface SrchunterProjectionGoal {
  readonly id: string
  readonly target: string
  readonly objective: string
  readonly authorization: string
  readonly destructive: SrchunterDestructive
}

/** One exploration-graph node, discriminated by kind. */
export type SrchunterProjectionNode =
  | {
    readonly id: string
    readonly kind: 'intent'
    readonly title: string
    readonly detail: string
    /** Reviewer disposition of this intent. */
    readonly status: SrchunterIntentStatus
    /** Why it holds that status; the next-round directive when `deepen`. */
    readonly disposition: string
  }
  | {
    readonly id: string
    readonly kind: 'fact'
    readonly factKind: SrchunterFactKind
    readonly intentId: string
    readonly target: string
    readonly detail: string
    readonly confidence: number
  }
  | {
    readonly id: string
    readonly kind: 'finding'
    readonly intentId: string
    readonly title: string
    readonly severity: SrchunterSeverity
    readonly description: string
    /** Concrete, ordered steps that reproduce the vulnerability. */
    readonly steps: readonly string[]
    readonly affectedAssetId: string | undefined
    readonly vulnType: string
    /** Attribution: the education organization the asset belongs to, with its evidence. */
    readonly owner: string
    /** Quantified blast radius. */
    readonly impact: string
    /** Verbatim request/response packets (clamped to the projection packet cap). */
    readonly rawRequest: string
    readonly rawResponse: string
    /** One-shot reproduction command. */
    readonly poc: string
    /** Ordered "action → what it yielded" attack path. */
    readonly killChain: readonly string[]
    readonly score: number
    /** Which EduSRC strict-list category the leaked data hits; `none` disqualifies info leaks. */
    readonly strictListHit: SrchunterStrictList
    /** Self-check: the endpoint was verified to be a public display interface. */
    readonly publicInterface: boolean
  }

/** One asset of the engagement's asset graph. */
export interface SrchunterProjectionAsset {
  readonly id: string
  readonly type: SrchunterAssetType
  readonly value: string
  readonly meta: string
  readonly owner: string
}

/** One directed graph edge (source → target). */
export interface SrchunterProjectionEdge {
  readonly id: string
  readonly kind: SrchunterEdgeKind
  readonly sourceId: string
  readonly targetId: string
}

/** The standing srchunter state shown by the Web view tab. */
export interface SrchunterProjection {
  readonly goal: SrchunterProjectionGoal | null
  readonly nodes: readonly SrchunterProjectionNode[]
  readonly assets: readonly SrchunterProjectionAsset[]
  readonly edges: readonly SrchunterProjectionEdge[]
  readonly counts: {
    readonly intents: number
    readonly facts: number
    readonly findings: number
    readonly assets: number
  }
}
