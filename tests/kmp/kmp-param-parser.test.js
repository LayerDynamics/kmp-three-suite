import { describe, it, expect } from 'vitest'
import { parseXmlConfig, autoAssignTextures } from '../../src/kmp/kmp-param-parser.js'
import { createDefaultMaterialDefinition } from '../../src/lux/lux.schema.js'

describe('parseXmlConfig', () => {
  it('extracts shader attribute', () => {
    const xml = '<Material shader="lux_toon" />'
    const cfg = parseXmlConfig(xml)
    expect(cfg.shaderHint).toBe('lux_toon')
  })
  it('returns null shaderHint when no XML', () => {
    expect(parseXmlConfig(null).shaderHint).toBeNull()
    expect(parseXmlConfig('').shaderHint).toBeNull()
  })
  it('captures all attributes into renderHints', () => {
    const xml = '<Material shader="toon" quality="high" />'
    expect(parseXmlConfig(xml).renderHints).toMatchObject({ shader: 'toon', quality: 'high' })
  })
})

describe('autoAssignTextures', () => {
  function texture(path) { return { path, bytes: new Uint8Array(), byteLength: 0, extension: path.split('.').pop() } }

  it('assigns albedo to map', () => {
    const mat = createDefaultMaterialDefinition()
    autoAssignTextures(mat, [texture('my_albedo.png')])
    expect(mat.map).toBe('my_albedo.png')
  })
  it('assigns normal to normalMap', () => {
    const mat = createDefaultMaterialDefinition()
    autoAssignTextures(mat, [texture('surface_normal.jpg')])
    expect(mat.normalMap).toBe('surface_normal.jpg')
  })
  it('assigns multiple textures to distinct slots', () => {
    const mat = createDefaultMaterialDefinition()
    autoAssignTextures(mat, [
      texture('base_color.png'),
      texture('rough.exr'),
      texture('metal.jpg'),
      texture('height.png'),
    ])
    expect(mat.map).toBe('base_color.png')
    expect(mat.roughnessMap).toBe('rough.exr')
    expect(mat.metalnessMap).toBe('metal.jpg')
    expect(mat.displacementMap).toBe('height.png')
  })
  it('first match wins when same slot would match multiple', () => {
    const mat = createDefaultMaterialDefinition()
    autoAssignTextures(mat, [texture('first_albedo.png'), texture('second_albedo.png')])
    expect(mat.map).toBe('first_albedo.png')
  })
})
