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
  'diffuse_weight',
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
const STRUCTURAL_KEYS = new Set([
  'lux_const_color_extended', 'color', 'flags',
])

export function buildMaterialDefinition(rawParams, shaderType, subShaderColors) {
  const a = makeAccessors(rawParams)
  const mat = createDefaultMaterialDefinition()
  const warnings = []
  const type = (shaderType || '').toLowerCase()

  applyGenericMapping(mat, a, shaderType)
  applyShaderTypeMapping(mat, a, type, subShaderColors)
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
// ────────────────────────────────────────────────────────────────────────────
function applyGenericMapping(mat, a, shaderType) {
  const { getFloat, getColor, getColorRaw, getInt } = a

  // Base diffuse color.
  if (shaderType && a.byName[shaderType]?.type === 'color') {
    mat.color = getColor(shaderType)
  }
  const diffuseColor = getColor('diffuse', 'surface_color')
  if (diffuseColor && (!shaderType || !a.byName[shaderType] || a.byName[shaderType]?.type !== 'color')) {
    mat.color = diffuseColor
  }

  // Base weight.
  const baseWeight = getFloat('base')
  if (baseWeight !== null && baseWeight < 1.0 && baseWeight >= 0) {
    const [cr, cg, cb] = hexToComponents(mat.color)
    mat.color = componentsToHex(cr * baseWeight, cg * baseWeight, cb * baseWeight)
  }

  // PBR scalars.
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

  const sheen = getFloat('sheen', 'fuzz')
  if (sheen !== null) mat.sheen = clamp01(sheen)

  const sheenRoughness = getFloat('sheen_roughness', 'fuzz_roughness')
  if (sheenRoughness !== null) mat.sheenRoughness = clamp01(sheenRoughness)

  // Anisotropy.
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

  // Iridescence.
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

  // Color params.
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

  const attenuationColor = getColor('attenuation_color', 'transmission_color', 'subsurface_color', 'transmission')
  if (attenuationColor) mat.attenuationColor = attenuationColor

  const transmissionOut = getColor('transmission_out')
  if (transmissionOut && mat.attenuationColor === '#ffffff') mat.attenuationColor = transmissionOut

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

  const attenuationDistance = getFloat('attenuation_distance', 'subsurface_radius', 'translucency')
  if (attenuationDistance !== null && attenuationDistance > 0) mat.attenuationDistance = attenuationDistance

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
// Shader-type-specific mapping. Evidence: kmp-pipeline.mjs:1316-1790,
// extract-kmp-exact.mjs:481-697.
// ────────────────────────────────────────────────────────────────────────────
function applyShaderTypeMapping(mat, a, type, subShaderColors) {
  if (!type) return
  const { getFloat, getColor, getColorRaw, getInt, getBoolFlex } = a

  if (type.includes('toon')) {
    mat.roughness = 1.0
    mat.metalness = 0.0
    mat.specularIntensity = 0.0

    const fill = getColorRaw(type) ?? getColorRaw('color', 'diffuse')
    const alpha = getColorRaw('alpha')
    const shadow = getColorRaw('shadow color')
    const contour = getColorRaw('contour color')
    const shadowStr = getColorRaw('shadow strength')

    if (alpha) {
      const avg = (alpha.r + alpha.g + alpha.b) / 3
      if (avg < 0.99) { mat.opacity = clamp01(avg); mat.transparent = true }
    }
    const transparency = getBoolFlex('transparency') ?? false
    if (transparency) mat.transparent = true
    if (fill) mat.color = rgbToHex(fill.r, fill.g, fill.b)

    mat.kmpShaderType = 'lux_toon'
    mat.toonParams = {
      fillColor: fill ? [fill.r, fill.g, fill.b] : [0, 0, 0],
      shadowColor: shadow ? [shadow.r, shadow.g, shadow.b] : [0, 0, 0],
      shadowMultiplier: getFloat('shadow multiplier') ?? 1.0,
      shadowStrength: shadowStr ? [shadowStr.r, shadowStr.g, shadowStr.b] : [1, 1, 1],
      contourColor: contour ? [contour.r, contour.g, contour.b] : [0, 0, 0],
      contourAngle: getFloat('contour angle') ?? 60.0,
      contourWidth: getFloat('contour width') ?? 1.0,
      contourQuality: getFloat('contour quality') ?? 1.0,
      contourWidthInPixels: getBoolFlex('contour width is in pixels') ?? false,
      outlineWidthMultiplier: getFloat('outline width multiplier') ?? 1.0,
      partWidthMultiplier: getFloat('part width multiplier') ?? 1.0,
      outlineContour: getBoolFlex('outline contour') ?? false,
      materialContour: getBoolFlex('material contour') ?? false,
      partContour: getBoolFlex('part contour') ?? false,
      interiorEdgeContour: getBoolFlex('interior edge contour') ?? false,
      environmentShadows: getBoolFlex('environment shadows') ?? false,
      lightSourceShadows: getBoolFlex('light source shadows') ?? false,
      transparency,
    }
    return
  }

  if (type.includes('metallic_paint') || type.includes('car_paint')) {
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
    const flakeVisInt = getInt('metal_flake_visibility') ?? 16
    const metalVisibility = Math.min(flakeVisInt / 16.0, 1.0)
    if (metalCoverage > 0) {
      const baseMetal = metalCoverage <= 1.0 ? metalCoverage * 0.7 : 0.7 + Math.min((metalCoverage - 1.0) / 2.0, 0.3)
      mat.metalness = clamp01(baseMetal * clamp01(metalVisibility))
    }

    const metalColorRaw = getColorRaw('metal_color')
    if (metalColorRaw) mat.specularColor = rgbToHex(metalColorRaw.r, metalColorRaw.g, metalColorRaw.b)
    else if (thicknessMulRaw) mat.specularColor = rgbToHex(thicknessMulRaw.r, thicknessMulRaw.g, thicknessMulRaw.b)

    const metalRoughness = getFloat('metal_roughness')
    if (metalRoughness !== null && metalCoverage > 0.3) {
      const blendFactor = Math.min(metalCoverage / 1.5, 1.0)
      mat.roughness = lerp(mat.roughness, clamp01(metalRoughness), blendFactor)
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
    const metalRoughnessVal = getFloat('metal_roughness') ?? 0.3
    const metalCoverageVal = getFloat('metal_coverage') ?? 0.0
    const flakeVisFloat = getFloat('metal_flake_visibility')
    const flakeVisIntAgain = getInt('metal_flake_visibility')
    const metalFlakeVis = flakeVisFloat !== null
      ? flakeVisFloat
      : (flakeVisIntAgain !== null ? Math.min(flakeVisIntAgain / 16.0, 1.0) : 1.0)

    mat.kmpShaderType = 'metallic_paint'
    mat.carpaintParams = {
      baseColor: baseColorRaw ? [baseColorRaw.r, baseColorRaw.g, baseColorRaw.b] : [0.5, 0.3, 0.1],
      metalLayerVisibility: metalCoverageVal > 0 ? clamp01(metalFlakeVis) : 0,
      clearcoatIOR: (paintIor !== null && paintIor >= 1.0) ? paintIor : 1.5,
      clearcoatAbsorptionColor: thicknessMulRaw ? [thicknessMulRaw.r, thicknessMulRaw.g, thicknessMulRaw.b] : [1, 1, 1],
      metalSamples,
      metalCoverage: metalCoverageVal,
      metalRoughness: metalRoughnessVal,
      metalFlakeSize,
      metalFlakeVisibility: metalFlakeVis,
    }

    const density = clamp01(0.3 + metalCoverageVal * 0.3)
    const intensity = clamp01(0.05 + (1 - metalRoughnessVal) * 0.15)
    const flakeSize = getFloat('flake_size')
    mat.metalFlakeParams = {
      resolution: 512,
      flakeSize: flakeSize != null ? Math.max(1, Math.round(flakeSize)) : 2,
      flakeIntensity: intensity,
      flakeDensity: density,
      seed: 42,
    }
    return
  }

  if (type.includes('translucent') && type.includes('medium')) {
    mat.transmission = 0.9
    mat.attenuationDistance = 0.5
    mat.kmpShaderType = 'lux_translucent_medium'
    mat.transparent = true
    return
  }
  if (type.includes('scattering') && type.includes('medium')) {
    mat.transmission = 0.7
    mat.attenuationDistance = 0.3
    mat.kmpShaderType = 'lux_scattering_medium'
    mat.transparent = true
    return
  }

  if (type.includes('translucent') || type.includes('sss')) {
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

    mat.kmpShaderType = 'lux_translucent'
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
    return
  }

  if (type.includes('diamond')) {
    mat.transmission = 1.0
    mat.ior = 2.42
    if (mat.roughness > 0.1) mat.roughness = 0.05
    mat.kmpShaderType = 'lux_diamond'
    mat.gemParams = {
      dispersionStrength: getFloat('dispersion_strength') ?? (mat.dispersion > 0 ? mat.dispersion : 0.04),
      brilliance: getFloat('brilliance') ?? 1.0,
      fireIntensity: getFloat('fire_intensity') ?? 0.8,
    }
    return
  }

  if (type.includes('gem')) {
    mat.transmission = 1.0
    if (mat.ior === 1.5) mat.ior = 1.76
    if (mat.roughness > 0.1) mat.roughness = 0.05
    mat.kmpShaderType = 'lux_gem'
    mat.gemParams = {
      dispersionStrength: getFloat('dispersion_strength') ?? (mat.dispersion > 0 ? mat.dispersion : 0.02),
      brilliance: getFloat('brilliance') ?? 0.8,
      fireIntensity: getFloat('fire_intensity') ?? 0.5,
    }
    return
  }

  if (type.includes('glass') || type.includes('liquid')) {
    mat.transmission = 1.0
    if (mat.roughness > 0.1) mat.roughness = 0.05
    if (mat.ior === 1.5) mat.ior = type.includes('liquid') ? 1.33 : 1.52
    mat.kmpShaderType = type.includes('liquid') ? 'lux_liquid' : 'lux_glass'
    const absorptionColor = getColorRaw('absorption_color', 'attenuation_color')
    mat.glassParams = {
      absorptionColor: absorptionColor
        ? [absorptionColor.r, absorptionColor.g, absorptionColor.b]
        : hexToComponents(mat.attenuationColor),
      absorptionDistance: getFloat('absorption_distance') ?? mat.attenuationDistance ?? 0,
      chromaticAberration: getFloat('chromatic_aberration') ?? mat.dispersion ?? 0,
    }
    return
  }

  if (type.includes('dielectric')) {
    if (mat.transmission === 0) mat.transmission = 0.5
    if (mat.ior === 1.5) mat.ior = 1.5
    mat.kmpShaderType = 'lux_dielectric'
    return
  }

  if (type.includes('plastic') && type.includes('cloudy')) {
    mat.transmission = 0.3
    mat.attenuationDistance = mat.attenuationDistance || 0.5
    mat.roughness = Math.max(mat.roughness, 0.35)
    mat.kmpShaderType = 'lux_plastic_cloudy'
    return
  }
  if (type.includes('plastic') && type.includes('transparent')) {
    mat.transmission = 0.8
    mat.roughness = 0.1
    if (mat.ior === 1.5) mat.ior = 1.45
    mat.kmpShaderType = 'lux_plastic_transparent'
    return
  }
  if (type.includes('plastic')) {
    mat.transmission = 0.2
    mat.roughness = Math.max(mat.roughness, 0.15)
    mat.kmpShaderType = 'lux_plastic'
    return
  }

  if (type.includes('brushed_metal') || (type.includes('metal') && !type.includes('paint') && !type.includes('lic'))) {
    mat.metalness = 1.0
    if (mat.roughness === 0.5) mat.roughness = 0.2
    mat.envMapIntensity = Math.max(mat.envMapIntensity, 1.5)
    mat.kmpShaderType = type.includes('brushed') ? 'lux_brushed_metal' : 'lux_metal'
    return
  }

  if (type.includes('paint') && !type.includes('metal')) {
    if (mat.clearcoat === 0) mat.clearcoat = 0.3
    if (mat.clearcoatRoughness === 0) mat.clearcoatRoughness = 0.03
    if (mat.roughness === 0.5) mat.roughness = 0.4
    mat.kmpShaderType = 'lux_paint'
    return
  }

  if (type.includes('velvet') || type.includes('fabric') || type.includes('cloth') || type.includes('realcloth')) {
    mat.sheen = 1.0
    if (mat.sheenColor === '#ffffff') {
      const sc = getColorRaw('sheen_color', 'fuzz_color')
      if (sc) mat.sheenColor = rgbToHex(sc.r, sc.g, sc.b)
    }
    mat.kmpShaderType = type.includes('velvet') ? 'lux_velvet' : 'lux_cloth'
    const sc = getColorRaw('sheen_color', 'fuzz_color')
    mat.velvetParams = {
      sheenColor: sc ? [sc.r, sc.g, sc.b] : hexToComponents(mat.sheenColor),
      sheenIntensity: getFloat('sheen_intensity', 'sheen', 'fuzz') ?? 1.0,
      fuzzAmount: getFloat('fuzz_amount', 'fuzz') ?? 0.5,
    }
    return
  }

  if (type.includes('thin_film') || type.includes('thin film')) {
    if (mat.iridescence === 0) mat.iridescence = 1.0
    if (mat.iridescenceIOR === 1.3) mat.iridescenceIOR = 1.5
    mat.kmpShaderType = 'lux_thin_film'
    return
  }

  if (type.includes('anisotropic')) {
    mat.metalness = 1.0
    mat.kmpShaderType = 'lux_anisotropic'
    const rx = getFloat('roughness_x')
    const ry = getFloat('roughness_y')
    const rot = getFloat('anisotropy_rotation') ?? (getFloat('angle') !== null ? (getFloat('angle') * Math.PI) / 180 : 0)
    mat.anisotropicParams = {
      roughnessX: rx ?? mat.roughness,
      roughnessY: ry ?? mat.roughness,
      rotationAngle: rot,
    }
    return
  }

  if (type.includes('multi_layer') || type.includes('multi-layer') || type.includes('multilayer')) {
    mat.kmpShaderType = 'lux_multi_layer'
    return
  }

  if (type.includes('generic')) {
    mat.kmpShaderType = 'lux_generic'
    return
  }

  if (type.includes('advanced')) {
    mat.kmpShaderType = 'lux_advanced'
    return
  }

  if (type.includes('emissive')) {
    mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 1.0)
    if (mat.emissive === '#000000') mat.emissive = mat.color
    mat.kmpShaderType = 'lux_emissive'
    return
  }

  if (type.includes('flat')) {
    mat.roughness = 1.0
    mat.metalness = 0.0
    mat.kmpShaderType = 'lux_flat'
    return
  }

  if (type.includes('matte') || type.includes('diffuse')) {
    mat.roughness = 1.0
    mat.metalness = 0.0
    mat.kmpShaderType = type.includes('matte') ? 'lux_matte' : 'lux_diffuse'
    return
  }

  if (type.includes('glossy')) {
    if (mat.roughness === 0.5) mat.roughness = 0.1
    mat.kmpShaderType = 'lux_glossy'
    return
  }

  if (type.includes('rubber') || type.includes('silicone')) {
    if (mat.roughness === 0.5) mat.roughness = 0.8
    mat.kmpShaderType = type.includes('silicone') ? 'lux_silicone' : 'lux_rubber'
    return
  }

  if (type.includes('ceramic') || type.includes('porcelain')) {
    if (mat.clearcoat === 0) mat.clearcoat = 1.0
    if (mat.clearcoatRoughness === 0) mat.clearcoatRoughness = 0.05
    if (mat.roughness === 0.5) mat.roughness = 0.3
    mat.kmpShaderType = type.includes('porcelain') ? 'lux_porcelain' : 'lux_ceramic'
    return
  }

  if (type.includes('leather')) {
    if (mat.roughness === 0.5) mat.roughness = 0.7
    mat.kmpShaderType = 'lux_leather'
    return
  }

  if (type.includes('axalta') || type.includes('measured')) {
    mat.kmpShaderType = 'lux_measured'
    return
  }

  if (type.includes('xray') || type.includes('x_ray')) {
    mat.transmission = 1.0
    mat.ior = 1.0
    mat.kmpShaderType = 'lux_xray'
    return
  }

  if (type.includes('wireframe')) {
    mat.wireframe = true
    mat.kmpShaderType = 'lux_wireframe'
    return
  }

  if (type.includes('skin')) {
    if (mat.transmission === 0) mat.transmission = 0.1
    mat.attenuationDistance = mat.attenuationDistance || 0.3
    mat.roughness = Math.max(mat.roughness, 0.5)
    mat.kmpShaderType = 'lux_skin'
    return
  }

  if (type.includes('cutaway')) {
    mat.kmpShaderType = 'lux_cutaway'
    return
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Post-mapping — final fallbacks that depend on the full material state.
// Evidence: kmp-pipeline.mjs:1775-1790, extract-kmp-exact.mjs:693-697.
// ────────────────────────────────────────────────────────────────────────────
function applyPostMapping(mat, a) {
  const { getColorRaw } = a
  const sssColor = getColorRaw('subsurface_color', 'sss_color')
  if (sssColor && mat.attenuationColor === '#ffffff') {
    mat.attenuationColor = rgbToHex(sssColor.r, sssColor.g, sssColor.b)
  }
}
