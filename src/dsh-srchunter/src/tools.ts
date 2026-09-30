/**
 * Model-facing `srchunter_*` tools: record the exploration graph
 * (goal → intent → fact → intent → finding), record assets, read the current
 * state, and dump the graph or the final report for one session.
 *
 * Record ownership discipline: the decision agent writes and reads its own
 * graph with `srchunter_add_*` and read tools. Execution subagents use only
 * `srchunter_submit`, which resolves the parent session from session ancestry.
 * @module @deepseek-ai/dsh-srchunter/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { findingEvidenceGaps } from './spec.ts'
import type { SrchunterIntentStatus, SrchunterSeverity } from './spec.ts'
import type { AssetInput, FactInput, FindingInput, SrchunterStore, SrchunterStateView } from './store.ts'

/** Resolve the calling session id or fail a non-agent caller (like todo_write). */
function sessionIdOf(exec: { agent?: { session: { id: string } } }): string {
  if (!exec.agent) {
    throw new Error('srchunter_* 工具必须由拥有会话的 agent 调用')
  }
  return exec.agent.session.id
}

/** Resolve the only graph a delegated child is allowed to submit into. */
function parentSessionIdOf(exec: { agent?: { session: { header?: { parentSession?: string } } } }): string {
  const parentSessionId = exec.agent?.session.header?.parentSession
  if (parentSessionId === undefined || parentSessionId === '') {
    throw new Error('srchunter_submit 只有被委派、且带父会话的子 agent 才能调用')
  }
  return parentSessionId
}

