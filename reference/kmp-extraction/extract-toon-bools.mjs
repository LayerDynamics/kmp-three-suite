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

  // Search for known toon boolean param names in the binary
  const boolNames = [
    'transparency', 'contour width is in pixels',
    'outline contour', 'material contour', 'part contour',
    'interior edge contour', 'environment shadows', 'light source shadows'
  ]

  const text = new TextDecoder('utf-8', { fatal: false }).decode(mtlBuf)
  const view = new DataView(mtlBuf.buffer, mtlBuf.byteOffset, mtlBuf.byteLength)

  for (const name of boolNames) {
    let idx = 0
    while ((idx = text.indexOf(name, idx)) !== -1) {
      // Check what type marker follows
      const afterName = idx + name.length
      if (afterName < mtlBuf.length) {
        const marker = mtlBuf[afterName]
        if (marker === 0x1d) {
          // INT type
          const subId = mtlBuf[afterName + 1]
          const val = view.getInt32(afterName + 2, true)
          console.log(`  "${name}" → INT = ${val} (at offset ${idx})`)
        } else if (marker === 0x17) {
          // FLOAT type
          const subId = mtlBuf[afterName + 1]
          const val = view.getFloat32(afterName + 2, true)
          console.log(`  "${name}" → FLOAT = ${val} (at offset ${idx})`)
        } else {
          console.log(`  "${name}" → marker=0x${marker.toString(16)} (at offset ${idx})`)
        }
      }
      idx += name.length
    }
  }

  // Also search for "contour width" specifically
  let cwIdx = 0
  while ((cwIdx = text.indexOf('contour width', cwIdx)) !== -1) {
    const afterName = cwIdx + 'contour width'.length
    const nextChars = text.substring(afterName, afterName + 30)
    const marker = mtlBuf[afterName]
    console.log(`  "contour width" at ${cwIdx}, next marker=0x${marker.toString(16)}, next text: "${nextChars.replace(/[^\x20-\x7e]/g, '.')}"`)
    if (marker === 0x1d) {
      const val = view.getInt32(afterName + 2, true)
      console.log(`    → INT = ${val}`)
    } else if (marker === 0x17) {
      const val = view.getFloat32(afterName + 2, true)
      console.log(`    → FLOAT = ${val}`)
    }
    cwIdx += 13
  }

} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
