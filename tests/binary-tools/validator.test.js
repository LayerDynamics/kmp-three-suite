import { describe, it, expect } from 'vitest'
import { isPrintable, isValidColorMarker, isValidBoolMarker, isValidTexslotMarker, cleanParamName } from '../../src/binary-tools/validator.js'

function buildColorBuf(pre, marker, subId, r, g, b) {
  const buf = new Uint8Array(1 + 1 + 1 + 12)
  buf[0] = pre
  buf[1] = marker
  buf[2] = subId
  const v = new DataView(buf.buffer)
  v.setFloat32(3, r, true); v.setFloat32(7, g, true); v.setFloat32(11, b, true)
  return buf
}

describe('validator', () => {
  it('isPrintable matches [0x20, 0x7f)', () => {
    expect(isPrintable(0x1f)).toBe(false)
    expect(isPrintable(0x20)).toBe(true)
    expect(isPrintable(0x7e)).toBe(true)
    expect(isPrintable(0x7f)).toBe(false)
  })
  it('isValidColorMarker rejects when byte-before is non-printable', () => {
    const buf = buildColorBuf(0x00, 0x27, 0x05, 0.5, 0.5, 0.5)
    expect(isValidColorMarker(buf, 1, buf.length)).toBe(false)
  })
  it('isValidColorMarker rejects when sub_id >= 0x20', () => {
    const buf = buildColorBuf(0x41, 0x27, 0x20, 0.5, 0.5, 0.5)
    expect(isValidColorMarker(buf, 1, buf.length)).toBe(false)
  })
  it('isValidColorMarker accepts printable-before + non-printable-after + finite floats', () => {
    const buf = buildColorBuf(0x41, 0x27, 0x05, 0.5, 0.5, 0.5)
    expect(isValidColorMarker(buf, 1, buf.length)).toBe(true)
  })
  it('isValidColorMarker rejects non-finite floats', () => {
    const buf = buildColorBuf(0x41, 0x27, 0x05, NaN, 0, 0)
    expect(isValidColorMarker(buf, 1, buf.length)).toBe(false)
  })
  it('isValidBoolMarker requires printable-before, sub_id < 0x20, and no back-to-back %', () => {
    const ok = new Uint8Array([0x41, 0x25, 0x05, 0, 0, 0, 0])
    const bad1 = new Uint8Array([0x00, 0x25, 0x05, 0, 0, 0, 0])
    const bad2 = new Uint8Array([0x41, 0x25, 0x20, 0, 0, 0, 0])
    const bad3 = new Uint8Array([0x25, 0x25, 0x05, 0, 0, 0, 0])
    expect(isValidBoolMarker(ok, 1, ok.length)).toBe(true)
    expect(isValidBoolMarker(bad1, 1, bad1.length)).toBe(false)
    expect(isValidBoolMarker(bad2, 1, bad2.length)).toBe(false)
    expect(isValidBoolMarker(bad3, 1, bad3.length)).toBe(false)
  })
  it('isValidTexslotMarker requires printable-before and sub_id < 0x20', () => {
    const ok = new Uint8Array([0x41, 0x9b, 0x05, 0, 0, 0, 0])
    expect(isValidTexslotMarker(ok, 1, ok.length)).toBe(true)
    const badBefore = new Uint8Array([0x00, 0x9b, 0x05, 0, 0, 0, 0])
    expect(isValidTexslotMarker(badBefore, 1, badBefore.length)).toBe(false)
    const badAfter = new Uint8Array([0x41, 0x9b, 0x20, 0, 0, 0, 0])
    expect(isValidTexslotMarker(badAfter, 1, badAfter.length)).toBe(false)
  })
  it('cleanParamName strips leading non-alpha junk', () => {
    expect(cleanParamName(';\u00f9\u008broughness')).toBe('roughness')
    expect(cleanParamName('__shadow color')).toBe('__shadow color')
    expect(cleanParamName('12345abc')).toBe('abc')
    expect(cleanParamName('roughness')).toBe('roughness')
  })
})
