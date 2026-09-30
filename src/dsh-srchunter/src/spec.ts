/**
 * Durable storage-domain declaration for the vulnerability-hunting mode: the
 * per-task exploration graph.
 *
 * One engagement (per session) starts at a **goal**; the exploration advances
 * along a chain — goal spawns **intents**, an intent yields **facts**, a fact
 * derives a new intent, and an intent proves a **finding** (vulnerability
 * with reproducible steps). **Assets** (root domain / subdomain / ip / service
 * / app / endpoint) form a second, parent-linked graph. Every relationship is
 * an explicit **edge** row, so both graphs are fully reconstructible.
 *
 * Everything is scoped to a single session: every record carries the owning
 * `sessionId`. Record schemas are zod; the domain schema validates every
 * stored record at the durable boundary (the storage-domain facility is the
 * package's guard, so no separate event invariant companion is needed).
 * @module @deepseek-ai/dsh-srchunter/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Kind of a discovered fact (free-form evidence tag). */
export const srchunterFactKindSchema = z.enum(['port', 'service', 'vuln', 'finding', 'http', 'info'])
/** Severity of a vulnerability finding. */
export const srchunterSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info'])
/** Kind of a recorded asset. */
export const srchunterAssetTypeSchema = z.enum(['root-domain', 'subdomain', 'ip', 'service', 'app', 'endpoint'])
/** Kind of an exploration/asset graph edge. */
export const srchunterEdgeKindSchema = z.enum(['spawns', 'yields', 'derived_from', 'proves', 'parent'])
/**
 * Destructive-action budget granted to execution agents. `readonly` proves
 * existence through reads only; `limited` allows reversible self-created
 * proof data (the create→verify→delete loop); `full` lifts the guidance for an
 * engagement the human explicitly authorized end to end.
 */
export const srchunterDestructiveSchema = z.enum(['readonly', 'limited', 'full'])
/**
 * The EduSRC strict-list categories: only these four kinds of leaked data are
 * accepted as 敏感信息泄露. Anything else (设备信息/姓名/手机号/邮箱/订单/统计) is
 * `none` and must be filed under another class or dropped.
 */
export const srchunterStrictListSchema = z.enum(['id-card-photo', 'face-photo', 'id-number', 'password-hash', 'none'])
/**
 * Reviewer disposition of one intent — the verdict of the exploration chain.
 * `open` awaits delegation; `working` is delegated; `done` reached a conclusion;
 * `deepen` is a real lead whose exploitation is not proven yet, so the
 * next-round directive is recorded in `disposition` instead of a finding;
 * `blocked` needs the human (credentials, registration, a scope call);
 * `dead_end` is a hypothesis disproven by evidence.
 */
export const srchunterIntentStatusSchema = z.enum(['open', 'working', 'done', 'deepen', 'blocked', 'dead_end'])

/** Non-empty id. */
const id = z.string().min(1)

/**
 * The realized-harm gate of the finding record, evaluated on a loose payload so
 * both write paths (model tools) and the replay fold reject the same shape.
 * A finding without a raw packet or a runnable PoC is a lead, and a lead belongs
 * on an intent's `disposition` (status `deepen`), never in the report's
 * vulnerability list. Returns the list of gaps; empty means proven.
 */
export function findingEvidenceGaps(finding: Record<string, unknown>): string[] {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const gaps: string[] = []
  if (text(finding.rawRequest) === '' && text(finding.rawResponse) === '' && text(finding.poc) === '') {
    gaps.push('rawRequest / rawResponse / poc（至少一份逐字原始报文，或可直接运行的 PoC）')
  }
  if (text(finding.impact) === '') gaps.push('impact（量化危害面：多少条记录、多少用户、哪些系统）')
  if (text(finding.owner) === '') gaps.push('owner（归属单位，或写明「待确认（原因…）」）')
  if (finding.publicInterface === true) gaps.push('publicInterface 为 true：匿名可访问的展示型接口不算漏洞')
  return gaps
}

/** The engagement goal: one per session, reset by the next goal. */
export const srchunterGoalSchema = z.object({
  id,
  sessionId: id,
  target: z.string(),
  objective: z.string(),
  /**
   * Declarative authorization note for the engagement (permission holder or
   * written-permission reference). Recorded as an auditable fact, not a
   * gate: enforcement stays at the deployment's sandbox/approval layer.
   */
  authorization: z.string().default(''),
  /** Destructive-action budget granted to execution agents. */
  destructive: srchunterDestructiveSchema.default('limited'),
})

/** One exploration intent (what to verify / pursue next) and its disposition. */
export const srchunterIntentSchema = z.object({
  id,
  sessionId: id,
  title: z.string().min(1),
  detail: z.string().default(''),
  /** Reviewer disposition; a fresh intent is always `open`. */
  status: srchunterIntentStatusSchema.default('open'),
  /**
   * Why the intent holds this disposition. For `deepen` it is the concrete
   * next-round directive (endpoint, parameter, action to prove); for `blocked`
   * it states exactly what the human must supply.
   */
  disposition: z.string().default(''),
})

