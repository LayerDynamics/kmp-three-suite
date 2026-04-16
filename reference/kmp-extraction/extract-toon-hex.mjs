import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

const dir = '/Users/ryanoboyle/defcad-file-browser/file-browser-client'
const file = 'public/assets/kmp/Toon Fill Black bright  #9.kmp'
const fullPath = join(dir, file)
const tmpDir = mkdtempSync(join(tmpdir(), 'kmp-'))

try {
  execSync(`unzip -o "${fullPath}" -d "${tmpDir}"`, { stdio: 'pipe' })
  const extracted = readdirSync(tmpDir)
  const mtlFile = extracted.find(f => f.endsWith('.mtl'))
  const mtlBuf = new Uint8Array(readFileSync(join(tmpDir, mtlFile)))

  // Dump hex around the boolean section (offsets ~19250-19520)
  const start = 19250
  const end = Math.min(19530, mtlBuf.length)

  for (let i = start; i < end; i += 16) {
    const hex = []
    const ascii = []
    for (let j = 0; j < 16 && i + j < end; j++) {
      const b = mtlBuf[i + j]
      hex.push(b.toString(16).padStart(2, '0'))
      ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')
    }
    console.log(`${i.toString(16).padStart(6, '0')}: ${hex.join(' ').padEnd(48)} ${ascii.join('')}`)
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
