import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'

// Use unzip CLI instead of jszip
const dir = '/Users/ryanoboyle/defcad-file-browser/file-browser-client'
const files = [
  'public/assets/kmp/Paint Metallic Sienna gold #1.kmp',
  'public/assets/kmp/Toon Fill Black bright  #9.kmp',
  'public/assets/kmp/Translucent Candle Wax #3.kmp',
]

function parseParams(mtlBuf) {
  const view = new DataView(mtlBuf.buffer, mtlBuf.byteOffset, mtlBuf.byteLength)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(mtlBuf)
  
  const results = {}
  
  for (const st of ['metallic_paint', 'lux_toon', 'lux_translucent']) {
    for (let i = 0; i < mtlBuf.length - st.length - 2; i++) {
      if (mtlBuf[i] === 0x27) {
        const candidate = new TextDecoder('utf-8', {fatal: false}).decode(mtlBuf.slice(i + 1, i + 1 + st.length))
        if (candidate === st && mtlBuf[i + 1 + st.length] === 0) {
          // Found it - parse from here
          const params = {}
          let offset = i
          const end = Math.min(i + 2000, mtlBuf.length)
          
          while (offset < end - 2) {
            const tag = mtlBuf[offset]
            if (tag !== 0x17 && tag !== 0x27 && tag !== 0x1D) break
            
            offset += 1
            let nameEnd = offset
            while (nameEnd < end && mtlBuf[nameEnd] !== 0) nameEnd++
            const name = new TextDecoder().decode(mtlBuf.slice(offset, nameEnd))
            offset = nameEnd + 1
            
            if (tag === 0x17) {
              if (offset + 4 > end) break
              params[name] = { type: 'float', value: view.getFloat32(offset, true) }
              offset += 4
            } else if (tag === 0x27) {
              if (offset + 12 > end) break
              const r = view.getFloat32(offset, true)
              const g = view.getFloat32(offset + 4, true)
              const b = view.getFloat32(offset + 8, true)
              params[name] = { type: 'color', value: [r, g, b] }
              offset += 12
            } else if (tag === 0x1D) {
              if (offset + 4 > end) break
              params[name] = { type: 'int', value: view.getInt32(offset, true) }
              offset += 4
            }
          }
          
          results[st] = params
          break
        }
      }
    }
  }
  
  // Also find material name
  const metaIdx = text.indexOf('MATMETA')
  if (metaIdx !== -1) {
    let ns = metaIdx + 7
    while (ns < mtlBuf.length && mtlBuf[ns] < 0x20) ns++
    let ne = ns
    while (ne < mtlBuf.length && mtlBuf[ne] >= 0x20 && mtlBuf[ne] < 0x7f) ne++
    results._name = new TextDecoder().decode(mtlBuf.slice(ns, ne))
  }
  
  return results
}

import { createRequire } from 'module'
import { tmpdir } from 'os'
import { mkdtempSync, readdirSync, rmSync } from 'fs'

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
      const result = parseParams(mtlBuf)
      
      if (result._name) console.log('Name:', result._name)
      
      for (const [shader, params] of Object.entries(result)) {
        if (shader === '_name') continue
        console.log(`\nShader: ${shader}`)
        for (const [k, v] of Object.entries(params)) {
          if (v.type === 'color') {
            console.log(`  ${k}: [${v.value[0].toFixed(4)}, ${v.value[1].toFixed(4)}, ${v.value[2].toFixed(4)}]`)
          } else if (v.type === 'float') {
            console.log(`  ${k}: ${v.value.toFixed(4)}`)
          } else {
            console.log(`  ${k}: ${v.value}`)
          }
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
