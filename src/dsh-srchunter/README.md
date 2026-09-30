# @deepseek-ai/dsh-srchunter

English | [中文](README.zh.md)

Vulnerability-hunting mode for the DeepSeek Harness: an **exploration chain** — goal → intent → fact →
derived intent → finding — where a decision agent (root agent) delegates exploration/execution to subagents,
keeps every node and edge in durable records, and records **assets** (根域名 / 子域名 / IP / 服务 / App /
端点) with parent links. Every vulnerability **finding must clear the realized-harm gate** (a verbatim raw
packet or a runnable PoC, a quantified impact and an attributed owner, plus reproducible steps); a real but
unproven lead is recorded on an intent's `disposition` with status `deepen` instead. Human inputs land at
the decision gate via `ask_user_question` or as a directly submitted intent. The package is the single
deliverable: it wires the durable `srchunter` storage domain, the nine model-facing `srchunter_*` tools, and the
decision-agent protocol prompt section.

**Record ownership:** the decision agent records, adjudicates (`srchunter_set_intent`) and reports the graph.
Exploration/execution subagents write their own confirmed results straight into the delegated parent intent
with `srchunter_submit` — the only `srchunter_*` tool they may call; the rest are keyed to the calling agent's own
session, so a child cannot touch the parent graph or its own goal-less session.

## Configuration

The plugin takes no configuration. It requires the `ctx.tools` registry and the `ctx.storageDomain` facility;
it also contributes the protocol section when `ctx.systemPrompt` is composed. Compose the storage hub
(`@deepseek-ai/dsh-storage`), a storage backend (`@deepseek-ai/dsh-storage-sqlite`), and the storage-domain
facility in the same profile overlay.

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-sqlite
  name: '@deepseek-ai/dsh-storage-sqlite'
  config: { path: './.srchunter-sessions.db' }
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config: { backend: sqlite }
- id: srchunter
  name: '@deepseek-ai/dsh-srchunter'
