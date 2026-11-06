#!/usr/bin/env node
/**
 * Summarize local agent-eval result files with both mean and median.
 *
 * Usage:
 *   node bench/agent-eval/summarize.mjs [results.json ...]
 *   node bench/agent-eval/summarize.mjs --per-task results/2026-11-07-local-2x.json
 *
 * With no file argument it reads every `*.json` under `results/`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const perTask = args.includes('--per-task')
const files = args.filter(arg => !arg.startsWith('--'))
if (files.length === 0) {
  for (const name of readdirSync(join(HERE, 'results')).sort()) {
    if (name.endsWith('.json')) files.push(join(HERE, 'results', name))
  }
}

function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function stat(rows, key) {
  const values = rows.map(row => row[key] ?? 0)
  return { mean: mean(values), median: median(values), min: Math.min(...values), max: Math.max(...values) }
}

function printArm(arm, rows) {
  const pass = rows.filter(row => row.ok).length
  const fields = [
    ['steps', 'steps'],
    ['toolCalls', 'tools'],
    ['promptTokens', 'prompt'],
    ['outputTokens', 'output'],
    ['wallMs', 'wall'],
  ]
  const parts = fields.map(([key, label]) => {
    const value = stat(rows, key)
    return `${label} ${value.mean.toFixed(1)}/${value.median.toFixed(1)}`
  })
  console.log(`  ${arm.padEnd(6)} ${String(pass).padStart(2)}/${String(rows.length).padEnd(2)}  ${parts.join('  ')}`)
}

for (const file of files) {
  const absolute = resolve(file)
  const rows = JSON.parse(readFileSync(absolute, 'utf8'))
  console.log(`\n${absolute}`)
  console.log('  arm    ok      mean/median (steps, tools, prompt, output, wall ms)')
  for (const arm of [...new Set(rows.map(row => row.arm))]) {
    printArm(arm, rows.filter(row => row.arm === arm))
  }
  if (perTask) {
    console.log('  per task (mean steps / mean prompt / mean wall):')
    for (const task of [...new Set(rows.map(row => row.task))]) {
      const taskRows = rows.filter(row => row.task === task)
      const arms = [...new Set(taskRows.map(row => row.arm))]
      const cells = arms.map((arm) => {
        const armRows = taskRows.filter(row => row.arm === arm)
        return `${arm}: ${mean(armRows.map(row => row.steps)).toFixed(1)} / ${mean(armRows.map(row => row.promptTokens)).toFixed(0)} / ${mean(armRows.map(row => row.wallMs)).toFixed(0)}`
      })
      console.log(`    ${task.padEnd(14)} ${cells.join('   ')}`)
    }
  }
}