function requiredString(value: unknown, name: string, prefix = 'srchunter_submit'): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${prefix} 缺少必填参数 ${name}`)
  return value
}

/** Reject prompt variables before they are mistaken for a parent graph id. */
function concreteIntentId(value: string): string {
  const normalized = value.trim()
  if (/^(?:[<{[]\s*)?(?:delegation[-_])?intent[-_]?id(?:\s*[>}\]])?$/i.test(normalized)) {
    throw new Error(`srchunter_submit 需要 srchunter_add_intent 返回的真实父意图 id；收到的是占位符 ${JSON.stringify(value)}`)
  }
  return normalized
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function submissionList(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    throw new Error(`srchunter_submit 的 ${name} 必须是对象数组`)
  }
  return value as Record<string, unknown>[]
}

function stringList(value: unknown, name: string, prefix = 'srchunter_submit'): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string' && item !== '')) {
    throw new Error(`${prefix} 的 ${name} 必须是非空字符串数组`)
  }
  return value
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number], name: string, prefix = 'srchunter_submit'): T[number] {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T[number]
  throw new Error(`${prefix} 的 ${name} 只能取以下值之一：${allowed.join(', ')}`)
}

/** Optional list of non-empty strings (defaults to empty). `label` is the full call site. */
function optionalStringList(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item !== '')) {
    throw new Error(`${label} 必须是非空字符串数组`)
  }
  return value
}

/** A 0-10 severity score; a numeric string is accepted, anything absent scores 0. */
function scoreValue(value: unknown, label: string): number {
  if (value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(typeof value === 'string' ? value.trim() : Number.NaN)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
    throw new Error(`${label} 必须是 0 到 10 之间的分值`)
  }
  return parsed
}

/** A boolean flag tolerant of the `"true"` string form models send. */
function boolValue(value: unknown): boolean {
  return value === true || value === 'true'
}

function confidenceValue(value: unknown): number {
  if (value === undefined) return 0.5
  const text = typeof value === 'string' ? value.trim() : undefined
  const isPercent = text?.endsWith('%') === true
  const parsed = typeof value === 'number'
    ? value
    : text === undefined || text === '' ? Number.NaN : Number(isPercent ? text.slice(0, -1) : text)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('srchunter_submit 的 confidence 必须是 0..1 的小数，或 0 到 100 的百分数')
  }
  if (isPercent || parsed > 1) {
    if (parsed > 100) throw new Error('srchunter_submit 的 confidence 必须是 0..1 的小数，或 0 到 100 的百分数')
    return parsed / 100
  }
  return parsed
}

/** Completed generic card for the read-only projections: a domain title over the raw content. */
function titledCard(title: string, result: ToolResult): ToolResultView | undefined {
  if (result.isError) return undefined
  return { card: 'generic', title, content: result.content }
}

/** The closed enum values exposed by the tools. */
const FACT_KINDS = ['port', 'service', 'vuln', 'finding', 'http', 'info'] as const
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
const ASSET_TYPES = ['root-domain', 'subdomain', 'ip', 'service', 'app', 'endpoint'] as const
const STRICT_LISTS = ['id-card-photo', 'face-photo', 'id-number', 'password-hash', 'none'] as const
const DESTRUCTIVES = ['readonly', 'limited', 'full'] as const
/** Dispositions the adjudication tool can set (`open` only exists at creation). */
const ADJUDICATION_STATUSES = ['working', 'done', 'deepen', 'blocked', 'dead_end'] as const
/** Adjudications that never stand without a concrete directive. */
const NEEDS_DIRECTIVE: readonly string[] = ['deepen', 'blocked', 'dead_end']

/**
 * Build one finding record from a loose payload and enforce the realized-harm
 * gate at the write boundary: a finding without a raw packet/PoC, without
 * quantified impact, or self-reported as a public interface is a lead, and the
 * rejection message points the caller at the lead path (fact + deepen intent).
 * @param prefix - the tool name carrying the write (`srchunter_submit`, `srchunter_add_finding`).
 * @param field - the item path inside that call (`findings[0]`, `finding`).
 */
function toFindingInput(intentId: string, raw: Record<string, unknown>, prefix: string, field: string): FindingInput {
  const at = (name: string): string => `${prefix} ${field}.${name}`
  const finding: FindingInput = {
    intentId,
    title: requiredString(raw.title, `${field}.title`, prefix),
    severity: enumValue(raw.severity, SEVERITIES, 'info', `${field}.severity`, prefix),
    description: optionalString(raw.description),
    reproducibleSteps: stringList(raw.reproducibleSteps, `${field}.reproducibleSteps`, prefix),
    ...(typeof raw.affectedAssetId === 'string' && raw.affectedAssetId !== '' ? { affectedAssetId: raw.affectedAssetId } : {}),
    vulnType: optionalString(raw.vulnType),
    owner: optionalString(raw.owner),
    impact: optionalString(raw.impact),
    rawRequest: optionalString(raw.rawRequest),
    rawResponse: optionalString(raw.rawResponse),
    poc: optionalString(raw.poc),
    killChain: optionalStringList(raw.killChain, at('killChain')),
    score: scoreValue(raw.score, at('score')),
    strictListHit: enumValue(raw.strictListHit, STRICT_LISTS, 'none', `${field}.strictListHit`, prefix),
    publicInterface: boolValue(raw.publicInterface),
  }
  const gaps = findingEvidenceGaps(finding as unknown as Record<string, unknown>)
  if (gaps.length > 0) {
    throw new Error(`${prefix} 的 ${field} 不是已证实的漏洞——还缺 ${gaps.join('；')}。`
      + '请把它记成 fact，并用 srchunter_set_intent 把该意图裁决为 deepen、写清下一轮的具体定向指令。')
  }
  return finding
}

let submissionProjectionEvent = 0

/**
 * Drive the live parent projection from a delegated write. The durable graph
 * lives in storage, while the Web client consumes the session projection;
 * regular tool calls are the shared, known event vocabulary that updates both
 * the projection and history replay without introducing a custom session event.
 */
function appendSubmissionProjection(
  parent: unknown,
  intentId: string,
  facts: FactInput[],
  assets: AssetInput[],
  findings: FindingInput[],
): void {
  const append = (parent as { append: (type: 'tool/call', data: Record<string, unknown>) => unknown }).append.bind(parent)
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [
    ...facts.map(fact => ({ name: 'srchunter_add_fact', args: { ...fact, intentId } })),
    ...assets.map(asset => ({ name: 'srchunter_add_asset', args: { ...asset } })),
    ...findings.map(finding => ({ name: 'srchunter_add_finding', args: { ...finding, intentId } })),
  ]
  for (const call of calls) {
    submissionProjectionEvent += 1
    append('tool/call', {
      turn: 0,
      step: submissionProjectionEvent,
      callId: `srchunter-submit-${submissionProjectionEvent}`,
      name: call.name,
      arguments: JSON.stringify(call.args),
    })
  }
}

/** Build the exploration-chain dump for one session (pure projection). */
function buildGraph(state: SrchunterStateView): {
  goal: SrchunterStateView['goal'] | null
  intents: SrchunterStateView['intents']
  facts: SrchunterStateView['facts']
  findings: SrchunterStateView['findings']
  assets: SrchunterStateView['assets']
  edges: SrchunterStateView['edges']
} {
  return {
    goal: state.goal ?? null,
    intents: state.intents,
    facts: state.facts,
    findings: state.findings,
    assets: state.assets,
    edges: state.edges,
  }
}

/** Severity ordering for the report, strongest first. */
const SEVERITY_RANK: Record<SrchunterSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

/** Chinese labels of the intent dispositions, as the report reads them. */
const INTENT_STATUS_LABEL: Record<SrchunterIntentStatus, string> = {
  open: '待委派',
  working: '执行中',
  done: '已结论',
  deepen: '待深挖',
  blocked: '需人介入',
  dead_end: '已否证',
}

/** One fenced evidence block, tolerant of backticks inside a raw packet. */
function packetBlock(label: string, content: string): string[] {
  if (content === '') return []
  const fence = content.includes('```') ? '~~~~' : '```'
  return [`- ${label}:`, '', `${fence}`, content, `${fence}`, '']
}

/** Build the final report for one session (pure projection). */
function buildReport(state: SrchunterStateView): string {
  if (state.goal === undefined) {
    return ['# 漏洞挖掘报告', '', '（未初始化：尚未调用 srchunter_add_goal。）'].join('\n')
  }
  const goal = state.goal
  const anchorOf = (targetId: string): string => {
    const edge = state.edges.find(e => e.targetId === targetId)
    /* v8 ignore next 1 -- unreachable: the store writes the connecting edge with every node. */
    return edge === undefined ? '?' : `${edge.kind} ${edge.sourceId}`
  }
  const chainLines = [
    `- 目标 (goal ${goal.id})「${goal.target}」— 目的: ${goal.objective}`,
    ...state.intents.map(intent => `- 意图 (intent ${intent.id})「${intent.title}」(${anchorOf(intent.id)}) [${INTENT_STATUS_LABEL[intent.status]}]${intent.detail === '' ? '' : ` ${intent.detail}`}${intent.disposition === '' ? '' : ` → ${intent.disposition}`}`),
    ...state.facts.map(fact => `- 事实 (fact ${fact.id}) [${fact.kind}] ${fact.target === '' ? '' : `${fact.target}: `}${fact.detail} (${anchorOf(fact.id)})`),
    ...state.findings.map(finding => `- 漏洞 (finding ${finding.id}) [${finding.severity}/${finding.score}] ${finding.title} (${anchorOf(finding.id)})`),
  ]
  // Strongest harm first: the report is the SRC submission draft, so a reviewer
  // reads the top of the list, not the order the graph happened to fill in.
  const ranked = [...state.findings].sort((a, b) => b.score - a.score
    || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || Number(/-(\d+)$/.exec(a.id)?.[1] ?? 0) - Number(/-(\d+)$/.exec(b.id)?.[1] ?? 0))
  const findingSections = ranked.map((finding) => {
    const asset = finding.affectedAssetId === undefined ? undefined : state.assets.find(a => a.id === finding.affectedAssetId)
    return [
      `### ${finding.id} [${finding.severity} / ${finding.score}] ${finding.title}`,
      `- 类型: ${finding.vulnType === '' ? '（未分类）' : finding.vulnType}`,
      `- 归属单位: ${finding.owner === '' ? '待确认' : finding.owner}`,
      `- 影响资产: ${asset === undefined ? '（未关联）' : `[${asset.type}] ${asset.value}`}`,
      `- 危害量化: ${finding.impact === '' ? '（未量化）' : finding.impact}`,
      `- 描述: ${finding.description === '' ? '（无）' : finding.description}`,
      `- 死规矩自检: 敏感数据类别 ${finding.strictListHit}；公开接口 ${finding.publicInterface ? '是' : '否'}`,
      ...(finding.killChain.length === 0
        ? ['- 攻击链路: （未记录）']
        : ['- 攻击链路:', ...finding.killChain.map((step, index) => `  ${index + 1}. ${step}`)]),
      '- 可复现步骤:',
      ...finding.reproducibleSteps.map((step, index) => `  ${index + 1}. ${step}`),
      '',
      ...packetBlock('PoC', finding.poc),
      ...packetBlock('原始请求包', finding.rawRequest),
      ...packetBlock('原始响应包', finding.rawResponse),
    ].join('\n')
  })
  // Leads the engagement is handing off: what still needs digging, what needs a
  // human, and what evidence already refuted — never implied, always recorded.
  const handoff = (['deepen', 'blocked', 'dead_end'] as const).flatMap((status) => {
    const intents = state.intents.filter(intent => intent.status === status)
    if (intents.length === 0) return []
    return [
      `### ${INTENT_STATUS_LABEL[status]}`,
      ...intents.map(intent => `- intent ${intent.id}「${intent.title}」${intent.disposition === '' ? '（未写清交棒内容）' : `：${intent.disposition}`}`),
      '',
    ]
  })
  const assetLines = state.assets.map((asset) => {
    const parent = state.edges.find(e => e.kind === 'parent' && e.targetId === asset.id)
    const parentAsset = parent === undefined ? undefined : state.assets.find(a => a.id === parent.sourceId)
    return `- [${asset.type}] ${asset.value}${asset.meta === '' ? '' : `（${asset.meta}）`}${asset.owner === '' ? '' : ` — 归属: ${asset.owner}`}${parentAsset === undefined ? '' : ` ← ${parentAsset.value}`}`
  })
  const unresolved = state.intents.filter(intent => intent.status === 'open' || intent.status === 'working').length
  return [
    '# 漏洞挖掘报告',
    '',
    `- 目标 (target): ${goal.target}`,
    `- 目的 (objective): ${goal.objective}`,
    `- 授权 (authorization): ${goal.authorization === '' ? '（未声明）' : goal.authorization}`,
    `- 破坏性档位 (destructive): ${goal.destructive}`,
    `- 规模: ${state.findings.length} 个已证实漏洞，${state.facts.length} 条事实，${state.assets.length} 项资产，${unresolved} 个意图尚未收口`,
    '',
    '## 漏洞发现（按危害排序）',
    ...(findingSections.length === 0 ? ['（无已证实漏洞：结论为未发现可提交的实锤危害，或相关线索仍在待深挖清单中）'] : findingSections),
    '',
    '## 交棒清单',
    ...(handoff.length === 0 ? ['（无待深挖、需人介入或已否证的意图）'] : handoff),
    '',
    '## 资产',
    ...(assetLines.length === 0 ? ['（无）'] : assetLines),
    '',
    '## 探索链路',
    ...(chainLines.length === 1 ? ['（仅目标，尚未展开）'] : chainLines),
    '',
  ].join('\n')
}

