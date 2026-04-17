// Raw-param → MaterialDefinition mapper.
// Evidence: kmp-three-suite/reference/kmp-extraction/kmp-pipeline.mjs:952-1790,
//           extract-kmp-exact.mjs:245-697.

import { createDefaultMaterialDefinition } from './lux.schema.js'
import { makeAccessors } from './lux-param-parser.js'
import { rgbToHex, hexToComponents, componentsToHex } from '../binary-tools/binary-tools.js'

const clamp01 = v => Math.max(0, Math.min(1, v))
const lerp = (a, b, t) => a + (b - a) * t

// Every parameter name consumed by the generic or shader-type mapping. Raw
// params whose name is not in this set trigger a warning.
const MAPPED_KEYS = new Set([
  'diffuse', 'surface_color', 'base',
  'roughness', 'metal', 'metallic', 'ior', 'refractive_index',
  'clearcoat', 'clear_coat', 'clearcoat_roughness', 'coat_roughness', 'clear_coat_roughness',
  'clearcoat_ior', 'clearcoat_refractive_index', 'coat_ior',
  'transmission', 'transparency', 'specular_transmission', 'diffuse_transmission',
  'thickness', 'transmission_depth', 'transparency_distance', 'color_density',
  'sheen', 'fuzz', 'sheen_roughness', 'fuzz_roughness', 'sheen_color', 'fuzz_color', 'sheen_tint',
  'anisotropy', 'specular_anisotropy', 'roughness_x', 'roughness_y',
  'anisotropy_rotation', 'angle',
  'emissive_intensity', 'emission_luminance', 'luminance',
  'specular', 'specular_weight', 'specular_tint',
  'iridescence', 'thin_film', 'thin_film_ior', 'film_refractive_index',
  'film_thickness', 'thin_film_thickness', 'film_extinction', 'film_extinction_coefficient',
  'color_filter',
  'bump_intensity', 'normal_scale', 'bump', 'displacement_scale', 'height_scale',
  'dispersion', 'abbe_number',
  'roughness_transmission', 'diffuse_saturation',
  'alpha', 'emissive', 'emission', 'emissive_color',
  'specular_color', 'reflection_color',
  'attenuation_color', 'transmission_color', 'subsurface_color', 'transmission_out',
  'backscatter', 'ambient',
  'attenuation_distance', 'subsurface_radius', 'translucency',
  'edginess', 'fresnel', 'refractive_index_outside',
  'sss_color',
  // Toon
  'color', 'shadow color', 'contour color', 'shadow strength',
  'shadow multiplier', 'contour angle', 'contour width', 'contour quality',
  'contour width is in pixels', 'outline width multiplier', 'part width multiplier',
  'outline contour', 'material contour', 'part contour', 'interior edge contour',
  'environment shadows', 'light source shadows',
  // Metallic paint
  'metal_coverage', 'metal_flake_visibility', 'metal_color', 'metal_roughness',
  'metal_flake_size', 'flake_size', 'metal_samples', 'thickness multiplier',
  'clearcoat_color', 'coat_color',
  // Translucent
  'diffuse_weight', 'specularity',
  // Texture-bound color channel (KeyShot lux_translucent / lux_plastic_simple
  // with a color modulation texture: one TLV record binds the slot (texslot)
  // and a second sets the scalar intensity (float)). Mapping is performed at
  // the texture-assignment stage (autoAssignTextures in kmp-param-parser.js)
  // via filename patterns; listing it here silences the unmapped warning for
  // the TLV records themselves.
  'texture_color',
  // Glass / absorption
  'absorption_color', 'absorption_distance', 'chromatic_aberration',
  // Gem
  'dispersion_strength', 'brilliance', 'fire_intensity',
  // Velvet
  'sheen_intensity', 'fuzz_amount',
  // XRay / other
  'xray_color', 'xray_intensity',
])

// Known structural / bookkeeping names emitted by the parser that should not
// trigger "unmapped" warnings (they are intentional non-PBR records).
// Note: 'color' is intentionally NOT listed here — it is a mapped parameter
// consumed by applyToon (via getColorRaw('color', 'diffuse')) and is covered
// by MAPPED_KEYS. 'lux_'-prefixed names are also NOT listed here — they are
// handled by the startsWith('lux_') exemption in the warning loop below, so
// entries like 'lux_const_color_extended' would be duplicate coverage.
const STRUCTURAL_KEYS = new Set([
  'flags',
  // KeyShot render-hint TLV records present inside material params — they
  // control renderer quality / ray-tracing sampling rather than any PBR
  // material property, so they are structural and do not emit warnings.
  // Evidence: lux_plastic emits `glossy_samples` (bool), lux_translucent
  // emits `global illumination` (int) and `samples` (bool).
  'glossy_samples',
  'global illumination',
  'samples',
])

/**
 * Map a list of raw MTL parameters onto a Three-compatible
 * {@link MaterialDefinition}, applying (in order) the generic PBR mapping, an
 * optional user-supplied `shaderTypeOverrides` handler, the built-in
 * shader-type mapping (first-match-wins on `SHADER_RULES`), and final post-
 * mapping fallbacks.
 *
 * Any raw-param name the mapping does not consume produces a warning; an
 * `shaderTypeOverrides` handler that throws is captured as a warning and the
 * built-in mapping runs as fallback (overrides never crash the pipeline).
 *
 * @param {import('../../index.d.ts').RawParam[]} rawParams Parsed TLV records
 *   from {@link parseParamSection}.
 * @param {string | null} shaderType Lux shader-type name (usually the first
 *   param's name). Case-insensitive; `null` skips shader-type-specific mapping.
 * @param {Map<number, import('../../index.d.ts').RgbTriplet>} subShaderColors
 *   Sub-shader color slots from the MTL's sub-shader region (empty map is OK).
 * @param {Pick<import('../../index.d.ts').ProcessOptions, 'shaderTypeOverrides'>} [options]
 * @returns {{ materialDefinition: import('../../index.d.ts').MaterialDefinition; warnings: string[] }}
 */
