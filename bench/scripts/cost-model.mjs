#!/usr/bin/env node
/**
 * Billed-token cost model for the DSH graph-loop evaluation.
 *
 * Everything here is arithmetic over measured inputs; no model calls. It
 * answers three questions the proposal depends on:
 *
 *   1. Where do the billed input tokens actually go in a stock-loop session?
 *   2. How many steps must a tool-set change survive before it pays for the
 *      prefix-cache invalidation it causes?
 *   3. Does moving work into fresh-context subagent nodes beat one accumulating
 *      session, and at what task length?
 *
 * Prices are DeepSeek flash list prices (off-peak): cache hit $0.003/M,
 * cache miss $0.15/M, output $0.60/M. So one cache-hit token costs
 * HIT_RATIO = 0.02 of one miss token; one output token costs 4 miss tokens.
 *
 * Usage:
 *   node bench/scripts/cost-model.mjs                    # all models, defaults
 *   node bench/scripts/cost-model.mjs --measured <results.jsonl>
 *   node bench/scripts/cost-model.mjs --what break-even
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'

const PRICE = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }
const HIT_RATIO = PRICE.cacheHit / PRICE.cacheMiss // 0.02
const OUTPUT_RATIO = PRICE.output / PRICE.cacheMiss // 4

/** Billed input units for one request: miss at 1.0, cache read at HIT_RATIO. */
const billedInput = (missTokens, hitTokens) => missTokens + HIT_RATIO * hitTokens
const usd = units => units * PRICE.cacheMiss / 1e6

const fmt = value => new Intl.NumberFormat('en-US').format(Math.round(value))
const pct = (part, whole) => `${(100 * part / whole).toFixed(1)}%`

/**
 * Break-even between a per-step schema saving and a prefix invalidation.
 *
 * Removing `deltaSchema` tokens from the tool array saves `deltaSchema * HIT_RATIO`
 * billed units per step while the cache stays warm. Changing the tool array
 * invalidates reuse of everything after it, so the next request re-reads the
 * whole fixed prefix and history at miss price: a one-off cost of
 * `(1 - HIT_RATIO) * (prefix + history)`.
 *
 * @returns steps the smaller tool set must run before the change pays off.
 */
function breakEvenSteps({ deltaSchema, prefixTokens, historyTokens }) {
  const savePerStep = deltaSchema * HIT_RATIO
  const invalidate = (1 - HIT_RATIO) * (prefixTokens + historyTokens)
  return { savePerStep, invalidate, steps: invalidate / savePerStep }
}

/** Split a measured session row into prefix / history / new-content billed shares. */
function decompose(row) {
  const prefixPerStep = row.systemTokens + row.toolSchemaTokens
  const prefixHits = prefixPerStep * row.steps
  const historyHits = Math.max(0, row.cacheReadTokens - prefixHits)
  const input = billedInput(row.missTokens, row.cacheReadTokens)
  return {
    prefixHits,
    historyHits,
    prefixShare: pct(HIT_RATIO * prefixHits, input),
    historyShare: pct(HIT_RATIO * historyHits, input),
    newShare: pct(row.missTokens, input),
    input,
    output: OUTPUT_RATIO * row.outputTokens,
  }
}

const args = process.argv.slice(2)
const whatIndex = args.indexOf('--what')
const what = whatIndex === -1 ? 'all' : args[whatIndex + 1]
const measuredIndex = args.indexOf('--measured')
const measuredFile = measuredIndex === -1 ? undefined : args[measuredIndex + 1]
const want = name => what === 'all' || what === name

const out = []
const say = line => out.push(line)

