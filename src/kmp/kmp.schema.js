// Archive-level schema: texture-slot keyword table + texture extensions.

export { TEXTURE_EXTENSIONS } from '../binary-tools/texture-extensions.js'

// Ordered list — first match wins.
export const TEXTURE_SLOT_KEYWORDS = Object.freeze([
  { pattern: /(albedo|base[_-]?color|basecolor)/i, slot: 'map' },
  { pattern: /\bdiffuse\b/i, slot: 'map' },
  { pattern: /(normal|\bnrm\b)/i, slot: 'normalMap' },
  { pattern: /(roughness|\brough\b)/i, slot: 'roughnessMap' },
  { pattern: /(metalness|metallic|\bmetal\b)/i, slot: 'metalnessMap' },
  { pattern: /(ambient[_-]?occlusion|occlusion|(^|[_\-.])ao([_\-.]|$))/i, slot: 'aoMap' },
  { pattern: /(emissive|emission|\bemit\b)/i, slot: 'emissiveMap' },
  { pattern: /(alpha|opacity|transparency)/i, slot: 'alphaMap' },
  { pattern: /(bump|height|displacement)/i, slot: 'displacementMap' },
  { pattern: /(clearcoat|\bcoat\b)/i, slot: 'clearcoatMap' },
  { pattern: /\bsheen\b/i, slot: 'sheenColorMap' },
  { pattern: /\bspecular\b/i, slot: 'specularColorMap' },
  { pattern: /\bcolor\b/i, slot: 'map' },
])
