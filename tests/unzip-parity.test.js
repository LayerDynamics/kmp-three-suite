import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unzipArchive } from '../src/binary-tools/binary-tools.js'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

const hasSystemUnzip = (() => {
  try {
    execSync('which unzip', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.each([
  'paint-metallic-sienna-gold.kmp',
  'toon-fill-black-bright.kmp',
  'translucent-candle-wax.kmp',
])('fflate vs. system unzip parity — %s', (kmpName) => {
  it.skipIf(!hasSystemUnzip)('fflate output matches unzip output byte-for-byte', () => {
    const kmpPath = join(KMP_DIR, kmpName)
    const bytes = new Uint8Array(readFileSync(kmpPath))
    const ours = unzipArchive(bytes)

    const dir = mkdtempSync(join(tmpdir(), 'kmp-parity-'))
    try {
      execSync(`unzip -o "${kmpPath}" -d "${dir}"`, { stdio: 'pipe' })
      const sysFiles = readdirSync(dir)
      expect(new Set(ours.keys())).toEqual(new Set(sysFiles))
      for (const f of sysFiles) {
        const sysBytes = new Uint8Array(readFileSync(join(dir, f)))
        const ourBytes = ours.get(f)
        expect(ourBytes.length).toBe(sysBytes.length)
        expect(Buffer.from(ourBytes).equals(Buffer.from(sysBytes))).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