if (measuredFile !== undefined && want('measured')) {
  const rows = readFileSync(measuredFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  say('## 1. Where the billed input goes (measured sessions, provider usage)\n')
  say('| session | kind | steps | tools | prefix tok | prompt tok | hit ratio | prefix | history | new | billed in | $ |')
  say('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const row of rows) {
    if (row.tokenSource !== 'provider') continue
    const d = decompose(row)
    say(`| ${row.sessionFile.slice(0, 8)} | ${row.kind} | ${row.steps} | ${row.tools} | `
      + `${fmt(row.systemTokens + row.toolSchemaTokens)} | ${fmt(row.promptTokens)} | `
      + `${(100 * row.cacheReadRatio).toFixed(1)}% | ${d.prefixShare} | ${d.historyShare} | ${d.newShare} | `
      + `${fmt(d.input)} | ${usd(d.input + d.output).toFixed(4)} |`)
  }
  say('')
}

if (want('break-even')) {
  say('## 2. Break-even: per-step tool gating vs prefix-cache invalidation\n')
  say(`Price ratio hit:miss = ${HIT_RATIO} (1:${Math.round(1 / HIT_RATIO)}). A saving of ΔS schema tokens is worth `
    + `ΔS·${HIT_RATIO} per step; one invalidation costs (1−${HIT_RATIO})·(prefix+history).\n`)
  say('| scenario | ΔS schema tok | prefix+history | saving/step | invalidation | steps to break even | verdict |')
  say('|---|---|---|---|---|---|---|')
  const scenarios = [
    {
      name: 'S1 explore preset vs standard preset (Δ tools 1,955 + guidance 590)',
      deltaSchema: 2545, prefixTokens: 9150, historyTokens: 40000,
    },
    {
      name: 'S2 live 160-tool env, drop delegation+team+workflow',
      deltaSchema: 3354, prefixTokens: 35095, historyTokens: 116753,
    },
    {
      name: 'S3 in-session gating to a 2-tool subset, live env',
      deltaSchema: 28600, prefixTokens: 35095, historyTokens: 116753,
    },
  ]
  for (const scenario of scenarios) {
    const { savePerStep, invalidate, steps } = breakEvenSteps(scenario)
    const stepsAvailable = 40 // typical stock-loop task length measured in bench/results
    say(`| ${scenario.name} | ${fmt(scenario.deltaSchema)} | ${fmt(scenario.prefixTokens + scenario.historyTokens)} | `
      + `${fmt(savePerStep)} | ${fmt(invalidate)} | **${fmt(steps)}** | `
      + `${steps > stepsAvailable ? `loses: needs ${fmt(steps)} steps, task has ~${stepsAvailable}` : 'could win'} |`)
  }
  say('')
}

if (want('modes')) {
  say('## 3. Mode A (one session) vs Mode B (subagent nodes)\n')
  say('Model: every step re-reads the whole surface at hit price except its own new content at miss price.')
  say('A split moves work into K fresh contexts, so each node re-reads only its own trajectory, but every')
  say('node pays a one-time orientation cost (brief + re-reading what the parent already knew) and the')
  say('parent pays dispatch/collect steps. Per-step new content is the same work in both arms.\n')
  const base = { prefixTokens: 35095, firstHistory: 3000, perStepNew: 2000, nodeOrientation: 3000 }
  const options = { parentStepsPerNode: 2, parentOrientation: 4, parentPerStepNew: 1800 }
  /** Billed input units for one session with `steps` steps. */
  const session = (steps, firstHistory, perStepNew) => {
    let hit = 0
    for (let step = 0; step < steps; step += 1) hit += base.prefixTokens + firstHistory + step * perStepNew
    return { hit, miss: steps * perStepNew, units: billedInput(steps * perStepNew, hit) }
  }
  /** Billed input units for the K-node split of an S-step task. */
  const split = (steps, nodes) => {
    const parentSteps = options.parentStepsPerNode * nodes + options.parentOrientation
    const parent = session(parentSteps, 3000, options.parentPerStepNew)
    const nodeSteps = Math.ceil(steps / nodes)
    const nodeHit = nodeSteps === 0 ? 0 : (() => {
      let hit = 0
      for (let step = 0; step < nodeSteps; step += 1) hit += base.prefixTokens + 2500 + step * base.perStepNew
      return hit
    })()
    const nodeMiss = nodes * (nodeSteps * base.perStepNew + base.nodeOrientation)
    return parent.units + billedInput(nodeMiss, nodeHit)
  }
  const stock = session(68, 3000, base.perStepNew)
  say(`Reference task: 68 steps (median of the measured sessions), prefix ${fmt(base.prefixTokens)} tok, `
    + `${fmt(base.perStepNew)} new tok/step.`)
  say(`Stock loop billed input ${fmt(stock.units)} units (${usd(stock.units).toFixed(4)} USD).\n`)
  say('| decomposition | parent steps | node steps | billed input units | vs stock |')
  say('|---|---|---|---|---|')
  for (const nodes of [2, 4, 8]) {
    const parentSteps = options.parentStepsPerNode * nodes + options.parentOrientation
    const nodeSteps = Math.ceil(68 / nodes)
    const total = split(68, nodes)
    say(`| ${nodes} nodes | ${parentSteps} | ${nodeSteps} | ${fmt(total)} | ${((total / stock.units - 1) * 100).toFixed(1)}% |`)
  }
  say('')
  say('### Break-even task length (steps at which a split beats one session)\n')
  say('| nodes | break-even steps | stock units @200 | split units @200 | saving @200 |')
  say('|---|---|---|---|---|')
  for (const nodes of [2, 4, 8]) {
    let breakEven = null
    for (let steps = 5; steps <= 400; steps += 1) {
      if (split(steps, nodes) < session(steps, 3000, base.perStepNew).units) { breakEven = steps; break }
    }
    const s200 = session(200, 3000, base.perStepNew).units
    const t200 = split(200, nodes)
    say(`| ${nodes} | ${breakEven === null ? 'none ≤400' : breakEven} | ${fmt(s200)} | ${fmt(t200)} | ${((t200 / s200 - 1) * 100).toFixed(1)}% |`)
  }
  say('')
  say('Assumptions: prefix identical and cache-warm in every node; node orientation 3k new tokens; parent')
  say('keeps summaries only (1.8k new tok per dispatch); no quality loss. Raising node orientation or the')
  say('parent step count moves break-even later; a per-node tool surface change would also invalidate the')
  say('node prefix (see §2) and is not assumed here.')
  say('')
}

if (want('preset')) {
  say('## 4. Preset switch is a session-scoped, cache-stable change\n')
  say('A preset is chosen at session creation, so the smaller surface is one stable prefix for the whole run:')
  say('exactly one novel prefix per session, whose first request pays miss price for it. DeepSeek reports no')
  say('separate cache-write charge (cacheWriteTokens = 0 in every measured session), so the warm-up cost is')
  say('just that first request.\n')
  const standard = { system: 5771, toolsBytes: 30320 } // standard preset, reconstructed from the preset YAML
  const explore = { system: 5181, toolsBytes: 22491 } // standard minus delegation/team/workflow
  const tok = chars => Math.ceil(chars / 4)
  const stdPrefix = tok(standard.system) + tok(standard.toolsBytes)
  const expPrefix = tok(explore.system) + tok(explore.toolsBytes)
  say(`| preset | system tok | tool tok | fixed prefix tok | first-request miss cost (USD) | per-40-step saving vs standard |`)
  say('|---|---|---|---|---|---|')
  say(`| standard | ${fmt(tok(standard.system))} | ${fmt(tok(standard.toolsBytes))} | ${fmt(stdPrefix)} | ${usd(stdPrefix).toFixed(4)} | – |`)
  say(`| explore | ${fmt(tok(explore.system))} | ${fmt(tok(explore.toolsBytes))} | ${fmt(expPrefix)} | ${usd(expPrefix).toFixed(4)} | `
    + `${fmt((stdPrefix - expPrefix) * HIT_RATIO * 40)} units (${usd((stdPrefix - expPrefix) * HIT_RATIO * 40).toFixed(5)} USD) |`)
  say('')
  say(`Explore removes ${fmt(stdPrefix - expPrefix)} tokens (${pct(stdPrefix - expPrefix, stdPrefix)}) from every request.`)
  say('')
}

process.stdout.write(`${out.join('\n')}\n`)