```

## Tools

Registers on `ctx.tools`: `srchunter_submit`, `srchunter_add_goal`, `srchunter_add_intent`, `srchunter_set_intent`,
`srchunter_add_fact`, `srchunter_add_finding`, `srchunter_add_asset`, `srchunter_state`, `srchunter_graph`, `srchunter_report`.

| Tool | Purpose |
|---|---|
| `srchunter_add_goal` | Set target + objective + optional authorization + `destructive` budget (readonly / limited / full); RESETS the session's exploration graph (fresh chain, `goal-1`). |
| `srchunter_add_intent` | Record an intent node (always `status: open`), anchored with exactly one of `goalId` (spawns) or `derivedFromFactId` (derived_from). |
| `srchunter_set_intent` | Adjudicate an intent: `working` / `done` / `deepen` / `blocked` / `dead_end`, with `disposition` carrying the next-round directive, the missing human input, or what disproved it (required for the last three). Decision-agent only. |
| `srchunter_add_fact` | Record a fact (port/service/vuln/finding/http/info) yielded by an intent (yields edge). |
| `srchunter_add_finding` | Record a PROVEN finding (proves edge): **reproducibleSteps (min 1)** plus the realized-harm gate — one of `rawRequest`/`rawResponse`/`poc`, a quantified `impact`, a non-empty `owner`, and `publicInterface` not true. Also takes `vulnType`/`killChain`/`score`/`strictListHit`; an affected asset may be linked. |
| `srchunter_add_asset` | Record an asset (root-domain/subdomain/ip/service/app/endpoint) with optional `owner` attribution, optionally parented (parent edge). |
| `srchunter_state` | Read goal, node/asset lists, and counts. |
| `srchunter_graph` | Dump the full exploration graph (nodes + edges) as JSON. |
| `srchunter_report` | Pure final Markdown report: findings ordered by harm (each with class, attribution, quantified impact, 死规矩 self-check, kill chain, steps and fenced PoC / raw packet blocks), then the hand-off list of `deepen` / `blocked` / `dead_end` intents with their disposition, the asset graph and the full chain. |

Node and edge ids are deterministic (`<kind>-<n>`, per-session counters), so the session projection
replicates the graph purely from the logged tool calls and the decision agent can reference ids across calls.
The read-only trio carries `presentResult` completed-card views: `srchunter_state`/`srchunter_graph`/
`srchunter_report` render as generic cards titled 漏洞挖掘状态 / 漏洞挖掘探索图 / 漏洞挖掘报告 (error results
keep the default fallback).

## Session projection and Web surface

The package registers the standing `srchunter` session-projection unit (`./types` declares the
`SessionProjectionMap` key; `./client` re-exports the pure types for client consumers). The unit folds the
logged `srchunter_*` tool calls into the standing graph — goal, intent/fact/finding nodes, assets, edges, and
counts — so the value is replay-safe and never reads the storage domain. `null` before the first
`srchunter_add_goal`.

The Web surface lives in `@deepseek-ai/dsh-client-ui-srchunter`: the per-session 漏洞挖掘 conversation-view tab
over `useProjection('srchunter')`. The tab registers only while the current session is composed from the
`srchunter` agent preset (the projection key alone is not a session signal: the host-wide registry emits it
as `null` for every session), renders an engagement header card and the sub-tabs 探索链路 (the chain as an
interactive graph), 漏洞 (findings with reproducible steps), and 资产 (list or graph), and shows a guiding
empty note for a srchunter session with `null` (no `srchunter_add_goal` yet).

## Durable domain

Declared once with `defineDomain` as `srchunter` (version 2): `goals`, `intents`, `facts`, `findings`,
`assets`, and `edges` tables. Everything is scoped to a single session (each record carries its
`sessionId`). Writes are queued per-domain, persisted to the routed backend first, then applied to memory and
emitted via `domain/changed`; reads are synchronous from the authoritative in-memory state.

The store owns the exploration discipline: one goal per session (a new goal clears the whole graph), every
edge references source/target nodes of the exact kinds its kind demands within one session (spawns:
goal → intent; yields: intent → fact; derived_from: fact → intent; proves: intent → finding; parent:
asset → asset), findings require at least one reproducible step, and the `./invariant` companion re-checks
that referential discipline on every `domain/changed` emission.

## Model Experience

### Request context and condition

#### What the model sees

The package contributes the `srchunter:protocol` system-prompt section (order 50) with the verbatim protocol
text (see `src/instructions.ts`), which instructs the decision agent to follow the exploration chain, delegate
exploration/execution to subagents, transcribe subagent returns into the `srchunter_*` records, and always
attach reproducible steps to findings. The `srchunter_*` tool schemas are contributed to the model's tool
catalog and render exactly as declared in `src/tools.ts`; they are anchored in the generated tool catalog when
the deployment is part of the DeepSeek Harness build.

#### Token effect

Fixed, deployment-invariant: one always-present protocol section plus the nine tool schemas. No token growth
with session length; the full record stays in the storage domain and only `srchunter_state` summaries enter the
model context.

#### KV Cache effect

Prefix-stable: the protocol section text and the tool schemas are static across requests, so they form a
stable reusable prefix that does not invalidate cache reuse. Only tool arguments and results vary between
turns.

## Known Limitations and Deferred Work

- **Session-scoped only** — records are keyed by session; there is no cross-session/project resume (a confirmed
  deployment choice). Re-running an engagement requires a fresh `srchunter_add_goal`.
- **No enforcement of scope** — the protocol asks the decision agent to reject out-of-scope intents and
  `srchunter_add_goal` records a declarative `authorization` note, but the package does not itself block tools;
  sandbox/approval configuration remains the deployment's responsibility.
- **Subagent transcription burden** — subagent returns must be transcribed by the decision agent into
  `srchunter_*` records; nothing validates that transcription is complete or faithful.
- **SQLite/session concurrency** — writes are serialized per-domain (the storage-domain guarantee); concurrent
  multi-agent writes to one session are not additionally serialized.
