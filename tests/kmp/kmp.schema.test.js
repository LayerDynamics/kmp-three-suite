import { describe, it, expect } from 'vitest'
import { TEXTURE_EXTENSIONS, TEXTURE_SLOT_KEYWORDS } from '../../src/kmp/kmp.schema.js'
import { TEXTURE_EXTENSIONS as TEXTURE_EXTENSIONS_INTERNAL } from '../../src/binary-tools/texture-extensions.js'

describe('kmp.schema', () => {
  it('TEXTURE_EXTENSIONS includes all required formats', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'exr', 'hdr', 'tif', 'tiff', 'bmp']) {
      expect(TEXTURE_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  // Regression for Review.md finding: TEXTURE_EXTS was duplicated in
  // `decompression-tools.js` as a private, unfrozen Set. Both references now
  // resolve to one canonical binding so the two lists cannot drift.
  it('TEXTURE_EXTENSIONS is a single source of truth shared with the archive classifier', () => {
    expect(TEXTURE_EXTENSIONS).toBe(TEXTURE_EXTENSIONS_INTERNAL)
  })

  // Regression for Review.md finding: `Object.freeze(new Set([...]))` did
  // nothing to prevent `.add()` / `.delete()` / `.clear()` because Set
  // mutators operate on internal slots, not own properties. The replacement
  // wrapper swaps mutator methods for throwing stubs before freezing so the
  // guarantee is real.
  it('TEXTURE_EXTENSIONS is genuinely immutable', () => {
    expect(() => TEXTURE_EXTENSIONS.add('xyz')).toThrow(TypeError)
    expect(() => TEXTURE_EXTENSIONS.delete('png')).toThrow(TypeError)
    expect(() => TEXTURE_EXTENSIONS.clear()).toThrow(TypeError)
    expect(TEXTURE_EXTENSIONS.has('png')).toBe(true) // did not actually get deleted
    expect(TEXTURE_EXTENSIONS.has('xyz')).toBe(false) // did not actually get added
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
