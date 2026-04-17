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
  // Regression: the scanner previously checked only the 4-byte header
  // 0x89 0x00 0x9d 0x00, missing the 0x39 0x04 inner marker and the
  // 0x23 0xf9 0x8b 0x29 0x15 color-value marker. It also only accepted
  // 0x89 as byte 0 — but blocks 2..N start with 0x9f (the prior block's
  // end-of-block marker doubles as the next delimiter). Evidence: hex dump
  // of translucent-candle-wax.mtl at 0x458ea, 0x45916, 0x45942, 0x4596e.
  it('detects all four color-def blocks in translucent candle wax', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'translucent-candle-wax.kmp'))
    const res = extractMtl(buf)
    expect(res.subShaderRegion.blocks.length).toBe(4)
    expect(res.subShaderRegion.colorSlots.size).toBe(4)
    const slotIndices = [...res.subShaderRegion.colorSlots.keys()].sort((a, b) => a - b)
    expect(slotIndices).toEqual([0x1d, 0x1e, 0x1f, 0x20])
  })
  it('records correct float colors per slot for candle wax', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'translucent-candle-wax.kmp'))
    const res = extractMtl(buf)
    const slots = res.subShaderRegion.colorSlots
    // slot 0x1d: (0.5, 0.5, 0.5)
    expect(slots.get(0x1d).r).toBeCloseTo(0.5, 5)
    expect(slots.get(0x1d).g).toBeCloseTo(0.5, 5)
    expect(slots.get(0x1d).b).toBeCloseTo(0.5, 5)
    // slot 0x1e: (1.0, 0.91841, 0.562493)
    expect(slots.get(0x1e).r).toBeCloseTo(1.0, 5)
    expect(slots.get(0x1e).g).toBeCloseTo(0.91841, 4)
    expect(slots.get(0x1e).b).toBeCloseTo(0.562493, 4)
    // slots 0x1f and 0x20: (1.0, 1.0, 1.0)
    expect(slots.get(0x1f)).toEqual({ r: 1.0, g: 1.0, b: 1.0 })
    expect(slots.get(0x20)).toEqual({ r: 1.0, g: 1.0, b: 1.0 })
  })
  // Regression: `subId` used to be read from buf[pos+2], which is the
  // constant header byte 0x9d — bogus because it never varies across blocks.
  // It now reads the inner-marker variant byte at buf[pos+5], which encodes
  // the color-block format version (currently 0x04).
  it('exposes inner-marker variant byte as block.subId (not the fixed header byte)', () => {
    const { buf } = loadMtl(join(KMP_DIR, 'translucent-candle-wax.kmp'))
    const res = extractMtl(buf)
    for (const block of res.subShaderRegion.blocks) {
      expect(block.subId).toBe(0x04)
      expect(block.subId).not.toBe(0x9d)
    }
  })
  // Regression: a buffer with only the 4-byte header but wrong inner markers
  // must be rejected. Previously any `89 00 9d 00 <random> <random> <random>
  // <plausible floats>` pattern would be accepted and pollute colorSlots.
  it('rejects false-positive headers lacking the 0x39 0x04 inner marker', () => {
    const buf = buildSyntheticMtl({
      injectedBlock: Uint8Array.of(
        // bytes 0-3: correct block header
        0x89, 0x00, 0x9d, 0x00,
        // bytes 4-5: WRONG inner marker (0x00 0x00 instead of 0x39 0x04)
        0x00, 0x00,
        // byte 6: slot_index
        0x1d,
        // bytes 7-11: WRONG color-value marker (zeros instead of 23 f9 8b 29 15)
        0x00, 0x00, 0x00, 0x00, 0x00,
        // bytes 12-27: four plausible in-range floats (0.5, 0.5, 0.5, 1.0)
        0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x00, 0x3f,
        0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x80, 0x3f,
      ),
    })
    const res = extractMtl(buf)
    // Must detect no color blocks — the inner marker is wrong.
    expect(res.subShaderRegion).not.toBeNull()
    expect(res.subShaderRegion.blocks.length).toBe(0)
    expect(res.subShaderRegion.colorSlots.size).toBe(0)
  })
  it('rejects false-positive headers lacking the 0x23 0xf9 0x8b 0x29 0x15 marker', () => {
    const buf = buildSyntheticMtl({
      injectedBlock: Uint8Array.of(
        // bytes 0-5: correct header + inner marker
        0x89, 0x00, 0x9d, 0x00, 0x39, 0x04,
        // byte 6: slot_index
        0x1d,
        // bytes 7-11: WRONG 5-byte marker (zeros)
        0x00, 0x00, 0x00, 0x00, 0x00,
        // bytes 12-27: plausible floats
        0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x00, 0x3f,
        0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x80, 0x3f,
      ),
    })
    const res = extractMtl(buf)
    expect(res.subShaderRegion).not.toBeNull()
    expect(res.subShaderRegion.blocks.length).toBe(0)
    expect(res.subShaderRegion.colorSlots.size).toBe(0)
  })
  it('accepts continuation blocks that begin with 0x9f (not just 0x89)', () => {
    const continuationBlock = Uint8Array.of(
      // byte 0: 0x9f (end-of-prior-block marker, also valid block delimiter)
      0x9f,
      // bytes 1-11: complete marker sequence
      0x00, 0x9d, 0x00, 0x39, 0x04, 0x2a, 0x23, 0xf9, 0x8b, 0x29, 0x15,
      // bytes 12-27: RGBA = (1.0, 1.0, 1.0, 1.0)
      0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x80, 0x3f,
      0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x80, 0x3f,
    )
    const buf = buildSyntheticMtl({ injectedBlock: continuationBlock })
    const res = extractMtl(buf)
    expect(res.subShaderRegion).not.toBeNull()
    expect(res.subShaderRegion.blocks.length).toBe(1)
    expect(res.subShaderRegion.blocks[0].slotIndex).toBe(0x2a)
    expect(res.subShaderRegion.blocks[0].subId).toBe(0x04)
    expect(res.subShaderRegion.colorSlots.get(0x2a)).toEqual({ r: 1.0, g: 1.0, b: 1.0 })
  })
  it('rejects blocks whose floats fall outside the [0,1] range', () => {
    const buf = buildSyntheticMtl({
      injectedBlock: Uint8Array.of(
        // Full valid marker prefix
        0x89, 0x00, 0x9d, 0x00, 0x39, 0x04, 0x1d,
        0x23, 0xf9, 0x8b, 0x29, 0x15,
        // r = 2.0 (out of range)
        0x00, 0x00, 0x00, 0x40,
        // g, b, a = 0.5, 0.5, 1.0
        0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x80, 0x3f,
      ),
    })
    const res = extractMtl(buf)
    expect(res.subShaderRegion).not.toBeNull()
    expect(res.subShaderRegion.blocks.length).toBe(0)
    expect(res.subShaderRegion.colorSlots.size).toBe(0)
  })
})

