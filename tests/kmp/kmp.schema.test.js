import { describe, it, expect } from 'vitest'
import { TEXTURE_EXTENSIONS, TEXTURE_SLOT_KEYWORDS } from '../../src/kmp/kmp.schema.js'

describe('kmp.schema', () => {
  it('TEXTURE_EXTENSIONS includes all required formats', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'exr', 'hdr', 'tif', 'tiff', 'bmp']) {
      expect(TEXTURE_EXTENSIONS.has(ext)).toBe(true)
    }
  })
  it('TEXTURE_SLOT_KEYWORDS ordering: albedo beats color suffix', () => {
    const pick = (name) => TEXTURE_SLOT_KEYWORDS.find(({ pattern }) => pattern.test(name))?.slot
    expect(pick('my_albedo.png')).toBe('map')
    expect(pick('base_color.png')).toBe('map')
    expect(pick('surface_normal.png')).toBe('normalMap')
    expect(pick('roughness_map.exr')).toBe('roughnessMap')
    expect(pick('metallic.jpg')).toBe('metalnessMap')
    expect(pick('ao_bake.png')).toBe('aoMap')
    expect(pick('emissive_glow.png')).toBe('emissiveMap')
    expect(pick('alpha.png')).toBe('alphaMap')
    expect(pick('height_map.png')).toBe('displacementMap')
    expect(pick('coat.png')).toBe('clearcoatMap')
    expect(pick('sheen.png')).toBe('sheenColorMap')
    expect(pick('specular.png')).toBe('specularColorMap')
  })
})
