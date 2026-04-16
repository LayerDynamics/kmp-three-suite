import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

const dir = '/Users/ryanoboyle/defcad-file-browser/file-browser-client'
const file = 'public/assets/kmp/Toon Fill Black bright  #9.kmp'
const fullPath = join(dir, file)
const tmpDir = mkdtempSync(join(tmpdir(), 'kmp-'))
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IEND_MARKER = new Uint8Array([0x49, 0x45, 0x4e, 0x44])

function findSequence(data, needle, startOffset = 0) {
  for (let i = startOffset; i <= data.length - needle.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) { match = false; break }
    }
    if (match) return i
  }
  return -1
}

try {
  execSync(`unzip -o "${fullPath}" -d "${tmpDir}"`, { stdio: 'pipe' })
  const extracted = readdirSync(tmpDir)
  const mtlFile = extracted.find(f => f.endsWith('.mtl'))
  const mtlBuf = new Uint8Array(readFileSync(join(tmpDir, mtlFile)))

  const pngStart = findSequence(mtlBuf, PNG_MAGIC)
  const iendPos = findSequence(mtlBuf, IEND_MARKER, pngStart)
  const paramStart = iendPos + 8

  const matmetaMarker = new TextEncoder().encode('--MATMETA--')
  const matmetaPos = findSequence(mtlBuf, matmetaMarker, paramStart)

  console.log('PNG start:', pngStart)
  console.log('IEND pos:', iendPos)
  console.log('Param section start:', paramStart)
  console.log('MATMETA pos:', matmetaPos)
  console.log('Param section length:', matmetaPos - paramStart, 'bytes')
  console.log()

  // Dump the full param section as hex + ascii
  const start = paramStart
  const end = matmetaPos

  for (let i = start; i < end; i += 32) {
    const hex = []
    const ascii = []
    for (let j = 0; j < 32 && i + j < end; j++) {
      const b = mtlBuf[i + j]
      hex.push(b.toString(16).padStart(2, '0'))
      ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')
    }
    console.log(`${(i - start).toString().padStart(4)}: ${hex.join(' ').padEnd(96)} |${ascii.join('')}|`)
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