export function buildMaterialDefinition(rawParams, shaderType, subShaderColors, options) {
  const a = makeAccessors(rawParams)
  const mat = createDefaultMaterialDefinition()
  const warnings = []
  const type = (shaderType || '').toLowerCase()
  const overrides = options && options.shaderTypeOverrides ? options.shaderTypeOverrides : null

  applyGenericMapping(mat, a, shaderType)
  const overrideApplied = applyOverrideMapping(mat, a, type, overrides, warnings)
  if (!overrideApplied) applyShaderTypeMapping(mat, a, type, subShaderColors)
  applyPostMapping(mat, a, subShaderColors)

  // Warnings for any raw param name the mapping didn't consume.
  for (const p of rawParams) {
    if (!p?.name) continue
    if (p.name === shaderType) continue
    if (STRUCTURAL_KEYS.has(p.name)) continue
    if (MAPPED_KEYS.has(p.name)) continue
    // shader-type-like strings
    if (p.name.startsWith('lux_')) continue
    warnings.push(`unmapped parameter: ${p.name} (type=${p.type})`)
  }
  return { materialDefinition: mat, warnings }
}

// ────────────────────────────────────────────────────────────────────────────
// Generic PBR mapping. Evidence: kmp-pipeline.mjs:1042-1290,
// extract-kmp-exact.mjs:245-477.
//
// Split into per-concern helpers so each block is independently readable and
// test-targetable. Orchestrator call order IS behavior: helpers run in the
// sequence needed for state to flow correctly. Cross-helper dependencies:
//   mapBaseColor     → sets mat.color (read later by specular_tint/sheen_tint/color_filter/diffuse_saturation)
//   mapPbrScalars    → sets mat.ior, mat.specularIntensity (read by mapMisc's fresnel + ior_outside)
//   mapClearcoat     → self-contained
//   mapAttenuation   → sets mat.transmission (read by mapMisc's roughness_transmission),
//                      finalizes mat.attenuationColor so mapMisc no longer touches it
//   mapAnisotropy    → may overwrite mat.roughness (read by mapMisc's roughness_transmission)
//   mapIridescence   → self-contained
//   mapMisc          → everything else, strictly in original sub-order; internal
//                      invariants: specular_tint reads pre-filter mat.color,
//                      ambient skips if backscatter already populated emissive,
//                      fresnel/ior_outside see upstream specularIntensity/ior.
// ────────────────────────────────────────────────────────────────────────────
function applyGenericMapping(mat, a, shaderType) {
  mapBaseColor(mat, a, shaderType)
  mapPbrScalars(mat, a)
  mapClearcoat(mat, a)
  mapAttenuation(mat, a)
  mapAnisotropy(mat, a)
  mapIridescence(mat, a)
  mapMisc(mat, a)
}

// Base diffuse color: shader-type color slot > diffuse > surface_color, then
// optional base-weight darkening in linear space (componentsToHex = no gamma).
function mapBaseColor(mat, a, shaderType) {
  const { getFloat, getColor } = a
  if (shaderType && a.byName[shaderType]?.type === 'color') {
    mat.color = getColor(shaderType)
  }
  const diffuseColor = getColor('diffuse', 'surface_color')
  if (diffuseColor && (!shaderType || !a.byName[shaderType] || a.byName[shaderType]?.type !== 'color')) {
    mat.color = diffuseColor
  }
  const baseWeight = getFloat('base')
  if (baseWeight !== null && baseWeight < 1.0 && baseWeight >= 0) {
    const [cr, cg, cb] = hexToComponents(mat.color)
    mat.color = componentsToHex(cr * baseWeight, cg * baseWeight, cb * baseWeight)
  }
}

// Core PBR scalars: roughness, metalness, IOR. IOR also seeds specularIntensity
// via the Fresnel f0 approximation; mapMisc's `specular` param may later
// overwrite specularIntensity, and `refractive_index_outside` may recompute it.
function mapPbrScalars(mat, a) {
  const { getFloat } = a
  const roughness = getFloat('roughness')
  if (roughness !== null) mat.roughness = clamp01(roughness)

  const metal = getFloat('metal', 'metallic')
  if (metal !== null) mat.metalness = clamp01(metal)

  const ior = getFloat('ior', 'refractive_index')
  if (ior !== null && ior > 0) {
    mat.ior = Math.max(1.0, Math.min(ior, 5.0))
    const f0 = Math.pow((ior - 1) / (ior + 1), 2)
    mat.specularIntensity = Math.min(f0 / 0.04, 2.0)
  }
}

// Clearcoat family: weight, roughness, and the clearcoat-IOR f0 multiplier.
// clearcoat_ior reads the clearcoat weight set earlier in this helper.
function mapClearcoat(mat, a) {
  const { getFloat } = a
  const clearcoat = getFloat('clearcoat', 'clear_coat')
  if (clearcoat !== null) mat.clearcoat = clamp01(clearcoat)

  const clearcoatRoughness = getFloat('clearcoat_roughness', 'coat_roughness', 'clear_coat_roughness')
  if (clearcoatRoughness !== null) mat.clearcoatRoughness = clamp01(clearcoatRoughness)

  const clearcoatIor = getFloat('clearcoat_ior', 'clearcoat_refractive_index', 'coat_ior')
  if (clearcoatIor !== null && clearcoatIor > 0) {
    const ccF0 = Math.pow((clearcoatIor - 1) / (clearcoatIor + 1), 2)
    const defaultCcF0 = Math.pow((1.5 - 1) / (1.5 + 1), 2)
    mat.clearcoat = clamp01(mat.clearcoat * Math.min(ccF0 / defaultCcF0, 3.0))
  }
}

