#!/usr/bin/env node
/**
 * A/B bench runner skeleton for the DSH graph-loop evaluation.
 *
 * Runnable today:  --arm baseline | explore   (stock loop, one headless run per task)
 * Not wired:       --arm graph-control | graph-node   (prints exactly what is missing)
 *
 * A run is: spawn `dsh --profile <profile> <task prompt>`, let it write a session
 * log under $DSH_HOME, then price that log with scripts/analyze-session.mjs. The
 * runner never edits the DSH checkout; all state lives under --dsh-home.
 *
 * Requirements: pnpm + a built DSH checkout (see bench/README.md), and either a
 * real DEEPSEEK_API_KEY or a mock/replay endpoint:
 *
 *   # deterministic, free: point the DeepSeek adapter at the mock wire server
 *   node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
 *        --sequence success,tool_call_success,success --repeat-last --port 8123
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:8123 DEEPSEEK_API_KEY=mock \
 *     node bench/scripts/run-arm.mjs --arm baseline --tasks T1,T8
 *
 * Usage:
 *   node bench/scripts/run-arm.mjs --arm baseline --tasks T1,T2 --repetitions 1 [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const arm = flag('--arm', 'baseline')
const taskFilter = flag('--tasks', '')
const repetitions = Number(flag('--repetitions', '1'))
const dryRun = args.includes('--dry-run')
const workspace = resolve(flag('--workspace', new URL('..', new URL('..', import.meta.url)).pathname))
const checkout = resolve(flag('--checkout', '/Users/zhinan/deepseek-harness'))
const dshHome = resolve(flag('--dsh-home', join(workspace, 'bench', '.dsh-home')))
const profile = flag('--profile', 'headless')
const outPath = resolve(flag('--out', join(workspace, 'bench', 'results', `${arm}.jsonl`)))

/** Arms this runner can execute today, and the honest reason for the others. */
const ARMS = {
  'baseline': {
    ready: true,
    note: 'stock loop; headless profile composition (24 tools). NOT the web standard preset — see README gap 1.',
  },
  'explore': {
    ready: true,
    note: 'Same runner as baseline, pointed at a lean profile: pass --profile <explore profile>. '
      + 'Requires a preset-aware profile (README gap 2); without one this measures the headless composition.',
  },
  'graph-control': {
    ready: false,
    missing: [
      'A graph control-plane plugin mounted via a profile cordis.patch.yml row (replace the agent-loop row by id).',
      'The node dispatch must call the same AgentFactory seam so step events, approvals and compaction keep working.',
      'Nothing in bench/ can fabricate that: it needs the plugin from design/, or a --patch overlay that mounts it.',
    ],
  },
  'graph-node': {
    ready: false,
    missing: [
      'A coordinator that spawns one subagent session per node and passes typed hand-offs.',
      'A parent-session id recorded on each node row so sessionCount can be computed (results schema already has it).',
      'Without it, the arm would silently measure a single-session run and under-report sessionCount.',
    ],
  },
}

const spec = ARMS[arm]
if (spec === undefined) {
  process.stderr.write(`run-arm: unknown arm ${JSON.stringify(arm)}; known: ${Object.keys(ARMS).join(', ')}\n`)
  process.exit(2)
}
if (!spec.ready) {
  process.stderr.write(`run-arm: arm ${arm} is not runnable yet.\n\nMissing:\n`)
  for (const item of spec.missing) process.stderr.write(`  - ${item}\n`)
  process.stderr.write(`\nBaseline and explore arms are runnable now; graph arms need the plugin from design/.\n`)
  process.exit(3)
}

const tasks = readFileSync(join(workspace, 'bench', 'tasks', 'tasks.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))
  .filter(task => taskFilter === '' || taskFilter.split(',').includes(task.id))

if (tasks.length === 0) {
  process.stderr.write('run-arm: no tasks selected\n')
  process.exit(2)
}
mkdirSync(dshHome, { recursive: true })
mkdirSync(join(workspace, 'bench', 'results'), { recursive: true })

const runs = []
for (const task of tasks) {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const runId = `${task.id}.${arm}.r${repetition}`
    runs.push({ task, repetition, runId })
  }
}

if (dryRun) {
  for (const run of runs) {
    process.stdout.write(`# ${run.runId}\nDSH_HOME=${dshHome} pnpm --dir ${checkout} dsh --profile ${profile} ${JSON.stringify(run.task.prompt)}\n`)
  }
  process.stdout.write(`\n${spec.note}\n`)
  process.exit(0)
}

/** Newest session log under DSH_HOME, so each run can be attributed without parsing stdout. */
function newestSessionLog() {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return undefined
  const found = execFileSync('find', [root, '-name', 'session.v4.jsonl*', '-type', 'f'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
  const { statSync } = process.getBuiltinModule('node:fs')
  return found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
}

const rows = []
for (const run of runs) {
  const started = Date.now()
  let exitCode = 0
  let stdout = ''
  process.stderr.write(`[${run.runId}] running...\n`)
  try {
    stdout = execFileSync('pnpm', ['--dir', checkout, 'dsh', '--profile', profile, run.task.prompt], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: dshHome },
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // A task that fails is a result, not a crash: record the exit code.
    exitCode = error.status ?? 1
    stdout = `${error.stdout ?? ''}`
  }
  const wallTimeMs = Date.now() - started
  const log = newestSessionLog()
  if (log === undefined) {
    process.stderr.write(`[${run.runId}] no session log under ${dshHome}/sessions\n`)
    continue
  }
  const analyzed = execFileSync(process.execPath, [
    join(workspace, 'bench', 'scripts', 'analyze-session.mjs'), log, '--arm', arm,
  ], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const row = JSON.parse(analyzed.trim().split('\n').at(-1))
  rows.push({
    ...row,
    runId: run.runId,
    taskId: run.task.id,
    category: run.task.category,
    repetition: run.repetition,
    success: exitCode === 0,
    exitCode,
    wallTimeMs,
    profile,
    answerChars: stdout.trim().length,
  })
  // Persist incrementally so a long bench survives an interruption.
  writeFileSync(outPath, `${rows.map(entry => JSON.stringify(entry)).join('\n')}\n`)
}

process.stderr.write(`run-arm: wrote ${rows.length} row(s) to ${outPath}\n`)
process.stdout.write(`${JSON.stringify({
  arm, profile, tasks: tasks.length, rows: rows.length, out: outPath, note: spec.note,
}, null, 1)}\n`)
