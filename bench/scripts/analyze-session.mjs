#!/usr/bin/env node
/**
 * Offline metric extractor for a DSH session log.
 *
 * Reads one or more `session.v4.jsonl.zstd` files (or already-decompressed
 * `.jsonl` copies), folds the durable event stream the same way the harness
 * does, and emits one result row per session in the bench results schema.
 *
 * Two independent token sources are reported and never mixed:
 *   - `provider`: the usage the model API returned (inputTokens/cacheReadTokens/
 *     cacheWriteTokens/outputTokens). Authoritative, but absent or fake in a
 *     mock/replay run.
 *   - `heuristic`: DSH's own token-meter price (chars/4 + fixed block/role
 *     overheads, see packages/llm/token-meter/src/estimate.ts). Always
 *     available from the logged surface, so identical across arms.
 *
 * Usage:
 *   node bench/scripts/analyze-session.mjs <session file>... [--arm baseline]
 *   node bench/scripts/analyze-session.mjs --jsonl <file.jsonl> --arm graph-node
 *
 * No dependencies beyond Node >= 22 (uses the `zstd` binary when present).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import process from 'node:process'

/** Heuristic constants copied from packages/llm/token-meter/src/estimate.ts. */
const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

/** DeepSeek list prices, USD per 1M tokens, off-peak (api-docs.deepseek.com/quick_start/pricing). */
const PRICE = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }

const tokens = chars => Math.ceil(chars / CHARS_PER_TOKEN)
const priceToolArray = bytes => (bytes === 0 ? 0 : tokens(bytes) + BLOCK_OVERHEAD)

/** Decompress a session log; falls back to a single zstd frame if `zstd` is absent. */
function readLog(path) {
  if (extname(path) !== '.zstd') return readFileSync(path, 'utf8')
  try {
    return execFileSync('zstd', ['-d', '-q', '-c', path], { maxBuffer: 1 << 30 }).toString('utf8')
  } catch {
    // Node's zstd decoder stops at the first frame, which truncates an appended log.
    const { zstdDecompressSync } = process.getBuiltinModule('node:zlib')
    return zstdDecompressSync(readFileSync(path)).toString('utf8')
  }
}

/** Text length of one message's content blocks, using the meter's own pricing rule. */
function blockChars(blocks) {
  let chars = 0
  for (const block of blocks ?? []) {
    if (block.type === 'text' || block.type === 'reasoning') chars += (block.text ?? '').length
    else chars += JSON.stringify(block).length
  }
  return chars
}

/** One row of the results schema. Fields are filled in as the log is folded. */
function newRow(path, arm, runId) {
  return {
    schemaVersion: 1,
    arm,
    runId,
    sessionFile: basename(path),
    kind: 'main',
    provider: undefined,
    model: undefined,
    sessionCount: 1,
    tools: 0,
    toolSchemaBytes: 0,
    toolSchemaTokens: 0,
    systemChars: 0,
    systemTokens: 0,
    steps: 0,
    toolCalls: 0,
    promptTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    missTokens: 0,
    outputTokens: 0,
    cacheReadRatio: 0,
    billedInputUnits: 0,
    billedOutputUnits: 0,
    billedCostUsd: 0,
    wallTimeMs: 0,
    tokenSource: 'heuristic',
    contextBreakdownFirstStep: undefined,
    contextBreakdownLastStep: undefined,
    perStep: [],
  }
}

