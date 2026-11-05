// Build release JS for both bundles. Local @dsh/* and @deepseek-ai/* stay external;
// everything else (including dsh-graph-loop-core) is bundled per entry.
import { build } from 'esbuild'
import { rm, mkdir, copyFile } from 'node:fs/promises'

const external = ['@deepseek-ai/*', '@langchain/*']

async function buildPackage(dir, entries) {
  await rm(`${dir}/lib`, { recursive: true, force: true })
  await mkdir(`${dir}/lib`, { recursive: true })
  await build({
    entryPoints: entries,
    outdir: `${dir}/lib`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    sourcemap: false,
    external,
    logLevel: 'info',
  })
}

await buildPackage('packages/loop', {
  index: 'packages/loop/src/index.ts',
  registry: 'packages/loop/src/registry.ts',
  router: 'packages/loop/src/router.ts',
  runtime: 'packages/loop/src/runtime.ts',
  tools: 'packages/loop/src/tools.ts',
  scheduler: 'packages/loop/src/scheduler.ts',
  kernel: 'packages/loop/src/kernel/index.ts',
})
await buildPackage('packages/graph-ui', {
  index: 'packages/graph-ui/src/index.ts',
})
await copyFile('packages/graph-ui/client/graph-view.js', 'packages/graph-ui/lib/client.js')

await buildPackage('packages/mode', {
  policy: 'packages/mode/src/policy.ts',
  tools: 'packages/mode/src/tools.ts',
  reuse: 'packages/mode/src/reuse.ts',
})
console.log('built packages/loop/lib, packages/graph-ui/lib and packages/mode/lib')
