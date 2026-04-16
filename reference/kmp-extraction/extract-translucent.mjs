/**
 * Manually map the known raw params for Translucent Candle Wax #3
 * through the exact same mapping logic, using the correct param names
 * (which the binary parser extracted but with name corruption).
 */

function clamp01(v) { return Math.max(0, Math.min(1, v)) }
function linearToSrgb(c) {
  c = Math.max(0, Math.min(1, c))
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055
}
function rgbToHex(r, g, b) {
  const ri = Math.round(Math.min(255, Math.max(0, linearToSrgb(r) * 255)))
  const gi = Math.round(Math.min(255, Math.max(0, linearToSrgb(g) * 255)))
  const bi = Math.round(Math.min(255, Math.max(0, linearToSrgb(b) * 255)))
  return '#' + ri.toString(16).padStart(2, '0') + gi.toString(16).padStart(2, '0') + bi.toString(16).padStart(2, '0')
}

// Raw params extracted from the binary (with correct names):
const rawParams = {
  'lux_translucent': { type: 'color', value: { r: 0.5, g: 0.5, b: 0.5 } },
  'diffuse': { type: 'float', value: 1.442 },
  'ior': { type: 'color', value: { r: 1.0, g: 0.9184, b: 0.5625 } },
  'transmission': { type: 'float', value: 0.1 },
  'translucency': { type: 'color', value: { r: 1.0, g: 1.0, b: 1.0 } },
  'specular_color': { type: 'float', value: 1.0 },
  'specularity': { type: 'color', value: { r: 1.0, g: 1.0, b: 1.0 } },
  'alpha': { type: 'float', value: 0.05 },
  'dispersion': { type: 'float', value: 0.0 },
}

const shaderType = 'lux_translucent'

// Now run the EXACT mapping logic from LuxionMtlParser.ts:

const mat = {
  color: '#888888', metalness: 0.0, roughness: 0.5,
  normalScaleX: 1.0, normalScaleY: 1.0, aoMapIntensity: 1.0,
  displacementScale: 1.0, displacementBias: 0.0,
  emissive: '#000000', emissiveIntensity: 1.0,
  opacity: 1.0, transparent: false, alphaTest: 0.0, side: 'front',
  clearcoat: 0.0, clearcoatRoughness: 0.0,
  clearcoatNormalScaleX: 1.0, clearcoatNormalScaleY: 1.0,
  sheen: 0.0, sheenColor: '#ffffff', sheenRoughness: 1.0,
  transmission: 0.0, thickness: 0.0,
  ior: 1.5, attenuationColor: '#ffffff', attenuationDistance: 0,
  iridescence: 0.0, iridescenceIOR: 1.3,
  iridescenceThicknessMin: 100, iridescenceThicknessMax: 400,
  anisotropy: 0.0, anisotropyRotation: 0.0,
  specularIntensity: 1.0, specularColor: '#ffffff',
  dispersion: 0.0, envMapIntensity: 1.0, wireframe: false,
  metalFlakeParams: null, kmpShaderType: null,
  carpaintParams: null, toonParams: null, sssParams: null,
}

const getFloat = (...keys) => {
  for (const key of keys) {
    const p = rawParams[key]
    if (p && p.type === 'float') return p.value
  }
  return null
}
const getColor = (...keys) => {
  for (const key of keys) {
    const p = rawParams[key]
    if (p && p.type === 'color') {
      const c = p.value
      return rgbToHex(c.r, c.g, c.b)
    }
  }
  return null
}
const getColorRaw = (...keys) => {
  for (const key of keys) {
    const p = rawParams[key]
    if (p && p.type === 'color') return p.value
  }
  return null
}
const getInt = (...keys) => {
  for (const key of keys) {
    const p = rawParams[key]
    if (p && p.type === 'int') return p.value
  }
  return null
}

// ── Generic mapping (mapLuxionParamsToMaterial) ──

// Shader type base color
if (shaderType && rawParams[shaderType]?.type === 'color') {
  mat.color = getColor(shaderType)
}

// Diffuse color aliases
const diffuseColor = getColor('diffuse', 'surface_color')
if (diffuseColor && (!shaderType || !rawParams[shaderType] || rawParams[shaderType]?.type !== 'color')) {
  mat.color = diffuseColor
}
// diffuse is float type so diffuseColor is null, color stays from shader type

const roughness = getFloat('roughness')
if (roughness !== null) mat.roughness = clamp01(roughness)

const metal = getFloat('metal', 'metallic')
if (metal !== null) mat.metalness = clamp01(metal)

