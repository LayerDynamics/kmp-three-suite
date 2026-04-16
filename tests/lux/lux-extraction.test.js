import { describe, it, expect } from 'vitest'
import { buildMaterialDefinition } from '../../src/lux/lux-extraction.js'

function mk(params) { return params.map((p, i) => ({ offset: i, ...p })) }

describe('generic PBR mapping — base color, roughness, metal, ior', () => {
  it('shader-type color populates base color', () => {
    const raw = mk([{ name: 'metallic_paint', type: 'color', value: { r: 0.4, g: 0.2, b: 0.05 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'metallic_paint', new Map())
    expect(m.color).toMatch(/^#/)
    expect(m.color).not.toBe('#888888')
  })
  it('diffuse fallback when shader-type is not color', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'float', value: 1.0 },
      { name: 'diffuse', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_toon', new Map())
    expect(m.color).toMatch(/^#/)
  })
  it('base weight multiplies base color', () => {
    const raw = mk([
      { name: 'shader_x', type: 'color', value: { r: 1, g: 1, b: 1 } },
      { name: 'base', type: 'float', value: 0.5 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'shader_x', new Map())
    expect(m.color).not.toBe('#ffffff')
  })
  it('roughness clamped to [0,1]', () => {
    const raw = mk([{ name: 'roughness', type: 'float', value: 1.5 }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.roughness).toBe(1.0)
  })
  it('metal → metalness clamped', () => {
    const raw = mk([{ name: 'metal', type: 'float', value: 0.7 }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.metalness).toBe(0.7)
  })
  it('ior → specularIntensity via Fresnel f0', () => {
    const raw = mk([{ name: 'ior', type: 'float', value: 1.5 }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.ior).toBe(1.5)
    expect(m.specularIntensity).toBeCloseTo(1.0, 2)
  })
})

describe('generic mapping — clearcoat + transmission', () => {
  it('clearcoat_ior > 1.5 scales clearcoat up', () => {
    const raw = mk([
      { name: 'clearcoat', type: 'float', value: 0.5 },
      { name: 'clearcoat_ior', type: 'float', value: 2.0 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.clearcoat).toBeGreaterThan(0.5)
  })
  it('specular_transmission color enables transmission + transparent', () => {
    const raw = mk([{ name: 'specular_transmission', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.transmission).toBeCloseTo(0.5, 2)
    expect(m.transparent).toBe(true)
  })
  it('thickness float sets thickness', () => {
    const raw = mk([{ name: 'thickness', type: 'float', value: 2.3 }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.thickness).toBe(2.3)
  })
})

describe('generic mapping — sheen, anisotropy, iridescence, specular', () => {
  it('sheen + sheen_roughness', () => {
    const raw = mk([
      { name: 'sheen', type: 'float', value: 0.8 },
      { name: 'sheen_roughness', type: 'float', value: 0.3 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.sheen).toBe(0.8)
    expect(m.sheenRoughness).toBe(0.3)
  })
  it('anisotropy clamped to [-1, 1]', () => {
    const raw = mk([{ name: 'anisotropy', type: 'float', value: 2.0 }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.anisotropy).toBe(1.0)
  })
  it('anisotropy from roughness_x + roughness_y', () => {
    const raw = mk([
      { name: 'roughness_x', type: 'float', value: 0.1 },
      { name: 'roughness_y', type: 'float', value: 0.5 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.anisotropy).toBeGreaterThan(0)
  })
  it('iridescence sets iridescence', () => {
    const raw = mk([{ name: 'iridescence', type: 'float', value: 0.5 }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.iridescence).toBe(0.5)
  })
  it('dispersion from abbe_number', () => {
    const raw = mk([{ name: 'abbe_number', type: 'float', value: 40 }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.dispersion).toBeCloseTo(1 / 40, 6)
  })
})

describe('shader-type: toon', () => {
  it('populates toonParams and overrides PBR scalars', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'color', value: { r: 0.1, g: 0.1, b: 0.1 } },
      { name: 'shadow color', type: 'color', value: { r: 0, g: 0, b: 0 } },
      { name: 'shadow multiplier', type: 'float', value: 1.0 },
      { name: 'contour angle', type: 'float', value: 60 },
      { name: 'contour width', type: 'float', value: 1.0 },
      { name: 'outline width multiplier', type: 'float', value: 1.0 },
      { name: 'part width multiplier', type: 'float', value: 1.0 },
      { name: 'contour quality', type: 'float', value: 1.0 },
      { name: 'outline contour', type: 'bool', value: 1, bool: true },
      { name: 'transparency', type: 'bool', value: 0, bool: false },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_toon', new Map())
    expect(m.kmpShaderType).toBe('lux_toon')
    expect(m.roughness).toBe(1.0)
    expect(m.metalness).toBe(0.0)
    expect(m.specularIntensity).toBe(0.0)
    expect(m.toonParams).not.toBeNull()
    expect(m.toonParams.fillColor).toEqual([0.1, 0.1, 0.1])
    expect(m.toonParams.contourAngle).toBe(60)
    expect(m.toonParams.outlineContour).toBe(true)
  })
})

describe('shader-type: metallic_paint', () => {
  it('builds carpaintParams + metalFlakeParams + derived metalness', () => {
    const raw = mk([
      { name: 'metallic_paint', type: 'color', value: { r: 0.6, g: 0.3, b: 0.1 } },
      { name: 'metal_coverage', type: 'float', value: 1.2 },
      { name: 'metal_roughness', type: 'float', value: 0.3 },
      { name: 'metal_flake_visibility', type: 'int', value: 16 },
      { name: 'ior', type: 'float', value: 1.5 },
      { name: 'clearcoat', type: 'float', value: 1 },
      { name: 'thickness multiplier', type: 'color', value: { r: 0.95, g: 0.95, b: 0.95 } },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'metallic_paint', new Map())
    expect(m.kmpShaderType).toBe('metallic_paint')
    expect(m.carpaintParams.metalCoverage).toBe(1.2)
    expect(m.metalFlakeParams.flakeDensity).toBeCloseTo(Math.max(0, Math.min(1, 0.3 + 1.2 * 0.3)), 6)
    expect(m.metalFlakeParams.flakeIntensity).toBeCloseTo(0.05 + (1 - 0.3) * 0.15, 6)
    expect(m.metalness).toBeGreaterThan(0.5)
  })
})

describe('shader-type: translucent / sss', () => {
  it('builds sssParams with iorChannels from color ior', () => {
    const raw = mk([
      { name: 'lux_translucent', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } },
      { name: 'diffuse', type: 'float', value: 1.442 },
      { name: 'ior', type: 'color', value: { r: 1.0, g: 0.9184, b: 0.5625 } },
      { name: 'transmission', type: 'float', value: 0.1 },
      { name: 'translucency', type: 'color', value: { r: 1, g: 1, b: 1 } },
      { name: 'specularity', type: 'color', value: { r: 1, g: 1, b: 1 } },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_translucent', new Map())
    expect(m.kmpShaderType).toBe('lux_translucent')
    expect(m.side).toBe('double')
    expect(m.transparent).toBe(true)
    expect(m.sssParams.iorChannels).toEqual([1.0, 0.9184, 0.5625])
    expect(m.sssParams.diffuseWeight).toBe(1.442)
    expect(m.sssParams.subsurfaceRadius).toBeCloseTo(0.721, 3)
  })
  it('falls back to sub-shader color slot for subsurfaceColor', () => {
    const raw = mk([{ name: 'lux_translucent', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } }])
    const slots = new Map([[0, { r: 0.9, g: 0.7, b: 0.4 }]])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_translucent', slots)
    expect(m.sssParams.subsurfaceColor).toEqual([0.9, 0.7, 0.4])
  })
})

describe('shader-type: glass / liquid / dielectric', () => {
  it('glass sets transmission=1 and ior default 1.52', () => {
    const raw = mk([{ name: 'lux_glass', type: 'color', value: { r: 1, g: 1, b: 1 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_glass', new Map())
    expect(m.transmission).toBe(1.0)
    expect(m.ior).toBeCloseTo(1.52, 2)
    expect(m.glassParams).not.toBeNull()
  })
  it('liquid sets ior 1.33', () => {
    const raw = mk([{ name: 'lux_liquid', type: 'color', value: { r: 1, g: 1, b: 1 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_liquid', new Map())
    expect(m.ior).toBeCloseTo(1.33, 2)
  })
})

describe('shader-type: metal / plastic variants / paint', () => {
  it('metal forces metalness=1', () => {
    const raw = mk([{ name: 'lux_metal', type: 'color', value: { r: 0.7, g: 0.7, b: 0.7 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_metal', new Map())
    expect(m.metalness).toBe(1.0)
  })
  it('plastic cloudy sets transmission=0.3', () => {
    const raw = mk([{ name: 'lux_plastic_cloudy', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_plastic_cloudy', new Map())
    expect(m.transmission).toBeCloseTo(0.3, 2)
  })
  it('plastic transparent sets transmission=0.8', () => {
    const raw = mk([{ name: 'lux_plastic_transparent', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_plastic_transparent', new Map())
    expect(m.transmission).toBeCloseTo(0.8, 2)
  })
})

describe('shader-type: velvet / gem / anisotropic', () => {
  it('velvet sets sheen=1 and velvetParams', () => {
    const raw = mk([{ name: 'lux_velvet', type: 'color', value: { r: 0.8, g: 0.2, b: 0.2 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_velvet', new Map())
    expect(m.sheen).toBe(1.0)
    expect(m.velvetParams).not.toBeNull()
  })
  it('gem sets transmission=1 and ior 1.76', () => {
    const raw = mk([{ name: 'lux_gem', type: 'color', value: { r: 0.9, g: 0.1, b: 0.1 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_gem', new Map())
    expect(m.transmission).toBe(1.0)
    expect(m.ior).toBeCloseTo(1.76, 2)
    expect(m.gemParams).not.toBeNull()
  })
  it('diamond sets ior 2.42', () => {
    const raw = mk([{ name: 'lux_diamond', type: 'color', value: { r: 1, g: 1, b: 1 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_diamond', new Map())
    expect(m.ior).toBeCloseTo(2.42, 2)
  })
  it('anisotropic sets metalness=1 and anisotropicParams', () => {
    const raw = mk([
      { name: 'lux_anisotropic', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } },
      { name: 'roughness_x', type: 'float', value: 0.1 },
      { name: 'roughness_y', type: 'float', value: 0.5 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_anisotropic', new Map())
    expect(m.metalness).toBe(1.0)
    expect(m.anisotropicParams).not.toBeNull()
  })
})

describe('unmapped-param warnings', () => {
  it('records a warning for an invented property name', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'color', value: { r: 0, g: 0, b: 0 } },
      { name: 'some_invented_property_xyz', type: 'float', value: 1 },
    ])
    const { warnings } = buildMaterialDefinition(raw, 'lux_toon', new Map())
    expect(warnings.some(w => w.includes('some_invented_property_xyz'))).toBe(true)
  })
})
