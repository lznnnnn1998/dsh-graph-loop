/**
 * envelope-composition-reach.test.ts — composition must be reachable in the
 * profile it was built for, and its routing decision must explain itself.
 *
 * The real profile exposes the annotated core tools beside ~100 unannotated
 * MCP/craft tools. Before the baseline split, every unclassified preset tool was
 * folded into `extraTools`, so any profile over the 64-tool cap produced
 * `error:max-tools-exceeded` → `fallbackToStock`, and every ordinary task ran the
 * legacy fixed-stage synthesizer (`dyn:*`, `envelopeId` null) instead of the
 * capability-composed graph. This drill pins the route for three representative
 * shapes and prints the installed plan + rationale:
 *
 *   short chat   -> t_stock, 1 node   (triage, by design)
 *   multi-tool   -> t_compose, >= 3 nodes, envelopeId set
 *   file-edit    -> t_compose, >= 3 nodes, envelopeId set
 *
 * Run: node --import tsx --test test/unit/envelope-composition-reach.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { selectEnvelopeForTask } from '../../packages/core/src/envelope.ts'
import type { RegistryGraph } from '../../packages/core/src/graph-schema.ts'
import { extractFingerprint, type TaskFingerprint } from '../../packages/core/src/matching.ts'
import { buildRegistrySnapshot, type ToolSource } from '../../packages/core/src/registry.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

/**
 * The annotated core surface of a live DSH profile. All of these names are in
 * the curated table, so the registry gives them tags/produces facts; the drill
 * adds no annotation of its own.
 */
const CORE_TOOL_NAMES = [
  'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search',
  'web_fetch', 'todo_write', 'present', 'skill', 'ask_user_question', 'send_message',
  'list_agents', 'run_code', 'working_directory', 'workflow',
] as const

/** MCP/craft families; every generated tool name is unannotated by the table. */
const CRAFT_FAMILIES = [
  'gridcraft', 'wordcraft', 'deckcraft', 'pdfcraft', 'cadcraft', 'vectorcraft',
  'photocraft', 'lightcraft', 'filmcraft', 'soundcraft', 'effectcraft',
  'designcraft', 'figcraft', 'texturecraft',
] as const

/** The trip point used to be 57 unannotated tools; the live profile carries 98. */
const CRAFT_TOOLS = 98

const WORKSPACE: TaskFingerprint['workspace'] = {
  hasGit: true,
  hasPackageJson: true,
  hasTests: true,
  hasPython: false,
  languages: ['ts'],
}

const CORE_TOOLS: readonly ToolSource[] = CORE_TOOL_NAMES.map(name => ({
  name,
  description: `Annotated core tool ${name}.`,
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
}))

/** The live-profile shape: 18 annotated core tools + 98 unannotated MCP names. */
const CRAFT_TOOLS_SOURCES: readonly ToolSource[] = Array.from({ length: CRAFT_TOOLS }, (_, index) => ({
  name: `${CRAFT_FAMILIES[index % CRAFT_FAMILIES.length]!}_op${index}`,
  description: `Unannotated MCP tool ${index} from a craft package.`,
  parameters: { type: 'object', properties: { request: { type: 'string' }, limit: { type: 'number' } } },
}))

const registry = buildRegistrySnapshot({ tools: [...CORE_TOOLS, ...CRAFT_TOOLS_SOURCES] })
const graph = registry.graph
const presetTools = graph.nodes.flatMap(node => node.tool === undefined ? [] : [node.tool.name])

interface DrillShape {
  readonly name: string
  readonly text: string
  readonly templateId: 't_stock' | 't_compose'
  readonly minNodes: number
  readonly path: 'triage' | 'compose'
  /** Stage node ids the composed plan must contain. */
  readonly stages: readonly string[]
}

const SHORT_CHAT: DrillShape = {
  name: 'short chat',
  text: 'hi',
  templateId: 't_stock',
  minNodes: 1,
  path: 'triage',
  stages: [],
}

