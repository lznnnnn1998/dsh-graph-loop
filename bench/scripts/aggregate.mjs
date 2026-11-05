#!/usr/bin/env node
/**
 * Aggregate bench rows per arm and apply the pre-registered acceptance thresholds.
 *
 * Usage:
 *   node bench/scripts/aggregate.mjs bench/results/*.jsonl
 *
 * The thresholds live in ACCEPT below. They are the numbers research/04-tokens.md
 * commits to before any graph run exists; editing them after seeing results is
 * how an A/B stops being an A/B.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import process from 'node:process'

/** Pre-registered decision rules. Change only with a written reason in research/04-tokens.md. */
const ACCEPT = {
  /** Median billed input units per completed task must fall at least this much vs baseline. */
  minBilledInputDrop: 0.15,
  /** ...and the median prompt-token drop must be at least this much (what users perceive as "tokens"). */
  minPromptTokenDrop: 0.25,
  /** Kill if the cache-read ratio falls by more than this many points: dynamic gating ate the prefix. */
  maxCacheReadRatioDrop: 0.20,
  /** Kill if success rate drops by more than this many points. */
  maxSuccessDrop: 0.05,
  /** Kill if wall time per completed task rises more than this, even when tokens fall. */
  maxWallTimeRise: 0.30,
}

const median = values => {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const pct = (part, whole) => (whole === 0 ? 0 : (part - whole) / whole)

const files = process.argv.slice(2)
if (files.length === 0) {
  process.stderr.write('usage: aggregate.mjs <results.jsonl>...\n')
  process.exit(2)
}
const rows = files.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  .map(line => ({ ...JSON.parse(line), source: basename(file) })))
const arms = [...new Set(rows.map(row => row.arm))]

const summary = {}
for (const arm of arms) {
  const armRows = rows.filter(row => row.arm === arm)
  summary[arm] = {
    rows: armRows.length,
    tasks: new Set(armRows.map(row => row.taskId).filter(Boolean)).size,
    sessionCount: mean(armRows.map(row => row.sessionCount ?? 1)),
    stepsMedian: median(armRows.map(row => row.steps)),
    promptTokensMedian: median(armRows.map(row => row.promptTokens)),
    billedInputMedian: median(armRows.map(row => row.billedInputUnits)),
    cacheReadRatioMedian: median(armRows.map(row => row.cacheReadRatio)),
    successRate: mean(armRows.map(row => (row.success === false ? 0 : 1))),
    wallTimeMedianMs: median(armRows.map(row => row.wallTimeMs ?? 0)),
    tokenSources: [...new Set(armRows.map(row => row.tokenSource))],
  }
}

/** Apply the rules to one candidate arm against the baseline row. */
function judge(arm) {
  const candidate = summary[arm]
  const baseline = summary['baseline']
  if (baseline === undefined || arm === 'baseline') return { verdict: 'baseline', rules: [] }
  const billed = pct(candidate.billedInputMedian, baseline.billedInputMedian)
  const prompt = pct(candidate.promptTokensMedian, baseline.promptTokensMedian)
  const cache = candidate.cacheReadRatioMedian - baseline.cacheReadRatioMedian
  const success = candidate.successRate - baseline.successRate
  const wall = pct(candidate.wallTimeMedianMs, baseline.wallTimeMedianMs)
  const rules = [
    { rule: 'billed input ≥15% lower', value: billed, pass: billed <= -ACCEPT.minBilledInputDrop },
    { rule: 'prompt tokens ≥25% lower', value: prompt, pass: prompt <= -ACCEPT.minPromptTokenDrop },
    { rule: 'cache-read ratio drop ≤20 pts', value: cache, pass: cache >= -ACCEPT.maxCacheReadRatioDrop },
    { rule: 'success drop ≤5 pts', value: success, pass: success >= -ACCEPT.maxSuccessDrop },
    { rule: 'wall time rise ≤30%', value: wall, pass: wall <= ACCEPT.maxWallTimeRise },
  ]
  const killed = rules.filter(entry => !entry.pass)
  return { verdict: killed.length === 0 ? 'accept' : 'kill', rules }
}

const report = {
  generatedAt: new Date().toISOString(),
  thresholds: ACCEPT,
  files,
  summary,
  verdicts: Object.fromEntries(arms.map(arm => [arm, judge(arm)])),
}
writeFileSync(`${process.cwd()}/bench/results/aggregate.json`, `${JSON.stringify(report, null, 1)}\n`)

const fmtPct = value => `${(100 * value).toFixed(1)}%`
const lines = []
lines.push('| arm | rows | sessions | steps (med) | prompt tok (med) | billed input (med) | cache-read | success | wall (med) |')
lines.push('|---|---|---|---|---|---|---|---|---|')
for (const arm of arms) {
  const row = summary[arm]
  const verdict = judge(arm).verdict
  lines.push(`| ${arm} (${verdict}) | ${row.rows} | ${row.sessionCount.toFixed(1)} | ${row.stepsMedian} | `
    + `${Math.round(row.promptTokensMedian).toLocaleString('en-US')} | ${Math.round(row.billedInputMedian).toLocaleString('en-US')} | `
    + `${(100 * row.cacheReadRatioMedian).toFixed(1)}% | ${(100 * row.successRate).toFixed(0)}% | ${row.wallTimeMedianMs} |`)
}
for (const arm of arms) {
  const verdict = judge(arm)
  if (verdict.verdict === 'baseline') continue
  lines.push('', `### ${arm}: ${verdict.verdict.toUpperCase()}`)
  for (const entry of verdict.rules) {
    lines.push(`- ${entry.pass ? 'PASS' : 'FAIL'} — ${entry.rule} (${typeof entry.value === 'number' && Math.abs(entry.value) <= 1 ? fmtPct(entry.value) : entry.value})`)
  }
}
process.stdout.write(`${lines.join('\n')}\n`)
