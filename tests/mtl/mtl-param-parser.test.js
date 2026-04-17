import { describe, it, expect } from 'vitest'
import { parseParamSection, KNOWN_BOOL_PARAM_NAMES } from '../../src/mtl/mtl-param-parser.js'

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
  it('rejects stray 0x17 byte whose byte-before is non-printable (false FLOAT marker)', () => {
    // Layout: valid float param, then a padding/garbage byte (0x00), then a
    // stray 0x17 followed by plausible-looking payload bytes. Before the guard,
    // the stray 0x17 would be scanned as a marker (m > start, fits) and the
    // main walk would parse it with an empty/garbled name, producing a
    // spurious second record. The printable-byte-before guard rejects it.
    const buf = mkBuf(['roughness', [0x17, 0x00], f32(0.5), [0x00, 0x17, 0x03], f32(0.25)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: 'roughness', type: 'float', value: 0.5 })
  })
  it('rejects stray 0x1d byte whose byte-before is non-printable (false INT marker)', () => {
    const buf = mkBuf(['count', [0x1d, 0x00], u32(7), [0x00, 0x1d, 0x02], u32(999)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: 'count', type: 'int', value: 7 })
  })
  it('strips leading non-alpha junk from name', () => {
    const buf = mkBuf([[0x00, 0x01, 0x02], 'contour_angle', [0x17, 0x00], f32(60)])
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = parseParamSection(buf, v, 0, buf.length)
    expect(out[0].name).toBe('contour_angle')
    expect(out[0].value).toBeCloseTo(60, 6)
  })
})

describe('name-first BOOL fallback', () => {
  it('KNOWN_BOOL_PARAM_NAMES includes expected param names', () => {
    expect(KNOWN_BOOL_PARAM_NAMES).toContain('transparency')
    expect(KNOWN_BOOL_PARAM_NAMES).toContain('contour width is in pixels')
    expect(KNOWN_BOOL_PARAM_NAMES).toContain('outline contour')
    expect(KNOWN_BOOL_PARAM_NAMES).toContain('light source shadows')
  })
  it('records trailing printable text with no marker as bool_inferred false', () => {
    const enc = new TextEncoder()
    const name = enc.encode('roughness')
    const head = new Uint8Array(name.length + 6)
    head.set(name, 0)
    head[name.length] = 0x17
    head[name.length + 1] = 0x00
    new DataView(head.buffer).setFloat32(name.length + 2, 0.3, true)
    const trailingName = enc.encode('some trailing label')
    const buf = new Uint8Array(head.length + trailingName.length)
    buf.set(head, 0)
    buf.set(trailingName, head.length)
    const view = new DataView(buf.buffer)
    const out = parseParamSection(buf, view, 0, buf.length)
    const inferred = out.find(p => p.type === 'bool_inferred')
    expect(inferred).toBeDefined()
    expect(inferred.bool).toBe(false)
    expect(inferred.rawLength).toBeGreaterThan(0)
    expect(inferred.name).toMatch(/some/)
  })
  it('name-first falls back to FLOAT marker when known name encodes float', () => {
    const enc = new TextEncoder()
    // 'shadow color' at offset 0 — marker scan rejects (no printable-before).
    const name = enc.encode('shadow color')
    const buf = new Uint8Array(name.length + 6)
    buf.set(name, 0)
    buf[name.length] = 0x17
    buf[name.length + 1] = 0x02
    new DataView(buf.buffer).setFloat32(name.length + 2, 0.75, true)
    const view = new DataView(buf.buffer)
    const out = parseParamSection(buf, view, 0, buf.length)
    const p = out.find(x => x.name === 'shadow color')
    expect(p.type).toBe('float')
    expect(p.value).toBeCloseTo(0.75, 6)
  })
  it('name-first falls back to INT marker when known name encodes int', () => {
    const enc = new TextEncoder()
    const name = enc.encode('contour color')
    const buf = new Uint8Array(name.length + 6)
    buf.set(name, 0)
    buf[name.length] = 0x1d
    buf[name.length + 1] = 0x00
    new DataView(buf.buffer).setUint32(name.length + 2, 42, true)
    const view = new DataView(buf.buffer)
    const out = parseParamSection(buf, view, 0, buf.length)
    const p = out.find(x => x.name === 'contour color')
    expect(p.type).toBe('int')
    expect(p.value).toBe(42)
  })
  it('name-first falls back to COLOR marker when known name encodes color', () => {
    const enc = new TextEncoder()
    const name = enc.encode('shadow color')
    const buf = new Uint8Array(name.length + 14)
    buf.set(name, 0)
    buf[name.length] = 0x27
    buf[name.length + 1] = 0x05
    const v = new DataView(buf.buffer)
    v.setFloat32(name.length + 2, 0.1, true)
    v.setFloat32(name.length + 6, 0.2, true)
    v.setFloat32(name.length + 10, 0.3, true)
    const out = parseParamSection(buf, v, 0, buf.length)
    const p = out.find(x => x.name === 'shadow color')
    expect(p.type).toBe('color')
    expect(p.value.r).toBeCloseTo(0.1, 6)
  })
  it('picks up BOOL missed by marker scan by searching known names', () => {
    // A name that begins at offset 0 means there is no printable-before byte,
    // so isValidBoolMarker rejects. The name-first pass must still find it.
    const enc = new TextEncoder()
    const name = enc.encode('transparency')
    const buf = new Uint8Array(name.length + 6)
    buf.set(name, 0)
    buf[name.length] = 0x25
    buf[name.length + 1] = 0x00
    const view = new DataView(buf.buffer)
    view.setUint32(name.length + 2, 1, true)
    const out = parseParamSection(buf, view, 0, buf.length)
    const t = out.find(p => p.name === 'transparency')
    expect(t).toBeDefined()
    expect(t.type).toBe('bool')
    expect(t.value).toBe(1)
  })
})