const MULTI_TOOL: DrillShape = {
  name: 'multi-tool',
  text: 'Search the repo for every gridcraft mention, read the matching files, and explain how the composer picks tools',
  templateId: 't_compose',
  minNodes: 3,
  path: 'compose',
  stages: ['n_discover', 'n_inspect'],
}

const FILE_EDIT: DrillShape = {
  name: 'file-edit',
  text: 'Fix the failing scheduler test by editing packages/loop/src/scheduler.ts and verify with npm test',
  templateId: 't_compose',
  minNodes: 3,
  path: 'compose',
  stages: ['n_inspect', 'n_mutate', 'n_verify'],
}

const SHAPES: readonly DrillShape[] = [SHORT_CHAT, MULTI_TOOL, FILE_EDIT]

function fingerprintOf(text: string): TaskFingerprint {
  return extractFingerprint({
    text,
    surface: 'api',
    contextTokens: 0,
    attachments: [],
    workspace: WORKSPACE,
    visibleTools: [],
  })
}

async function drill(shape: DrillShape) {
  const driver = createGraphTurnDriver({ mode: 'dynamic', graphProvider: () => graph })
  const snapshot = await driver.beginTurn({ text: shape.text })
  return { driver, snapshot }
}

test('the composed path is reachable in a 116-tool profile (drill over three shapes)', async () => {
  const drilled: { shape: DrillShape; snapshot: Awaited<ReturnType<typeof drill>>['snapshot']; universe: readonly string[] }[] = []
  const rows: string[] = []
  for (const shape of SHAPES) {
    const { driver, snapshot } = await drill(shape)
    drilled.push({ shape, snapshot, universe: driver.toolUniverse?.() ?? [] })
    rows.push(
      `${shape.name.padEnd(11)} templateId=${snapshot.templateId.padEnd(9)} nodes=${String(snapshot.plan.nodes.length).padEnd(2)} path=${(snapshot.path ?? 'none').padEnd(10)} envelopeId=${snapshot.envelopeId ?? 'none'}`,
      `  plan:      ${snapshot.plan.nodes.map(node => node.id).join(',')}`,
      `  rationale: ${snapshot.rationale.join(' | ')}`,
      `  universe:  ${driver.toolUniverse?.()?.length ?? 0} tools (hard allowlist)`,
    )
  }
  // The drill is evidence, not just an assertion: print the plan it installed.
  console.log(`\n${rows.join('\n')}\n`)

  // Assert the two real tasks first: they are the claim this cycle changes.
  const ordered = [...drilled].sort((left, right) =>
    (left.shape.path === 'compose' ? 0 : 1) - (right.shape.path === 'compose' ? 0 : 1))
  for (const { shape, snapshot, universe } of ordered) {
    const issues = snapshot.envelopeIssues ?? []
    assert.equal(snapshot.templateId, shape.templateId, `${shape.name}: templateId`)
    assert.ok(
      snapshot.plan.nodes.length >= shape.minNodes,
      `${shape.name}: composed plan needs >= ${shape.minNodes} nodes, got ${snapshot.plan.nodes.length}`,
    )
    assert.equal(snapshot.path, shape.path, `${shape.name}: path provenance`)
    if (shape.path === 'compose') {
      assert.match(snapshot.envelopeId ?? '', /^env_[0-9a-f]{16}$/u, `${shape.name}: envelopeId`)
      assert.equal(snapshot.plan.fallback, false, `${shape.name}: composed plan is not a fallback`)
      for (const stage of shape.stages) {
        assert.ok(
          snapshot.plan.nodes.some(node => node.id === stage),
          `${shape.name}: composed plan must contain ${stage}`,
        )
      }
      assert.match(snapshot.rationale[0] ?? '', /^envelope env_/u, `${shape.name}: rationale names the envelope`)
      assert.ok(
        !issues.some(issue => issue.code === 'max-tools-exceeded'),
        `${shape.name}: profile size must not trip the capacity cap`,
      )
      // Capacity independence is observable: the unannotated baseline is admitted
      // with a warning, and it stays in the hard allowlist the driver exposes.
      const baseline = issues.find(issue => issue.code === 'baseline-admitted')
      assert.ok(baseline, `${shape.name}: baseline admission is recorded`)
      assert.match(baseline.detail, new RegExp(`\\b${CRAFT_TOOLS} unannotated tool\\(s\\)`, 'u'))
      assert.ok(universe.length > 64, `${shape.name}: allowlist carries the whole profile (${universe.length})`)
      assert.ok(universe.includes('gridcraft_op0'), `${shape.name}: unannotated baseline tool stays callable`)
    } else {
      // The short chat keeps the single triage step: no envelope is attempted.
      assert.equal(snapshot.envelopeId, undefined, `${shape.name}: no envelope on the triage path`)
      assert.equal(issues.length, 0, `${shape.name}: triage attempts no envelope`)
      assert.ok(
        snapshot.rationale.some(line => line.includes('triage') && line.includes('single-node')),
        `${shape.name}: rationale explains the single step`,
      )
    }
  }
})

