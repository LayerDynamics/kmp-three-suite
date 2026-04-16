import { describe, it, expect } from 'vitest'
import { createDefaultMaterialDefinition, KNOWN_SHADER_TYPES } from '../../src/lux/lux.schema.js'

describe('lux.schema', () => {
  it('default MaterialDefinition has documented defaults', () => {
    const m = createDefaultMaterialDefinition()
    expect(m.color).toBe('#888888')
    expect(m.metalness).toBe(0.0)
    expect(m.roughness).toBe(0.5)
    expect(m.ior).toBe(1.5)
    expect(m.opacity).toBe(1.0)
    expect(m.transparent).toBe(false)
    expect(m.side).toBe('front')
    expect(m.clearcoat).toBe(0.0)
    expect(m.iridescenceThicknessMin).toBe(100)
    expect(m.iridescenceThicknessMax).toBe(400)
    expect(m.toonParams).toBeNull()
    expect(m.carpaintParams).toBeNull()
    expect(m.sssParams).toBeNull()
    expect(m.kmpShaderType).toBeNull()
    expect(m.envMapIntensity).toBe(1.0)
    expect(m.specularIntensity).toBe(1.0)
    expect(m.specularColor).toBe('#ffffff')
    expect(m.attenuationColor).toBe('#ffffff')
    expect(m.attenuationDistance).toBe(0)
  })
  it('KNOWN_SHADER_TYPES includes canonical lux_* names', () => {
    for (const n of ['lux_toon', 'lux_translucent', 'metallic_paint', 'lux_glass',
                     'lux_velvet', 'lux_gem', 'lux_advanced', 'lux_metal']) {
      expect(KNOWN_SHADER_TYPES).toContain(n)
    }
  })
  it('every texture slot is null by default', () => {
    const m = createDefaultMaterialDefinition()
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
                     'emissiveMap', 'alphaMap', 'clearcoatMap', 'sheenColorMap',
                     'transmissionMap', 'iridescenceMap', 'anisotropyMap']) {
      expect(m[k]).toBeNull()
    }
  })
})
