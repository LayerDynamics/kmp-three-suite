/**
 * Standalone KMP parser that replicates the exact logic from LuxionMtlParser.ts
 * without Three.js dependencies. Outputs MaterialDefinition JSON for preset use.
 */
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(v) { return Math.max(0, Math.min(1, v)) }
function lerp(a, b, t) { return a + (b - a) * t }
function isPrintable(b) { return b >= 0x20 && b < 0x7f }

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

function readAsciiClean(data, start, end) {
  let result = ''
  for (let i = start; i < end && i < data.length; i++) {
    if (isPrintable(data[i])) result += String.fromCharCode(data[i])
  }
  return result
}

function readAscii(data, start, end) {
  let result = ''
  for (let i = start; i < end && i < data.length; i++) {
    result += String.fromCharCode(data[i])
  }
  return result
}

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IEND_MARKER = new Uint8Array([0x49, 0x45, 0x4e, 0x44])
const TYPE_FLOAT = 0x17
const TYPE_INT = 0x1d

function findSequence(data, needle, startOffset = 0) {
  for (let i = startOffset; i <= data.length - needle.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) { match = false; break }
    }
    if (match) return i
  }
  return -1
}

function findParamSectionWithoutPng(data) {
  const shaderMarker = new TextEncoder().encode('//--lux:shader:')
  const pos = findSequence(data, shaderMarker)
  if (pos >= 0) {
    let i = pos + shaderMarker.length
    while (i < data.length && data[i] !== 0x0a) i++
    return i + 1
  }
  return Math.min(128, data.length)
}

// ── Parameter Section Parser (exact copy of LuxionMtlParser logic) ──────────

function parseParamSection(data, view, start, end) {
  const results = []
  let i = start
  while (i < end && !isPrintable(data[i])) i++

  const markers = []
  for (let m = i; m < end; m++) {
    if (data[m] === TYPE_FLOAT) markers.push({ pos: m, type: 'float' })
    else if (data[m] === TYPE_INT) markers.push({ pos: m, type: 'int' })
  }

  const colorMarkers = []
  for (let m = i; m < end - 13; m++) {
    if (data[m] === 0x27 && m > i) {
      const byteBefore = m > 0 ? data[m - 1] : 0
      const byteAfter = data[m + 1]
      if (isPrintable(byteBefore) && byteAfter < 0x20) {
        colorMarkers.push({ pos: m })
      }
    }
  }

  const allMarkers = [
    ...markers.map(m => ({ ...m })),
    ...colorMarkers.map(m => ({ pos: m.pos, type: 'color' })),
  ].sort((a, b) => a.pos - b.pos)

  let cursor = i

  if (allMarkers.length > 0) {
    const firstMarker = allMarkers[0]
    if (firstMarker.type === 'color') {
      const nameStr = readAsciiClean(data, cursor, firstMarker.pos)
      const r = view.getFloat32(firstMarker.pos + 2, true)
      const g = view.getFloat32(firstMarker.pos + 6, true)
      const b = view.getFloat32(firstMarker.pos + 10, true)
      results.push([nameStr, { type: 'color', value: { r, g, b } }])
      cursor = firstMarker.pos + 14
    } else if (firstMarker.type === 'float') {
      const nameStr = readAsciiClean(data, cursor, firstMarker.pos)
      const val = view.getFloat32(firstMarker.pos + 2, true)
      results.push([nameStr, { type: 'float', value: val }])
      cursor = firstMarker.pos + 6
    } else {
      const nameStr = readAsciiClean(data, cursor, firstMarker.pos)
      const val = view.getUint32(firstMarker.pos + 2, true)
      results.push([nameStr, { type: 'int', value: val }])
      cursor = firstMarker.pos + 6
    }
  }

  for (let mi = 1; mi < allMarkers.length; mi++) {
    const marker = allMarkers[mi]
    let nameStart = cursor
    while (nameStart < marker.pos && !isPrintable(data[nameStart])) nameStart++
    let nameStr = readAsciiClean(data, nameStart, marker.pos)
    nameStr = nameStr.replace(/^[^a-zA-Z_]+/, '')

    if (marker.type === 'color') {
      if (marker.pos + 14 <= end) {
        const r = view.getFloat32(marker.pos + 2, true)
        const g = view.getFloat32(marker.pos + 6, true)
        const b = view.getFloat32(marker.pos + 10, true)
        results.push([nameStr, { type: 'color', value: { r, g, b } }])
        cursor = marker.pos + 14
      }
    } else if (marker.type === 'float') {
      if (marker.pos + 6 <= end) {
        const val = view.getFloat32(marker.pos + 2, true)
        results.push([nameStr, { type: 'float', value: val }])
        cursor = marker.pos + 6
      }
    } else {
      if (marker.pos + 6 <= end) {
        const val = view.getUint32(marker.pos + 2, true)
        results.push([nameStr, { type: 'int', value: val }])
        cursor = marker.pos + 6
      }
    }
  }

  return results
}

