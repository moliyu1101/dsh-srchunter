/**
 * The srchunter invariant companion: referential discipline on
 * `domain/changed` — every record references an existing goal of the srchunter
 * domain, every edge references source/target nodes of the exact kinds its
 * kind demands within one session, and goals rows carry their own key as
 * sessionId.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { type InvariantError } from '@deepseek-ai/dsh-invariants'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import * as Companion from '../src/invariant.ts'
import { srchunterDomainSpec, type SrchunterEdge } from '../src/spec.ts'
import { MemoryStorageBackend } from './memory-backend.ts'

/** One well-formed edge of every kind for session s1. */
const edge = (kind: SrchunterEdge['kind'], sourceId: string, targetId: string): SrchunterEdge => ({
  id: `e-${kind}`, sessionId: 's1', kind, sourceId, targetId,
})

async function setup(open = true): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(Companion)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  if (open) {
    const domain = await facility.open(srchunterDomainSpec)
    await domain.table('goals').put('s1', { id: 'goal-1', sessionId: 's1', target: 'example.com', objective: 'o', authorization: '' })
    await domain.table('goals').put('s9', { id: 'goal-1', sessionId: 's9', target: 'other', objective: 'o', authorization: '' })
    await domain.table('intents').put('intent-1', { id: 'intent-1', sessionId: 's1', title: 'a', detail: '' })
    await domain.table('intents').put('intent-2', { id: 'intent-2', sessionId: 's1', title: 'b', detail: '' })
    await domain.table('intents').put('intent-9', { id: 'intent-9', sessionId: 's9', title: 'foreign', detail: '' })
    await domain.table('facts').put('fact-1', { id: 'fact-1', sessionId: 's1', intentId: 'intent-1', kind: 'port', target: 't', detail: 'd', confidence: 1 })
    await domain.table('findings').put('finding-1', {
      id: 'finding-1', sessionId: 's1', intentId: 'intent-2', title: 'n', severity: 'high',
      description: '', reproducibleSteps: ['x'], affectedAssetId: 'asset-1',
    })
    await domain.table('assets').put('asset-1', { id: 'asset-1', sessionId: 's1', type: 'root-domain', value: 'example.com', meta: '' })
    await domain.table('assets').put('asset-2', { id: 'asset-2', sessionId: 's1', type: 'subdomain', value: 'api.example.com', meta: '' })
    await domain.table('assets').put('asset-9', { id: 'asset-9', sessionId: 's9', type: 'ip', value: '10.0.0.1', meta: '' })
    await domain.table('edges').put('e-spawns', edge('spawns', 'goal-1', 'intent-1'))
    await domain.table('edges').put('e-yields', edge('yields', 'intent-1', 'fact-1'))
    await domain.table('edges').put('e-derived', edge('derived_from', 'fact-1', 'intent-2'))
    await domain.table('edges').put('e-proves', edge('proves', 'intent-2', 'finding-1'))
    await domain.table('edges').put('e-parent', edge('parent', 'asset-1', 'asset-2'))
  }
  return { ctx }
}

const invariantViolation: unknown = expect.objectContaining<Partial<InvariantError>>({
  code: 'INVARIANT',
  packageName: '@deepseek-ai/dsh-srchunter',
})

function emit(ctx: Context, change: Omit<DomainChanged, 'domain'> & { domain?: string }): void {
  ctx.emit('domain/changed', { domain: 'srchunter', ...change } as DomainChanged)
}