/** Register all `srchunter_*` tools on the caller's tool registry. */
export function registerSrchunterTools(ctx: Context, store: SrchunterStore): void {
  ctx.tools.register(defineTool({
    name: 'srchunter_submit',
    description: '把新确认的委派执行结果立刻直接提交进指定的父意图。只有子 agent 可用：它把事实、资产和已证实漏洞写进父会话的链路图，刷新父会话投影，然后只返回提交条数。用它做实时检查点；同一条内容绝不重复提交。parentId 与 affectedAssetId 只能引用委派提示里给到的、父会话中已存在的资产 id；本次新提交的资产请省略这两个字段。',
    parameters: {
      intentId: { type: 'string', required: true, description: '委派提示里给出的那个父意图 id。' },
      facts: { type: 'array', required: true, description: '要挂到父意图上的已观察事实。', items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', enum: FACT_KINDS, description: '事实类别（默认 info）。' },
        target: { type: 'string', description: '这条事实指向的主机、URL 或服务。' },
        detail: { type: 'string', required: true, description: '已确认的证据内容。' },
        confidence: { oneOf: [
          { type: 'number', description: '置信度 0..1，或以百分数表示的 0..100。' },
          { type: 'string', description: '形如 "90%" 的百分数。' },
        ] },
      } } },
      assets: { type: 'array', required: true, description: '执行过程中新发现的资产。parentId 只能引用委派提示里给到的、父会话中已存在的资产 id。', items: { type: 'object', additionalProperties: true, properties: {
        type: { type: 'string', required: true, enum: ASSET_TYPES, description: '资产类型：root-domain / subdomain / ip / service / app / endpoint。' },
        value: { type: 'string', required: true, description: '资产值。' },
        parentId: { type: 'string', description: '已知时填父资产 id（必须是父会话里已存在的资产）。' },
        meta: { type: 'string', description: '可选的资产附加信息。' },
        owner: { type: 'string', description: '归属单位（学校全称 + 归属依据：.edu.cn / ICP 主体 / 证书 CN / 页脚 / 后台 org 字段），未核实写「待确认（原因）」。' },
      } } },
      findings: { type: 'array', required: true, description: '只提交已实锤的漏洞——每条都要有逐字原始报文或可运行的 PoC、量化危害、归属单位，缺任一项整批会被拒（未证实的线索请记成 fact，让指挥官把意图裁决为 deepen）。affectedAssetId 只能引用委派提示里给到的、父会话中已存在的资产 id。', items: { type: 'object', additionalProperties: false, properties: {
        title: { type: 'string', required: true, description: '简短的漏洞标题。' },
        severity: { type: 'string', enum: SEVERITIES, description: '危害等级（默认 info）。' },
        description: { type: 'string', description: '危害与后果，不是操作流水账。' },
        reproducibleSteps: { type: 'array', required: true, description: '一条或多条有序的可复现命令、请求或动作。', items: { type: 'string' } },
        affectedAssetId: { type: 'string', description: '已知时填受影响的父会话资产 id。' },
        vulnType: { type: 'string', description: '按提交口径的漏洞类型，例如 unauthorized_access / idor / sqli / weak_password / file_upload / backdoor_compromised。' },
        owner: { type: 'string', description: '必填：归属的教育单位 + 该归属的依据，或写明「待确认（原因）」。' },
        impact: { type: 'string', description: '必填：量化影响面——多少条记录/多少用户/哪些系统，实际拿到了或改动了什么。' },
        rawRequest: { type: 'string', description: '与 rawResponse 同一次交互的逐字请求包。' },
        rawResponse: { type: 'string', description: '证明危害的逐字响应包（响应头 + 能证明问题的若干行；长正文标「…(已截断)」，取样内容写进 impact）。' },
        poc: { type: 'string', description: '一条即可复现的命令（curl/python），审核人能原样重跑。' },
        killChain: { type: 'array', description: '还原真实攻击路径的有序步骤，每步写「做了什么 → 拿到了什么」。', items: { type: 'string' } },
        score: { type: 'number', description: '该危害等级区间内的分值 0-10。' },
        strictListHit: { type: 'string', enum: STRICT_LISTS, description: 'EduSRC 死规矩（信息泄露类）：id-card-photo / face-photo / id-number / password-hash；取 none 则信息泄露类不予接收。' },
        publicInterface: { type: 'boolean', description: '自查：该接口是否对匿名公众（首页/小程序）直接开放——是就不算漏洞。' },
      } } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        facts: { type: 'number', required: true },
        assets: { type: 'number', required: true },
        findings: { type: 'number', required: true },
      } },
      render: (_a, value) => [{ type: 'text', text: `已向父会话提交 ${value.facts} 条事实、${value.assets} 项资产、${value.findings} 条漏洞。` }],
    },
    execute: async (args, exec) => {
      const parentSessionId = parentSessionIdOf(exec)
      const input = args as Record<string, unknown>
      const intentId = concreteIntentId(requiredString(input.intentId, 'intentId'))
      const facts = submissionList(input.facts, 'facts')
      const assets = submissionList(input.assets, 'assets')
      const findings = submissionList(input.findings, 'findings')
      // Do not persist a partial submission which cannot be surfaced through
      // the parent session projection.
      const parent = ctx.sessions.get(parentSessionId as never)
      if (parent === undefined) throw new Error(`srchunter_submit 的父会话 ${parentSessionId} 当前不在运行中`)

      const factWrites: FactInput[] = facts.map(fact => ({
          intentId,
          kind: enumValue(fact.kind, FACT_KINDS, 'info', 'fact.kind'),
          target: optionalString(fact.target),
          detail: requiredString(fact.detail, 'fact.detail'),
          confidence: confidenceValue(fact.confidence),
      }))
      const assetWrites: AssetInput[] = assets.map(asset => ({
          type: enumValue(asset.type, ASSET_TYPES, 'endpoint', 'asset.type'),
          value: requiredString(asset.value, 'asset.value'),
          meta: optionalString(asset.meta),
          owner: optionalString(asset.owner),
          ...(typeof asset.parentId === 'string' ? { parentId: asset.parentId } : {}),
      }))
      const findingWrites: FindingInput[] = findings.map((finding, index) =>
        toFindingInput(intentId, finding, 'srchunter_submit', `findings[${index}]`))
      await store.addSubmission(parentSessionId, intentId, factWrites, assetWrites, findingWrites)
      appendSubmissionProjection(parent, intentId, factWrites, assetWrites, findingWrites)
      return { facts: facts.length, assets: assets.length, findings: findings.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'srchunter_add_goal',
    description: '开启一次 EduSRC（教育行业 SRC）漏洞挖掘作业：设定目标、目的、授权说明与破坏性动作预算，并会重置本会话的整张探索链路图（新的 goal 就是从一条全新链路开始）。记录意图、事实、漏洞或资产之前必须先调用一次。`authorization` 只是留档声明（谁给的授权，或书面许可的编号），不是准入闸门——真正的拦截在部署沙箱；`destructive` 规定执行 agent 可以走到哪一步：readonly 只靠读取来证明，limited（默认）允许对自己创建的测试数据做「建→验→删」闭环，full 只在人类端到端全程授权后才用。',
    parameters: {
      target: { type: 'string', required: true, description: '挖掘目标（主机、URL、网段范围或仓库路径）。' },
      objective: { type: 'string', required: true, description: '本次作业的目的 / 完成标准。' },
      authorization: { type: 'string', description: '可选的留档授权说明（谁授权本次作业，或书面许可编号）。' },
      destructive: { type: 'string', enum: DESTRUCTIVES, description: '给执行 agent 的破坏性预算：readonly / limited（默认，仅自建举证数据）/ full。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        target: { type: 'string', required: true },
        objective: { type: 'string', required: true },
      } },
      render: (_a, v) => [{ type: 'text', text: `已记录目标 ${v.id} → ${v.target}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const goal = await store.initGoal(sessionId, {
        target: args.target,
        objective: args.objective,
        authorization: args.authorization ?? '',
        destructive: args.destructive ?? 'limited',
      })
      return { id: goal.id, target: goal.target, objective: goal.objective }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'srchunter_add_intent',
    description: '把一条探索意图（下一步要验证 / 要追查什么）记成链路图上的节点。必须且只能用其中一个锚点：goalId（spawns：朝目标推进的一条待验证意图）或 derivedFromFactId（derived_from：由此前已记录的事实派生出的新意图）。边的类型会自动记录。',
    parameters: {
      title: { type: 'string', required: true, description: '简短的意图标题（例如「枚举 Web 接口」）。' },
      detail: { type: 'string', description: '可选补充（范围、假设、期望拿到的证据）。' },
      goalId: { type: 'string', description: '锚点 goal id（spawns 边）。goalId / derivedFromFactId 二者必选其一。' },
      derivedFromFactId: { type: 'string', description: '锚点 fact id（derived_from 边）。goalId / derivedFromFactId 二者必选其一。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        title: { type: 'string', required: true },
        edgeId: { type: 'string', required: true },
        edgeKind: { type: 'string', required: true },
        sourceId: { type: 'string', required: true },
      } },
      render: (_a, v) => [{ type: 'text', text: `已记录意图 ${v.id}「${v.title}」（${v.edgeKind} ${v.sourceId} → ${v.id}，边 ${v.edgeId}）。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const write = await store.addIntent(sessionId, {
        title: args.title,
        detail: args.detail ?? '',
        ...(args.goalId !== undefined ? { goalId: args.goalId } : {}),
        ...(args.derivedFromFactId !== undefined ? { derivedFromFactId: args.derivedFromFactId } : {}),
      })
      /* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for intent writes. */
      return { id: write.nodeId, title: args.title, edgeId: write.edge?.id ?? '', edgeKind: write.edge?.kind ?? '', sourceId: write.edge?.sourceId ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'srchunter_set_intent',
    description: '裁决一条意图——这是探索链路的审核结论，也是关闭意图的唯一途径。状态取值：`working`（已委派，等子 agent 回来）、`done`（已有结论：记下了漏洞，或假设被证伪）、`deepen`（确实是真线索但利用尚未证实——`disposition` 必须写清下一轮的具体定向指令：哪个接口、哪个参数、做什么才能证实）、`blocked`（需要人来补——`disposition` 必须说清究竟要补什么，例如注册验证码或一个账号）、`dead_end`（已被证据否证——`disposition` 写清是什么把它否证了）。未证实的线索绝不写进 finding；`deepen` 也不是垃圾桶：明显不予接收的类别（反射型 XSS、phpinfo、用户名枚举）以及已证实不可利用的东西，一律不要给 deepen。这是决策 agent 的工具，执行子 agent 无法调用。',
    parameters: {
      intentId: { type: 'string', required: true, description: '要裁决的意图 id。' },
      status: { type: 'string', required: true, enum: ADJUDICATION_STATUSES, description: '新的裁决态：working / done / deepen / blocked / dead_end。' },
      disposition: { type: 'string', description: '为什么成立在这个状态上。deepen、blocked、dead_end 三者必填，而且必须具体。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        status: { type: 'string', required: true },
        disposition: { type: 'string', required: true },
      } },
      render: (_a, v) => [{ type: 'text', text: `已裁决意图 ${v.id} → ${v.status}${v.disposition === '' ? '' : `：${v.disposition}`}` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const disposition = args.disposition ?? ''
      if (NEEDS_DIRECTIVE.includes(args.status) && disposition.trim() === '') {
        throw new Error(`srchunter_set_intent 在状态为 '${args.status}' 时必须给出具体 disposition（下一轮的定向指令、需要人补的东西，或否证依据）`)
      }
      const intent = await store.setIntent(sessionId, {
        intentId: args.intentId,
        status: args.status,
        disposition,
      })
      return { id: intent.id, status: intent.status, disposition: intent.disposition }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'srchunter_add_fact',
    description: '记录一条由意图产出的已发现事实（证据）。这是决策 agent 的工具；执行子 agent 通过 srchunter_submit 提交事实。',
    parameters: {
      intentId: { type: 'string', required: true, description: '产出这条事实的意图 id（yields 边）。' },
      detail: { type: 'string', required: true, description: '事实内容（例如「tcp/80 开放」「登录接口用默认口令返回 200」）。' },
      kind: { type: 'string', enum: FACT_KINDS, description: '事实类别（默认 info）。' },
      target: { type: 'string', description: '这条事实指向的主机 / URL / 服务。' },
      confidence: { oneOf: [
        { type: 'number', description: '置信度 0..1，或以百分数表示的 0..100。' },
        { type: 'string', description: '形如 "90%" 的百分数。' },
      ], description: '置信度（默认 0.5）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        kind: { type: 'string', required: true },
        detail: { type: 'string', required: true },
        edgeId: { type: 'string', required: true },
      } },
      render: (_a, v) => [{ type: 'text', text: `已记录事实 ${v.id} [${v.kind}] ${v.detail}（边 ${v.edgeId}）。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const write = await store.addFact(sessionId, {
        intentId: args.intentId,
        kind: args.kind ?? 'info',
        target: args.target ?? '',
        detail: args.detail,
        confidence: confidenceValue(args.confidence),
      })
      /* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for fact writes. */
      return { id: write.nodeId, kind: args.kind ?? 'info', detail: args.detail, edgeId: write.edge?.id ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'srchunter_add_finding',
    description: '记录一条由意图证明（proves 边）的、已实锤的漏洞。实锤危害门槛就在这里执行：除了具体有序、至少一条的 reproducibleSteps，这条漏洞还必须带上逐字原始报文或可运行的 PoC、量化危害 impact、归属单位 owner；缺任何一项它就只是线索——请改记 fact，并用 srchunter_set_intent 把该意图裁决为 deepen。可选关联受影响的资产。',
    parameters: {
      intentId: { type: 'string', required: true, description: '证明这条漏洞的意图 id（proves 边）。' },
      title: { type: 'string', required: true, description: '简短的漏洞标题（例如「/search 存在 SQL 注入」）。' },
      severity: { type: 'string', required: true, enum: SEVERITIES, description: '危害等级：critical / high / medium / low / info。' },
      reproducibleSteps: { type: 'array', required: true, description: '能复现该漏洞的有序步骤（命令、请求或动作）。至少一条（持久化层会强制校验）。', items: { type: 'string' } },
      description: { type: 'string', description: '影响 / 成因描述。' },
      affectedAssetId: { type: 'string', description: '可选：这条漏洞影响到的资产 id。' },
      vulnType: { type: 'string', description: '按提交口径的漏洞类型，例如 unauthorized_access / idor / sqli / weak_password / file_upload / backdoor_compromised。' },
      owner: { type: 'string', description: '必填：归属的教育单位，并附上归属依据（.edu.cn / ICP 主体 / 证书 CN / 页面页脚 / 后台 org 字段），或写明「待确认（原因）」。' },
      impact: { type: 'string', description: '必填：量化影响面——触达多少记录/用户/系统，实际拿到了或改动了什么。' },
      rawRequest: { type: 'string', description: '与 rawResponse 同一次交互的逐字请求包。' },
      rawResponse: { type: 'string', description: '证明危害的逐字响应包（长正文：保留能证明问题的几行并标注已截断）。' },
      poc: { type: 'string', description: '一条即可复现的命令（curl/python），审核人能原样重跑。' },
      killChain: { type: 'array', description: '还原真实攻击路径的有序步骤，每步写「做了什么 → 拿到了什么」。', items: { type: 'string' } },
      score: { type: 'number', description: '该危害等级区间内的分值 0-10。' },
      strictListHit: { type: 'string', enum: STRICT_LISTS, description: 'EduSRC 死规矩（信息泄露类）：id-card-photo / face-photo / id-number / password-hash；取 none 则信息泄露类不予接收。' },
      publicInterface: { type: 'boolean', description: '自查：该接口是否对匿名公众（首页/小程序）直接开放——是就不算漏洞。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        title: { type: 'string', required: true },
        severity: { type: 'string', required: true },
        edgeId: { type: 'string', required: true },
      } },
      render: (_a, v) => [{ type: 'text', text: `已记录漏洞 ${v.id} [${v.severity}] ${v.title}（边 ${v.edgeId}）。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const write = await store.addFinding(sessionId,
        toFindingInput(args.intentId, args as unknown as Record<string, unknown>, 'srchunter_add_finding', 'finding'))
      /* v8 ignore next 1 -- unreachable: the store always writes the connecting edge for finding writes. */
      return { id: write.nodeId, title: args.title, severity: args.severity, edgeId: write.edge?.id ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'srchunter_add_asset',
    description: '记录本次作业的一项资产：root-domain、subdomain、ip、service、app 或 endpoint。可选把它挂到父资产上（parentId，例如子域挂在主域下、服务挂在 ip 下），资产图才能反映真实归属。parentId 可以省略或留空表示根资产。请先记录父资产再记录子资产，并复用返回的 id。',
    parameters: {
      type: { type: 'string', required: true, enum: ASSET_TYPES, description: '资产类型：root-domain / subdomain / ip / service / app / endpoint。' },
      value: { type: 'string', required: true, description: '资产值（例如 "example.com"、"10.0.0.5"、"nginx/1.24"）。' },
      parentId: { type: 'string', description: '可选的父资产 id（parent 边，例如拥有这个 endpoint 的子域）。' },
      meta: { type: 'string', description: '可选的自由格式信息（版本、技术栈、备注）。' },
      owner: { type: 'string', description: '该资产归属的单位（学校全称 + 归属依据），确认后填写；未核实时留空。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        type: { type: 'string', required: true },
        value: { type: 'string', required: true },
        edgeId: { type: 'string' },
      } },
      render: (_a, v) => [{ type: 'text', text: `已记录资产 ${v.id} [${v.type}] ${v.value}${v.edgeId === undefined ? '' : `（父边 ${v.edgeId}）`}。` }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const write = await store.addAsset(sessionId, {
        type: args.type,
        value: args.value,
        ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
        meta: args.meta ?? '',
        owner: args.owner ?? '',
      })
      return {
        id: write.nodeId,
        type: args.type,
        value: args.value,
        ...(write.edge !== undefined ? { edgeId: write.edge.id } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'srchunter_state',
    description: '读取本会话当前的漏洞挖掘状态：目标、各类记录条数，以及节点/资产的简要清单。用它来决定下一步往哪条线探索。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          initialized: { type: 'boolean', required: true },
          goal: { type: 'object', additionalProperties: true, properties: {} },
          counts: { type: 'object', additionalProperties: true, properties: {} },
          intents: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          facts: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          findings: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          assets: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
          edges: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
        },
      },
      render: (_a, v) => {
        const view = v as unknown as SrchunterStateView
        if (!view.initialized || view.goal === undefined) {
          return [{ type: 'text', text: '尚未初始化：请带上 target 和 objective 调用 srchunter_add_goal。' }]
        }
        const goal = view.goal
        const join = (rows: readonly string[]): string => rows.join('；') || '无'
        const body = `目标：${goal.target} | 目的：${goal.objective} | 破坏性档位：${goal.destructive} | 意图 ${view.counts.intents} 条、事实 ${view.counts.facts} 条、漏洞 ${view.counts.findings} 条、资产 ${view.counts.assets} 项。意图：${join(view.intents.map(i => `${i.id}「${i.title}」[${i.status}${i.disposition === '' ? '' : `：${i.disposition}`}]`))}。事实：${join(view.facts.map(f => `${f.id} [${f.kind}] ${f.detail}`))}。漏洞：${join(view.findings.map(f => `${f.id} [${f.severity}/${f.score}] ${f.title}`))}。资产：${join(view.assets.map(a => `${a.id} [${a.type}] ${a.value}`))}。`
        return [{ type: 'text', text: body }]
      },
    },
    presentResult: (_args, result) => titledCard('漏洞挖掘状态', result),
    execute: async (_args, exec) => {
      const sessionId = sessionIdOf(exec)
      const view = await store.view(sessionId)
      // The view's record shapes are richer than the schema's permissive JSON
      // item types; the runtime value round-trips fine and the render below
      // re-narrows it.
      return view as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'srchunter_graph',
    description: '把本会话完整的探索链路图以 JSON 导出：goal、intents、facts、findings、assets，以及所有的边（spawns / yields / derived_from / proves / parent）。出报告之前用它复盘链路。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { graph: { type: 'object', additionalProperties: true, properties: {} } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v.graph) }],
    },
    presentResult: (_args, result) => titledCard('漏洞挖掘探索图', result),
    execute: async (_args, exec) => {
      const sessionId = sessionIdOf(exec)
      const state = await store.view(sessionId)
      // The graph is richer than the schema's permissive object item type; the
      // runtime value round-trips fine and the render stringifies it.
      return { graph: buildGraph(state) } as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'srchunter_report',
    description: '生成本会话的最终 Markdown 报告：目标、探索链路（goal → intents → facts → 派生 intents → findings）、每条漏洞及其可复现步骤，以及资产图。作业收尾时调用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { markdown: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.markdown }],
    },
    presentResult: (_args, result) => titledCard('漏洞挖掘报告', result),
    execute: async (_args, exec) => {
      const sessionId = sessionIdOf(exec)
      const state = await store.view(sessionId)
      return { markdown: buildReport(state) }
    },
  }))
}