// ── MATMETA name extraction ──────────────────────────────────────────────────

function extractNameFromMatmeta(data, matmetaPos) {
  const attrMarker = new TextEncoder().encode('attribute')
  const attrPos = findSequence(data, attrMarker, matmetaPos)
  if (attrPos < 0) return null
  let i = attrPos + attrMarker.length
  while (i < data.length && i < attrPos + 20) {
    if (isPrintable(data[i])) {
      const nameStart = i
      while (i < data.length && data[i] >= 0x20 && data[i] < 0x7f && data[i] !== 0x3b) i++
      const nameStr = readAscii(data, nameStart, i)
      if (nameStr.length > 0) return nameStr
    }
    i++
  }
  return null
}

// ── Default material definition ──────────────────────────────────────────────

function createDefaultMaterialDefinition() {
  return {
    color: '#888888', metalness: 0.0, roughness: 0.5,
    map: null, metalnessMap: null, roughnessMap: null, normalMap: null,
    normalScaleX: 1.0, normalScaleY: 1.0,
    aoMap: null, aoMapIntensity: 1.0,
    displacementMap: null, displacementScale: 1.0, displacementBias: 0.0,
    emissive: '#000000', emissiveMap: null, emissiveIntensity: 1.0,
    opacity: 1.0, alphaMap: null, transparent: false, alphaTest: 0.0, side: 'front',
    clearcoat: 0.0, clearcoatRoughness: 0.0,
    clearcoatMap: null, clearcoatRoughnessMap: null,
    clearcoatNormalMap: null, clearcoatNormalScaleX: 1.0, clearcoatNormalScaleY: 1.0,
    sheen: 0.0, sheenColor: '#ffffff', sheenRoughness: 1.0,
    sheenColorMap: null, sheenRoughnessMap: null,
    transmission: 0.0, transmissionMap: null, thickness: 0.0, thicknessMap: null,
    ior: 1.5, attenuationColor: '#ffffff', attenuationDistance: 0,
    iridescence: 0.0, iridescenceIOR: 1.3,
    iridescenceThicknessMin: 100, iridescenceThicknessMax: 400,
    iridescenceMap: null, iridescenceThicknessMap: null,
    anisotropy: 0.0, anisotropyRotation: 0.0, anisotropyMap: null,
    specularIntensity: 1.0, specularIntensityMap: null,
    specularColor: '#ffffff', specularColorMap: null,
    dispersion: 0.0, envMapIntensity: 1.0, wireframe: false,
    metalFlakeParams: null, kmpShaderType: null,
    carpaintParams: null, toonParams: null, sssParams: null,
  }
}

// ── Param accessor helpers ──────────────────────────────────────────────────

