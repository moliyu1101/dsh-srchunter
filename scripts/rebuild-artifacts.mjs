/**
 * Regenerate the published runtime files from the checked-in source snapshots,
 * per the "Rebuild Workflow" section of AGENTS.md:
 *
 *   host   src/dsh-srchunter/src/*           -> lib/srchunter.js
 *   client src/dsh-client-ui-srchunter/src/* -> lib/ui-srchunter.client.js
 *   invariant src/invariant.ts               -> lib/invariant.js
 *
 * Both artifacts are patched at their region boundaries so everything they
 * already inline stays byte-identical: the host file keeps its prelude and the
 * bundled zod namespace (rolldown inlines zod as `external_exports`), the client
 * file keeps React and @xyflow/react, and each `dsh-css` region keeps the
 * stylesheet identifier and scope prefix it already uses while its text and its
 * class map are recompiled from the matching `<View>.module.css`.
 *
 * Identity is rebased rather than hand-patched: every bundle-owned `@scope/dsh-srchunter`
 * literal (the client loader `id`, the `dsh-css` tagIds and `data-plugin*` values, and the
 * `lib/types` declaration shells) is rewritten to `package.json`'s current name, while the
 * `@deepseek-ai/*` host namespace is left exactly as the loader expects it.
 *
 * Each module is transpiled on its own with every import kept external, then
 * normalized onto the identifiers the artifact already uses:
 *   host    `z.x` becomes `external_exports.x`, relative imports are dropped
 *           (those names already live in bundle scope), non-ASCII is escaped;
 *   client  `useState(` becomes `(0, react.useState)(`, `jsx(`/`jsxs(` the
 *           runtime namespace, `Fragment` becomes `react_jsx_runtime.Fragment`,
 *           `css.x` becomes `<File>_module_css_default.x`, and `ReactFlow`
 *           becomes `index` (React Flow's public component is
 *           `var index = forwardRef(ReactFlow)`).
 * Top-level names two modules both declare take the suffix the artifact already
 * uses for that region, so re-running this script is idempotent.
 *
 * Usage: node scripts/rebuild-artifacts.mjs [--check]
 */
import { rolldown } from 'rolldown'
import fs from 'node:fs'
import path from 'node:path'

const CHECK = process.argv.includes('--check')
const ROOT = path.resolve(import.meta.dirname, '..')
const NON_ASCII = new RegExp('[\\u0080-\\uffff]', 'g')

/**
 * Read a generated file with line endings normalized. Region markers are matched
 * as exact lines, so a CRLF checkout (a fresh clone before the repo's
 * `.gitattributes` takes effect) must not make the assembly silently fail.
 */
const readText = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

/**
 * The bundle's own npm identity, taken from `package.json`. Artifacts carry it
 * in the client loader `id`, in every `dsh-css` region's tagId and `data-plugin*`
 * values, and in the `lib/types` declaration shells — so a package rename needs
 * one source of truth rather than hand edits under `lib/`. The host service
 * namespace (`@deepseek-ai/*`, including the snapshot's own `@module` tags) is
 * deliberately NOT rewritten: those specifiers resolve through the host loader.
 *
 * The legacy `/<surface-subpath>` suffix is dropped onto the bare package name
 * while rewriting, because the host's client-module discovery keys on the bare
 * specifier: `exactPackageSpecifier` rejects a subpath row name before it ever
 * reads a manifest, and the host's own client bundles all register as
 * `<package>`, `<package>` and `<package>/<Stylesheet>.module.css`.
 */
const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name
const PACKAGE_IDENTITY = /@(?!(?:deepseek-ai)\/)[\w.-]+\/dsh-srchunter(?:\/ui-srchunter)?/g

/** Point every bundle-owned identity literal in `text` at the current package name. */
const normalizeIdentity = text => text.replace(PACKAGE_IDENTITY, PACKAGE_NAME)

/**
 * The `lib/types` declaration shells are snapshots of the upstream build rather
 * than regenerated modules, so only their identity strings move.
 */
