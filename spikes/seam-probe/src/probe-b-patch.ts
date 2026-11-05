/**
 * Probe B — can a bundle layer replace the `agent-loop` row without touching
 * DSH source? This runs the REAL composition algorithm:
 *
 *   loadOverlayPatches()  packages/boot/app-boot/src/index.ts:534  (boot + dump-config use it)
 *   applyEntryPatches()   vendor/include/src/index.ts:57           ("THE patch semantics ... shared
 *                                                                   by mounting and offline config tooling")
 *
 * on the REAL base bundle layer, then asserts the row swap. No profile, no
 * install, no boot.
 *
 * Run: node src/probe-b-patch.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const CHECKOUT = '/Users/zhinan/deepseek-harness'
const BASE_PATCH = resolve(CHECKOUT, 'packages/bundle/base/cordis.patch.yml')
const OVERLAY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'patches', 'graph-loop.patch.yml')
const STOCK = '@deepseek-ai/dsh-agent-loop'
const REPLACEMENT = '@deepseek-ai/dsh-graph-loop'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`)
  if (!ok) failures += 1
}

interface Row { id?: string; name?: string; config?: unknown; disabled?: boolean }

const warnings: string[] = []
const warn = (message: string, ...args: unknown[]): void => {
  warnings.push([message, ...args.map(String)].join(' '))
}

// 1. The empty profile root plus the base layer == a composed profile tree.
const basePatches: PatchOptions[] = loadOverlayPatches('dsh', BASE_PATCH)
const composed = applyEntryPatches([], basePatches, warn) as Row[]
check('base layer composes to a flat entry list', composed.length > 50, `rows=${String(composed.length)}`)

const stockRow = composed.find(row => row.id === 'agent-loop')
check('base inserts an `agent-loop` row naming the stock package',
  stockRow?.name === STOCK, `row=${JSON.stringify(stockRow)}`)

// 2. Apply the bundle layer from patches/graph-loop.patch.yml.
const overlayPatches: PatchOptions[] = loadOverlayPatches('dsh', OVERLAY)
const patched = applyEntryPatches(composed as EntryOptions[], overlayPatches, warn) as Row[]
check('bundle layer composes cleanly', warnings.length === 0, `warnings=${JSON.stringify(warnings)}`)

const retired = patched.find(row => row.id === 'agent-loop')
check('stock row is disabled in place', retired?.disabled === true && retired.name === STOCK,
  `row=${JSON.stringify(retired)}`)

const replacement = patched.find(row => row.id === 'graph-loop')
check('graph row is inserted with the bundle entry point',
  replacement?.name === REPLACEMENT && (replacement.disabled ?? false) === false,
  `row=${JSON.stringify(replacement)}`)
check('exactly one ENABLED row can own the agent factory',
  patched.filter(row => row.name === STOCK && row.disabled !== true).length === 0,
  'no enabled stock row remains')
check('row count grew by exactly one (insert, not replace)',
  patched.length === composed.length + 1, `${String(composed.length)} -> ${String(patched.length)}`)

// 3. What the patch dialect CANNOT do: rename a row. `name` is a guard, so an
//    overlay that tries to repoint the stock row is skipped with a warning.
warnings.length = 0
const renameAttempt = applyEntryPatches(composed as EntryOptions[], [{
  id: 'agent-loop', name: '@deepseek-ai/some-other-loop',
}] as PatchOptions[], warn) as Row[]
check('a `name` mismatch guards instead of renaming (patch skipped)',
  (renameAttempt.find(row => row.id === 'agent-loop') as Row).name === STOCK && warnings.length === 1,
  `warnings=${JSON.stringify(warnings)}`)

// 4. Duplicate-id caveat: inserting a second row with id `agent-loop` composes
//    (both rows exist in the list) but the Loader keys rows in store[id], so the
//    later row shadows the earlier one for every id-addressed patch
//    (vendor/loader/src/config/tree.ts:51-58, 62-73).
warnings.length = 0
const duplicated = applyEntryPatches(composed as EntryOptions[], [{
  id: 'agent-loop', disabled: true,
}, {
  insert: [{ id: 'agent-loop', name: REPLACEMENT }],
}] as PatchOptions[], warn) as Row[]
check('a duplicate-id insert composes to two rows (ambiguity is the Loader\'s)',
  duplicated.filter(row => row.id === 'agent-loop').length === 2,
  `agent-loop rows=${String(duplicated.filter(row => row.id === 'agent-loop').length)}`)

// 5. Downstream overlays that configure `- id: agent-loop` (many test profiles and
//    user profiles do: e.g. apps/cli/tests/profiles/headless/tests/fixtures/cli.patch.yml:10)
//    keep targeting the row id, not the plugin. After the swap they edit the
//    disabled row, so their `config.agents` silently stops taking effect.
warnings.length = 0
const downstream = applyEntryPatches(patched as EntryOptions[], [{
  id: 'agent-loop', config: { agents: [{ id: 'main', provider: 'p', model: 'm' }] },
}] as PatchOptions[], warn) as Row[]
check('a legacy `id: agent-loop` config overlay now edits the DISABLED row',
  (downstream.find(row => row.id === 'agent-loop') as Row).disabled === true
  && JSON.stringify((downstream.find(row => row.id === 'agent-loop') as Row).config).includes('main'),
  'migration hazard: overlay silently lands on the retired row')

// 6. Static cross-check: the same row id exists in the second profile family.
const sdkMinimal = readFileSync(resolve(CHECKOUT, 'packages/bundle/sdk-minimal/cordis.patch.yml'), 'utf8')
check('sdk-minimal declares the same row id (a second profile family the bundle can target)',
  /- id: agent-loop\b/.test(sdkMinimal), 'packages/bundle/sdk-minimal/cordis.patch.yml:139')

// 7. Static cross-check: PROFILE_TEMPLATES is a source literal, so a shipped
//    `explore` mode cannot be added without editing DSH source. The out-of-tree
//    path is a user profile + this bundle.
const templates = readFileSync(resolve(CHECKOUT, 'packages/util/official-bundles/src/bundles.ts'), 'utf8')
const templateNames = [...templates.matchAll(/^ {2}(?:'([\w-]+)'|(\w+)): \{$/gmu)]
  .map(match => match[1] ?? match[2])
check('shipped profile templates are a literal list (no explore entry)',
  templateNames.length > 0 && !templateNames.includes('explore'),
  `templates=${JSON.stringify(templateNames)}`)

console.log(failures === 0 ? '\nprobe-b: all checks passed' : `\nprobe-b: ${String(failures)} FAILURE(S) above`)
process.exitCode = failures === 0 ? 0 : 1