test('unannotated tools ride as an uncapped baseline, not as selected tools', () => {
  const selected = selectEnvelopeForTask({
    fingerprint: fingerprintOf(MULTI_TOOL.text),
    graph,
    presetTools,
    includePresetTools: false,
  })
  assert.equal(selected.fallbackToStock, false)
  assert.equal(selected.envelope.tools.baseline.length, CRAFT_TOOLS)
  assert.ok(selected.envelope.tools.selected.length < 64, 'selected tools stay inside the cap')
  assert.ok(
    selected.envelope.tools.universe.length > 64,
    `the whole profile is still the hard allowlist (${selected.envelope.tools.universe.length} tools)`,
  )
  assert.deepEqual(
    selected.envelope.tools.universe,
    [...selected.envelope.tools.selected, ...selected.envelope.tools.baseline].sort(),
    'universe = selected + baseline',
  )
  assert.ok(selected.envelope.tools.baseline.includes('gridcraft_op0'))
  assert.ok(selected.envelope.tools.selected.includes('grep'))
  assert.ok(selected.envelope.tools.selected.includes('read'))
  const admission = selected.issues.find(issue => issue.code === 'baseline-admitted')
  assert.equal(admission?.severity, 'warning')
  assert.match(admission?.detail ?? '', /not counted against the 64 cap/u)
})

test('maxTools still bounds the router’s own selection (capacity semantics unchanged)', () => {
  const fingerprint = fingerprintOf(FILE_EDIT.text)
  const capped = selectEnvelopeForTask({ fingerprint, graph, presetTools, includePresetTools: false, maxTools: 2 })
  assert.equal(capped.fallbackToStock, true)
  const error = capped.issues.find(issue => issue.code === 'max-tools-exceeded')
  assert.equal(error?.severity, 'error')
  // The cap counts the selected half only: the 98-tool baseline is not a selection.
  assert.equal(
    error?.detail,
    `envelope selected ${capped.envelope.tools.selected.length} tools, over the 2 cap`,
  )
  assert.ok(capped.envelope.tools.selected.length > 2)
})

test('a rejected envelope is visible in the snapshot instead of silently degrading', async () => {
  // A registry with no tool nodes cannot fill any role; the composition branch
  // must decline, say why, and let the legacy path run — not swallow the reason.
  const toolLess = buildRegistrySnapshot({ sections: [{ id: 'composition:node', tokens: 40 }] })
  const driver = createGraphTurnDriver({ mode: 'dynamic', graphProvider: () => toolLess.graph as RegistryGraph })
  const snapshot = await driver.beginTurn({
    text: 'explain how the composer resolves the capability envelope from the live registry',
  })
  assert.equal(snapshot.path, 'synthesized')
  assert.equal(snapshot.envelopeId, undefined)
  assert.ok(
    snapshot.envelopeIssues.some(issue => issue.code === 'envelope-empty' && issue.severity === 'error'),
    'the rejection code is recorded on the snapshot',
  )
  assert.match(snapshot.rationale[0] ?? '', /^envelope rejected: envelope-empty/u)
})
