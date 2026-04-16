import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('browser bundle', () => {
  it('builds under 30 KB gzipped', () => {
    execSync('npm run build', { cwd: root, stdio: 'pipe' })
    const bundle = readFileSync(join(root, 'dist', 'kmp-three-suite.browser.mjs'))
    const gz = gzipSync(bundle).length
    expect(gz).toBeLessThan(30 * 1024)
  }, 30000)
})