// IOR: ior is color type, so getFloat('ior') returns null
const ior = getFloat('ior', 'refractive_index')
if (ior !== null && ior > 0) {
  mat.ior = Math.max(1.0, Math.min(ior, 5.0))
  const f0 = Math.pow((ior - 1) / (ior + 1), 2)
  mat.specularIntensity = Math.min(f0 / 0.04, 2.0)
}

const transmission = getFloat('transmission', 'transparency')
if (transmission !== null) mat.transmission = clamp01(transmission)

const dispersion = getFloat('dispersion')
if (dispersion !== null) mat.dispersion = dispersion

// Alpha
const alpha = getColorRaw('alpha')
// alpha is float type (0.05), not color, so getColorRaw returns null
// But wait - in the real parser, alpha could be parsed differently
// From the raw output: alpha: 0.0500 (float) - NOT a color
// So no alpha/transparency adjustment from generic mapping

// specular_color is float type → getColor('specular_color') returns null
// specular as color → getColor('specular') returns null

// ── Apply shader-type-specific mapping: lux_translucent ──

// type.includes('translucent') || type.includes('sss')
if (!rawParams['transmission'] || rawParams['transmission'].type !== 'float' || getFloat('transmission') === null) {
  // Actually we DID find transmission = 0.1
}
// mat.transmission was set to 0.1 by generic mapping above
// The shader-specific code checks: if (!params['transmission'] && !params['transparency'])
// params['transmission'] EXISTS → condition is false → transmission stays at 0.1

if (mat.attenuationDistance === 0) mat.attenuationDistance = 0.5

const sssSubsurfaceColor = getColorRaw('translucency', 'subsurface_color', 'sss_color')
const sssTransmissionColor = getColorRaw('transmission_color', 'transmission', 'attenuation_color')
const sssSpecularColorRaw = getColorRaw('specular_color', 'reflection_color')
const sssSpecularity = getColorRaw('specularity')

const sssIorR = getFloat('ior') ?? 1.5
// ior is color type → getFloat returns null → sssIorR = 1.5
const sssIorColor = getColorRaw('ior')
// ior IS color type → sssIorColor = {r: 1.0, g: 0.9184, b: 0.5625}
const sssIorChannels = sssIorColor
  ? [sssIorColor.r, sssIorColor.g, sssIorColor.b]
  : [sssIorR, sssIorR, sssIorR]

const sssDiffuseWeight = getFloat('diffuse', 'diffuse_weight') ?? 0.5
// diffuse is float 1.442 → sssDiffuseWeight = 1.442
const sssDispersion = getFloat('dispersion') ?? 0.0

mat.kmpShaderType = 'lux_translucent'
mat.sssParams = {
  subsurfaceColor: sssSubsurfaceColor ? [sssSubsurfaceColor.r, sssSubsurfaceColor.g, sssSubsurfaceColor.b] : [1, 0.9, 0.8],
  subsurfaceRadius: sssDiffuseWeight * 0.5,
  iorChannels: sssIorChannels,
  diffuseWeight: sssDiffuseWeight,
  transmissionColor: sssTransmissionColor ? [sssTransmissionColor.r, sssTransmissionColor.g, sssTransmissionColor.b] : [1, 1, 1],
  specularColor: sssSpecularColorRaw ? [sssSpecularColorRaw.r, sssSpecularColorRaw.g, sssSpecularColorRaw.b] : [1, 1, 1],
  specularity: sssSpecularity ? [sssSpecularity.r, sssSpecularity.g, sssSpecularity.b] : [1, 1, 1],
  dispersion: sssDispersion,
}

// Handle translucency color for attenuation
if (sssSubsurfaceColor) {
  mat.attenuationColor = rgbToHex(sssSubsurfaceColor.r, sssSubsurfaceColor.g, sssSubsurfaceColor.b)
}
mat.transparent = true
mat.side = 'double'

// diffuseWeight > 1 is clamped for shader uniform but stored raw in sssParams

console.log('--- Translucent Candle Wax MaterialDefinition ---')
console.log(JSON.stringify(mat, (k, v) => v === null ? undefined : v, 2))
console.log('\nKey values:')
console.log('  color:', mat.color, '(sRGB of linear [0.5, 0.5, 0.5])')
console.log('  transmission:', mat.transmission)
console.log('  attenuationColor:', mat.attenuationColor)
console.log('  attenuationDistance:', mat.attenuationDistance)
console.log('  sssParams.subsurfaceRadius:', mat.sssParams.subsurfaceRadius, '(diffuseWeight', sssDiffuseWeight, '* 0.5)')
console.log('  sssParams.iorChannels:', mat.sssParams.iorChannels)
console.log('  sssParams.diffuseWeight:', mat.sssParams.diffuseWeight)