function makeAccessors(params) {
  const getFloat = (...keys) => {
    for (const key of keys) {
      const p = params[key]
      if (p && p.type === 'float') return p.value
    }
    return null
  }
  const getColor = (...keys) => {
    for (const key of keys) {
      const p = params[key]
      if (p && p.type === 'color') {
        const c = p.value
        return rgbToHex(c.r, c.g, c.b)
      }
    }
    return null
  }
  const getColorRaw = (...keys) => {
    for (const key of keys) {
      const p = params[key]
      if (p && p.type === 'color') return p.value
    }
    return null
  }
  const getInt = (...keys) => {
    for (const key of keys) {
      const p = params[key]
      if (p && p.type === 'int') return p.value
    }
    return null
  }
  return { getFloat, getColor, getColorRaw, getInt }
}

// ── mapLuxionParamsToMaterial (exact copy) ──────────────────────────────────

function mapLuxionParamsToMaterial(params, shaderType, mat) {
  const { getFloat, getColor, getColorRaw, getInt } = makeAccessors(params)

  // Shader type base color
  if (shaderType && params[shaderType]?.type === 'color') {
    mat.color = getColor(shaderType)
  }

  const diffuseColor = getColor('diffuse', 'surface_color')
  if (diffuseColor && (!shaderType || !params[shaderType] || params[shaderType]?.type !== 'color')) {
    mat.color = diffuseColor
  }

  const baseWeight = getFloat('base')
  if (baseWeight !== null && baseWeight < 1.0 && baseWeight >= 0) {
    const hex = mat.color.replace('#', '')
    const r = Math.round(parseInt(hex.substring(0, 2), 16) * baseWeight)
    const g = Math.round(parseInt(hex.substring(2, 4), 16) * baseWeight)
    const b = Math.round(parseInt(hex.substring(4, 6), 16) * baseWeight)
    mat.color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  }

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
    const hex = mat.color.replace('#', '')
    const br = parseInt(hex.substring(0, 2), 16) / 255
    const bg = parseInt(hex.substring(2, 4), 16) / 255
    const bb = parseInt(hex.substring(4, 6), 16) / 255
    const t = clamp01(specularTint)
    mat.specularColor = rgbToHex(lerp(1, br, t), lerp(1, bg, t), lerp(1, bb, t))
  }

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
  if (filmExtinction !== null && filmExtinction > 0) {
    if (mat.iridescence > 0) mat.iridescence = clamp01(mat.iridescence * (1 + filmExtinction * 0.1))
  }

  const colorFilter = getColor('color_filter')
  if (colorFilter) {
    const baseHex = mat.color.replace('#', '')
    const filterHex = colorFilter.replace('#', '')
    const r = Math.round((parseInt(baseHex.substring(0, 2), 16) / 255) * (parseInt(filterHex.substring(0, 2), 16) / 255) * 255)
    const g = Math.round((parseInt(baseHex.substring(2, 4), 16) / 255) * (parseInt(filterHex.substring(2, 4), 16) / 255) * 255)
    const b = Math.round((parseInt(baseHex.substring(4, 6), 16) / 255) * (parseInt(filterHex.substring(4, 6), 16) / 255) * 255)
    mat.color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
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
    const hex = mat.color.replace('#', '')
    const cr = parseInt(hex.substring(0, 2), 16) / 255
    const cg = parseInt(hex.substring(2, 4), 16) / 255
    const cb = parseInt(hex.substring(4, 6), 16) / 255
    const gray = (cr + cg + cb) / 3
    const sat = Math.min(diffuseSaturation, 3.0)
    mat.color = rgbToHex(clamp01(gray + (cr - gray) * sat), clamp01(gray + (cg - gray) * sat), clamp01(gray + (cb - gray) * sat))
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

  const attenuationColor = getColor('attenuation_color', 'transmission_color', 'subsurface_color', 'transmission')
  if (attenuationColor) mat.attenuationColor = attenuationColor

  const transmissionOut = getColor('transmission_out')
  if (transmissionOut && mat.attenuationColor === '#ffffff') mat.attenuationColor = transmissionOut

  const sheenColor = getColor('sheen_color', 'fuzz_color', 'sheen')
  if (sheenColor) mat.sheenColor = sheenColor

  const sheenTintVal = getFloat('sheen_tint')
  if (sheenTintVal !== null && sheenTintVal > 0 && mat.sheen > 0) {
    const hex = mat.color.replace('#', '')
    const br = parseInt(hex.substring(0, 2), 16) / 255
    const bg = parseInt(hex.substring(2, 4), 16) / 255
    const bb = parseInt(hex.substring(4, 6), 16) / 255
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

  // ── Shader-type-specific mapping ──
  applyShaderTypeMapping(shaderType, mat, params, getFloat, getColor, getColorRaw, getInt)
}

// ── applyShaderTypeMapping (exact copy of relevant branches) ──────────────

function applyShaderTypeMapping(shaderType, mat, params, getFloat, getColor, getColorRaw, getInt) {
  if (!shaderType) return
  const type = shaderType.toLowerCase()

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
        const scHex = mat.specularColor.replace('#', '')
        const sr = parseInt(scHex.substring(0, 2), 16) / 255
        const sg = parseInt(scHex.substring(2, 4), 16) / 255
        const sb = parseInt(scHex.substring(4, 6), 16) / 255
        mat.specularColor = rgbToHex(sr * clearcoatColor.r, sg * clearcoatColor.g, sb * clearcoatColor.b)
      }
    }

    mat.envMapIntensity = Math.max(mat.envMapIntensity, 1.2)
    mat.ior = 1.5
    if (paintIor !== null && paintIor <= 0) mat.specularIntensity = 1.0

    const baseColorRaw = getColorRaw(type) ?? getColorRaw('diffuse', 'surface_color')
    const metalFlakeSize = getFloat('metal_flake_size', 'flake_size') ?? 2.0
    const metalSamples = getInt('metal_samples') ?? 8
    const metalRoughnessVal = getFloat('metal_roughness') ?? 0.3
    const metalCoverageVal = getFloat('metal_coverage') ?? 0.0
    const metalFlakeVis = getFloat('metal_flake_visibility') ?? (getInt('metal_flake_visibility') !== null ? Math.min(getInt('metal_flake_visibility') / 16.0, 1.0) : 1.0)

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

    // metalFlakeParams (from parseLuxionMtl main body)
    const flakeSize = getFloat('flake_size')
    function metalFlakeParamsFromKmp(coverage, mRoughness, fSize) {
      const density = clamp01(0.3 + coverage * 0.3)
      const intensity = clamp01(0.05 + (1 - mRoughness) * 0.15)
      return {
        resolution: 512,
        flakeSize: fSize ?? 2,
        flakeIntensity: intensity,
        flakeDensity: density,
        seed: 42,
      }
    }
    const flakeParams = metalFlakeParamsFromKmp(metalCoverageVal, metalRoughnessVal, flakeSize ? Math.max(1, Math.round(flakeSize)) : undefined)
    mat.metalFlakeParams = {
      resolution: flakeParams.resolution ?? 512,
      flakeSize: flakeParams.flakeSize ?? 2,
      flakeIntensity: flakeParams.flakeIntensity ?? 0.15,
      flakeDensity: flakeParams.flakeDensity ?? 0.7,
      seed: flakeParams.seed ?? 42,
    }

  } else if (type.includes('toon')) {
    mat.roughness = 1.0
    mat.metalness = 0.0
    mat.specularIntensity = 0.0

    const toonFillColor = getColorRaw(type) ?? getColorRaw('color', 'diffuse')
    const toonAlpha = getColorRaw('alpha')
    const toonShadowColor = getColorRaw('shadow color')
    const toonContourColor = getColorRaw('contour color')
    const toonShadowStrength = getColorRaw('shadow strength')

    const toonShadowMultiplier = getFloat('shadow multiplier') ?? 1.0
    const toonContourAngle = getFloat('contour angle') ?? 60.0
    const toonContourWidth = getFloat('contour width') ?? 1.0
    const toonContourQuality = getFloat('contour quality') ?? 1.0
    const toonOutlineWidthMul = getFloat('outline width multiplier') ?? 1.0
    const toonPartWidthMul = getFloat('part width multiplier') ?? 1.0

    const getBool = (key) => {
      const intVal = getInt(key)
      if (intVal !== null) return intVal !== 0
      const floatVal = getFloat(key)
      if (floatVal !== null) return floatVal > 0.5
      return false
    }

    const toonTransparency = getBool('transparency')
    const toonContourInPixels = getBool('contour width is in pixels')
    const toonOutlineContour = getBool('outline contour')
    const toonMaterialContour = getBool('material contour')
    const toonPartContour = getBool('part contour')
    const toonInteriorEdge = getBool('interior edge contour')
    const toonEnvShadows = getBool('environment shadows')
    const toonLightShadows = getBool('light source shadows')

    if (toonAlpha) {
      const avg = (toonAlpha.r + toonAlpha.g + toonAlpha.b) / 3
      if (avg < 0.99) { mat.opacity = clamp01(avg); mat.transparent = true }
    }
    if (toonTransparency) mat.transparent = true

    if (toonFillColor) mat.color = rgbToHex(toonFillColor.r, toonFillColor.g, toonFillColor.b)

    mat.kmpShaderType = 'lux_toon'
    mat.toonParams = {
      fillColor: toonFillColor ? [toonFillColor.r, toonFillColor.g, toonFillColor.b] : [0, 0, 0],
      shadowColor: toonShadowColor ? [toonShadowColor.r, toonShadowColor.g, toonShadowColor.b] : [0, 0, 0],
      shadowMultiplier: toonShadowMultiplier,
      shadowStrength: toonShadowStrength ? [toonShadowStrength.r, toonShadowStrength.g, toonShadowStrength.b] : [1, 1, 1],
      contourColor: toonContourColor ? [toonContourColor.r, toonContourColor.g, toonContourColor.b] : [0, 0, 0],
      contourAngle: toonContourAngle,
      contourWidth: toonContourWidth,
      contourQuality: toonContourQuality,
      contourWidthInPixels: toonContourInPixels,
      outlineWidthMultiplier: toonOutlineWidthMul,
      partWidthMultiplier: toonPartWidthMul,
      outlineContour: toonOutlineContour,
      materialContour: toonMaterialContour,
      partContour: toonPartContour,
      interiorEdgeContour: toonInteriorEdge,
      environmentShadows: toonEnvShadows,
      lightSourceShadows: toonLightShadows,
      transparency: toonTransparency,
    }

  } else if (type.includes('translucent') || type.includes('sss')) {
    if (!params['transmission'] && !params['transparency']) mat.transmission = 0.5
    if (mat.attenuationDistance === 0) mat.attenuationDistance = 0.5

    const sssSubsurfaceColor = getColorRaw('translucency', 'subsurface_color', 'sss_color')
    const sssTransmissionColor = getColorRaw('transmission_color', 'transmission', 'attenuation_color')
    const sssSpecularColorRaw = getColorRaw('specular_color', 'reflection_color')
    const sssSpecularity = getColorRaw('specularity')

    const sssIorR = getFloat('ior') ?? 1.5
    const sssIorColor = getColorRaw('ior')
    const sssIorChannels = sssIorColor ? [sssIorColor.r, sssIorColor.g, sssIorColor.b] : [sssIorR, sssIorR, sssIorR]

    const sssDiffuseWeight = getFloat('diffuse', 'diffuse_weight') ?? 0.5
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

    // Also handle the translucency color for attenuation
    if (sssSubsurfaceColor) {
      mat.attenuationColor = rgbToHex(sssSubsurfaceColor.r, sssSubsurfaceColor.g, sssSubsurfaceColor.b)
    }
    mat.transparent = true
    mat.side = 'double'
  }

  // Post-mapping
  const sssColor = getColorRaw('subsurface_color', 'sss_color')
  if (sssColor && mat.attenuationColor === '#ffffff') {
    mat.attenuationColor = rgbToHex(sssColor.r, sssColor.g, sssColor.b)
  }
}

