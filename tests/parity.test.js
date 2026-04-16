import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { extractMtl } from '../src/mtl/mtl-extraction.js'
import { buildMaterialDefinition } from '../src/lux/lux-extraction.js'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

const FIXTURES = [
  { kmp: 'paint-metallic-sienna-gold.kmp', golden: 'paint-metallic-sienna-gold-extracted.json', shaderType: 'metallic_paint' },
  { kmp: 'toon-fill-black-bright.kmp', golden: 'toon-fill-black-bright-extracted.json', shaderType: 'lux_toon' },
  { kmp: 'translucent-candle-wax.kmp', golden: 'translucent-candle-wax-extracted.json', shaderType: 'lux_translucent' },
]

describe.each(FIXTURES)('MaterialDefinition parity — $kmp', ({ kmp, golden, shaderType }) => {
  const entries = unzipSync(new Uint8Array(readFileSync(join(KMP_DIR, kmp))))
  const mtlName = Object.keys(entries).find(n => n.endsWith('.mtl'))
  const res = extractMtl(entries[mtlName])
  const subColors = res.subShaderRegion?.colorSlots ?? new Map()
  const { materialDefinition } = buildMaterialDefinition(res.rawParameters, res.shaderType, subColors)
  const goldenJson = JSON.parse(readFileSync(join(KMP_DIR, golden), 'utf8'))
  const expected = goldenJson.materialDefinition

  it('kmpShaderType matches expected', () => {
    expect(materialDefinition.kmpShaderType).toBe(shaderType)
  })
  it('base color is a valid sRGB hex', () => {
    expect(materialDefinition.color).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('metalness, roughness, ior are within expected ranges', () => {
    expect(materialDefinition.metalness).toBeGreaterThanOrEqual(0)
    expect(materialDefinition.metalness).toBeLessThanOrEqual(1)
    expect(materialDefinition.roughness).toBeGreaterThanOrEqual(0)
    expect(materialDefinition.roughness).toBeLessThanOrEqual(1)
    expect(materialDefinition.ior).toBeGreaterThanOrEqual(1)
    expect(materialDefinition.ior).toBeLessThanOrEqual(5)
  })
  it('matches committed golden transparent + side flags', () => {
    expect(materialDefinition.transparent).toBe(expected.transparent)
    expect(materialDefinition.side).toBe(expected.side)
  })
  it('matches committed golden kmpShaderType', () => {
    expect(materialDefinition.kmpShaderType).toBe(expected.kmpShaderType)
  })
})

describe('toon-specific parity', () => {
  const entries = unzipSync(new Uint8Array(readFileSync(join(KMP_DIR, 'toon-fill-black-bright.kmp'))))
  const mtlName = Object.keys(entries).find(n => n.endsWith('.mtl'))
  const res = extractMtl(entries[mtlName])
  const { materialDefinition: m } = buildMaterialDefinition(res.rawParameters, res.shaderType, new Map())

  it('has non-null toonParams', () => {
    expect(m.toonParams).not.toBeNull()
  })
  it('overrides roughness=1, metalness=0, specularIntensity=0', () => {
    expect(m.roughness).toBe(1.0)
    expect(m.metalness).toBe(0.0)
    expect(m.specularIntensity).toBe(0.0)
  })
})

describe('metallic-paint-specific parity', () => {
  const entries = unzipSync(new Uint8Array(readFileSync(join(KMP_DIR, 'paint-metallic-sienna-gold.kmp'))))
  const mtlName = Object.keys(entries).find(n => n.endsWith('.mtl'))
  const res = extractMtl(entries[mtlName])
  const { materialDefinition: m } = buildMaterialDefinition(res.rawParameters, res.shaderType, new Map())

  it('has non-null carpaintParams', () => {
    expect(m.carpaintParams).not.toBeNull()
  })
  it('has non-null metalFlakeParams', () => {
    expect(m.metalFlakeParams).not.toBeNull()
  })
  it('has clearcoat > 0', () => {
    expect(m.clearcoat).toBeGreaterThan(0)
  })
})

describe('translucent-specific parity', () => {
  const entries = unzipSync(new Uint8Array(readFileSync(join(KMP_DIR, 'translucent-candle-wax.kmp'))))
  const mtlName = Object.keys(entries).find(n => n.endsWith('.mtl'))
  const res = extractMtl(entries[mtlName])
  const subColors = res.subShaderRegion?.colorSlots ?? new Map()
  const { materialDefinition: m } = buildMaterialDefinition(res.rawParameters, res.shaderType, subColors)

  it('has non-null sssParams with 3-channel ior', () => {
    expect(m.sssParams).not.toBeNull()
    expect(m.sssParams.iorChannels.length).toBe(3)
  })
  it('is transparent with side=double', () => {
    expect(m.transparent).toBe(true)
    expect(m.side).toBe('double')
  })
})