// Transmission, thickness, attenuation color + distance. Internal order is
// load-bearing because each stage may overwrite the previous:
//   transmission_float → specTransmission (sets attenuationColor) →
//   diffTransmission (sets attenuationColor + distance, guarded on transmission===0) →
//   thickness → transparency_distance →
//   attenuation_color (overwrites attenuationColor if param present) →
//   transmission_out (fallback: only if attenuationColor still default '#ffffff') →
//   attenuation_distance (overwrites distance if param present).
function mapAttenuation(mat, a) {
  const { getFloat, getColor, getColorRaw } = a

  const transmission = getFloat('transmission', 'transparency')
  if (transmission !== null) mat.transmission = clamp01(transmission)

  const specTransmission = getColorRaw('specular_transmission')
  if (specTransmission) {
    const avg = (specTransmission.r + specTransmission.g + specTransmission.b) / 3
    if (avg > 0.01) {
      mat.transmission = clamp01(avg)
      mat.transparent = true
      mat.attenuationColor = rgbToHex(specTransmission.r, specTransmission.g, specTransmission.b)
    }
  }

  const diffTransmission = getColorRaw('diffuse_transmission')
  if (diffTransmission) {
    const avg = (diffTransmission.r + diffTransmission.g + diffTransmission.b) / 3
    if (avg > 0.01 && mat.transmission === 0) {
      mat.transmission = clamp01(avg * 0.5)
      mat.attenuationColor = rgbToHex(diffTransmission.r, diffTransmission.g, diffTransmission.b)
      mat.attenuationDistance = 0.3
      mat.transparent = true
    }
  }

  const thickness = getFloat('thickness', 'transmission_depth')
  if (thickness !== null && thickness > 0) mat.thickness = thickness

  const transparencyDist = getFloat('transparency_distance', 'color_density')
  if (transparencyDist !== null && transparencyDist > 0) mat.attenuationDistance = transparencyDist

  const attenuationColor = getColor('attenuation_color', 'transmission_color', 'subsurface_color', 'transmission')
  if (attenuationColor) mat.attenuationColor = attenuationColor

  const transmissionOut = getColor('transmission_out')
  if (transmissionOut && mat.attenuationColor === '#ffffff') mat.attenuationColor = transmissionOut

  const attenuationDistance = getFloat('attenuation_distance', 'subsurface_radius', 'translucency')
  if (attenuationDistance !== null && attenuationDistance > 0) mat.attenuationDistance = attenuationDistance
}

// Anisotropy: direct scalar (clamped to [-1, 1]) OR roughness_x/y-derived
// (which also rewrites mat.roughness to sqrt(rx*ry)). Rotation prefers an
// explicit `anisotropy_rotation`, else converts `angle` (degrees) to radians.
function mapAnisotropy(mat, a) {
  const { getFloat } = a
  const anisotropy = getFloat('anisotropy', 'specular_anisotropy')
  const roughnessX = getFloat('roughness_x')
  const roughnessY = getFloat('roughness_y')
  if (anisotropy !== null) {
    mat.anisotropy = Math.max(-1, Math.min(anisotropy, 1))
  } else if (roughnessX !== null && roughnessY !== null) {
    const maxR = Math.max(roughnessX, roughnessY, 0.001)
    const minR = Math.min(roughnessX, roughnessY)
    mat.anisotropy = clamp01(1.0 - minR / maxR)
    mat.roughness = clamp01(Math.sqrt(roughnessX * roughnessY))
  }

  const anisoRotation = getFloat('anisotropy_rotation')
  const anisoAngle = getFloat('angle')
  if (anisoRotation !== null) mat.anisotropyRotation = anisoRotation
  else if (anisoAngle !== null) mat.anisotropyRotation = (anisoAngle * Math.PI) / 180
}

// Iridescence / thin-film family: weight, IOR (clamped [1, 3]), thickness
// window (auto-promotes iridescence from 0 to 1 if thickness is given), and
// an extinction-coefficient boost applied only when iridescence is already active.
function mapIridescence(mat, a) {
  const { getFloat } = a
  const iridescence = getFloat('iridescence', 'thin_film')
  if (iridescence !== null) mat.iridescence = clamp01(iridescence)

  const iridescenceIOR = getFloat('thin_film_ior', 'film_refractive_index')
  if (iridescenceIOR !== null) mat.iridescenceIOR = Math.max(1.0, Math.min(iridescenceIOR, 3.0))

  const filmThickness = getFloat('film_thickness', 'thin_film_thickness')
  if (filmThickness !== null && filmThickness > 0) {
    if (mat.iridescence === 0) mat.iridescence = 1.0
    mat.iridescenceThicknessMin = Math.max(0, filmThickness * 0.5)
    mat.iridescenceThicknessMax = filmThickness * 1.5
  }

  const filmExtinction = getFloat('film_extinction', 'film_extinction_coefficient')
  if (filmExtinction !== null && filmExtinction > 0 && mat.iridescence > 0) {
    mat.iridescence = clamp01(mat.iridescence * (1 + filmExtinction * 0.1))
  }
}