function rebaseTypeShims() {
  const dir = path.join(ROOT, 'lib', 'types')
  if (!fs.existsSync(dir)) return false
  let stale = false
  for (const entry of fs.readdirSync(dir)) {
    if (!/\.(?:js|d\.ts)$/.test(entry)) continue
    const file = path.join(dir, entry)
    const previous = readText(file)
    const next = normalizeIdentity(previous)
    if (next === previous) continue
    stale = true
    if (!CHECK) fs.writeFileSync(file, next)
  }
  return stale
}

const escapeNonAscii = text => text.replace(NON_ASCII, ch => '\\u' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
const declarationAt = line => /^\s{0,2}(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line ?? '')?.[1]

/**
 * Transpile one module with every import kept external and no export statements.
 * `keepHostImports` retains the `@deepseek-ai/*` import lines: the host artifact
 * resolves those through the plugin loader, while the client artifact has React
 * and @xyflow/react inlined by its own build and must not re-import them.
 */
async function transpile(entry, keepHostImports = false) {
  const bundle = await rolldown({ input: entry, external: [/./], treeshake: false })
  const out = await bundle.generate({ format: 'esm', sourcemap: false, minify: false })
  return out.output[0].code
    .split('\n')
    .filter(line => !line.startsWith('//#region') && !line.startsWith('//#endregion'))
    .filter(line => !(line.startsWith('import ') && !(keepHostImports && line.includes('from "@deepseek-ai/'))))
    .join('\n')
    .replace(/^export (const|let|var|function|class) /gm, '$1 ')
}

/**
 * Rewrite the transpiled body onto the names this artifact already uses. A region
 * that already ships `name$1` keeps it (so re-runs cannot drift to `name$2`);
 * a genuinely new name takes the next free suffix in the shared scope.
 */
function deconflict(body, declaredHere, scopeNames, aliasMap) {
  let out = body
  for (const name of aliasMap.keys()) out = out.replace(new RegExp('\\b' + name + '\\b', 'g'), aliasMap.get(name))
  for (const name of [...out.matchAll(/^ {0,2}(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1])) {
    // Prefer whatever this region already owns: the artifact's own suffix wins
    // over minting a new one, which is what keeps re-runs byte-stable.
    const owned = [...declaredHere].find(candidate => candidate === name || candidate.startsWith(name + '$'))
    if (owned !== undefined) {
      if (owned !== name) out = out.replace(new RegExp('\\b' + name + '\\b', 'g'), owned)
      continue
    }
    if (!scopeNames.has(name)) continue
    let suffix = 1
    while (scopeNames.has(name + '$' + suffix)) suffix += 1
    const renamed = name + '$' + suffix
    scopeNames.add(renamed)
    out = out.replace(new RegExp('\\b' + name + '\\b', 'g'), renamed)
  }
  return out
}

const HOST_DIR = 'src/dsh-srchunter/src/'
/** Host regions run from their `// src/x.ts` marker to the next marker line. */
const hostRegionEnd = (lines, start) => {
  let end = start + 1
  while (end < lines.length && !(lines[end].startsWith('// src/') || lines[end].startsWith('// ../') || lines[end].startsWith('// /'))) end += 1
  return end
}
const HOST_MODULES = ['instructions', 'spec', 'store', 'projection', 'tools', 'index']

async function rebuildHost() {
  const target = path.join(ROOT, 'lib', 'srchunter.js')
  const previous = readText(target)
  const lines = previous.split('\n')
  const scopeNames = new Set(lines.map(declarationAt).filter(Boolean))
  const bodies = {}
  let publicExports = []
  for (const name of HOST_MODULES) {
    let body = await transpile(HOST_DIR + name + '.ts', true)
    // Re-exports carry a `from` clause; the public surface of the bundle is the
    // union of those and the entry's own local exports.
    const exported = [...body.matchAll(/\bexport \{([^}]*)\}(?:\s+from "[^"]*")?;/g)].flatMap(m =>
      m[1].split(',').map(entry => entry.trim().replace(/^type\s+/,'')).filter(entry => entry !== ''))
    body = body.replace(/\bexport \{[^}]*\};/g, '').replace(/\bz\./g, 'external_exports.')
    const start = lines.findIndex(line => line === '// src/' + name + '.ts')
    const declaredHere = new Set(lines.slice(start + 1, hostRegionEnd(lines, start)).map(declarationAt).filter(Boolean))
    body = deconflict(body, declaredHere, scopeNames, new Map())
    for (const match of body.matchAll(/^ {0,2}(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) scopeNames.add(match[1])
    bodies[name] = escapeNonAscii(body).trimEnd()
    if (name === 'index') publicExports = exported
  }
  // Region bodies are replaced back-to-front so earlier line numbers stay valid.
  const ordered = HOST_MODULES
    .map(mod => ({ name: mod, at: lines.findIndex(line => line === '// src/' + mod + '.ts') }))
    .sort((a, b) => b.at - a.at)
  for (const region of ordered) {
    const marker = '// src/' + region.name + '.ts'
    const start = lines.indexOf(marker)
    const end = hostRegionEnd(lines, start)
    lines.splice(start + 1, end - start - 1, ...bodies[region.name].split('\n'))
  }
  const tail = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  const exportBlock = 'export {\n' + [...new Set(publicExports)].sort().map(entry => '  ' + entry + ',').join('\n') + '\n};'
  const cleaned = normalizeIdentity(tail.join('\n').replace(/\n+$/, '') + '\n' + exportBlock + '\n')
  if (!CHECK) fs.writeFileSync(target, cleaned)
  console.log('host artifact:', cleaned.length, 'bytes')
  return { stale: previous !== cleaned }
}

const CLIENT_DIR = 'src/dsh-client-ui-srchunter/src/client/'
const CLIENT_REGIONS = {
  'graph.ts': { css: null },
  'AssetsView.tsx': { css: 'AssetsView_module_css_default', cssFile: 'AssetsView.module.css', alias: { ReactFlow: 'index' } },
  'ExploreView.tsx': { css: 'ExploreView_module_css_default', cssFile: 'ExploreView.module.css', alias: { ReactFlow: 'index' } },
  'FindingsView.tsx': { css: 'FindingsView_module_css_default', cssFile: 'FindingsView.module.css' },
  'GraphDetailDrawer.tsx': { css: 'GraphDetailDrawer_module_css_default', cssFile: 'GraphDetailDrawer.module.css' },
  'ReportView.tsx': { css: 'ReportView_module_css_default', cssFile: 'ReportView.module.css' },
  'SrchunterView.tsx': { css: 'SrchunterView_module_css_default', cssFile: 'SrchunterView.module.css' },
  'locales.ts': { css: null },
  'index.ts': { css: null },
}

/** Alphabet of a minted CSS-module scope (only when a region carries none yet). */
const SCOPE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** A stable 6-character scope for a stylesheet whose region has none yet. */
function mintScope(seed) {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  let value = hash >>> 0
  let out = ''
  while (out.length < 6) {
    out += SCOPE_ALPHABET[value % SCOPE_ALPHABET.length]
    value = Math.floor(value / SCOPE_ALPHABET.length)
  }
  return out
}

/** Collapse every whitespace run of one CSS fragment. */
const flatten = text => text.replace(/\s+/g, ' ').trim()

/** One rule's declaration list, minified to `a:b;c:d`. */
function minifyDeclarations(body) {
  return body
    .split(';')
    .map(entry => flatten(entry))
    .filter(entry => entry !== '')
    .join(';')
}

/** Index of the `}` that closes the block opening at `open`. */
function blockEnd(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}' && (depth -= 1) === 0) return index
  }
  throw new Error('unbalanced CSS braces')
}

/**
 * Compile one CSS module into the stylesheet text the artifact inlines plus the
 * local-name to scoped-name map the transpiled component reads through
 * `X_module_css_default`. The scope prefix rides along from the artifact, so a
 * re-run over unchanged sources stays byte-stable; `:global(...)` spans keep
 * their contents verbatim (React Flow's classes are not ours to rename).
 */
function compileModuleCss(source, scope) {
  const locals = new Map()
  const globals = []
  const scopeSelector = (selector) => {
    const guarded = selector.replace(/:global\(([^)]*)\)/g, (_match, inner) => {
      globals.push(inner)
      return '\u0000' + (globals.length - 1) + '\u0000'
    })
    const scoped = guarded.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (_match, name) => {
      const local = `${scope}_${name}`
      if (!locals.has(name)) locals.set(name, local)
      return '.' + local
    })
    return scoped.replace(/\u0000(\d+)\u0000/g, (_match, index) => globals[Number(index)])
  }
  const walk = (text) => {
    let out = ''
    let cursor = 0
    while (cursor < text.length) {
      const open = text.indexOf('{', cursor)
      if (open < 0) break
      const prelude = flatten(text.slice(cursor, open))
      const close = blockEnd(text, open)
      const body = text.slice(open + 1, close)
      if (prelude === '') cursor = close + 1
      else if (/^@(media|supports|layer|container)/.test(prelude)) out += `${prelude}{${walk(body)}}`
      else if (prelude.startsWith('@')) out += `${prelude}{${minifyDeclarations(body)}}`
      else out += `${scopeSelector(prelude)}{${minifyDeclarations(body)}}`
      cursor = close + 1
    }
    return out
  }
  const text = walk(source.replace(/\/\*[\s\S]*?\*\//g, ''))
  return { text, locals }
}

/**
 * Rewrite the artifact's `dsh-css` regions from the checked-in stylesheets: the
 * inlined stylesheet string and the class map keep the identifiers the artifact
 * already uses (`css`, `css$4`, `tagId$4`), so only the text and the entries move.
 */
function rebuildClientCss(lines, configs) {
  for (const config of configs) {
    if (config.cssFile === undefined) continue
    const source = fs.readFileSync(path.join(ROOT, CLIENT_DIR, config.cssFile), 'utf8')
    const at = lines.findIndex(line => line.startsWith('\t\t//#region \\0dsh-css:') && line.endsWith(config.cssFile + '.mjs'))
    if (at < 0) throw new Error('css region missing: ' + config.cssFile)
    let end = at + 1
    while (end < lines.length && !/^\t\t\/\/#endregion$/.test(lines[end]) && !/^\t\t\/\/#region /.test(lines[end])) end += 1
    const region = lines.slice(at, end)
    const cssLine = region.findIndex(line => /^\t\tconst (css(?:\$\d+)?) = ".+";$/.test(line))
    if (cssLine < 0) throw new Error('css literal missing: ' + config.cssFile)
    const identifier = /^\t\tconst (css(?:\$\d+)?) = /.exec(region[cssLine])[1]
    const previous = JSON.parse(region[cssLine].trim().slice(`const ${identifier} = `.length, -1))
    const scope = /^\.([A-Za-z0-9]{6})_/.exec(previous)?.[1] ?? mintScope(config.cssFile)
    const { text, locals } = compileModuleCss(source, scope)
    const mapAt = region.findIndex(line => line === `\t\tvar ${config.css} = {`)
    if (mapAt < 0) throw new Error('css map missing: ' + config.css)
    let mapEnd = mapAt + 1
    while (mapEnd < region.length && region[mapEnd].trim() !== '};') mapEnd += 1
    const entries = [...locals].map(([name, local]) => `${JSON.stringify(name)}: ${JSON.stringify(local)}`)
      .map((entry, index, all) => `\t\t\t${entry}${index === all.length - 1 ? '' : ','}`)
    lines.splice(at + cssLine, 1, `\t\tconst ${identifier} = ${escapeNonAscii(JSON.stringify(text))};`)
    lines.splice(at + mapAt + 1, mapEnd - mapAt - 1, ...entries)
  }
  return lines
}

async function rebuildClient() {
  const target = path.join(ROOT, 'lib', 'ui-srchunter.client.js')
  const previous = readText(target)
  const pristine = previous.split('\n')
  const lines = [...pristine]
  const scopeNames = new Set(pristine.map(line => /^\t\t(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1]).filter(Boolean))
  for (const [file, config] of Object.entries(CLIENT_REGIONS)) {
    let body = (await transpile(CLIENT_DIR + file))
      .replace(/\bexport \{[^}]*\};/g, '')
      .replace(/\b(useState|useEffect|useMemo|useCallback|useRef)\(/g, '(0, react.$1)(')
      .replace(/\bjsxs\(/g, '(0, react_jsx_runtime.jsxs)(')
      .replace(/\bjsx\(/g, '(0, react_jsx_runtime.jsx)(')
      .replace(/\bFragment\b/g, 'react_jsx_runtime.Fragment')
    if (config.css !== null) body = body.replace(/\bcss\./g, config.css + '.')
    const start = pristine.indexOf('\t\t//#region src/client/' + file)
    if (start < 0) throw new Error('client region missing: ' + file)
    let stop = start + 1
    while (stop < pristine.length && !/^\t\t\/\/#endregion$/.test(pristine[stop]) && !/^\t\t\/\/#region /.test(pristine[stop])) stop += 1
    const declaredHere = new Set(pristine.slice(start + 1, stop).map(line => /^\t\t(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1]).filter(Boolean))
    body = deconflict(body, declaredHere, scopeNames, new Map(Object.entries(config.alias ?? {})))
    // Everything this region now owns joins the shared scope, so a later region
    // declaring the same top-level name is suffixed instead of colliding.
    for (const match of body.matchAll(/^ {0,2}(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) scopeNames.add(match[1])
    const indented = body.replace(/^/gm, '\t\t').trimEnd().split('\n')
    const at = lines.indexOf('\t\t//#region src/client/' + file)
    let end = at + 1
    while (end < lines.length && !/^\t\t\/\/#endregion$/.test(lines[end]) && !/^\t\t\/\/#region /.test(lines[end])) end += 1
    lines.splice(at + 1, end - at - 1, ...indented)
  }
  rebuildClientCss(lines, Object.values(CLIENT_REGIONS))
  const output = normalizeIdentity(lines.join('\n'))
  if (!CHECK) fs.writeFileSync(target, output)
  console.log('client artifact:', output.length, 'bytes')
  return { stale: previous !== output }
}


/**
 * The invariant companion ships as its own root artifact: it watches
 * `domain/changed` for the mode's storage domain, so its domain literal must
 * track the identifier rename.
 */
async function rebuildInvariant() {
  const target = path.join(ROOT, 'lib', 'invariant.js')
  const previous = readText(target)
  const body = (await transpile('src/invariant.ts')).trimEnd()
  const exported = [...body.matchAll(/\bexport \{([^}]*)\}(?:\s+from "[^"]*")?;/g)].flatMap(m =>
    m[1].split(',').map(entry => entry.trim()).filter(entry => entry !== ''))
  const clean = body.replace(/\bexport \{[^}]*\};/g, '').trimEnd()
  const output = normalizeIdentity('// src/invariant.ts\n' + clean + '\nexport {\n'
    + [...new Set(exported)].sort().map(entry => '  ' + entry + ',').join('\n') + '\n};\n')
  if (!CHECK) fs.writeFileSync(target, output)
  console.log('invariant artifact:', output.length, 'bytes')
  return { stale: previous !== output }
}

const host = await rebuildHost()
const invariant = await rebuildInvariant()
const client = await rebuildClient()
const shims = rebaseTypeShims()
if (CHECK && (host.stale || invariant.stale || client.stale || shims)) {
  console.error('artifacts are stale; run: node scripts/rebuild-artifacts.mjs')
  process.exitCode = 1
}
