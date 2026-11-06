#!/usr/bin/env node
/**
 * Local agent evaluation: stock DSH loop versus the graph driver.
 *
 * This is the cheap, reproducible inner-loop harness for 0.2. It is NOT the
 * OfficeBench probe (see docs/EVALUATION.md); it is the before/after signal used
 * while wiring the graph runtime.
 *
 * Usage (real model; the shell wrapper supplies DEEPSEEK_API_KEY):
 *   node bench/agent-eval/run.mjs --arm both
 *   node bench/agent-eval/run.mjs --arm graph --task read-summary
 *
 * Metrics per run: success (task check), steps, tool calls, input/output/cache
 * tokens from assistant usage, and end-to-end wall time.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const DSH_ROOT = process.env.DSH_ROOT ?? '/Users/zhinan/deepseek-harness'
const PATCH = join(ROOT, 'packages/loop', 'dev-headless.patch.yml')
const PATCH_PRESET = join(ROOT, 'packages/loop', 'dev-headless-preset.patch.yml')
const TSX_LOADER = process.env.TSX_LOADER ?? join(DSH_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')
const WRAPPER = join(HERE, 'cli-wrapper.mjs')
const TASKS = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'))
const DEFAULT_TIMEOUT_MS = 180_000

function parseArgs(argv) {
  const options = { arm: 'both', tasks: TASKS.map(task => task.id), reps: 1, out: undefined, keep: false, installed: false, home: undefined, stockProfile: 'headless', graphProfile: 'headless', toolPolicy: 'plan' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--arm') options.arm = argv[++index]
    else if (arg === '--task') options.tasks = [argv[++index]]
    else if (arg === '--reps') options.reps = Number(argv[++index])
    else if (arg === '--out') options.out = argv[++index]
    else if (arg === '--keep') options.keep = true
    else if (arg === '--installed') options.installed = true
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--stock-profile') options.stockProfile = argv[++index]
    else if (arg === '--graph-profile') options.graphProfile = argv[++index]
    else if (arg === '--tool-policy') options.toolPolicy = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!['stock', 'graph', 'both'].includes(options.arm)) throw new Error(`bad arm: ${options.arm}`)
  if (!['plan', 'preset'].includes(options.toolPolicy)) throw new Error(`bad tool policy: ${options.toolPolicy}`)
  return options
}

function findSession(home) {
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return undefined
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.v4.jsonl.zstd') files.push(path)
    }
  }
  walk(sessions)
  return files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
}

function sessionMetrics(sessionFile) {
  if (sessionFile === undefined) return { sessionFound: false, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
  const text = execFileSync('zstd', ['-dc', sessionFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let steps = 0
  let toolCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let totalTokens = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'step/start') steps += 1
    if (event.type === 'tool/call') toolCalls += 1
    const usage = event?.data?.usage
    if (usage !== undefined) {
      inputTokens += usage.inputTokens ?? 0
      outputTokens += usage.outputTokens ?? 0
      cacheReadTokens += usage.cacheReadTokens ?? 0
      totalTokens += usage.totalTokens ?? 0
    }
  }
  return { sessionFound: true, steps, toolCalls, inputTokens, outputTokens, cacheReadTokens, totalTokens, promptTokens: inputTokens + cacheReadTokens }
}

function arithmeticMean(values) {
  if (values.length === 0) return 0
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length)
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function runOne(arm, task, outDir) {
  const runDir = join(outDir, `${arm}-${task.id}`)
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  const workspace = join(runDir, 'workspace')
  const home = options.home ?? join(runDir, 'home')
  const fixture = join(HERE, 'tasks', task.id)
  mkdirSync(workspace, { recursive: true })
  mkdirSync(home, { recursive: true })
  if (existsSync(fixture)) cpSync(fixture, workspace, { recursive: true })

  const profile = arm === 'graph' ? options.graphProfile : options.stockProfile
  const args = ['--import', TSX_LOADER, WRAPPER, '--profile', profile]
  if (arm === 'graph' && !options.installed) args.push('--patch', options.toolPolicy === 'preset' ? PATCH_PRESET : PATCH)
  args.push(task.prompt)
  const env = { ...process.env, DSH_HOME: home, DSH_EVAL_WORKSPACE: workspace }
  delete env.DEEPSEEK_BASE_URL
  if (env.DEEPSEEK_API_KEY === undefined) throw new Error('DEEPSEEK_API_KEY is required; run via run-real.sh')

  const started = Date.now()
  const result = spawnSync('node', args, {
    cwd: DSH_ROOT,
    env,
    encoding: 'utf8',
    timeout: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
  const wallMs = Date.now() - started
  const check = spawnSync('bash', ['-lc', task.check], { cwd: workspace, encoding: 'utf8', timeout: 60_000 })
  const metrics = sessionMetrics(findSession(home))
  const row = {
    arm,
    task: task.id,
    ok: result.status === 0 && check.status === 0,
    exit: result.status,
    checkExit: check.status,
    checkOutput: (check.stdout ?? '') + (check.stderr ?? ''),
    wallMs,
    agentStdout: (result.stdout ?? '').slice(-2000),
    agentStderr: (result.stderr ?? '').slice(-2000),
    ...metrics,
  }
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(row, null, 2))
  return row
}

function gitHead(cwd) {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? (result.stdout ?? '').trim() : undefined
}

const options = parseArgs(process.argv.slice(2))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = resolve(options.out ?? join(tmpdir(), 'dsh-agent-eval', stamp))
mkdirSync(outDir, { recursive: true })
const arms = options.arm === 'both' ? ['stock', 'graph'] : [options.arm]
const selected = TASKS.filter(task => options.tasks.includes(task.id))
if (selected.length === 0) throw new Error(`no matching tasks: ${options.tasks.join(', ')}`)
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
  startedAt: new Date().toISOString(),
  model: process.env.DSH_EVAL_MODEL ?? 'deepseek-flash',
  modelSnapshot: 'DeepSeek V4.1-Flash-1017',
  arms,
  tasks: selected.map(task => task.id),
  reps: options.reps,
  installed: options.installed,
  stockProfile: options.stockProfile,
  graphProfile: options.graphProfile,
  toolPolicy: options.toolPolicy,
  dshRoot: DSH_ROOT,
  dshCommit: gitHead(DSH_ROOT),
  pluginCommit: gitHead(ROOT),
  node: process.version,
  platform: process.platform,
}, null, 2))

const rows = []
for (let rep = 0; rep < options.reps; rep += 1) {
  for (const arm of arms) {
    for (const task of selected) {
      process.stderr.write(`[${rep + 1}/${options.reps}] ${arm} ${task.id} ... `)
      const row = runOne(arm, task, outDir)
      process.stderr.write(`${row.ok ? 'ok' : 'FAIL'} steps=${row.steps} in=${row.inputTokens} wall=${row.wallMs}ms\n`)
      rows.push({ rep, ...row })
    }
  }
}

writeFileSync(join(outDir, 'results.json'), JSON.stringify(rows, null, 2))
const width = Math.max(...selected.map(task => task.id.length), 4)
console.log(`\nresults: ${outDir}`)
console.log(`${'arm'.padEnd(6)} ${'task'.padEnd(width)}  ok  steps tools   inTok  outTok  cache prompt  wallMs`)
for (const row of rows) {
  console.log(`${row.arm.padEnd(6)} ${row.task.padEnd(width)}  ${row.ok ? 'Y ' : 'N '}  ${String(row.steps).padStart(5)} ${String(row.toolCalls).padStart(5)} ${String(row.inputTokens).padStart(7)} ${String(row.outputTokens).padStart(7)} ${String(row.cacheReadTokens).padStart(6)} ${String(row.promptTokens).padStart(6)} ${String(row.wallMs).padStart(7)}`)
}
console.log('')
for (const arm of arms) {
  const armRows = rows.filter(row => row.arm === arm)
  const pass = armRows.filter(row => row.ok).length
  console.log(
    `${arm}: success ${pass}/${armRows.length}; `
    + `steps mean ${arithmeticMean(armRows.map(row => row.steps))} median ${median(armRows.map(row => row.steps))}; `
    + `prompt mean ${arithmeticMean(armRows.map(row => row.promptTokens))} median ${median(armRows.map(row => row.promptTokens))}; `
    + `wall mean ${arithmeticMean(armRows.map(row => row.wallMs))}ms median ${median(armRows.map(row => row.wallMs))}ms`,
  )
}
