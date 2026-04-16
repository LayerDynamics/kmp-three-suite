import { describe, it, expect } from 'vitest'
import { findSequence, findPngBounds, findParamSection, findFooter, findSubShaderRegion } from '../../src/binary-tools/param-finder.js'
import { PNG_MAGIC, PNG_IEND, MATMETA_MARKER, FOOTER_NAME_PREFIX } from '../../src/mtl/mtl.schema.js'

describe('findSequence', () => {
  it('returns -1 when not found', () => {
    const buf = new Uint8Array([1, 2, 3])
    expect(findSequence(buf, new Uint8Array([4, 5]))).toBe(-1)
  })
  it('returns first match offset', () => {
    const buf = new Uint8Array([1, 2, 3, 2, 3, 4])
    expect(findSequence(buf, new Uint8Array([2, 3]))).toBe(1)
  })
  it('honours startOffset', () => {
    const buf = new Uint8Array([1, 2, 3, 2, 3, 4])
    expect(findSequence(buf, new Uint8Array([2, 3]), 2)).toBe(3)
  })
})

describe('findPngBounds', () => {
  it('returns null when no PNG', () => {
    expect(findPngBounds(new Uint8Array(64))).toBeNull()
  })
  it('locates magic and IEND + 4-byte CRC', () => {
    const buf = new Uint8Array(128)
    buf.set(PNG_MAGIC, 10)
    buf.set(PNG_IEND, 40)
    const bounds = findPngBounds(buf)
    expect(bounds.start).toBe(10)
    expect(bounds.end).toBe(48)
    expect(bounds.size).toBe(38)
  })
})

describe('findParamSection', () => {
  it('uses pngEnd when positive', () => {
    const buf = new Uint8Array(100)
    buf.set(MATMETA_MARKER, 80)
    const section = findParamSection(buf, 40, -1)
    expect(section.start).toBe(40)
    expect(section.end).toBe(80)
  })
  it('ends at MATMETA when present', () => {
    const buf = new Uint8Array(200)
    buf.set(MATMETA_MARKER, 100)
    const section = findParamSection(buf, 10, -1)
    expect(section.end).toBe(100)
  })
  it('falls back to shader-version-line newline', () => {
    const line = '//--lux:shader:3.0\n'
    const head = new TextEncoder().encode(line)
    const buf = new Uint8Array(head.length + 64)
    buf.set(head, 0)
    buf.set(MATMETA_MARKER, head.length + 16)
    const section = findParamSection(buf, -1, -1)
    expect(section.start).toBe(head.length)
    expect(section.end).toBe(head.length + 16)
  })
})

describe('findFooter', () => {
  it('identifies MATMETA', () => {
    const buf = new Uint8Array(128)
    buf.set(MATMETA_MARKER, 32)
    expect(findFooter(buf, 10)).toEqual({ type: 'matmeta', offset: 32 })
  })
  it('falls back to 09 00 0b name footer', () => {
    const buf = new Uint8Array(128)
    buf.set(FOOTER_NAME_PREFIX, 50)
    expect(findFooter(buf, 10)).toEqual({ type: 'name_footer', offset: 50 })
  })
  it('returns eof when nothing found', () => {
    expect(findFooter(new Uint8Array(20), 0)).toEqual({ type: 'eof', offset: 20 })
  })
})

describe('findSubShaderRegion', () => {
  it('returns null when main shader is at start', () => {
    const buf = new Uint8Array(new TextEncoder().encode('lux_toon padding'))
    const region = findSubShaderRegion(buf, 0, 16, ['lux_toon'])
    expect(region).toBeNull()
  })
  it('detects sub-shader region when a header byte precedes the main shader name', () => {
    const pre = new Uint8Array(20)
    pre[0] = 0x89
    const name = new TextEncoder().encode('lux_translucent')
    const buf = new Uint8Array(pre.length + name.length + 8)
    buf.set(pre, 0)
    buf.set(name, pre.length)
    const region = findSubShaderRegion(buf, 0, buf.length, ['lux_translucent'])
    expect(region).not.toBeNull()
    expect(region.mainShaderStart).toBeGreaterThanOrEqual(0)
  })
})
