/**
 * The srchunter bundle package: the patch layer parses and names the rows it
 * composes, the inert node half mounts, and the invariant companion
 * registers over a real Context (covered by the vitest-wide invariant host).
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { apply as nodeApply } from '../lib/index.js'

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

/** The loader's `!!js` scalar: parse as its raw expression string. */
const jsExprTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: unknown) => data,
})
const patchSchema = yaml.JSON_SCHEMA.extend(jsExprTag)

describe('srchunter bundle', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('the patch layer declares the UI and storage rows, and the route override', () => {
    const patch = yaml.load(readFileSync(PATCH_PATH, 'utf8'), { schema: patchSchema }) as Array<Record<string, unknown>>
    const insert = patch.find(entry => entry.insert !== undefined)
    expect(insert).toBeDefined()
    const rows = (insert!['insert'] as Array<{ id: string; name: string }>).map(row => ({ id: row.id, name: row.name }))
    // Every row resolves to a subpath of the self-contained bundle package,
    // so a single tarball installs the whole mode. The Web surface row is the
    // exception on purpose: the host's client discovery only accepts a bare
    // package specifier, so a subpath row name would ship a UI nobody loads.
    expect(rows).toEqual([
      { id: 'ui-srchunter', name: '@moliyu1101/dsh-srchunter' },
      { id: 'storage-sqlite', name: '@moliyu1101/dsh-srchunter/storage-sqlite' },
    ])
    const sqlite = insert!['insert'].find((row: { id: string }) => row.id === 'storage-sqlite') as { config?: { path?: string } }
    expect(sqlite.config).toEqual({ path: "dshHomePath('storages', 'srchunter-sessions.db')" })
    const override = patch.find(entry => entry.id === 'storage-domain') as { config: { backend: string; routes: Record<string, string> } }
    expect(override.config).toMatchObject({ backend: 'json', routes: { srchunter: 'sqlite' } })
    const presetRoot = patch.find(entry => {
      const inserted = entry.insert as Array<{ id: string; name: string }> | undefined
      return inserted?.some(row => row.id === 'srchunter-preset-root')
    })
    expect(presetRoot).toBeDefined()
    expect((presetRoot!.insert as Array<{ id: string; name: string }>)).toEqual([
      { id: 'srchunter-preset-root', name: '@moliyu1101/dsh-srchunter/preset-root' },
    ])
  })

  it('declares the sqlite backend runtime import contract', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['@deepseek-ai/schemastery']).toBe('3.18.1')
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-storage']).toBe('0.1.0-rc.6')
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-storage-domain']).toBe('0.1.0-rc.6')
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-tools']).toBe('0.1.0-rc.6')
    expect(manifest.peerDependenciesMeta).toBeUndefined()
  })
})