/** One discovered fact (evidence) yielded by an intent. */
export const srchunterFactSchema = z.object({
  id,
  sessionId: id,
  intentId: id,
  kind: srchunterFactKindSchema,
  target: z.string().default(''),
  detail: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
})

/** One vulnerability finding proved by an intent, with reproducible steps. */
export const srchunterFindingSchema = z.object({
  id,
  sessionId: id,
  intentId: id,
  title: z.string().min(1),
  severity: srchunterSeveritySchema,
  description: z.string().default(''),
  /** Concrete, ordered steps that reproduce the vulnerability (min one). */
  reproducibleSteps: z.array(z.string().min(1)).min(1),
  /** Optional asset the finding affects. */
  affectedAssetId: id.optional(),
  /** Vulnerability class as reported (e.g. `unauthorized_access`, `idor`, `sqli`, `backdoor_compromised`). */
  vulnType: z.string().default(''),
  /**
   * Attribution: the organization the affected asset belongs to, with the
   * evidence of that attribution (ICP filing subject, certificate CN, domain,
   * page footer) — a report row without attribution cannot be filed.
   */
  owner: z.string().default(''),
  /** Quantified blast radius (how many records/users/systems, what was taken). */
  impact: z.string().default(''),
  /** Verbatim request packet proving the finding (same exchange as `rawResponse`). */
  rawRequest: z.string().default(''),
  /** Verbatim response packet proving the finding. */
  rawResponse: z.string().default(''),
  /** One-shot reproduction command (curl/python) a reviewer can rerun unchanged. */
  poc: z.string().default(''),
  /** Ordered "action → what it yielded" steps reconstructing the attack path. */
  killChain: z.array(z.string().min(1)).default([]),
  /** Numeric score inside the severity band (0-10). */
  score: z.number().min(0).max(10).default(0),
  /**
   * EduSRC 死规矩自检: which strict-list category the leaked data actually hits.
   * `none` means it cannot be filed as 敏感信息泄露 (设备信息/姓名/手机号/邮箱/
   * 订单/统计数据 are ordinary business data, not sensitive by the SRC's rule).
   */
  strictListHit: srchunterStrictListSchema.default('none'),
  /**
   * Self-check: the endpoint was verified to be a public display interface
   * (called anonymously by the front page or the mini program). A public
   * interface is neither information leakage nor unauthorized access.
   */
  publicInterface: z.boolean().default(false),
})

/** One recorded asset; parent linkage lives on the `parent` edge row. */
export const srchunterAssetSchema = z.object({
  id,
  sessionId: id,
  type: srchunterAssetTypeSchema,
  value: z.string().min(1),
  meta: z.string().default(''),
  /** Organization this asset belongs to, once attributed (with its evidence). */
  owner: z.string().default(''),
})

/** One graph edge: source → target with a semantic kind. */
export const srchunterEdgeSchema = z.object({
  id,
  sessionId: id,
  kind: srchunterEdgeKindSchema,
  sourceId: id,
  targetId: id,
})

/** The whole srchunter domain: goal/intent/fact/finding/asset nodes plus edges. */
export const srchunterDomainSpec = defineDomain({
  name: 'srchunter',
  // Stays at 2 on purpose: the sqlite backend stamps the descriptor version per
  // unit and rejects a mismatch outright (no in-place migration exists), so a
  // bump would strand every existing `srchunter-sessions.db`. These record fields
  // are additive and zod-filled by default, so old rows read unchanged.
  version: 2,
  tables: {
    goals: domainTable<string, z.infer<typeof srchunterGoalSchema>>(srchunterGoalSchema),
    intents: domainTable<string, z.infer<typeof srchunterIntentSchema>>(srchunterIntentSchema),
    facts: domainTable<string, z.infer<typeof srchunterFactSchema>>(srchunterFactSchema),
    findings: domainTable<string, z.infer<typeof srchunterFindingSchema>>(srchunterFindingSchema),
    assets: domainTable<string, z.infer<typeof srchunterAssetSchema>>(srchunterAssetSchema),
    edges: domainTable<string, z.infer<typeof srchunterEdgeSchema>>(srchunterEdgeSchema),
  },
})

export type SrchunterFactKind = z.infer<typeof srchunterFactKindSchema>
export type SrchunterSeverity = z.infer<typeof srchunterSeveritySchema>
export type SrchunterAssetType = z.infer<typeof srchunterAssetTypeSchema>
export type SrchunterEdgeKind = z.infer<typeof srchunterEdgeKindSchema>
export type SrchunterDestructive = z.infer<typeof srchunterDestructiveSchema>
export type SrchunterIntentStatus = z.infer<typeof srchunterIntentStatusSchema>
export type SrchunterStrictList = z.infer<typeof srchunterStrictListSchema>
export type SrchunterGoal = z.infer<typeof srchunterGoalSchema>
export type SrchunterIntent = z.infer<typeof srchunterIntentSchema>
export type SrchunterFact = z.infer<typeof srchunterFactSchema>
export type SrchunterFinding = z.infer<typeof srchunterFindingSchema>
export type SrchunterAsset = z.infer<typeof srchunterAssetSchema>
export type SrchunterEdge = z.infer<typeof srchunterEdgeSchema>
