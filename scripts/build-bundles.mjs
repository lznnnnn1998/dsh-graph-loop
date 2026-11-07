// Build release JS for the bundles. Local @dsh/* and @deepseek-ai/* stay external;
// everything else (including dsh-graph-loop-core) is bundled per entry.
//
//   node scripts/build-bundles.mjs           build into packages/*/lib
//   node scripts/build-bundles.mjs --check   build into a temp dir and fail when
//                                            packages/*/lib differs byte-for-byte,
//                                            or when an export target is missing
//
// --check is what makes a published tarball reproducible: prepack always rebuilds,
// and CI can prove the installed lib still matches the source. Every path is
// anchored to the repo root, so the script also works from a package directory
// (npm runs `prepack` with the package as cwd).
import { build } from 'esbuild'
import { mkdtemp, rm, mkdir, copyFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHECK = process.argv.includes('--check')

const external = ['@deepseek-ai/*', '@langchain/*']

const PACKAGES = [
  {
    dir: 'packages/loop',
    entries: [
      'packages/loop/src/index.ts',
      'packages/loop/src/registry.ts',
      'packages/loop/src/router.ts',
      'packages/loop/src/runtime.ts',
      'packages/loop/src/tools.ts',
      'packages/loop/src/scheduler.ts',
      'packages/loop/src/kernel/index.ts',
    ],
  },
  {
    dir: 'packages/graph-ui',
    entries: ['packages/graph-ui/src/index.ts'],
    copy: [['packages/graph-ui/client/graph-view.js', 'client.js']],
  },
  {
    dir: 'packages/mode',
    entries: [
      'packages/mode/src/policy.ts',
      'packages/mode/src/tools.ts',
      'packages/mode/src/reuse.ts',
    ],
  },
]

/** Absolute outdir for one workspace relative to a build root. */
function outDir(base, definition) {
  return join(base, definition.dir, 'lib')
}

async function buildPackage(base, definition) {
  const outdir = outDir(base, definition)
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })
  await build({
    entryPoints: definition.entries.map(entry => join(ROOT, entry)),
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    sourcemap: false,
    external,
    logLevel: 'silent',
  })
  for (const [source, name] of definition.copy ?? []) {
    await copyFile(join(ROOT, source), join(outdir, name))
  }
}

/** Recursively list files under `dir`, relative to it. */
async function filesOf(dir) {
  const found = []
  const walk = async (relative) => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true })
    for (const entry of entries) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile()) found.push(next)
    }
  }
  await walk('')
  return found.sort()
}

/** Every export target in a published package must exist in the fresh build. */
async function checkExports(base, definition) {
  const manifest = JSON.parse(await readFile(join(ROOT, definition.dir, 'package.json'), 'utf8'))
  const targets = Object.values(manifest.exports ?? {}).filter(value => typeof value === 'string')
  const problems = []
  for (const target of targets) {
    // package.json and other non-build assets ship as-is; only lib/ is built.
    if (!target.startsWith('./lib/')) continue
    try {
      await readFile(join(base, definition.dir, target.slice(2)))
    } catch {
      problems.push(`${manifest.name}: export ${target} is not produced by the build`)
    }
  }
  if (!(manifest.files ?? []).includes('lib')) problems.push(`${manifest.name}: files[] does not include "lib"`)
  return problems
}

/** Byte-compare a fresh build against the checked-out lib. */
async function checkAgainstSource(base) {
  const problems = []
  for (const definition of PACKAGES) {
    const fresh = outDir(base, definition)
    const current = join(ROOT, definition.dir, 'lib')
    const [freshFiles, currentFiles] = await Promise.all([filesOf(fresh), filesOf(current).catch(() => [])])
    const all = [...new Set([...freshFiles, ...currentFiles])].sort()
    for (const file of all) {
      if (!freshFiles.includes(file)) {
        problems.push(`${definition.dir}/lib/${file} is stale (not produced by the current source)`)
        continue
      }
      if (!currentFiles.includes(file)) {
        problems.push(`${definition.dir}/lib/${file} is missing (run npm run build)`)
        continue
      }
      const [a, b] = await Promise.all([readFile(join(fresh, file)), readFile(join(current, file))])
      if (!a.equals(b)) problems.push(`${definition.dir}/lib/${file} differs from a fresh build`)
    }
    problems.push(...await checkExports(base, definition))
  }
  return problems
}

const base = CHECK ? await mkdtemp(join(tmpdir(), 'dsh-graph-loop-build-')) : ROOT
try {
  for (const definition of PACKAGES) await buildPackage(base, definition)
  if (CHECK) {
    const problems = await checkAgainstSource(base)
    if (problems.length > 0) {
      console.error(problems.join('\n'))
      console.error(`\nFAIL  lib is not reproducible from the source (${problems.length} problem(s)); run npm run build and commit the source`)
      process.exitCode = 1
    } else {
      console.error('lib matches a fresh build of the source')
    }
  } else {
    // stderr: npm pack --json and other tooling own stdout.
    console.error('built packages/loop/lib, packages/graph-ui/lib and packages/mode/lib')
  }
} finally {
  if (CHECK) await rm(base, { recursive: true, force: true })
}
