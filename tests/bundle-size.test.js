import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Cap intentionally tracks the real cost of the public API surface. Bumps
// only land alongside new exports (e.g. findSubShaderRefs, the subShaderColors
// fallback in applyPostMapping), never to paper over incidental growth.
const GZIPPED_BUDGET_BYTES = 32 * 1024

describe('browser bundle', () => {
  it(`builds under ${GZIPPED_BUDGET_BYTES / 1024} KB gzipped`, () => {
    execSync('npm run build', { cwd: root, stdio: 'pipe' })
    const bundle = readFileSync(join(root, 'dist', 'kmp-three-suite.browser.mjs'))
    const gz = gzipSync(bundle).length
    expect(gz).toBeLessThan(GZIPPED_BUDGET_BYTES)
  }, 30000)
})