// ── Main: Parse each KMP file ──────────────────────────────────────────────

const dir = '/Users/ryanoboyle/defcad-file-browser/file-browser-client'
const files = [
  'public/assets/kmp/Paint Metallic Sienna gold #1.kmp',
  'public/assets/kmp/Toon Fill Black bright  #9.kmp',
  'public/assets/kmp/Translucent Candle Wax #3.kmp',
]

for (const file of files) {
  console.log('\n' + '='.repeat(70))
  console.log('FILE:', file.split('/').pop())
  console.log('='.repeat(70))

  const fullPath = join(dir, file)
  const tmpDir = mkdtempSync(join(tmpdir(), 'kmp-'))

  try {
    execSync(`unzip -o "${fullPath}" -d "${tmpDir}"`, { stdio: 'pipe' })
    const extracted = readdirSync(tmpDir)
    const mtlFile = extracted.find(f => f.endsWith('.mtl'))

    if (!mtlFile) { console.log('  No .mtl file found!'); continue }

    const mtlBuf = readFileSync(join(tmpDir, mtlFile))
    const data = new Uint8Array(mtlBuf)
    const view = new DataView(mtlBuf.buffer, mtlBuf.byteOffset, mtlBuf.byteLength)

    // Find PNG end
    let paramSectionStart = 0
    const pngStart = findSequence(data, PNG_MAGIC)
    if (pngStart >= 0) {
      const iendPos = findSequence(data, IEND_MARKER, pngStart)
      if (iendPos >= 0) {
        paramSectionStart = iendPos + 4 + 4
      }
    }
    if (paramSectionStart === 0) {
      paramSectionStart = findParamSectionWithoutPng(data)
    }

    // Find MATMETA
    const matmetaMarker = new TextEncoder().encode('--MATMETA--')
    const matmetaPos = findSequence(data, matmetaMarker, paramSectionStart)
    const paramSectionEnd = matmetaPos >= 0 ? matmetaPos : data.length

    // Parse params
    const paramList = parseParamSection(data, view, paramSectionStart, paramSectionEnd)
    const rawParams = {}
    for (const [pName, pVal] of paramList) {
      rawParams[pName] = pVal
    }

    const shaderType = paramList.length > 0 ? paramList[0][0] : null

    // Extract name
    let name = null
    if (matmetaPos >= 0) name = extractNameFromMatmeta(data, matmetaPos)

    console.log('\nName:', name)
    console.log('Shader type:', shaderType)
    console.log('\nRaw params:')
    for (const [k, v] of Object.entries(rawParams)) {
      if (v.type === 'color') {
        const c = v.value
        console.log(`  ${k}: [${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}] (color)`)
      } else if (v.type === 'float') {
        console.log(`  ${k}: ${v.value.toFixed(4)} (float)`)
      } else {
        console.log(`  ${k}: ${v.value} (int)`)
      }
    }

    // Create material definition
    const mat = createDefaultMaterialDefinition()
    mapLuxionParamsToMaterial(rawParams, shaderType, mat)

    // Strip null/map fields for cleaner output
    const cleanMat = {}
    for (const [k, v] of Object.entries(mat)) {
      if (v === null || (typeof k === 'string' && k.endsWith('Map') && v === null)) continue
      cleanMat[k] = v
    }

    console.log('\n--- MaterialDefinition (non-null fields only) ---')
    console.log(JSON.stringify(cleanMat, null, 2))

  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