// Synthetic MTL builder for sub-shader regression tests. Lays out a minimum
// valid buffer: header with shader-version line, then an injected byte region
// inside the sub-shader area, then the 0x89 shader-marker byte followed by a
// known shader-type name to anchor findSubShaderRegion. `findParamSection`
// terminates at EOF (footer.type === 'eof').
function buildSyntheticMtl({ injectedBlock }) {
  const header = new TextEncoder().encode('//--lux:shader:1.0\n')
  const leadingPadding = new Uint8Array(32)
  // Trailing gap covers two needs:
  //   - decodeSubShaderRegion's loop condition `pos + 28 < mainShaderStart`
  //     requires the block to end strictly before the shader marker.
  //   - findSubShaderRegion's back-scan for SHADER_MARKER_BYTES (0x89, 0x09)
  //     is bounded to 16 bytes — so the gap must be short enough that the
  //     shader marker we place below is still reachable from the shader name.
  const trailingGap = new Uint8Array(8)
  const shaderMarker = Uint8Array.of(0x89)
  const shaderName = new TextEncoder().encode('lux_translucent')
  const total = header.length + leadingPadding.length + injectedBlock.length
    + trailingGap.length + shaderMarker.length + shaderName.length
  const buf = new Uint8Array(total)
  let off = 0
  buf.set(header, off); off += header.length
  buf.set(leadingPadding, off); off += leadingPadding.length
  buf.set(injectedBlock, off); off += injectedBlock.length
  buf.set(trailingGap, off); off += trailingGap.length
  buf.set(shaderMarker, off); off += shaderMarker.length
  buf.set(shaderName, off)
  return buf
}
