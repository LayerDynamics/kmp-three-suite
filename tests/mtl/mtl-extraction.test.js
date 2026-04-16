import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { extractMtl } from '../../src/mtl/mtl-extraction.js'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

function loadMtl(kmpPath) {
  const zip = new Uint8Array(readFileSync(kmpPath))
  const entries = unzipSync(zip)
  const name = Object.keys(entries).find(n => n.endsWith('.mtl'))
  return { name, buf: entries[name] }
}

describe('extractMtl — header + PNG', () => {
  it('extracts header fields from metallic paint MTL', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'paint-metallic-sienna-gold.kmp'))
    const res = extractMtl(buf)
    expect(res.header.matVersion).toMatch(/\d/)
    expect(res.header.shaderVersion).toMatch(/\d/)
  })
  it('extracts PNG thumbnail bounds and PNG magic signature', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const res = extractMtl(buf)
    expect(res.png).not.toBeNull()
    expect(res.png.bytes[0]).toBe(0x89)
    expect(res.png.bytes[1]).toBe(0x50)
    expect(res.png.bytes[2]).toBe(0x4e)
    expect(res.png.bytes[3]).toBe(0x47)
    expect(res.png.size).toBe(res.png.end - res.png.start)
    expect(res.png.size).toBeGreaterThan(0)
  })
  it('shaderType is first param name (lux_toon)', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const res = extractMtl(buf)
    expect(res.shaderType).toBe('lux_toon')
  })
  it('paramSection bounds are within buffer', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'paint-metallic-sienna-gold.kmp'))
    const res = extractMtl(buf)
    expect(res.paramSection.start).toBeGreaterThan(0)
    expect(res.paramSection.end).toBeGreaterThan(res.paramSection.start)
    expect(res.paramSection.end).toBeLessThanOrEqual(buf.length)
  })
})

describe('extractMtl — synthetic edge cases', () => {
  it('returns null materialName when footer is eof', () => {
    // Minimal buffer: header only, no PNG, no footer
    const head = new TextEncoder().encode('//--lux:mat:1.0\n//--lux:shader:2.0\n')
    const buf = new Uint8Array(head.length)
    buf.set(head, 0)
    const res = extractMtl(buf)
    expect(res.footer.type).toBe('eof')
    expect(res.materialName).toBeNull()
  })
  it('pattern-3 fallback finds capitalised string in footer', () => {
    // Construct a footer with 0x09 0x00 0x0b 0x00 (zero length triggers pattern-3 scan)
    const head = new TextEncoder().encode('//--lux:shader:1\n')
    const name = new TextEncoder().encode('CapitalisedLabel')
    const prefix = Uint8Array.of(0x09, 0x00, 0x0b, 0x00)
    const buf = new Uint8Array(head.length + prefix.length + name.length)
    buf.set(head, 0)
    buf.set(prefix, head.length)
    buf.set(name, head.length + prefix.length)
    const res = extractMtl(buf)
    expect(res.materialName).toMatch(/CapitalisedLabel/)
  })
  it('header without KeyShot version omits the field', () => {
    const head = new TextEncoder().encode('//--lux:mat:1.0\n//--lux:shader:2.0\n')
    const buf = new Uint8Array(head.length)
    buf.set(head, 0)
    const res = extractMtl(buf)
    expect(res.header.matVersion).toBe('1.0')
    expect(res.header.shaderVersion).toBe('2.0')
    expect(res.header.keyshotVersion).toBeUndefined()
  })
})

describe('extractMtl — material name', () => {
  it('extracts "Sienna" from metallic paint', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'paint-metallic-sienna-gold.kmp'))
    const res = extractMtl(buf)
    expect(res.materialName).toMatch(/Sienna/)
  })
  it('extracts "Toon Fill Black" from toon fixture', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const res = extractMtl(buf)
    expect(res.materialName).toMatch(/Toon Fill Black/)
  })
  it('extracts "Candle Wax" from translucent fixture', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'translucent-candle-wax.kmp'))
    const res = extractMtl(buf)
    expect(res.materialName).toMatch(/Candle Wax/)
  })
})

describe('extractMtl — sub-shader color slots', () => {
  it('populates subShaderRegion.colorSlots for translucent candle wax', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'translucent-candle-wax.kmp'))
    const res = extractMtl(buf)
    expect(res.subShaderRegion).not.toBeNull()
    expect(res.subShaderRegion.colorSlots).toBeInstanceOf(Map)
    expect(res.subShaderRegion.colorSlots.size).toBeGreaterThan(0)
    for (const [slotIndex, color] of res.subShaderRegion.colorSlots) {
      expect(typeof slotIndex).toBe('number')
      expect(color.r).toBeGreaterThanOrEqual(0)
      expect(color.r).toBeLessThanOrEqual(1)
      expect(color.g).toBeGreaterThanOrEqual(0)
      expect(color.g).toBeLessThanOrEqual(1)
      expect(color.b).toBeGreaterThanOrEqual(0)
      expect(color.b).toBeLessThanOrEqual(1)
    }
  })
  it('records sub-shader blocks with offsets', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'translucent-candle-wax.kmp'))
    const res = extractMtl(buf)
    expect(res.subShaderRegion.blocks.length).toBeGreaterThan(0)
    for (const block of res.subShaderRegion.blocks) {
      expect(block.offset).toBeGreaterThan(0)
      expect(typeof block.subId).toBe('number')
    }
  })
})