// Everything not captured by the named topic helpers, in the exact original
// sub-order (sheen → emissive/specular scalars → color post-processing →
// bump/displacement → dispersion → roughness_transmission → color outputs →
// sheen color/tint → backscatter/ambient → edginess → fresnel → ior_outside).
// Internal order is load-bearing:
//   * specular_tint reads mat.color BEFORE color_filter / diffuse_saturation mutate it
//   * sheen_tint reads mat.color AFTER color_filter + diffuse_saturation (matches original)
//   * ambient only fires when backscatter didn't already populate mat.emissive
//   * edginess reads mat.sheen set earlier in this helper
//   * fresnel reads specularIntensity set by mapPbrScalars / this helper's `specular`
//   * refractive_index_outside recomputes ior+specularIntensity from mapPbrScalars' values
function mapMisc(mat, a) {
  const { getFloat, getColor, getColorRaw, getInt } = a

  const sheen = getFloat('sheen', 'fuzz')
  if (sheen !== null) mat.sheen = clamp01(sheen)

  const sheenRoughness = getFloat('sheen_roughness', 'fuzz_roughness')
  if (sheenRoughness !== null) mat.sheenRoughness = clamp01(sheenRoughness)

  const emissiveIntensity = getFloat('emissive_intensity', 'emission_luminance', 'luminance')
  if (emissiveIntensity !== null) mat.emissiveIntensity = emissiveIntensity

  const specular = getFloat('specular', 'specular_weight')
  if (specular !== null) mat.specularIntensity = Math.max(0, specular)

  const specularTint = getFloat('specular_tint')
  if (specularTint !== null && specularTint > 0) {
    const [br, bg, bb] = hexToComponents(mat.color)
    const t = clamp01(specularTint)
    mat.specularColor = rgbToHex(lerp(1, br, t), lerp(1, bg, t), lerp(1, bb, t))
  }

  const colorFilter = getColor('color_filter')
  if (colorFilter) {
    const [br, bg, bb] = hexToComponents(mat.color)
    const [fr, fg, fb] = hexToComponents(colorFilter)
    mat.color = componentsToHex(br * fr, bg * fg, bb * fb)
  }

  const bumpIntensity = getFloat('bump_intensity', 'normal_scale', 'bump')
  if (bumpIntensity !== null) { mat.normalScaleX = bumpIntensity; mat.normalScaleY = bumpIntensity }

  const displacementScale = getFloat('displacement_scale', 'height_scale')
  if (displacementScale !== null) mat.displacementScale = displacementScale

  const dispersion = getFloat('dispersion')
  const abbeNumber = getFloat('abbe_number')
  if (dispersion !== null) mat.dispersion = dispersion
  else if (abbeNumber !== null && abbeNumber > 0) mat.dispersion = 1.0 / abbeNumber

  const roughnessTransmission = getFloat('roughness_transmission')
  if (roughnessTransmission !== null && mat.transmission > 0.5) {
    mat.roughness = lerp(mat.roughness, clamp01(roughnessTransmission), mat.transmission)
  }

  const diffuseSaturation = getFloat('diffuse_saturation')
  if (diffuseSaturation !== null && diffuseSaturation > 1.0) {
    const [cr, cg, cb] = hexToComponents(mat.color)
    const gray = (cr + cg + cb) / 3
    const sat = Math.min(diffuseSaturation, 3.0)
    mat.color = rgbToHex(
      clamp01(gray + (cr - gray) * sat),
      clamp01(gray + (cg - gray) * sat),
      clamp01(gray + (cb - gray) * sat),
    )
  }

  const alpha = getColorRaw('alpha')
  if (alpha) {
    const avg = (alpha.r + alpha.g + alpha.b) / 3
    if (avg < 0.99) { mat.opacity = clamp01(avg); mat.transparent = true }
  }

  const emissive = getColor('emissive', 'emission', 'emissive_color')
  if (emissive) mat.emissive = emissive

  const specularColor = getColor('specular_color', 'reflection_color')
  if (specularColor) mat.specularColor = specularColor
  else {
    const specAsColor = getColor('specular')
    if (specAsColor) mat.specularColor = specAsColor
  }

  const sheenColor = getColor('sheen_color', 'fuzz_color', 'sheen')
  if (sheenColor) mat.sheenColor = sheenColor

  const sheenTintVal = getFloat('sheen_tint')
  if (sheenTintVal !== null && sheenTintVal > 0 && mat.sheen > 0) {
    const [br, bg, bb] = hexToComponents(mat.color)
    const t = clamp01(sheenTintVal)
    mat.sheenColor = rgbToHex(lerp(1, br, t), lerp(1, bg, t), lerp(1, bb, t))
  }

  const backscatter = getColor('backscatter')
  if (backscatter) { mat.emissive = backscatter; mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 0.05) }

  const ambient = getColor('ambient')
  if (ambient && mat.emissive === '#000000') { mat.emissive = ambient; mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 0.02) }

  const edginess = getFloat('edginess')
  if (edginess !== null && mat.sheen > 0) mat.sheenRoughness = clamp01(1.0 - edginess)

  const fresnelToggle = getInt('fresnel')
  if (fresnelToggle !== null && fresnelToggle === 0) mat.specularIntensity = Math.max(mat.specularIntensity, 0.5)

  const iorOutside = getFloat('refractive_index_outside')
  if (iorOutside !== null && iorOutside > 0 && mat.ior > 0) {
    const effectiveIor = mat.ior / iorOutside
    mat.ior = Math.max(1.0, Math.min(effectiveIor, 5.0))
    const f0 = Math.pow((effectiveIor - 1) / (effectiveIor + 1), 2)
    mat.specularIntensity = Math.min(f0 / 0.04, 2.0)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Optional user-supplied shader-type overrides (ProcessOptions.shaderTypeOverrides).
// Selection: exact key match on `type` wins; otherwise the longest substring
// match wins (longest so more specific keys like 'metallic_paint' beat 'paint').
// If a handler throws, the error is captured as a warning and the built-in
// mapping runs as fallback — overrides never crash the pipeline.
// ────────────────────────────────────────────────────────────────────────────
function applyOverrideMapping(mat, a, type, overrides, warnings) {
  if (!overrides || !type) return false
  const keys = Object.keys(overrides)
  if (keys.length === 0) return false

  let selectedKey = null
  if (Object.prototype.hasOwnProperty.call(overrides, type)) {
    selectedKey = type
  } else {
    let bestLen = 0
    for (const k of keys) {
      const kl = k.toLowerCase()
      if (kl.length > 0 && type.includes(kl) && kl.length > bestLen) {
        selectedKey = k
        bestLen = kl.length
      }
    }
  }
  if (selectedKey === null) return false

  const handler = overrides[selectedKey]
  if (typeof handler !== 'function') {
    warnings.push(`shaderTypeOverrides["${selectedKey}"] is not a function; skipped`)
    return false
  }
  try {
    handler(mat, a.byName, a)
    return true
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    warnings.push(`shaderTypeOverrides["${selectedKey}"] threw: ${msg}`)
    return false
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Shader-type-specific mapping. Evidence: kmp-pipeline.mjs:1316-1790,
// extract-kmp-exact.mjs:481-697.
//
// Dispatch is table-driven (first-match-wins). SHADER_RULES order IS
// semantics — more-specific rules MUST precede less-specific ones. Each rule
// is `{ id, canonical, match, apply? }`; the dispatcher assigns
// `mat.kmpShaderType = rule.canonical`, then invokes `rule.apply` (if any) to
// populate per-shader side effects.
//
// Note on `metallic_*` naming: any shader whose name contains "metal" but is
// not plain metal must be listed BEFORE the `metal` rule with its own
// matcher. Today, `metallic_paint` / `car_paint` are the only such variants;
// both are captured by the `metallic_paint` rule. A future `metallic_X` that
// should not route to `lux_metal` must add its own rule above `metal` — do
// not rely on substring guards in the `metal` matcher.
// ────────────────────────────────────────────────────────────────────────────

function applyToon(mat, a, type) {
  const { getFloat, getColorRaw, getColorOrScalar, getAnyScalar, getBoolFlex } = a
  mat.roughness = 1.0
  mat.metalness = 0.0
  mat.specularIntensity = 0.0

  // KeyShot toon params frequently store "color" fields as a texslot binding
  // to a sub-shader color slot PLUS a fallback scalar float (e.g. 1.0 for a
  // white contour, 43.29 for an HDR-gray shadow tint). When the sub-shader
  // region is not populated the scalar is the authoritative colour; we use
  // getColorOrScalar so those bare scalars expand to {r,s,g,s,b,s} instead
  // of silently falling through to the [0,0,0] default.
  const fill = getColorOrScalar(type) ?? getColorOrScalar('color', 'diffuse')
  const alpha = getColorRaw('alpha')
  const shadow = getColorOrScalar('shadow color')
  const contour = getColorOrScalar('contour color')
  const shadowStr = getColorOrScalar('shadow strength')

  if (alpha) {
    const avg = (alpha.r + alpha.g + alpha.b) / 3
    if (avg < 0.99) { mat.opacity = clamp01(avg); mat.transparent = true }
  }
  const transparency = getBoolFlex('transparency') ?? false
  if (transparency) mat.transparent = true
  if (fill) mat.color = rgbToHex(fill.r, fill.g, fill.b)

  mat.toonParams = {
    fillColor: fill ? [fill.r, fill.g, fill.b] : [0, 0, 0],
    shadowColor: shadow ? [shadow.r, shadow.g, shadow.b] : [0, 0, 0],
    shadowMultiplier: getFloat('shadow multiplier') ?? 1.0,
    shadowStrength: shadowStr ? [shadowStr.r, shadowStr.g, shadowStr.b] : [1, 1, 1],
    contourColor: contour ? [contour.r, contour.g, contour.b] : [0, 0, 0],
    contourAngle: getFloat('contour angle') ?? 60.0,
    // KeyShot stores "contour width" as an INT (observed value 2 in DEFCAD
    // STANDARD TOON.kmp). Use getAnyScalar so int/float/bool all map.
    contourWidth: getAnyScalar('contour width') ?? 1.0,
    contourQuality: getFloat('contour quality') ?? 1.0,
    contourWidthInPixels: getBoolFlex('contour width is in pixels') ?? false,
    outlineWidthMultiplier: getAnyScalar('outline width multiplier') ?? 1.0,
    partWidthMultiplier: getAnyScalar('part width multiplier') ?? 1.0,
    outlineContour: getBoolFlex('outline contour') ?? false,
    materialContour: getBoolFlex('material contour') ?? false,
    partContour: getBoolFlex('part contour') ?? false,
    interiorEdgeContour: getBoolFlex('interior edge contour') ?? false,
    environmentShadows: getBoolFlex('environment shadows') ?? false,
    lightSourceShadows: getBoolFlex('light source shadows') ?? false,
    transparency,
  }
}

function applyMetallicPaint(mat, a, type) {
  const { getFloat, getColorRaw, getInt } = a
  const paintIor = getFloat('ior', 'refractive_index', 'clearcoat_ior', 'clearcoat_refractive_index')
  const ccVal = getFloat('clearcoat', 'clear_coat')
  if (ccVal !== null && ccVal > 0) {
    mat.clearcoat = clamp01(ccVal)
    if (mat.clearcoatRoughness === 0) mat.clearcoatRoughness = 0.03
    const effectiveIor = (paintIor !== null && paintIor >= 1.0) ? paintIor : 1.5
    if (effectiveIor !== 1.5) {
      const ccF0 = Math.pow((effectiveIor - 1) / (effectiveIor + 1), 2)
      const defaultCcF0 = Math.pow((1.5 - 1) / (1.5 + 1), 2)
      mat.clearcoat = clamp01(mat.clearcoat * Math.min(ccF0 / defaultCcF0, 3.0))
    }
  } else if (paintIor !== null && paintIor <= 0) {
    mat.clearcoat = 0.0
  } else {
    mat.clearcoat = 1.0
    if (mat.clearcoatRoughness === 0) mat.clearcoatRoughness = 0.03
    if (paintIor !== null && paintIor >= 1.0) {
      const ccF0 = Math.pow((paintIor - 1) / (paintIor + 1), 2)
      const defaultCcF0 = Math.pow((1.5 - 1) / (1.5 + 1), 2)
      mat.clearcoat = clamp01(mat.clearcoat * Math.min(ccF0 / defaultCcF0, 3.0))
    }
  }

  const thicknessMulRaw = getColorRaw('thickness multiplier')
  const metalCoverage = getFloat('metal_coverage') ?? 0
  const metalRoughnessRaw = getFloat('metal_roughness')
  const metalRoughnessVal = metalRoughnessRaw ?? 0.3
  const flakeVisIntRaw = getInt('metal_flake_visibility')
  const flakeVisFloat = getFloat('metal_flake_visibility')
  const metalVisibility = flakeVisIntRaw !== null ? Math.min(flakeVisIntRaw / 16.0, 1.0) : 1.0
  const metalFlakeVis = flakeVisFloat !== null ? flakeVisFloat : metalVisibility

  if (metalCoverage > 0) {
    const baseMetal = metalCoverage <= 1.0 ? metalCoverage * 0.7 : 0.7 + Math.min((metalCoverage - 1.0) / 2.0, 0.3)
    mat.metalness = clamp01(baseMetal * clamp01(metalVisibility))
  }

  const metalColorRaw = getColorRaw('metal_color')
  if (metalColorRaw) mat.specularColor = rgbToHex(metalColorRaw.r, metalColorRaw.g, metalColorRaw.b)
  else if (thicknessMulRaw) mat.specularColor = rgbToHex(thicknessMulRaw.r, thicknessMulRaw.g, thicknessMulRaw.b)

  if (metalRoughnessRaw !== null && metalCoverage > 0.3) {
    const blendFactor = Math.min(metalCoverage / 1.5, 1.0)
    mat.roughness = lerp(mat.roughness, clamp01(metalRoughnessRaw), blendFactor)
  }

  if (thicknessMulRaw) {
    mat.attenuationColor = rgbToHex(thicknessMulRaw.r, thicknessMulRaw.g, thicknessMulRaw.b)
    mat.attenuationDistance = 0.5
  }

  const clearcoatColor = getColorRaw('clearcoat_color', 'coat_color')
  if (clearcoatColor) {
    const avg = (clearcoatColor.r + clearcoatColor.g + clearcoatColor.b) / 3
    if (avg < 0.95) {
      const [sr, sg, sb] = hexToComponents(mat.specularColor)
      mat.specularColor = rgbToHex(sr * clearcoatColor.r, sg * clearcoatColor.g, sb * clearcoatColor.b)
    }
  }

  mat.envMapIntensity = Math.max(mat.envMapIntensity, 1.2)
  mat.ior = 1.5
  if (paintIor !== null && paintIor <= 0) mat.specularIntensity = 1.0

  const baseColorRaw = a.byName[type]?.type === 'color' ? a.byName[type].value : (getColorRaw('diffuse', 'surface_color'))
  const metalFlakeSize = getFloat('metal_flake_size', 'flake_size') ?? 2.0
  const metalSamples = getInt('metal_samples') ?? 8

  mat.carpaintParams = {
    baseColor: baseColorRaw ? [baseColorRaw.r, baseColorRaw.g, baseColorRaw.b] : [0.5, 0.3, 0.1],
    metalLayerVisibility: metalCoverage > 0 ? clamp01(metalFlakeVis) : 0,
    clearcoatIOR: (paintIor !== null && paintIor >= 1.0) ? paintIor : 1.5,
    clearcoatAbsorptionColor: thicknessMulRaw ? [thicknessMulRaw.r, thicknessMulRaw.g, thicknessMulRaw.b] : [1, 1, 1],
    metalSamples,
    metalCoverage,
    metalRoughness: metalRoughnessVal,
    metalFlakeSize,
    metalFlakeVisibility: metalFlakeVis,
  }

  const density = clamp01(0.3 + metalCoverage * 0.3)
  const intensity = clamp01(0.05 + (1 - metalRoughnessVal) * 0.15)
  const flakeSize = getFloat('flake_size')
  mat.metalFlakeParams = {
    resolution: 512,
    flakeSize: flakeSize != null ? Math.max(1, Math.round(flakeSize)) : 2,
    flakeIntensity: intensity,
    flakeDensity: density,
    seed: 42,
  }
}

function applyTranslucentMedium(mat) {
  mat.transmission = 0.9
  mat.attenuationDistance = 0.5
  mat.transparent = true
}

function applyScatteringMedium(mat) {
  mat.transmission = 0.7
  mat.attenuationDistance = 0.3
  mat.transparent = true
}

function applyTranslucentSss(mat, a, _type, subShaderColors) {
  const { getFloat, getColorRaw } = a
  if (a.byName['transmission'] === undefined && a.byName['transparency'] === undefined) mat.transmission = 0.5
  if (mat.attenuationDistance === 0) mat.attenuationDistance = 0.5

  let sssSubsurfaceColor = getColorRaw('translucency', 'subsurface_color', 'sss_color')
  const sssTransmissionColor = getColorRaw('transmission_color', 'transmission', 'attenuation_color')
  const sssSpecularColorRaw = getColorRaw('specular_color', 'reflection_color')
  const sssSpecularity = getColorRaw('specularity')

  const sssIorR = getFloat('ior') ?? 1.5
  const sssIorColor = getColorRaw('ior')
  const sssIorChannels = sssIorColor
    ? [sssIorColor.r, sssIorColor.g, sssIorColor.b]
    : [sssIorR, sssIorR, sssIorR]

  const sssDiffuseWeight = getFloat('diffuse', 'diffuse_weight') ?? 0.5
  const sssDispersion = getFloat('dispersion') ?? 0.0

  // Fall back to the first sub-shader color slot if SSS color is absent.
  if (!sssSubsurfaceColor && subShaderColors && subShaderColors.size > 0) {
    const first = subShaderColors.values().next().value
    if (first) sssSubsurfaceColor = first
  }

  mat.sssParams = {
    subsurfaceColor: sssSubsurfaceColor
      ? [sssSubsurfaceColor.r, sssSubsurfaceColor.g, sssSubsurfaceColor.b]
      : [1, 0.9, 0.8],
    subsurfaceRadius: sssDiffuseWeight * 0.5,
    iorChannels: sssIorChannels,
    diffuseWeight: sssDiffuseWeight,
    transmissionColor: sssTransmissionColor ? [sssTransmissionColor.r, sssTransmissionColor.g, sssTransmissionColor.b] : [1, 1, 1],
    specularColor: sssSpecularColorRaw ? [sssSpecularColorRaw.r, sssSpecularColorRaw.g, sssSpecularColorRaw.b] : [1, 1, 1],
    specularity: sssSpecularity ? [sssSpecularity.r, sssSpecularity.g, sssSpecularity.b] : [1, 1, 1],
    dispersion: sssDispersion,
  }
  if (sssSubsurfaceColor) {
    mat.attenuationColor = rgbToHex(sssSubsurfaceColor.r, sssSubsurfaceColor.g, sssSubsurfaceColor.b)
  }
  mat.transparent = true
  mat.side = 'double'
}

function applyDiamond(mat, a) {
  const { getFloat } = a
  mat.transmission = 1.0
  mat.ior = 2.42
  if (mat.roughness > 0.1) mat.roughness = 0.05
  mat.gemParams = {
    dispersionStrength: getFloat('dispersion_strength') ?? (mat.dispersion > 0 ? mat.dispersion : 0.04),
    brilliance: getFloat('brilliance') ?? 1.0,
    fireIntensity: getFloat('fire_intensity') ?? 0.8,
  }
}

function applyGem(mat, a) {
  const { getFloat } = a
  mat.transmission = 1.0
  if (mat.ior === 1.5) mat.ior = 1.76
  if (mat.roughness > 0.1) mat.roughness = 0.05
  mat.gemParams = {
    dispersionStrength: getFloat('dispersion_strength') ?? (mat.dispersion > 0 ? mat.dispersion : 0.02),
    brilliance: getFloat('brilliance') ?? 0.8,
    fireIntensity: getFloat('fire_intensity') ?? 0.5,
  }
}

function applyLiquidLike(mat, a, iorDefault) {
  const { getFloat, getColorRaw } = a
  mat.transmission = 1.0
  if (mat.roughness > 0.1) mat.roughness = 0.05
  if (mat.ior === 1.5) mat.ior = iorDefault
  const absorptionColor = getColorRaw('absorption_color', 'attenuation_color')
  mat.glassParams = {
    absorptionColor: absorptionColor
      ? [absorptionColor.r, absorptionColor.g, absorptionColor.b]
      : hexToComponents(mat.attenuationColor),
    absorptionDistance: getFloat('absorption_distance') ?? mat.attenuationDistance ?? 0,
    chromaticAberration: getFloat('chromatic_aberration') ?? mat.dispersion ?? 0,
  }
}

function applyDielectric(mat) {
  if (mat.transmission === 0) mat.transmission = 0.5
  if (mat.ior === 1.5) mat.ior = 1.5
}

function applyPlasticCloudy(mat) {
  mat.transmission = 0.3
  mat.attenuationDistance = mat.attenuationDistance || 0.5
  mat.roughness = Math.max(mat.roughness, 0.35)
}

function applyPlasticTransparent(mat) {
  mat.transmission = 0.8
  mat.roughness = 0.1
  if (mat.ior === 1.5) mat.ior = 1.45
}

function applyPlastic(mat) {
  mat.transmission = 0.2
  mat.roughness = Math.max(mat.roughness, 0.15)
}

function applyMetalLike(mat) {
  mat.metalness = 1.0
  if (mat.roughness === 0.5) mat.roughness = 0.2
  mat.envMapIntensity = Math.max(mat.envMapIntensity, 1.5)
}

function applyPaintNonMetal(mat) {
  if (mat.clearcoat === 0) mat.clearcoat = 0.3
  if (mat.clearcoatRoughness === 0) mat.clearcoatRoughness = 0.03
  if (mat.roughness === 0.5) mat.roughness = 0.4
}

function applyFabricLike(mat, a) {
  const { getFloat, getColorRaw } = a
  mat.sheen = 1.0
  if (mat.sheenColor === '#ffffff') {
    const sc = getColorRaw('sheen_color', 'fuzz_color')
    if (sc) mat.sheenColor = rgbToHex(sc.r, sc.g, sc.b)
  }
  const sc = getColorRaw('sheen_color', 'fuzz_color')
  mat.velvetParams = {
    sheenColor: sc ? [sc.r, sc.g, sc.b] : hexToComponents(mat.sheenColor),
    sheenIntensity: getFloat('sheen_intensity', 'sheen', 'fuzz') ?? 1.0,
    fuzzAmount: getFloat('fuzz_amount', 'fuzz') ?? 0.5,
  }
}

function applyThinFilm(mat) {
  if (mat.iridescence === 0) mat.iridescence = 1.0
  if (mat.iridescenceIOR === 1.3) mat.iridescenceIOR = 1.5
}

function applyAnisotropic(mat, a) {
  const { getFloat } = a
  mat.metalness = 1.0
  const rx = getFloat('roughness_x')
  const ry = getFloat('roughness_y')
  const anisoAngle = getFloat('angle')
  const rot = getFloat('anisotropy_rotation') ?? (anisoAngle !== null ? (anisoAngle * Math.PI) / 180 : 0)
  mat.anisotropicParams = {
    roughnessX: rx ?? mat.roughness,
    roughnessY: ry ?? mat.roughness,
    rotationAngle: rot,
  }
}

function applyEmissive(mat) {
  mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 1.0)
  if (mat.emissive === '#000000') mat.emissive = mat.color
}

function applyFlat(mat) {
  mat.roughness = 1.0
  mat.metalness = 0.0
}

function applyMatteLike(mat) {
  mat.roughness = 1.0
  mat.metalness = 0.0
}

function applyGlossy(mat) {
  if (mat.roughness === 0.5) mat.roughness = 0.1
}

function applyRubberLike(mat) {
  if (mat.roughness === 0.5) mat.roughness = 0.8
}

function applyCeramicLike(mat) {
  if (mat.clearcoat === 0) mat.clearcoat = 1.0
  if (mat.clearcoatRoughness === 0) mat.clearcoatRoughness = 0.05
  if (mat.roughness === 0.5) mat.roughness = 0.3
}

function applyLeather(mat) {
  if (mat.roughness === 0.5) mat.roughness = 0.7
}

function applyXray(mat) {
  mat.transmission = 1.0
  mat.ior = 1.0
}

function applyWireframe(mat) {
  mat.wireframe = true
}

function applySkin(mat) {
  if (mat.transmission === 0) mat.transmission = 0.1
  mat.attenuationDistance = mat.attenuationDistance || 0.3
  mat.roughness = Math.max(mat.roughness, 0.5)
}

// First-match-wins dispatch table. Rule order encodes precedence. See
// header comment for invariants — in particular, metallic-variant rules
// MUST precede the `metal` rule.
const SHADER_RULES = [
  { id: 'toon',                canonical: 'lux_toon',                match: t => t.includes('toon'),                                                          apply: applyToon },
  { id: 'metallic_paint',      canonical: 'metallic_paint',          match: t => t.includes('metallic_paint') || t.includes('car_paint'),                     apply: applyMetallicPaint },
  { id: 'translucent_medium',  canonical: 'lux_translucent_medium',  match: t => t.includes('translucent') && t.includes('medium'),                           apply: applyTranslucentMedium },
  { id: 'scattering_medium',   canonical: 'lux_scattering_medium',   match: t => t.includes('scattering') && t.includes('medium'),                            apply: applyScatteringMedium },
  { id: 'translucent_sss',     canonical: 'lux_translucent',         match: t => t.includes('translucent') || t.includes('sss'),                              apply: applyTranslucentSss },
  { id: 'diamond',             canonical: 'lux_diamond',             match: t => t.includes('diamond'),                                                        apply: applyDiamond },
  { id: 'gem',                 canonical: 'lux_gem',                 match: t => t.includes('gem'),                                                            apply: applyGem },
  { id: 'liquid',              canonical: 'lux_liquid',              match: t => t.includes('liquid'),                                                         apply: (mat, a) => applyLiquidLike(mat, a, 1.33) },
  { id: 'glass',               canonical: 'lux_glass',               match: t => t.includes('glass'),                                                          apply: (mat, a) => applyLiquidLike(mat, a, 1.52) },
  { id: 'dielectric',          canonical: 'lux_dielectric',          match: t => t.includes('dielectric'),                                                     apply: applyDielectric },
  { id: 'plastic_cloudy',      canonical: 'lux_plastic_cloudy',      match: t => t.includes('plastic') && t.includes('cloudy'),                                apply: applyPlasticCloudy },
  { id: 'plastic_transparent', canonical: 'lux_plastic_transparent', match: t => t.includes('plastic') && t.includes('transparent'),                           apply: applyPlasticTransparent },
  { id: 'plastic',             canonical: 'lux_plastic',             match: t => t.includes('plastic'),                                                        apply: applyPlastic },
  { id: 'brushed_metal',       canonical: 'lux_brushed_metal',       match: t => t.includes('brushed_metal'),                                                  apply: applyMetalLike },
  { id: 'metal',               canonical: 'lux_metal',               match: t => t.includes('metal') && !t.includes('paint'),                                  apply: applyMetalLike },
  { id: 'paint',               canonical: 'lux_paint',               match: t => t.includes('paint') && !t.includes('metal'),                                  apply: applyPaintNonMetal },
  { id: 'velvet',              canonical: 'lux_velvet',              match: t => t.includes('velvet'),                                                         apply: applyFabricLike },
  { id: 'cloth',               canonical: 'lux_cloth',               match: t => t.includes('fabric') || t.includes('cloth') || t.includes('realcloth'),       apply: applyFabricLike },
  { id: 'thin_film',           canonical: 'lux_thin_film',           match: t => t.includes('thin_film') || t.includes('thin film'),                           apply: applyThinFilm },
  { id: 'anisotropic',         canonical: 'lux_anisotropic',         match: t => t.includes('anisotropic'),                                                    apply: applyAnisotropic },
  { id: 'multi_layer',         canonical: 'lux_multi_layer',         match: t => t.includes('multi_layer') || t.includes('multi-layer') || t.includes('multilayer') },
  { id: 'generic',             canonical: 'lux_generic',             match: t => t.includes('generic') },
  { id: 'advanced',            canonical: 'lux_advanced',            match: t => t.includes('advanced') },
  { id: 'emissive',            canonical: 'lux_emissive',            match: t => t.includes('emissive'),                                                       apply: applyEmissive },
  { id: 'flat',                canonical: 'lux_flat',                match: t => t.includes('flat'),                                                           apply: applyFlat },
  { id: 'matte',               canonical: 'lux_matte',               match: t => t.includes('matte'),                                                          apply: applyMatteLike },
  { id: 'diffuse',             canonical: 'lux_diffuse',             match: t => t.includes('diffuse'),                                                        apply: applyMatteLike },
  { id: 'glossy',              canonical: 'lux_glossy',              match: t => t.includes('glossy'),                                                         apply: applyGlossy },
  { id: 'silicone',            canonical: 'lux_silicone',            match: t => t.includes('silicone'),                                                       apply: applyRubberLike },
  { id: 'rubber',              canonical: 'lux_rubber',              match: t => t.includes('rubber'),                                                         apply: applyRubberLike },
  { id: 'porcelain',           canonical: 'lux_porcelain',           match: t => t.includes('porcelain'),                                                      apply: applyCeramicLike },
  { id: 'ceramic',             canonical: 'lux_ceramic',             match: t => t.includes('ceramic'),                                                        apply: applyCeramicLike },
  { id: 'leather',             canonical: 'lux_leather',             match: t => t.includes('leather'),                                                        apply: applyLeather },
  { id: 'measured',            canonical: 'lux_measured',            match: t => t.includes('axalta') || t.includes('measured') },
  { id: 'xray',                canonical: 'lux_xray',                match: t => t.includes('xray') || t.includes('x_ray'),                                    apply: applyXray },
  { id: 'wireframe',           canonical: 'lux_wireframe',           match: t => t.includes('wireframe'),                                                      apply: applyWireframe },
  { id: 'skin',                canonical: 'lux_skin',                match: t => t.includes('skin'),                                                           apply: applySkin },
  { id: 'cutaway',             canonical: 'lux_cutaway',             match: t => t.includes('cutaway') },
]

function applyShaderTypeMapping(mat, a, type, subShaderColors) {
  if (!type) return
  for (const rule of SHADER_RULES) {
    if (rule.match(type)) {
      mat.kmpShaderType = rule.canonical
      if (rule.apply) rule.apply(mat, a, type, subShaderColors)
      return
    }
  }
}

export { SHADER_RULES }

// ────────────────────────────────────────────────────────────────────────────
// Post-mapping — final fallbacks that depend on the full material state.
// Evidence: kmp-pipeline.mjs:1775-1790, extract-kmp-exact.mjs:693-697.
// ────────────────────────────────────────────────────────────────────────────
function applyPostMapping(mat, a, subShaderColors) {
  const { getColorRaw } = a
  const sssColor = getColorRaw('subsurface_color', 'sss_color')
  if (sssColor && mat.attenuationColor === '#ffffff') {
    mat.attenuationColor = rgbToHex(sssColor.r, sssColor.g, sssColor.b)
    return
  }
  // Final sub-shader fallback: materials flagged translucent (transmission > 0)
  // whose shader-type rule never fired applyTranslucentSss still need a
  // meaningful attenuation colour. Pull it from the first sub-shader colour
  // slot when no explicit sss/subsurface param is present. Gated on transmission
  // so opaque materials' sub-shader palettes never leak into attenuation.
  if (
    mat.attenuationColor === '#ffffff'
    && mat.transmission > 0
    && subShaderColors
    && subShaderColors.size > 0
  ) {
    const first = subShaderColors.values().next().value
    if (first) mat.attenuationColor = rgbToHex(first.r, first.g, first.b)
  }
}
