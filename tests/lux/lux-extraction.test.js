import { describe, it, expect } from 'vitest'
import { buildMaterialDefinition, SHADER_RULES } from '../../src/lux/lux-extraction.js'
import { hexToComponents } from '../../src/binary-tools/binary-tools.js'

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

// ────────────────────────────────────────────────────────────────────────────
// Regression tests for previously-uncovered generic-mapping branches:
// colorFilter, diffuseSaturation, backscatter, ambient, edginess, fresnel,
// refractive_index_outside, transmission_out. These pin exact behavior so a
// refactor into per-concern helpers cannot silently reorder or drop logic.
// ────────────────────────────────────────────────────────────────────────────
describe('generic mapping — colorFilter branch', () => {
  it('color_filter multiplies base color component-wise (dimming)', () => {
    const raw = mk([
      { name: 'diffuse',      type: 'color', value: { r: 1,   g: 1, b: 1 } },
      { name: 'color_filter', type: 'color', value: { r: 0.5, g: 1, b: 0.5 } },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    const [cr, cg, cb] = hexToComponents(m.color)
    // After filter, R and B channels must dim (< 1); G must stay close to 1.
    expect(cr).toBeLessThan(0.99)
    expect(cb).toBeLessThan(0.99)
    expect(cg).toBeGreaterThan(0.95)
    // And must differ from an unfiltered baseline run with just diffuse.
    const { materialDefinition: baseline } = buildMaterialDefinition(
      mk([{ name: 'diffuse', type: 'color', value: { r: 1, g: 1, b: 1 } }]),
      null, new Map(),
    )
    expect(m.color).not.toBe(baseline.color)
  })
})

describe('generic mapping — diffuseSaturation branch', () => {
  it('diffuse_saturation > 1 widens R-B channel spread vs. unsaturated baseline', () => {
    const raw = mk([
      { name: 'diffuse',            type: 'color', value: { r: 0.6, g: 0.4, b: 0.2 } },
      { name: 'diffuse_saturation', type: 'float', value: 2.0 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    const { materialDefinition: baseline } = buildMaterialDefinition(
      mk([{ name: 'diffuse', type: 'color', value: { r: 0.6, g: 0.4, b: 0.2 } }]),
      null, new Map(),
    )
    const [cr, , cb] = hexToComponents(m.color)
    const [br, , bb] = hexToComponents(baseline.color)
    // Color must change.
    expect(m.color).not.toBe(baseline.color)
    // Saturation boost widens the dominant-to-minor channel spread.
    expect(cr - cb).toBeGreaterThan(br - bb)
  })

  it('diffuse_saturation <= 1 is a no-op', () => {
    const raw = mk([
      { name: 'diffuse',            type: 'color', value: { r: 0.6, g: 0.4, b: 0.2 } },
      { name: 'diffuse_saturation', type: 'float', value: 1.0 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    const { materialDefinition: baseline } = buildMaterialDefinition(
      mk([{ name: 'diffuse', type: 'color', value: { r: 0.6, g: 0.4, b: 0.2 } }]),
      null, new Map(),
    )
    expect(m.color).toBe(baseline.color)
  })
})

describe('generic mapping — backscatter branch', () => {
  it('backscatter populates emissive and clamps emissiveIntensity to at least 0.05', () => {
    const raw = mk([{ name: 'backscatter', type: 'color', value: { r: 0.8, g: 0.2, b: 0.1 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.emissive).not.toBe('#000000')
    expect(m.emissiveIntensity).toBeGreaterThanOrEqual(0.05)
  })
})

describe('generic mapping — ambient branch', () => {
  it('ambient fills emissive only when still default black', () => {
    const raw = mk([{ name: 'ambient', type: 'color', value: { r: 0.3, g: 0.3, b: 0.3 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.emissive).not.toBe('#000000')
  })

  it('ambient is skipped when backscatter already set emissive (ordering invariant)', () => {
    const raw = mk([
      { name: 'backscatter', type: 'color', value: { r: 0.8, g: 0.2, b: 0.1 } },
      { name: 'ambient',     type: 'color', value: { r: 0.3, g: 0.3, b: 0.3 } },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    const { materialDefinition: backOnly } = buildMaterialDefinition(
      mk([{ name: 'backscatter', type: 'color', value: { r: 0.8, g: 0.2, b: 0.1 } }]),
      null, new Map(),
    )
    expect(m.emissive).toBe(backOnly.emissive)
  })
})

describe('generic mapping — edginess branch', () => {
  it('edginess sets sheenRoughness = 1 - edginess when sheen > 0', () => {
    const raw = mk([
      { name: 'sheen',    type: 'float', value: 0.5 },
      { name: 'edginess', type: 'float', value: 0.3 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.sheenRoughness).toBeCloseTo(0.7, 6)
  })

  it('edginess is a no-op when sheen is 0 (branch guard)', () => {
    const raw = mk([{ name: 'edginess', type: 'float', value: 0.3 }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.sheenRoughness).toBe(1.0) // default
  })
})

describe('generic mapping — fresnel toggle branch', () => {
  it('fresnel=0 clamps specularIntensity up to at least 0.5', () => {
    const raw = mk([
      { name: 'specular', type: 'float', value: 0.2 },
      { name: 'fresnel',  type: 'int',   value: 0 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.specularIntensity).toBeCloseTo(0.5, 6)
  })

  it('fresnel=1 does not modify specularIntensity', () => {
    const raw = mk([
      { name: 'specular', type: 'float', value: 0.2 },
      { name: 'fresnel',  type: 'int',   value: 1 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.specularIntensity).toBeCloseTo(0.2, 6)
  })
})

describe('generic mapping — refractive_index_outside branch', () => {
  it('effective ior becomes mat.ior / refractive_index_outside and re-derives specularIntensity', () => {
    const raw = mk([
      { name: 'ior',                     type: 'float', value: 2.0 },
      { name: 'refractive_index_outside',type: 'float', value: 1.5 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.ior).toBeCloseTo(2.0 / 1.5, 5)
    const eff = 2.0 / 1.5
    const f0 = Math.pow((eff - 1) / (eff + 1), 2)
    expect(m.specularIntensity).toBeCloseTo(Math.min(f0 / 0.04, 2.0), 4)
  })

  it('refractive_index_outside clamps ior to floor of 1.0', () => {
    const raw = mk([
      { name: 'ior',                     type: 'float', value: 1.2 },
      { name: 'refractive_index_outside',type: 'float', value: 2.0 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    // 1.2 / 2.0 = 0.6; floor = 1.0
    expect(m.ior).toBeCloseTo(1.0, 6)
  })
})

describe('generic mapping — transmission_out branch', () => {
  it('transmission_out fills attenuationColor when still default white', () => {
    const raw = mk([{ name: 'transmission_out', type: 'color', value: { r: 0.5, g: 0.3, b: 0.1 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    expect(m.attenuationColor).not.toBe('#ffffff')
  })

  it('transmission_out is skipped when attenuation_color already set (guard invariant)', () => {
    const raw = mk([
      { name: 'attenuation_color', type: 'color', value: { r: 0.9, g: 0.9, b: 0.9 } },
      { name: 'transmission_out',  type: 'color', value: { r: 0.1, g: 0.1, b: 0.1 } },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, null, new Map())
    const { materialDefinition: attOnly } = buildMaterialDefinition(
      mk([{ name: 'attenuation_color', type: 'color', value: { r: 0.9, g: 0.9, b: 0.9 } }]),
      null, new Map(),
    )
    expect(m.attenuationColor).toBe(attOnly.attenuationColor)
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

  // Regression: DEFCAD STANDARD TOON.kmp stores contour/shadow colors as a
  // texslot binding + scalar float (e.g. 1.0 for a white contour, 43.29 for
  // an HDR-gray shadow). Prior to this fix applyToon used getColorRaw,
  // which only matches true `color` records, so the scalar fallback was
  // silently dropped and every such KMP extracted with contourColor[0,0,0].
  // See samples-to-match-identically-kmp-files/SingleMaterial01Toon/
  //     DEFCAD STANDARD TOON.kmp (real-world case that drove this fix).
  it('expands scalar-float "contour color" / "shadow color" into RGB triplets', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'color', value: { r: 0, g: 0, b: 0 } },
      // KeyShot texslot + scalar-float pattern. getColorRaw would return
      // null for both; getColorOrScalar returns { r:s, g:s, b:s }.
      { name: 'contour color', type: 'float', value: 1.0 },
      { name: 'shadow color', type: 'float', value: 43.29 },
      { name: 'shadow strength', type: 'color', value: { r: 0, g: 0, b: 0 } },
      { name: 'shadow multiplier', type: 'float', value: 0 },
      { name: 'contour angle', type: 'float', value: 0.2296 },
      // KMP observed this as an INT (not a float). getFloat would miss;
      // getAnyScalar picks it up.
      { name: 'contour width', type: 'int', value: 2 },
      { name: 'contour quality', type: 'float', value: 0.313 },
      { name: 'outline contour', type: 'bool', value: 1, bool: true },
      { name: 'part contour', type: 'bool', value: 1, bool: true },
      { name: 'material contour', type: 'bool', value: 0, bool: false },
      { name: 'transparency', type: 'bool', value: 1, bool: true },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_toon', new Map())
    expect(m.toonParams.contourColor).toEqual([1.0, 1.0, 1.0])
    expect(m.toonParams.shadowColor).toEqual([43.29, 43.29, 43.29])
    expect(m.toonParams.contourWidth).toBe(2)
    expect(m.toonParams.contourAngle).toBeCloseTo(0.2296, 4)
    expect(m.toonParams.transparency).toBe(true)
    expect(m.toonParams.partContour).toBe(true)
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
  // Regression: 'color' is consumed by applyToon via getColorRaw('color', 'diffuse'),
  // so MAPPED_KEYS covers it. It must NOT rely on a duplicate STRUCTURAL_KEYS entry
  // to suppress the "unmapped parameter" warning.
  it('does not warn for "color" on a toon shader (MAPPED_KEYS alone suppresses it)', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'color', value: { r: 0, g: 0, b: 0 } },
      { name: 'color', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } },
    ])
    const { warnings } = buildMaterialDefinition(raw, 'lux_toon', new Map())
    expect(warnings.some(w => w.includes('unmapped parameter: color'))).toBe(false)
  })
  it('does not warn for "color" on a non-toon shader (MAPPED_KEYS alone suppresses it)', () => {
    const raw = mk([
      { name: 'lux_metal', type: 'color', value: { r: 0.7, g: 0.7, b: 0.7 } },
      { name: 'color', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } },
    ])
    const { warnings } = buildMaterialDefinition(raw, 'lux_metal', new Map())
    expect(warnings.some(w => w.includes('unmapped parameter: color'))).toBe(false)
  })
  // Regression: 'lux_const_color_extended' was previously listed in
  // STRUCTURAL_KEYS, but the startsWith('lux_') exemption in the warning loop
  // already suppresses any 'lux_'-prefixed name. The STRUCTURAL_KEYS entry was
  // redundant; this test pins that the prefix exemption remains load-bearing.
  it('does not warn for "lux_const_color_extended" (lux_ prefix exemption covers it)', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'color', value: { r: 0, g: 0, b: 0 } },
      { name: 'lux_const_color_extended', type: 'int', value: 1 },
    ])
    const { warnings } = buildMaterialDefinition(raw, 'lux_toon', new Map())
    expect(warnings.some(w => w.includes('unmapped parameter: lux_const_color_extended'))).toBe(false)
  })
  // Sanity: an arbitrary 'lux_'-prefixed name that is not in any set also
  // passes through without warning, proving the prefix check is the real
  // gate (not a per-key allowlist).
  it('does not warn for an arbitrary lux_ prefixed parameter name', () => {
    const raw = mk([
      { name: 'lux_metal', type: 'color', value: { r: 0.7, g: 0.7, b: 0.7 } },
      { name: 'lux_future_unknown_param', type: 'float', value: 1 },
    ])
    const { warnings } = buildMaterialDefinition(raw, 'lux_metal', new Map())
    expect(warnings.some(w => w.includes('unmapped parameter: lux_future_unknown_param'))).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Data-driven coverage of every shader-type branch in applyShaderTypeMapping.
// Each row pins (a) the input shader-type string, (b) the emitted kmpShaderType
// literal, and (c) one or more branch-critical scalar side effects.
// Catches: typos in emitted literals (e.g. 'lux_ceremic'), branch-ordering
// regressions (metallic_paint-before-metal, *_medium-before-translucent,
// plastic_cloudy-before-plastic, etc.), and accidentally removed branches.
// ────────────────────────────────────────────────────────────────────────────
const SHADER_TYPE_CASES = [
  // [label, shaderTypeInput, expectedKmpShaderType, scalarAssertions]
  ['toon',                  'lux_toon',                 'lux_toon',                 { roughness: 1.0, metalness: 0.0, specularIntensity: 0.0 }],
  ['metallic_paint',        'metallic_paint',           'metallic_paint',           {}],
  ['car_paint',             'lux_car_paint',            'metallic_paint',           {}],
  ['translucent_medium',    'lux_translucent_medium',   'lux_translucent_medium',   { transmission: 0.9, attenuationDistance: 0.5, transparent: true }],
  ['scattering_medium',     'lux_scattering_medium',    'lux_scattering_medium',    { transmission: 0.7, attenuationDistance: 0.3, transparent: true }],
  ['translucent',           'lux_translucent',          'lux_translucent',          { transmission: 0.5, side: 'double', transparent: true }],
  ['sss',                   'lux_sss',                  'lux_translucent',          { transmission: 0.5, side: 'double', transparent: true }],
  ['diamond',               'lux_diamond',              'lux_diamond',              { transmission: 1.0, ior: 2.42, roughness: 0.05 }],
  ['gem',                   'lux_gem',                  'lux_gem',                  { transmission: 1.0, ior: 1.76, roughness: 0.05 }],
  ['glass',                 'lux_glass',                'lux_glass',                { transmission: 1.0, ior: 1.52, roughness: 0.05 }],
  ['liquid',                'lux_liquid',               'lux_liquid',               { transmission: 1.0, ior: 1.33, roughness: 0.05 }],
  ['dielectric',            'lux_dielectric',           'lux_dielectric',           { transmission: 0.5 }],
  ['plastic_cloudy',        'lux_plastic_cloudy',       'lux_plastic_cloudy',       { transmission: 0.3 }],
  ['plastic_transparent',   'lux_plastic_transparent',  'lux_plastic_transparent',  { transmission: 0.8, ior: 1.45, roughness: 0.1 }],
  ['plastic_plain',         'lux_plastic',              'lux_plastic',              { transmission: 0.2 }],
  ['brushed_metal',         'lux_brushed_metal',        'lux_brushed_metal',        { metalness: 1.0, roughness: 0.2 }],
  ['metal',                 'lux_metal',                'lux_metal',                { metalness: 1.0, roughness: 0.2 }],
  ['paint_non_metal',       'lux_paint',                'lux_paint',                { clearcoat: 0.3, clearcoatRoughness: 0.03, roughness: 0.4 }],
  ['velvet',                'lux_velvet',               'lux_velvet',               { sheen: 1.0 }],
  ['fabric',                'lux_fabric',               'lux_cloth',                { sheen: 1.0 }],
  ['cloth',                 'lux_cloth',                'lux_cloth',                { sheen: 1.0 }],
  ['realcloth',             'lux_realcloth',            'lux_cloth',                { sheen: 1.0 }],
  ['thin_film_snake',       'lux_thin_film',            'lux_thin_film',            { iridescence: 1.0, iridescenceIOR: 1.5 }],
  ['thin_film_space',       'lux thin film',            'lux_thin_film',            { iridescence: 1.0, iridescenceIOR: 1.5 }],
  ['anisotropic',           'lux_anisotropic',          'lux_anisotropic',          { metalness: 1.0 }],
  ['multi_layer_underscore','lux_multi_layer',          'lux_multi_layer',          {}],
  ['multi_layer_hyphen',    'lux_multi-layer',          'lux_multi_layer',          {}],
  ['multilayer_packed',     'lux_multilayer',           'lux_multi_layer',          {}],
  ['generic',               'lux_generic',              'lux_generic',              {}],
  ['advanced',              'lux_advanced',             'lux_advanced',             {}],
  ['emissive',              'lux_emissive',             'lux_emissive',             {}],
  ['flat',                  'lux_flat',                 'lux_flat',                 { roughness: 1.0, metalness: 0.0 }],
  ['matte',                 'lux_matte',                'lux_matte',                { roughness: 1.0, metalness: 0.0 }],
  ['diffuse',               'lux_diffuse',              'lux_diffuse',              { roughness: 1.0, metalness: 0.0 }],
  ['glossy',                'lux_glossy',               'lux_glossy',               { roughness: 0.1 }],
  ['rubber',                'lux_rubber',               'lux_rubber',               { roughness: 0.8 }],
  ['silicone',              'lux_silicone',             'lux_silicone',             { roughness: 0.8 }],
  ['ceramic',               'lux_ceramic',              'lux_ceramic',              { clearcoat: 1.0, clearcoatRoughness: 0.05, roughness: 0.3 }],
  ['porcelain',             'lux_porcelain',            'lux_porcelain',            { clearcoat: 1.0, clearcoatRoughness: 0.05, roughness: 0.3 }],
  ['leather',               'lux_leather',              'lux_leather',              { roughness: 0.7 }],
  ['axalta',                'lux_axalta',               'lux_measured',             {}],
  ['measured',              'lux_measured',             'lux_measured',             {}],
  ['xray_packed',           'lux_xray',                 'lux_xray',                 { transmission: 1.0, ior: 1.0 }],
  ['xray_underscore',       'lux_x_ray',                'lux_xray',                 { transmission: 1.0, ior: 1.0 }],
  ['wireframe',             'lux_wireframe',            'lux_wireframe',            { wireframe: true }],
  ['skin',                  'lux_skin',                 'lux_skin',                 { transmission: 0.1, attenuationDistance: 0.3 }],
  ['cutaway',               'lux_cutaway',              'lux_cutaway',              {}],
]

describe('shader-type mapping — data-driven coverage of every branch', () => {
  it.each(SHADER_TYPE_CASES)(
    '%s (input=%s) → kmpShaderType=%s',
    (_label, shaderType, expectedKmp, scalarAssertions) => {
      const raw = mk([{ name: shaderType, type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } }])
      const { materialDefinition: m } = buildMaterialDefinition(raw, shaderType, new Map())
      expect(m.kmpShaderType).toBe(expectedKmp)
      for (const [key, expected] of Object.entries(scalarAssertions)) {
        if (typeof expected === 'number') {
          expect(m[key], `${shaderType}.${key}`).toBeCloseTo(expected, 5)
        } else {
          expect(m[key], `${shaderType}.${key}`).toBe(expected)
        }
      }
    },
  )
})

// ────────────────────────────────────────────────────────────────────────────
// Meta-test: structurally couples the data-driven table to SHADER_RULES (the
// single source of truth for every canonical kmpShaderType emitted by
// applyShaderTypeMapping). Reads rule.canonical directly from the exported
// table — no regex scanning. Adding a new rule without a matching table row
// (or adding a test row for a canonical no rule emits) fails this test.
// ────────────────────────────────────────────────────────────────────────────
describe('shader-type mapping — meta-test: every rule canonical is covered', () => {
  it('every SHADER_RULES canonical has a corresponding SHADER_TYPE_CASES row', () => {
    const ruleCanonicals = new Set(SHADER_RULES.map(r => r.canonical))
    expect(ruleCanonicals.size, 'SHADER_RULES must define at least one canonical').toBeGreaterThan(0)

    const coveredLiterals = new Set(SHADER_TYPE_CASES.map(row => row[2]))
    const uncovered = [...ruleCanonicals].filter(lit => !coveredLiterals.has(lit)).sort()
    expect(
      uncovered,
      `SHADER_RULES emits canonical(s) with no SHADER_TYPE_CASES row: ${uncovered.join(', ')}`,
    ).toEqual([])

    const unusedTableLiterals = [...coveredLiterals].filter(lit => !ruleCanonicals.has(lit)).sort()
    expect(
      unusedTableLiterals,
      `SHADER_TYPE_CASES lists expected canonical(s) that no rule emits: ${unusedTableLiterals.join(', ')}`,
    ).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Rule-order invariants. These lock in the precedence that the refactor
// relies on. Reordering SHADER_RULES without preserving these invariants
// will silently misroute shader types — these tests catch that.
// ────────────────────────────────────────────────────────────────────────────
describe('shader-type mapping — rule-order invariants', () => {
  const indexOfRule = id => SHADER_RULES.findIndex(r => r.id === id)

  it('metallic_paint precedes brushed_metal and metal (so paint is never routed to lux_metal)', () => {
    const iPaint = indexOfRule('metallic_paint')
    const iBrushed = indexOfRule('brushed_metal')
    const iMetal = indexOfRule('metal')
    expect(iPaint).toBeGreaterThanOrEqual(0)
    expect(iBrushed).toBeGreaterThanOrEqual(0)
    expect(iMetal).toBeGreaterThanOrEqual(0)
    expect(iPaint).toBeLessThan(iBrushed)
    expect(iPaint).toBeLessThan(iMetal)
  })

  it('brushed_metal precedes metal (so "brushed_metal" gets lux_brushed_metal, not lux_metal)', () => {
    expect(indexOfRule('brushed_metal')).toBeLessThan(indexOfRule('metal'))
  })

  it('*_medium rules precede the generic translucent/sss rule', () => {
    const iTransMed = indexOfRule('translucent_medium')
    const iScatMed = indexOfRule('scattering_medium')
    const iSss = indexOfRule('translucent_sss')
    expect(iTransMed).toBeLessThan(iSss)
    expect(iScatMed).toBeLessThan(iSss)
  })

  it('diamond precedes gem (diamond is a specific gem variant)', () => {
    expect(indexOfRule('diamond')).toBeLessThan(indexOfRule('gem'))
  })

  it('plastic_cloudy and plastic_transparent precede bare plastic', () => {
    const iCloudy = indexOfRule('plastic_cloudy')
    const iTrans = indexOfRule('plastic_transparent')
    const iPlastic = indexOfRule('plastic')
    expect(iCloudy).toBeLessThan(iPlastic)
    expect(iTrans).toBeLessThan(iPlastic)
  })

  it('velvet precedes cloth, silicone precedes rubber, porcelain precedes ceramic, matte precedes diffuse', () => {
    expect(indexOfRule('velvet')).toBeLessThan(indexOfRule('cloth'))
    expect(indexOfRule('silicone')).toBeLessThan(indexOfRule('rubber'))
    expect(indexOfRule('porcelain')).toBeLessThan(indexOfRule('ceramic'))
    expect(indexOfRule('matte')).toBeLessThan(indexOfRule('diffuse'))
  })

  it('liquid precedes glass (so "liquid" gets lux_liquid with ior 1.33, not lux_glass with 1.52)', () => {
    expect(indexOfRule('liquid')).toBeLessThan(indexOfRule('glass'))
  })

  it('metal matcher excludes names containing "paint" (belt-and-braces alongside rule order)', () => {
    const metalRule = SHADER_RULES.find(r => r.id === 'metal')
    expect(metalRule.match('lux_metallic_paint')).toBe(false)
    expect(metalRule.match('lux_car_paint')).toBe(false)
    expect(metalRule.match('lux_paint')).toBe(false)
    expect(metalRule.match('lux_metal')).toBe(true)
    expect(metalRule.match('lux_brushed_metal')).toBe(true)
  })

  it('paint matcher excludes names containing "metal" (so metallic_paint is not double-matched)', () => {
    const paintRule = SHADER_RULES.find(r => r.id === 'paint')
    expect(paintRule.match('lux_metallic_paint')).toBe(false)
    expect(paintRule.match('lux_paint')).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Post-refactor behavior: removal of the historical `!type.includes('lic')`
// hack in the metal matcher. Any shader name containing "metal" (without
// "paint") now routes to the metal rule — including names like
// `relic_metal` that the old `!lic` guard quietly excluded, leaving them
// with no kmpShaderType. This is the intended behavior change.
// ────────────────────────────────────────────────────────────────────────────
describe('shader-type mapping — post-refactor: names with "lic" route to metal when appropriate', () => {
  it('a name containing both "metal" and "lic" (no "paint") routes to lux_metal', () => {
    const raw = mk([{ name: 'relic_metal', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'relic_metal', new Map())
    expect(m.kmpShaderType).toBe('lux_metal')
    expect(m.metalness).toBe(1.0)
  })

  it('metallic_paint still routes to metallic_paint (rule ordering, not the removed hack, protects it)', () => {
    const raw = mk([{ name: 'lux_metallic_paint', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_metallic_paint', new Map())
    expect(m.kmpShaderType).toBe('metallic_paint')
  })

  it('car_paint still routes to metallic_paint canonical', () => {
    const raw = mk([{ name: 'lux_car_paint', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } }])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_car_paint', new Map())
    expect(m.kmpShaderType).toBe('metallic_paint')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// ProcessOptions.shaderTypeOverrides — regression tests for the
// public-contract hook that was declared in index.d.ts:237 but previously
// never threaded into buildMaterialDefinition. The hook now runs between
// applyGenericMapping and applyShaderTypeMapping, replacing the built-in
// shader-type branch on match and leaving applyPostMapping intact.
// ────────────────────────────────────────────────────────────────────────────
describe('ProcessOptions.shaderTypeOverrides', () => {
  it('exact-match override replaces the built-in shader-type branch', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'color', value: { r: 0.1, g: 0.1, b: 0.1 } },
      { name: 'shadow multiplier', type: 'float', value: 1.0 },
    ])
    const overrides = {
      'lux_toon': (mat) => {
        mat.kmpShaderType = 'custom_toon'
        mat.roughness = 0.25
        mat.metalness = 0.9
      },
    }
    const { materialDefinition: m } = buildMaterialDefinition(
      raw, 'lux_toon', new Map(), { shaderTypeOverrides: overrides },
    )
    expect(m.kmpShaderType).toBe('custom_toon')
    expect(m.roughness).toBe(0.25)
    expect(m.metalness).toBe(0.9)
    expect(m.toonParams).toBeNull()
  })

  it('handler receives params (byName map) and working accessors', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'color', value: { r: 0.2, g: 0.4, b: 0.6 } },
      { name: 'shadow multiplier', type: 'float', value: 2.5 },
      { name: 'shadow color', type: 'color', value: { r: 0.1, g: 0.1, b: 0.1 } },
    ])
    let capturedParams = null
    let capturedShadowMul = null
    let capturedShadowColor = null
    const overrides = {
      'lux_toon': (mat, params, a) => {
        capturedParams = params
        capturedShadowMul = a.getFloat('shadow multiplier')
        capturedShadowColor = a.getColorRaw('shadow color')
        mat.kmpShaderType = 'captured'
      },
    }
    buildMaterialDefinition(raw, 'lux_toon', new Map(), { shaderTypeOverrides: overrides })
    expect(capturedParams).not.toBeNull()
    expect(capturedParams['shadow multiplier'].value).toBe(2.5)
    expect(capturedParams['lux_toon'].type).toBe('color')
    expect(capturedShadowMul).toBe(2.5)
    expect(capturedShadowColor).toEqual({ r: 0.1, g: 0.1, b: 0.1 })
  })

  it('runs AFTER applyGenericMapping so generic PBR baseline is visible', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'color', value: { r: 0.2, g: 0.4, b: 0.6 } },
      { name: 'roughness', type: 'float', value: 0.42 },
    ])
    let observedRoughness = null
    const overrides = {
      'lux_toon': (mat) => {
        observedRoughness = mat.roughness
        mat.kmpShaderType = 'custom'
      },
    }
    buildMaterialDefinition(raw, 'lux_toon', new Map(), { shaderTypeOverrides: overrides })
    expect(observedRoughness).toBeCloseTo(0.42, 6)
  })

  it('applyPostMapping still runs after override (attenuationColor fallback)', () => {
    const raw = mk([
      { name: 'custom_shader', type: 'color', value: { r: 0.2, g: 0.2, b: 0.2 } },
      { name: 'subsurface_color', type: 'color', value: { r: 0.8, g: 0.5, b: 0.2 } },
    ])
    const overrides = {
      'custom_shader': (mat) => { mat.kmpShaderType = 'custom_shader_applied' },
    }
    const { materialDefinition: m } = buildMaterialDefinition(
      raw, 'custom_shader', new Map(), { shaderTypeOverrides: overrides },
    )
    expect(m.kmpShaderType).toBe('custom_shader_applied')
    expect(m.attenuationColor).not.toBe('#ffffff')
  })

  it('longest-substring match wins over shorter keys', () => {
    const raw = mk([
      { name: 'metallic_paint', type: 'color', value: { r: 0.5, g: 0.2, b: 0.1 } },
    ])
    const overrides = {
      'paint':           (mat) => { mat.kmpShaderType = 'handler_paint' },
      'metallic_paint':  (mat) => { mat.kmpShaderType = 'handler_metallic_paint' },
    }
    const { materialDefinition: m } = buildMaterialDefinition(
      raw, 'metallic_paint', new Map(), { shaderTypeOverrides: overrides },
    )
    expect(m.kmpShaderType).toBe('handler_metallic_paint')
  })

  it('substring match fires for compound shader types', () => {
    const raw = mk([{ name: 'lux_glass_frosted', type: 'color', value: { r: 1, g: 1, b: 1 } }])
    const overrides = {
      'glass': (mat) => { mat.kmpShaderType = 'glass_handler' },
    }
    const { materialDefinition: m } = buildMaterialDefinition(
      raw, 'lux_glass_frosted', new Map(), { shaderTypeOverrides: overrides },
    )
    expect(m.kmpShaderType).toBe('glass_handler')
  })

  it('handler throw produces warning, does NOT crash, and falls back to built-in', () => {
    const raw = mk([
      { name: 'lux_toon', type: 'color', value: { r: 0.1, g: 0.1, b: 0.1 } },
      { name: 'shadow multiplier', type: 'float', value: 1.0 },
    ])
    const overrides = {
      'lux_toon': () => { throw new Error('boom') },
    }
    const { materialDefinition: m, warnings } = buildMaterialDefinition(
      raw, 'lux_toon', new Map(), { shaderTypeOverrides: overrides },
    )
    expect(warnings.some(w => w.includes('shaderTypeOverrides["lux_toon"] threw') && w.includes('boom'))).toBe(true)
    expect(m.kmpShaderType).toBe('lux_toon')
    expect(m.roughness).toBe(1.0)
    expect(m.toonParams).not.toBeNull()
  })

  it('non-function entry produces warning and falls back to built-in', () => {
    const raw = mk([{ name: 'lux_toon', type: 'color', value: { r: 0.1, g: 0.1, b: 0.1 } }])
    const overrides = { 'lux_toon': 'not a function' }
    const { materialDefinition: m, warnings } = buildMaterialDefinition(
      raw, 'lux_toon', new Map(), { shaderTypeOverrides: overrides },
    )
    expect(warnings.some(w => w.includes('shaderTypeOverrides["lux_toon"] is not a function'))).toBe(true)
    expect(m.kmpShaderType).toBe('lux_toon')
  })

  it('no-match override falls through to built-in mapping unchanged', () => {
    const raw = mk([{ name: 'lux_toon', type: 'color', value: { r: 0.1, g: 0.1, b: 0.1 } }])
    const overrides = {
      'some_unrelated_key': (mat) => { mat.kmpShaderType = 'should_not_run' },
    }
    const { materialDefinition: m } = buildMaterialDefinition(
      raw, 'lux_toon', new Map(), { shaderTypeOverrides: overrides },
    )
    expect(m.kmpShaderType).toBe('lux_toon')
    expect(m.toonParams).not.toBeNull()
  })

  it('missing options / empty overrides behave exactly like before (baseline)', () => {
    const raw = mk([{ name: 'lux_toon', type: 'color', value: { r: 0.1, g: 0.1, b: 0.1 } }])
    const { materialDefinition: baseline } = buildMaterialDefinition(raw, 'lux_toon', new Map())
    const { materialDefinition: withEmpty } = buildMaterialDefinition(raw, 'lux_toon', new Map(), {})
    const { materialDefinition: withEmptyOverrides } = buildMaterialDefinition(raw, 'lux_toon', new Map(), { shaderTypeOverrides: {} })
    expect(withEmpty.kmpShaderType).toBe(baseline.kmpShaderType)
    expect(withEmptyOverrides.kmpShaderType).toBe(baseline.kmpShaderType)
    expect(withEmpty.toonParams).toEqual(baseline.toonParams)
  })
})

// Regression for Review.md finding: `applyPostMapping accepts third arg at
// call site but signature has two`. The fix widens the signature to accept
// `subShaderColors` and — when a translucent material lacks an explicit
// sss/subsurface colour — uses the first sub-shader colour slot as the
// attenuation-colour fallback. Confirms the arg is consumed, gated on
// transmission, and never mutates opaque materials.
describe('applyPostMapping sub-shader colour fallback', () => {
  it('uses the first sub-shader slot for attenuationColor when transmission > 0 and no sss/subsurface param is present', () => {
    const raw = mk([
      { name: 'lux_some_shader', type: 'color', value: { r: 1, g: 1, b: 1 } },
      { name: 'transmission', type: 'float', value: 0.5 },
    ])
    const subShaderColors = new Map([
      [0, { r: 0.2, g: 0.4, b: 0.8 }],
      [1, { r: 0.9, g: 0.1, b: 0.1 }],
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_some_shader', subShaderColors)
    expect(m.transmission).toBeGreaterThan(0)
    // First slot (insertion order) mapped through linear→sRGB rgbToHex.
    const [r0, g0, b0] = hexToComponents(m.attenuationColor)
    expect(r0).toBeGreaterThan(0)
    expect(g0).toBeGreaterThan(0)
    expect(b0).toBeGreaterThan(r0) // blue-dominant reflects the slot
    expect(m.attenuationColor).not.toBe('#ffffff')
  })
  it('does not override attenuationColor for opaque materials even when sub-shader colours exist', () => {
    // transmission stays 0 — post-mapping must leave attenuationColor at its
    // default, since sub-shader colours only have attenuation semantics for
    // translucent materials.
    const raw = mk([
      { name: 'lux_opaque', type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } },
    ])
    const subShaderColors = new Map([[0, { r: 0.9, g: 0.0, b: 0.0 }]])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_opaque', subShaderColors)
    expect(m.transmission).toBe(0)
    expect(m.attenuationColor).toBe('#ffffff')
  })
  it('prefers an explicit sss/subsurface_color param over the sub-shader fallback', () => {
    // sss_color wins over slot 0; the fallback path is skipped entirely.
    const raw = mk([
      { name: 'lux_translucent', type: 'color', value: { r: 1, g: 1, b: 1 } },
      { name: 'transmission', type: 'float', value: 0.5 },
      { name: 'sss_color', type: 'color', value: { r: 0.8, g: 0.2, b: 0.2 } },
    ])
    const subShaderColors = new Map([[0, { r: 0.1, g: 0.9, b: 0.1 }]]) // green — must be ignored
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_translucent', subShaderColors)
    const [r, g, b] = hexToComponents(m.attenuationColor)
    expect(r).toBeGreaterThan(g) // red-dominant reflects sss_color, not slot 0
    expect(r).toBeGreaterThan(b)
  })
  it('tolerates an empty subShaderColors map without error', () => {
    const raw = mk([
      { name: 'lux_some_shader', type: 'color', value: { r: 1, g: 1, b: 1 } },
      { name: 'transmission', type: 'float', value: 0.5 },
    ])
    const { materialDefinition: m } = buildMaterialDefinition(raw, 'lux_some_shader', new Map())
    expect(m.transmission).toBeGreaterThan(0)
    expect(m.attenuationColor).toBe('#ffffff')
  })
})
