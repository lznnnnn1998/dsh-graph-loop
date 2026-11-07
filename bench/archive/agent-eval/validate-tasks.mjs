#!/usr/bin/env node
/**
 * Validate the benchmark's negative case: every check must fail on the initial
 * fixture, otherwise the task is trivially passing. The positive case (check
 * passes after a verified solution) is validated when the suite is built; this
 * script catches regressions in the fixtures/checks.
 *
 *   node bench/agent-eval/validate-tasks.mjs
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const tasks = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'))
let failed = 0
for (const task of tasks) {
  const fixture = join(HERE, 'tasks', task.id)
  const dir = mkdtempSync(join(tmpdir(), `dsh-bench-${task.id}-`))
  try {
    if (existsSync(fixture)) cpSync(fixture, dir, { recursive: true })
    const result = spawnSync('bash', ['-lc', task.check], { cwd: dir, encoding: 'utf8', timeout: 30_000 })
    if (result.status === 0) {
      failed += 1
      console.error(`FAIL ${task.id}: check passes on the initial fixture`)
    } else {
      console.log(`ok   ${task.id}: check fails before work`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
if (failed > 0) {
  console.error(`${failed}/${tasks.length} tasks are trivially passing`)
  process.exit(1)
}
console.log(`PASS ${tasks.length} tasks fail on their initial fixture`)
