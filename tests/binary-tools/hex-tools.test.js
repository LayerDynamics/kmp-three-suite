import { describe, it, expect } from 'vitest'
import { linearToSrgb, srgbToLinear, rgbToHex, hexToComponents, componentsToHex, hexDump } from '../../src/binary-tools/hex-tools.js'

describe('hex-tools', () => {
  it('linearToSrgb: 0 → 0, 1 → 1', () => {
    expect(linearToSrgb(0)).toBe(0)
    expect(linearToSrgb(1)).toBeCloseTo(1, 10)
  })
  it('linearToSrgb: linear segment for c ≤ 0.0031308', () => {
    expect(linearToSrgb(0.001)).toBeCloseTo(0.001 * 12.92, 8)
  })
  it('linearToSrgb: power segment for c > 0.0031308', () => {
    expect(linearToSrgb(0.5)).toBeCloseTo(0.7353569830524495, 6)
  })
  it('srgbToLinear inverts linearToSrgb for a range of values', () => {
    for (const v of [0, 0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.99, 1]) {
      expect(srgbToLinear(linearToSrgb(v))).toBeCloseTo(v, 6)
    }
  })
  it('rgbToHex: linear [0,1] → sRGB hex', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000')
    expect(rgbToHex(1, 1, 1)).toBe('#ffffff')
  })
  it('rgbToHex: linear mid-gray → sRGB ~#bcbcbc (188/255)', () => {
    // linearToSrgb(0.5) ≈ 0.7353 → *255 = 187.5 → round to 188 = 0xbc
    expect(rgbToHex(0.5, 0.5, 0.5)).toBe('#bcbcbc')
  })
  it('hexToComponents returns sRGB-space [0,1] floats', () => {
    expect(hexToComponents('#ff0000')).toEqual([1, 0, 0])
    expect(hexToComponents('00ff00')).toEqual([0, 1, 0])
  })
  it('componentsToHex rounds to nearest', () => {
    expect(componentsToHex(1, 0.5, 0)).toBe('#ff8000')
  })
  it('hexDump emits one line per 16 bytes with offset + hex + ascii gutter', () => {
    const buf = new Uint8Array([0x48, 0x69, 0x21, 0x00, 0x0a])
    const lines = hexDump(buf, 0, 5)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^000000: 48 69 21 00 0a/)
    expect(lines[0]).toMatch(/Hi!\.\./)
  })
})
