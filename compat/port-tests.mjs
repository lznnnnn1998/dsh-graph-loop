// Port node:test specs to vitest and adjust repo-relative imports for the
// packages/loop/tests location.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const [src, dst] = process.argv.slice(2)
for (const file of readdirSync(src)) {
  if (!file.endsWith('.test.ts')) continue
  let text = readFileSync(join(src, file), 'utf8')
  text = text.replaceAll("import { test } from 'node:test'", "import { test } from 'vitest'")
  text = text.replaceAll("import test from 'node:test'", "import { test } from 'vitest'")
  text = text.replaceAll("from '../../packages/", "from '../../")
  text = text.replace(/t\.diagnostic\(`([^`]*)`\)/g, 'console.log(`$1`)')
  writeFileSync(join(dst, file.replace('.test.ts', '.spec.ts')), text)
}
