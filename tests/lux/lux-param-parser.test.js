import { describe, it, expect } from 'vitest'
import { makeAccessors } from '../../src/lux/lux-param-parser.js'

function build(raws) { return raws.map((p, i) => ({ offset: i, ...p })) }

describe('makeAccessors', () => {
  const params = build([
    { name: 'roughness', type: 'float', value: 0.3 },
    { name: 'ior', type: 'color', value: { r: 1.0, g: 0.9, b: 0.5 } },
    { name: 'metal_samples', type: 'int', value: 8 },
    { name: 'transparency', type: 'bool', value: 1, bool: true },
  ])
  const a = makeAccessors(params)

  it('getFloat prefers float-typed params', () => {
    expect(a.getFloat('roughness')).toBe(0.3)
    expect(a.getFloat('ior')).toBeNull()
  })
  it('getColor returns rgbToHex for color-typed', () => {
    expect(a.getColor('ior')).toMatch(/^#/)
    expect(a.getColor('roughness')).toBeNull()
  })
  it('getColorRaw returns {r,g,b}', () => {
    expect(a.getColorRaw('ior')).toEqual({ r: 1.0, g: 0.9, b: 0.5 })
  })
  it('getInt returns int and bool u32', () => {
    expect(a.getInt('metal_samples')).toBe(8)
    expect(a.getInt('transparency')).toBe(1)
  })
  it('getBoolFlex coerces int/bool/float > 0.5', () => {
    expect(a.getBoolFlex('transparency')).toBe(true)
    expect(a.getBoolFlex('roughness')).toBe(false)
    expect(a.getBoolFlex('nonexistent')).toBeNull()
  })
  it('getAnyScalar returns value regardless of numeric type', () => {
    expect(a.getAnyScalar('roughness')).toBe(0.3)
    expect(a.getAnyScalar('metal_samples')).toBe(8)
  })
  it('getColorOrScalar returns {r,g,b} when float', () => {
    expect(a.getColorOrScalar('roughness')).toEqual({ r: 0.3, g: 0.3, b: 0.3 })
    expect(a.getColorOrScalar('ior')).toEqual({ r: 1.0, g: 0.9, b: 0.5 })
  })
  it('getAnyAsColorArray returns [r,g,b] arrays', () => {
    expect(a.getAnyAsColorArray('ior')).toEqual([1.0, 0.9, 0.5])
    expect(a.getAnyAsColorArray('roughness')).toEqual([0.3, 0.3, 0.3])
  })
  it('walks aliases left-to-right', () => {
    expect(a.getFloat('nonexistent', 'roughness')).toBe(0.3)
  })
})