describe('srchunter invariant companion', () => {
  it('accepts well-formed records of every srchunter table', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, {
        table: 'goals', key: 's2', operation: 'put',
        value: { id: 'goal-1', sessionId: 's2', target: 't', objective: 'o', authorization: '' },
      })
    }).not.toThrow()
    expect(() => {
      emit(ctx, {
        table: 'intents', key: 'intent-3', operation: 'put',
        value: { id: 'intent-3', sessionId: 's1', title: 'c', detail: '' },
      })
    }).not.toThrow()
    expect(() => {
      emit(ctx, {
        table: 'edges', key: 'e-new', operation: 'put',
        value: edge('derived_from', 'fact-1', 'intent-2'),
      })
    }).not.toThrow()
  })

  it('rejects a goals row whose key does not match its sessionId', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, {
        table: 'goals', key: 's2', operation: 'put',
        value: { id: 'goal-1', sessionId: 's9', target: 't', objective: 'o', authorization: '' },
      })
    }).toThrow(invariantViolation)
  })

  it('rejects records referencing an unknown session', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, {
        table: 'intents', key: 'i-ghost', operation: 'put',
        value: { id: 'i-ghost', sessionId: 'ghost', title: 'a', detail: '' },
      })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, {
        table: 'edges', key: 'e-ghost', operation: 'put',
        value: { ...edge('spawns', 'goal-1', 'intent-1'), sessionId: 'ghost' },
      })
    }).toThrow(invariantViolation)
  })

  it('rejects edges whose source is not the required node kind of the session', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('spawns', 'intent-1', 'intent-2') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('yields', 'fact-1', 'fact-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('derived_from', 'intent-1', 'intent-2') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('proves', 'fact-1', 'finding-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('parent', 'intent-1', 'asset-2') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('spawns', 'goal-9', 'intent-1') })
    }).toThrow(invariantViolation)
  })

  it('rejects edges whose target is not the node kind the edge points at', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('spawns', 'goal-1', 'fact-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('proves', 'intent-2', 'intent-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('parent', 'asset-1', 'finding-1') })
    }).toThrow(invariantViolation)
  })

  it('rejects edges referencing nodes of another session', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('yields', 'intent-9', 'fact-1') })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, { table: 'edges', key: 'e1', operation: 'put', value: edge('parent', 'asset-9', 'asset-2') })
    }).toThrow(invariantViolation)
  })

  it('rejects findings referencing an unknown or foreign-session asset', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, {
        table: 'findings', key: 'finding-2', operation: 'put',
        value: {
          id: 'finding-2', sessionId: 's1', intentId: 'intent-2', title: 'n', severity: 'low',
          description: '', reproducibleSteps: ['x'], affectedAssetId: 'missing',
        },
      })
    }).toThrow(invariantViolation)
    expect(() => {
      emit(ctx, {
        table: 'findings', key: 'finding-2', operation: 'put',
        value: {
          id: 'finding-2', sessionId: 's1', intentId: 'intent-2', title: 'n', severity: 'low',
          description: '', reproducibleSteps: ['x'], affectedAssetId: 'asset-9',
        },
      })
    }).toThrow(invariantViolation)
    // No affected asset is fine.
    expect(() => {
      emit(ctx, {
        table: 'findings', key: 'finding-2', operation: 'put',
        value: {
          id: 'finding-2', sessionId: 's1', intentId: 'intent-2', title: 'n', severity: 'low',
          description: '', reproducibleSteps: ['x'],
        },
      })
    }).not.toThrow()
  })

  it('rejects a srchunter event emitted while the domain is not open', async () => {
    const { ctx } = await setup(false)
    expect(() => {
      emit(ctx, {
        table: 'intents', key: 'i1', operation: 'put',
        value: { id: 'i1', sessionId: 's1', title: 'a', detail: '' },
      })
    }).toThrow(invariantViolation)
  })

  it('ignores deletions, events of other domains, and unknown srchunter tables', async () => {
    const { ctx } = await setup()
    expect(() => {
      emit(ctx, { table: 'intents', key: 'i1', operation: 'deleted', value: {} })
    }).not.toThrow()
    expect(() => {
      emit(ctx, { table: 'mystery', key: 'm1', operation: 'put', value: {} })
    }).not.toThrow()
    ctx.emit('domain/changed', { domain: 'other', table: 'rows', key: 'a', operation: 'put', value: {} } as DomainChanged)
  })
})
