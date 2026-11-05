#!/usr/bin/env node
// Structural conformance check for one DSH session log (stock or graph driver).
//
// The graph driver forks agent-loop, so the risk is silent event-taxonomy drift.
// This script checks the invariants every consumer (UI, compaction, projections)
// relies on, without requiring byte-identical step counts:
//
//   - turns open and close exactly;
//   - steps open and close exactly, in order;
//   - every tool/result has a preceding tool/call with the same call id;
//   - an assistant message never appears outside an open step;
//   - the first assistant message is preceded by a request/header (later steps may
//     reuse the logged header, so a per-step header is not required).
import { spawnSync } from 'node:child_process'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: conformance-diff.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}
const decompressed = spawnSync('zstd', ['-dc', file], { encoding: 'utf8' })
if (decompressed.status !== 0) {
  console.error(`zstd failed for ${file}: ${decompressed.stderr}`)
  process.exit(2)
}
const events = decompressed.stdout.split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line) } catch { return null }
}).filter(Boolean)

const errors = []
let turnOpen = false
let stepOpen = false
let openStep = null
let lastTurn = 0
let lastStep = 0
let headerInStep = false
let sawHeader = false
const calls = new Map()
const counts = {}
for (const event of events) {
  counts[event.type] = (counts[event.type] ?? 0) + 1
  switch (event.type) {
    case 'turn/start':
      if (turnOpen) errors.push(`turn/start while turn open at seq ${event.seq}`)
      if (event.data.turn !== lastTurn + 1) errors.push(`turn number ${event.data.turn} after ${lastTurn} at seq ${event.seq}`)
      lastTurn = event.data.turn
      lastStep = 0
      turnOpen = true
      break
    case 'turn/end':
      if (!turnOpen) errors.push(`turn/end without open turn at seq ${event.seq}`)
      if (stepOpen) errors.push(`turn/end while step open at seq ${event.seq}`)
      turnOpen = false
      break
    case 'step/start':
      if (!turnOpen) errors.push(`step/start outside a turn at seq ${event.seq}`)
      if (stepOpen) errors.push(`step/start while step open at seq ${event.seq}`)
      const stepNumber = event.data.step
      if (stepNumber !== lastStep + 1) errors.push(`step number ${stepNumber} after ${lastStep} at seq ${event.seq}`)
      lastStep = stepNumber
      stepOpen = true
      openStep = event.data
      headerInStep = false
      break
    case 'step/end':
      if (!stepOpen) errors.push(`step/end without open step at seq ${event.seq}`)
      stepOpen = false
      break
    case 'request/header':
      if (!stepOpen) errors.push(`request/header outside a step at seq ${event.seq}`)
      headerInStep = true
      sawHeader = true
      break
    case 'assistant/message':
      if (!stepOpen) errors.push(`assistant/message outside a step at seq ${event.seq}`)
      if (!sawHeader) errors.push(`assistant/message before any request/header at seq ${event.seq}`)
      break
    case 'tool/call':
      if (!stepOpen) errors.push(`tool/call outside a step at seq ${event.seq}`)
      calls.set(event.data.callId, event.data.name)
      break
    case 'tool/result': {
      if (!stepOpen) errors.push(`tool/result outside a step at seq ${event.seq}`)
      const callId = event.data.message?.toolCallId
      if (callId === undefined || !calls.has(callId)) errors.push(`tool/result for unknown call ${String(callId)} at seq ${event.seq}`)
      break
    }
    default:
      break
  }
}
if (turnOpen) errors.push('session ended with an open turn')
if (stepOpen) errors.push('session ended with an open step')
if ((counts['turn/start'] ?? 0) !== (counts['turn/end'] ?? 0)) errors.push('turn/start and turn/end counts differ')
if ((counts['step/start'] ?? 0) !== (counts['step/end'] ?? 0)) errors.push('step/start and step/end counts differ')

const summary = {
  file,
  events: events.length,
  turns: counts['turn/start'] ?? 0,
  steps: counts['step/start'] ?? 0,
  toolCalls: counts['tool/call'] ?? 0,
  assistant: counts['assistant/message'] ?? 0,
  errors,
}
console.log(JSON.stringify(summary, null, 2))
if (errors.length > 0) process.exit(1)
