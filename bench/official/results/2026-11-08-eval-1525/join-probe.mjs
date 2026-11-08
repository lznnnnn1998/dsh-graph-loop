// Probe the frontier join barrier through the built, shipped bundle
// (packages/loop/lib/index.js == tarball lib after stripping esbuild comments).
import { createGraphTurnDriver } from '/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop/packages/loop/lib/index.js'

function planOf(edges, { terminals, maxSteps = 10, nodes }) {
  return {
    id: 'probe',
    templateId: 'test',
    version: 1,
    entry: nodes[0],
    terminals,
    nodes: nodes.map(id => ({ id, kind: 'agent-step', executor: 'step', instruction: `run ${id}` })),
    edges,
    budget: { maxNodes: nodes.length, maxSteps, maxTokens: 10000, maxWallMs: 60000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'probe',
  }
}
const e = (from, to, when) => ({ from, to, kind: 'control', ...(when ? { when } : {}) })

async function walk(plan, stream) {
  const driver = createGraphTurnDriver({ kernel: 'off', maxSteps: plan.budget.maxSteps })
  driver.adopt(plan)
  const nodes = []
  let i = 0
  for (;;) {
    const current = driver.current()
    if (current === undefined) break
    if (nodes.length > 40) throw new Error('runaway')
    nodes.push(current.id)
    await driver.advance(stream[i++] ?? { ok: true })
  }
  return { nodes, status: driver.snapshot().status, trail: driver.snapshot().trail.map(row => row.id) }
}

const deep = planOf([
  e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'c2'), e('c2', 'd'),
], { nodes: ['a', 'b', 'c', 'c2', 'd'], terminals: ['d'], maxSteps: 8 })

const inverted = planOf([
  e('a', 'b'), e('a', 'c'), e('b', 'd'), e('d', 'c'),
], { nodes: ['a', 'b', 'c', 'd'], terminals: ['c'], maxSteps: 8 })

const cycle = planOf([
  e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'c2'), e('c2', 'd'), e('d', 'e'), e('e', 'a'),
], { nodes: ['a', 'b', 'c', 'c2', 'd', 'e'], terminals: ['e'], maxSteps: 12 })

const retry = planOf([
  e('entry', 'a'), e('entry', 'b'),
  e('a', 'a', { op: 'callFailed', tool: 'bash' }),
  e('a', 'join'), e('b', 'join'), e('join', 'answer'),
], { nodes: ['entry', 'a', 'b', 'join', 'answer'], terminals: ['answer'], maxSteps: 10 })

for (const [name, plan, stream] of [
  ['deep-diamond', deep, []],
  ['inverted-join', inverted, []],
  ['join-cycle', cycle, []],
  ['fanout-retry', retry, [
    { ok: true }, { ok: false, failedTool: 'bash' }, { ok: true }, { ok: true }, { ok: true }, { ok: true },
  ]],
]) {
  const r = await walk(plan, stream)
  console.log(`${name}: nodes=${JSON.stringify(r.nodes)} status=${r.status} trail=${JSON.stringify(r.trail)}`)
}
