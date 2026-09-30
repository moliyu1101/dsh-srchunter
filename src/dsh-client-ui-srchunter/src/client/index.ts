/**
 * Vulnerability-hunting surface plugin, browser half: the 漏洞挖掘 conversation-view
 * tab. Projection-mode surface — the live srchunter state arrives through
 * `useProjection('srchunter')` (seeded by the history tail page, updated by
 * session/projection frames), so this plugin owns no store, no refresh chain,
 * and no event listener.
 *
 * The tab is a per-session surface: the view entry registers only while the
 * CURRENT session is composed from the `srchunter` agent preset (the sessions
 * list's per-row `agentPreset`). The projection-key presence is NOT a usable
 * signal: the session-projection registry is host-wide, so once any srchunter
 * preset is mounted the `srchunter` key exists (as `null`) in every session's
 * baseline. Sessions drive the entry — switching the current session (or
 * switching the session's preset in place) toggles the registration, and the
 * view ring re-reads its entries on every slots version bump.
 */
import type { ClientContext, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the conversation.view
// entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SrchunterView } from './SrchunterView.tsx'
import { en, NS, zh, type SrchunterKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The srchunter view tab copy. */
    srchunter: SrchunterKey
  }
}

/** The current-session id carried by the sessions list snapshot. */
type CurrentSessionId = SessionListState['current']

/**
 * The agent-preset id whose sessions carry the srchunter capability.
 */
const SRCHUNTER_PRESET = 'srchunter'

/**
 * Whether a session is composed from the srchunter preset — the session itself
 * or any listed ancestor (subagents of a srchunter session inherit its preset;
 * their own rows may or may not carry `agentPreset` on the wire).
 */
function isSrchunterSession(snapshot: SessionListState, id: string): boolean {
  let cursor: string | undefined = id
  const seen = new Set<string>()
  const byId = snapshot.byId as Readonly<Record<string, { agentPreset?: string; parentId?: string } | undefined>>
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    const row: { agentPreset?: string; parentId?: string } | undefined = byId[cursor]
    if (row?.agentPreset === SRCHUNTER_PRESET) return true
    cursor = row?.parentId
  }
  return false
}

/** Required services for the view registration and its copy. */
export const inject = ['slots', 'locale', 'sessions']

/**
 * Client plugin body: the 漏洞挖掘 view tab over the srchunter projection, mounted
 * per-session (registered while the current session — or a listed ancestor —
 * carries the `srchunter` agent preset, disposed as soon as it does not).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-srchunter: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  const sessions = ctx.sessions

  ctx.slots.inject('conversation.view', () => {
    let disposeEntry: (() => void) | undefined
    let sessionId: CurrentSessionId
    let sessionSrchunter: boolean | undefined

    const sync = (): void => {
      const snapshot = sessions.list.getSnapshot()
      const current = snapshot.current
      const srchunter = current === undefined ? undefined : isSrchunterSession(snapshot, current)
      if (current === sessionId && srchunter === sessionSrchunter) return
      disposeEntry?.()
      disposeEntry = undefined
      sessionId = current
      sessionSrchunter = srchunter
      if (current === undefined || srchunter !== true) return
      disposeEntry = ctx.slots.register({
        name: 'conversation.view',
        id: 'srchunter',
        order: 20,
        locale: NS,
        label: () => t('view.srchunter'),
      }, SrchunterView)
    }

    sync()
    const offList = sessions.list.subscribe(sync)
    return () => {
      offList()
      disposeEntry?.()
    }
  })
}
