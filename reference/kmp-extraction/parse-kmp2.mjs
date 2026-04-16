import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

const dir = '/Users/ryanoboyle/defcad-file-browser/file-browser-client'
const files = [
  'public/assets/kmp/Paint Metallic Sienna gold #1.kmp',
  'public/assets/kmp/Toon Fill Black bright  #9.kmp',
  'public/assets/kmp/Translucent Candle Wax #3.kmp',
]

for (const file of files) {
  console.log('\n' + '='.repeat(60))
  console.log('FILE:', file.split('/').pop())
  console.log('='.repeat(60))
  
  const fullPath = join(dir, file)
  const tmpDir = mkdtempSync(join(tmpdir(), 'kmp-'))
  
  try {
    execSync(`unzip -o "${fullPath}" -d "${tmpDir}"`, { stdio: 'pipe' })
    const extracted = readdirSync(tmpDir)
    const mtlFile = extracted.find(f => f.endsWith('.mtl'))
    
    if (mtlFile) {
      const mtlBuf = new Uint8Array(readFileSync(join(tmpDir, mtlFile)))
      const text = new TextDecoder('utf-8', { fatal: false }).decode(mtlBuf)
      
      // Find shader type strings
      for (const st of ['metallic_paint', 'lux_toon', 'lux_translucent']) {
        let idx = 0
        while ((idx = text.indexOf(st, idx)) !== -1) {
          const prevByte = idx > 0 ? mtlBuf[idx - 1] : -1
          const afterByte = mtlBuf[idx + st.length]
          console.log(`  "${st}" at offset ${idx}, prev=0x${prevByte.toString(16)}, after=0x${afterByte.toString(16)}`)
          
          // If prev byte is 0x27, parse params from idx-1
          if (prevByte === 0x27) {
            console.log('  >> Parsing TLV from offset', idx - 1)
            const view = new DataView(mtlBuf.buffer, mtlBuf.byteOffset, mtlBuf.byteLength)
            let offset = idx - 1
            const end = Math.min(offset + 2000, mtlBuf.length)
            
            while (offset < end - 2) {
              const tag = mtlBuf[offset]
              if (tag !== 0x17 && tag !== 0x27 && tag !== 0x1D) break
              
              offset += 1
              let nameEnd = offset
              while (nameEnd < end && mtlBuf[nameEnd] !== 0) nameEnd++
              if (nameEnd >= end) break
              const name = new TextDecoder().decode(mtlBuf.slice(offset, nameEnd))
              offset = nameEnd + 1
              
              if (tag === 0x17) {
                if (offset + 4 > end) break
                const val = view.getFloat32(offset, true)
                console.log(`    [float] ${name} = ${val.toFixed(4)}`)
                offset += 4
              } else if (tag === 0x27) {
                if (offset + 12 > end) break
                const r = view.getFloat32(offset, true)
                const g = view.getFloat32(offset + 4, true)
                const b = view.getFloat32(offset + 8, true)
                console.log(`    [color] ${name} = [${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}]`)
                offset += 12
              } else if (tag === 0x1D) {
                if (offset + 4 > end) break
                const val = view.getInt32(offset, true)
                console.log(`    [int]   ${name} = ${val}`)
                offset += 4
              }
            }
          }
          idx += st.length
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
