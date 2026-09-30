# @deepseek-ai/dsh-client-ui-srchunter

English | [中文](README.zh.md)

Vulnerability-hunting surface plugin: the **漏洞挖掘 view tab** (`conversation.view`). It is a pure projection-mode
surface — the live engagement state arrives through `useProjection('srchunter')` (seeded by the history tail
page, updated by `session/projection` frames), so the plugin owns no store, no refresh chain, and no event
listener.

The tab is per-session: the view entry registers only while the **current** session is composed from the
`srchunter` agent preset (the sessions list's per-row `agentPreset`). The projection-key presence is not a
usable signal — the session-projection registry is host-wide, so once any srchunter preset is mounted the
`srchunter` key exists (as `null`) in every session's baseline. Switching sessions (or switching the session's
preset in place) toggles the registration, so non-srchunter sessions never show the tab. A srchunter session
with `null` (no `srchunter_add_goal` yet) renders the guiding empty note.

The view renders one engagement header card (goal target, objective, authorization, **destructive budget**, a
stat chip per record kind, a **severity distribution** of the proven findings, and a pending-intent note) over
a sticky sub-tab bar whose tabs carry live count pills:

- **探索链路** — the exploration chain (goal → intent → fact → derived intent → finding) as an interactive
  graph rendered with [@xyflow/react](https://reactflow.dev). Positions come from the pure `layoutExploration`
  helper (BFS layers from the goal); nodes carry kind badges and connection handles, intents show their
  **adjudication badge** (to delegate / running / concluded / to deepen / needs a human / disproven),
  findings show their severity, and each chain edge renders a visible relationship pill (意图链 / 产出 /
  推导自 / 证实). A legend over the canvas counts the kinds currently present, clicking a node opens a drawer
  with the full record (including its `disposition`), and clicking empty canvas closes it.
- **漏洞** — every proven finding as a card, with a severity stripe and a toolbar above the list: filter by
  severity (the header's severity chips deep-link straight into a filtered list) and order by harm
  (score, then severity) or by record order. Each card shows its severity badge with score, class,
  attribution, quantified impact, description, the **死规矩 self-check** (`strictListHit` and
  whether the endpoint is public), the **kill chain**, the **reproducible steps**, the affected asset when
  linked, and collapsed evidence packets — each PoC / raw request / raw response block copies on its own.
- **资产** — the recorded assets (根域名 / 子域名 / IP / 服务 / App / 端点) in two modes: a list grouped by
  type (each group headed by its count) with inline parent links, the **attributed organization**, and a search
  box matching value, metadata, owner or parent; or a parent-child graph (the pure
  `layoutAssets` helper) rendered with @xyflow/react.
- **报告** — Markdown on the same EduSRC shape the host `srchunter_report` emits: header (target, objective,
  authorization, destructive budget, scale), findings ordered by harm with class / attribution / quantified
  impact / self-check / kill chain / steps and fenced PoC and raw-packet blocks, then the **hand-off list**
  (to deepen / needs a human / disproven), the assets and the full chain. Rendered, copyable and savable
  as `.md`.

The host side of the projection unit lives in [`@deepseek-ai/dsh-srchunter`](../dsh-srchunter/README.md):
it folds the logged `srchunter_*` tool calls into the standing graph, so the tab is replay-safe by
construction.

## Configuration

No configuration. Compose the plugin in the web bundle (`dsh.client` row) next to the srchunter host plugin; the
view slot itself is declared by `@deepseek-ai/dsh-client-ui-conversation`, and the entry registers into it via
`ctx.slots.inject('conversation.view', …)` with `order: 20`, gated on `ctx.sessions`' current session and its
`agentPreset`. Copy lives in the plugin-owned `srchunter` locale namespace, registered with the locale service.
`@xyflow/react` is inlined into the client bundle; its stylesheet rides the package's raw-CSS inline plugin
(injected through the loader-owned `<style data-plugin>` channel).

## Model Experience

Pure presentation: nothing here reaches the model, the session log, or the tool catalog. The projected value
is computed by the host srchunter package from already-logged tool calls.

## Known Limitations and Deferred Work

- **Read-only tab** — the view displays the standing state only; engaging, pausing, or resetting a srchunter
  session still happens through the decision agent's `srchunter_*` tools or a future command surface.
- **Current-session visibility** — the tab follows the currently selected session (including subagents of a
  srchunter session, resolved through the listed ancestor chain); a background srchunter session shows no tab
  until selected.
- **Static graph layout** — the chain and asset graphs use a fixed layered layout; nodes are not draggable
  (React Flow's pan/zoom stays available).