/** Fold one session log into a results row. */
function analyze(path, arm) {
  const events = readLog(path).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const row = newRow(path, arm, basename(path, extname(extname(path)) ? extname(path) : ''))
  if (events.some(event => event.type === 'subagent/descriptor')) row.kind = 'subagent'

  const header = events.find(event => event.type === 'request/header')
  const tools = header?.data?.header?.tools ?? []
  row.toolSchemaBytes = JSON.stringify(tools).length
  row.toolSchemaTokens = priceToolArray(row.toolSchemaBytes)
  row.tools = tools.length
  row.provider = events.find(event => event.type === 'request/context')?.data?.provider
  row.model = events.find(event => event.type === 'request/context')?.data?.model

  const systemNodes = events.filter(event => event.type === 'system/message')
  row.systemChars = systemNodes.reduce((sum, event) => sum + blockChars(event.data.message?.content), 0)
  row.systemTokens = systemNodes.length === 0 ? 0 : tokens(row.systemChars) + ROLE_OVERHEAD

  // Provider usage, step by step. A mock adapter reports synthetic usage, so the
  // presence of any real cache counter decides the token source.
  const assistant = events.filter(event => event.type === 'assistant/message')
  const usage = assistant.map(event => event.data.usage ?? {})
  row.steps = events.filter(event => event.type === 'step/start').length
  row.toolCalls = events.filter(event => event.type === 'tool/call').length

  let messageChars = 0
  let stepIndex = 0
  const perStep = []
  let sawCacheCounter = false
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      messageChars += blockChars(event.data.message?.content ?? event.data.content ?? [])
    }
    if (event.type !== 'assistant/message') continue
    const used = usage[stepIndex] ?? {}
    const hit = used.cacheReadTokens ?? 0
    const miss = used.inputTokens ?? 0
    const write = used.cacheWriteTokens ?? 0
    const output = used.outputTokens ?? 0
    if (hit > 0 || write > 0) sawCacheCounter = true
    const prompt = hit + miss + write
    perStep.push({
      step: stepIndex,
      promptTokens: prompt,
      cacheReadTokens: hit,
      missTokens: miss,
      outputTokens: output,
      // Surface split, priced by the meter's heuristic at this step's tail.
      systemTokens: row.systemTokens,
      toolsTokens: row.toolSchemaTokens,
      messageTokens: tokens(messageChars),
    })
    row.cacheReadTokens += hit
    row.cacheWriteTokens += write
    row.missTokens += miss
    row.outputTokens += output
    row.promptTokens += prompt
    stepIndex += 1
  }
  row.tokenSource = sawCacheCounter ? 'provider' : 'heuristic'
  if (!sawCacheCounter) {
    // No usable provider usage: derive prompt tokens from the logged surface.
    row.promptTokens = perStep.reduce(
      (sum, step) => sum + step.systemTokens + step.toolsTokens + step.messageTokens, 0,
    )
    row.missTokens = row.promptTokens
  }
  row.contextBreakdownFirstStep = perStep[0]
  row.contextBreakdownLastStep = perStep.at(-1)
  row.perStep = perStep
  row.cacheReadRatio = row.promptTokens === 0 ? 0 : row.cacheReadTokens / row.promptTokens
  row.billedInputUnits = row.missTokens + PRICE.cacheHit / PRICE.cacheMiss * row.cacheReadTokens
  row.billedOutputUnits = (PRICE.output / PRICE.cacheMiss) * row.outputTokens
  row.billedCostUsd = (row.billedInputUnits + row.billedOutputUnits) * PRICE.cacheMiss / 1e6

  const starts = events.filter(event => event.type === 'turn/start')
  const ends = events.filter(event => event.type === 'turn/end')
  if (starts.length > 0 && ends.length > 0) row.wallTimeMs = ends.at(-1).time - starts[0].time
  return row
}

const args = process.argv.slice(2)
const armIndex = args.indexOf('--arm')
const arm = armIndex === -1 ? 'baseline' : args[armIndex + 1]
const files = args.filter((arg, index) => !arg.startsWith('--') && (armIndex === -1 || index !== armIndex + 1))
if (files.length === 0) {
  process.stderr.write('usage: analyze-session.mjs <session.v4.jsonl.zstd|session.jsonl>... [--arm <name>]\n')
  process.exit(2)
}
const rows = files.map(file => analyze(file, arm))
process.stdout.write(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
