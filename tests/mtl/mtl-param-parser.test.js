import { describe, it, expect } from 'vitest'
import { parseParamSection } from '../../src/mtl/mtl-param-parser.js'

function mkBuf(pieces) {
  const enc = new TextEncoder()
  const parts = []
  for (const p of pieces) parts.push(typeof p === 'string' ? enc.encode(p) : new Uint8Array(p))
  const total = parts.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of parts) { out.set(a, off); off += a.length }
  return out
}

function f32(n) {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setFloat32(0, n, true)
  return b
}

function u32(n) {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

describe('parseParamSection — marker scan', () => {
  it('parses FLOAT (0x17)', () => {
    const buf = mkBuf(['roughness', [0x17, 0x03], f32(0.5)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: 'roughness', type: 'float', subId: 0x03, value: 0.5 })
  })
  it('parses INT (0x1d)', () => {
    const buf = mkBuf(['count', [0x1d, 0x01], u32(42)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out[0]).toMatchObject({ name: 'count', type: 'int', value: 42 })
  })
  it('parses COLOR (0x27) with context validation', () => {
    const buf = mkBuf(['diffuse', [0x27, 0x05], f32(0.1), f32(0.2), f32(0.3)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out[0].name).toBe('diffuse')
    expect(out[0].type).toBe('color')
    expect(out[0].value.r).toBeCloseTo(0.1, 6)
    expect(out[0].value.g).toBeCloseTo(0.2, 6)
    expect(out[0].value.b).toBeCloseTo(0.3, 6)
    expect(out[0].hex).toMatch(/^#/)
  })
  it('parses BOOL (0x25)', () => {
    const buf = mkBuf(['flag', [0x25, 0x02], u32(1)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out[0]).toMatchObject({ name: 'flag', type: 'bool', value: 1, bool: true })
  })
  it('parses TEXSLOT (0x9b)', () => {
    const buf = mkBuf(['diffuse_tex', [0x9b, 0x01], u32(3)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out[0]).toMatchObject({ name: 'diffuse_tex', type: 'texslot', value: 3 })
  })
  it("skips literal apostrophe in text when context doesn't match a COLOR marker", () => {
    const buf = mkBuf(["it's fine", [0x17, 0x00], f32(1)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('float')
  })
  it('sequentially walks multiple markers', () => {
    const buf = mkBuf(['roughness', [0x17, 0x01], f32(0.3), 'metal', [0x17, 0x02], f32(1.0)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out.map(p => p.name)).toEqual(['roughness', 'metal'])
    expect(out[1].value).toBeCloseTo(1.0, 6)
  })
  it('strips leading non-alpha junk from name', () => {
    const buf = mkBuf([[0x00, 0x01, 0x02], 'contour_angle', [0x17, 0x00], f32(60)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out[0].name).toBe('contour_angle')
    expect(out[0].value).toBeCloseTo(60, 6)
  })
})
