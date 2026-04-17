// MaterialDefinition default factory + canonical shader-type registry.
// Evidence: kmp-three-suite/reference/kmp-extraction/kmp-pipeline.mjs:904-931
//           (factory) and :477-483 (shader-type list).

export const KNOWN_SHADER_TYPES = Object.freeze([
  'lux_toon', 'toon', 'lux_translucent', 'metallic_paint',
  'lux_plastic', 'lux_metal', 'lux_glass', 'lux_dielectric',
  'lux_gem', 'lux_diffuse', 'lux_emissive', 'lux_velvet',
  'lux_paint', 'lux_car_paint', 'lux_cloth', 'lux_skin',
  'lux_x_ray', 'lux_flat', 'lux_advanced', 'lux_cutaway',
])

/**
 * Build a fresh {@link MaterialDefinition} populated with Three.js / Lux PBR
 * defaults (grey diffuse, zero metalness, 0.5 roughness, IOR 1.5, all maps
 * nulled, no per-shader side-table). Each call returns a new object so the
 * caller may mutate it freely without leaking state.
 *
 * @returns {import('../../index.d.ts').MaterialDefinition}
 */
export function createDefaultMaterialDefinition() {
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
    glassParams: null, gemParams: null, velvetParams: null, anisotropicParams: null,
  }
}
