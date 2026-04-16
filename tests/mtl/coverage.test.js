import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { extractMtl } from '../../src/mtl/mtl-extraction.js'
import { isPrintable } from '../../src/binary-tools/binary-tools.js'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

function loadMtl(p) {
  const entries = unzipSync(new Uint8Array(readFileSync(p)))
  const name = Object.keys(entries).find(n => n.endsWith('.mtl'))
  return entries[name]
}

function coverage(buf, paramStart, paramEnd, params) {
  const claimed = new Set()
  for (const p of params) {
    let valueLen
    if (p.type === 'color') valueLen = 14
    else if (p.type === 'bool_inferred') valueLen = p.rawLength || 0
    else valueLen = 6
    const nameLen = (p.name || '').length
    for (let b = p.offset - nameLen; b < p.offset + valueLen; b++) {
      if (b >= 0) claimed.add(b)
    }
  }
  const unclaimed = []
  let run = ''
  let runStart = -1
  for (let i = paramStart; i < paramEnd; i++) {
    if (!claimed.has(i) && isPrintable(buf[i])) {
      if (run === '') runStart = i
      run += String.fromCharCode(buf[i])
    } else {
      if (run.length >= 3) unclaimed.push({ offset: runStart, text: run })
      run = ''
    }
  }
  if (run.length >= 3) unclaimed.push({ offset: runStart, text: run })
  return unclaimed
}

describe.each([
  ['paint-metallic-sienna-gold.kmp'],
  ['toon-fill-black-bright.kmp'],
  ['translucent-candle-wax.kmp'],
])('coverage for %s', (fixture) => {
  it('has zero unclaimed printable runs of length ≥ 3 in param section', () => {
    const buf = loadMtl(join(KMP_DIR, fixture))
    const res = extractMtl(buf)
    const unclaimed = coverage(buf, res.paramSection.start, res.paramSection.end, res.rawParameters)
    if (unclaimed.length > 0) {
      console.error(`[${fixture}] unclaimed runs:`, unclaimed)
    }
    expect(unclaimed).toEqual([])
  })
})
