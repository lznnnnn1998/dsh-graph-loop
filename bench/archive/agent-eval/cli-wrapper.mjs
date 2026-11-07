/**
 * CLI wrapper for the local evaluation harness.
 *
 * Module resolution for the DSH workspace (tsx, cordis, vendor packages) only
 * works while cwd is the DSH checkout. The agent's file tools, however, use
 * `process.cwd()` as the workspace. So: preload the harness module graph with
 * the DSH cwd, then switch to the task workspace before booting the CLI.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshRoot = process.env.DSH_ROOT ?? '/Users/zhinan/deepseek-harness'
const workspace = process.env.DSH_EVAL_WORKSPACE
if (workspace === undefined) throw new Error('DSH_EVAL_WORKSPACE is required')

// Resolve the harness packages while the cwd is still the DSH checkout.
await import(pathToFileURL(join(dshRoot, 'apps/cli/src/profile-boot.ts')).href)
process.chdir(workspace)
const bin = await import(pathToFileURL(join(dshRoot, 'apps/cli/src/bin.ts')).href)
await bin.runCli()
