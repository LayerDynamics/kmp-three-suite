// kmp-three-suite — Luxion KeyShot KMP/MTL → Three.js MaterialDefinition.
// Hand-written public surface. Mirrors src/index.js.

export type RgbTriplet = { r: number; g: number; b: number }

export type RawParam =
  | { name: string; type: 'float'; subId: number; offset: number; value: number }
  | { name: string; type: 'int'; subId: number; offset: number; value: number }
  | { name: string; type: 'color'; subId: number; offset: number; value: RgbTriplet; hex: string }
  | { name: string; type: 'bool'; subId: number; offset: number; value: number; bool: boolean }
  | { name: string; type: 'bool_inferred'; subId: number; offset: number; value: number; bool: boolean; rawLength: number; note?: string }
  | { name: string; type: 'texslot'; subId: number; offset: number; value: number; note?: string }

export interface ToonParams {
  fillColor: [number, number, number]
  shadowColor: [number, number, number]
  shadowMultiplier: number
  shadowStrength: [number, number, number]
  contourColor: [number, number, number]
  contourAngle: number
  contourWidth: number
  contourQuality: number
  contourWidthInPixels: boolean
  outlineWidthMultiplier: number
  partWidthMultiplier: number
  outlineContour: boolean
  materialContour: boolean
  partContour: boolean
  interiorEdgeContour: boolean
  environmentShadows: boolean
  lightSourceShadows: boolean
  transparency: boolean
}

export interface CarpaintParams {
  baseColor: [number, number, number]
  metalLayerVisibility: number
  clearcoatIOR: number
  clearcoatAbsorptionColor: [number, number, number]
  metalSamples: number
  metalCoverage: number
  metalRoughness: number
  metalFlakeSize: number
  metalFlakeVisibility: number
}

export interface MetalFlakeParams {
  resolution: number
  flakeSize: number
  flakeIntensity: number
  flakeDensity: number
  seed: number
}

export interface SssParams {
  subsurfaceColor: [number, number, number]
  subsurfaceRadius: number
  iorChannels: [number, number, number]
  diffuseWeight: number
  transmissionColor: [number, number, number]
  specularColor: [number, number, number]
  specularity: [number, number, number]
  dispersion: number
}

export interface GlassParams {
  absorptionColor: [number, number, number]
  absorptionDistance: number
  chromaticAberration: number
}

export interface GemParams {
  dispersionStrength: number
  brilliance: number
  fireIntensity: number
}

export interface VelvetParams {
  sheenColor: [number, number, number]
  sheenIntensity: number
  fuzzAmount: number
}

export interface AnisotropicParams {
  roughnessX: number
  roughnessY: number
  rotationAngle: number
}

export interface MaterialDefinition {
  color: string
  emissive: string
  emissiveIntensity: number
  metalness: number
  roughness: number
  ior: number
  specularIntensity: number
  specularColor: string
  opacity: number
  transparent: boolean
  alphaTest: number
  side: 'front' | 'back' | 'double'
  transmission: number
  thickness: number
  attenuationColor: string
  attenuationDistance: number
  clearcoat: number
  clearcoatRoughness: number
  clearcoatNormalScaleX: number
  clearcoatNormalScaleY: number
  sheen: number
  sheenColor: string
  sheenRoughness: number
  iridescence: number
  iridescenceIOR: number
  iridescenceThicknessMin: number
  iridescenceThicknessMax: number
  anisotropy: number
  anisotropyRotation: number
  normalScaleX: number
  normalScaleY: number
  displacementScale: number
  displacementBias: number
  aoMapIntensity: number
  envMapIntensity: number
  dispersion: number
  wireframe: boolean
  kmpShaderType: string | null
  toonParams: ToonParams | null
  carpaintParams: CarpaintParams | null
  metalFlakeParams: MetalFlakeParams | null
  sssParams: SssParams | null
  glassParams: GlassParams | null
  gemParams: GemParams | null
  velvetParams: VelvetParams | null
  anisotropicParams: AnisotropicParams | null
  map: string | null
  normalMap: string | null
  roughnessMap: string | null
  metalnessMap: string | null
  aoMap: string | null
  emissiveMap: string | null
  alphaMap: string | null
  clearcoatMap: string | null
  clearcoatRoughnessMap: string | null
  clearcoatNormalMap: string | null
  sheenColorMap: string | null
  sheenRoughnessMap: string | null
  transmissionMap: string | null
  thicknessMap: string | null
  iridescenceMap: string | null
  iridescenceThicknessMap: string | null
  specularIntensityMap: string | null
  specularColorMap: string | null
  displacementMap: string | null
  anisotropyMap: string | null
}

export interface TextureEntry {
  path: string
  bytes: Uint8Array
  byteLength: number
  extension: string
}

export interface XmlConfig {
  shaderHint: string | null
  renderHints: Record<string, string>
}

export interface Coverage {
  claimedBytes: number
  totalBytes: number
  unclaimedBytes: Array<{ offset: string; text: string }>
}

export interface SubShaderRegion {
  start: number
  end: number
  mainShaderStart: number
  blocks: Array<{ offset: number; subId: number; slotIndex: number | null }>
  colorSlots: Map<number, RgbTriplet>
}

export interface MtlExtraction {
  header: { matVersion?: string; shaderVersion?: string; keyshotVersion?: string }
  png: { bytes: Uint8Array; start: number; end: number; size: number } | null
  paramSection: { start: number; end: number }
  subShaderRegion: SubShaderRegion | null
  footer: { start: number; type: 'matmeta' | 'name_footer' | 'eof' }
  rawParameters: RawParam[]
  materialName: string | null
  shaderType: string | null
  // Original MTL byte buffer. Retained so downstream code (hex dumps, coverage,
  // re-archiving) can re-scan without re-decoding. Holding the extraction keeps
  // these bytes alive — drop references to free memory.
  source: Uint8Array
}

export interface KmpExtraction {
  mtlName: string
  mtlExtraction: MtlExtraction
  textures: TextureEntry[]
  xmlConfig: XmlConfig | null
}

export interface ProcessResult {
  meta: {
    sourceFile: string | null
    mtlFile: string
    mtlSize: number
    paramSectionOffset: string
    paramSectionEnd: string
    paramSectionSize: number
    tailSectionOffset: string
    extractedAt: string
    matVersion?: string
    shaderVersion?: string
    keyshotVersion?: string
  }
  materialName: string | null
  shaderType: string | null
  png: { bytes: Uint8Array; size: number; startOffset: string; endOffset: string } | null
  rawParameters: RawParam[]
  subShaderColors: Map<number, RgbTriplet>
  materialDefinition: MaterialDefinition
  warnings: string[]
  coverage: Coverage
  paramHexDump: string[]
  tailHexDump: string[]
  textures: TextureEntry[]
  xmlConfig: XmlConfig | null
}

export type ProcessInput = string | Uint8Array | ArrayBuffer | Buffer | File | Blob

export interface ExtractOptions {
  /** Hard cap, in bytes, on cumulative uncompressed archive size. */
  maxArchiveSize?: number
}

export interface ProcessOptions extends ExtractOptions {
  includeHexDump?: boolean
  includeCoverage?: boolean
  shaderTypeOverrides?: Record<string, (mat: MaterialDefinition, params: Record<string, RawParam>, accessors: Accessors) => void>
}

export interface Accessors {
  getFloat: (...keys: string[]) => number | null
  getColor: (...keys: string[]) => string | null
  getColorRaw: (...keys: string[]) => RgbTriplet | null
  getInt: (...keys: string[]) => number | null
  getBoolFlex: (...keys: string[]) => boolean | null
  getAnyScalar: (...keys: string[]) => number | null
  getColorOrScalar: (...keys: string[]) => RgbTriplet | null
  getAnyAsColorArray: (...keys: string[]) => [number, number, number] | null
  byName: Record<string, RawParam>
}

export class KmpParseError extends Error {
  code: 'NO_MTL' | 'BAD_ZIP' | 'BAD_PNG'
  offset?: number
  constructor(code: KmpParseError['code'], message: string, offset?: number, options?: { cause?: unknown })
}

export function process(input: ProcessInput, options?: ProcessOptions): Promise<ProcessResult[]>
export function extractKmp(input: ProcessInput, options?: ExtractOptions): Promise<KmpExtraction[]>
export function extractMtl(mtlBuf: Uint8Array): MtlExtraction
export const MTL_KNOWN_SHADER_TYPES: readonly string[]
export function parseParamSection(buf: Uint8Array, view: DataView, start: number, end: number): RawParam[]
export const KNOWN_BOOL_PARAM_NAMES: readonly string[]
export function buildMaterialDefinition(rawParams: RawParam[], shaderType: string | null, subShaderColors: Map<number, RgbTriplet>, options?: Pick<ProcessOptions, 'shaderTypeOverrides'>): { materialDefinition: MaterialDefinition; warnings: string[] }
export function makeAccessors(rawParams: RawParam[]): Accessors
export function createDefaultMaterialDefinition(): MaterialDefinition
export const KNOWN_SHADER_TYPES: readonly string[]
export function toMemory(result: ProcessResult): ProcessResult
export function toFilesystem(result: ProcessResult, outDir: string): Promise<{ jsonPath: string; pngPath: string; texturePaths: string[] }>
export function toMaterialDefinitionOnly(result: ProcessResult): MaterialDefinition
export interface FixtureJsonOptions {
  /** Repo-relative identifier written into the `sourceKmp` field. */
  sourceKmp?: string
  /** Library version string written into the `bakerVersion` field. */
  bakerVersion?: string
  /** Override `bakedAt` timestamp so byte-identical re-runs are possible. */
  bakedAt?: string
}
export function toFixtureJson(
  result: ProcessResult,
  outPath: string,
  options?: FixtureJsonOptions,
): Promise<{ outPath: string; byteLength: number }>
export const TEXTURE_SLOT_KEYWORDS: readonly { pattern: RegExp; slot: string }[]
export const TEXTURE_EXTENSIONS: ReadonlySet<string>
export function parseXmlConfig(xmlText: string | null | undefined): XmlConfig
export function autoAssignTextures(mat: MaterialDefinition, textures: TextureEntry[]): MaterialDefinition

export namespace binaryTools {
  export function findSequence(buf: Uint8Array, needle: Uint8Array, start?: number): number
  export function isPrintable(b: number): boolean
  export function linearToSrgb(c: number): number
  export function srgbToLinear(c: number): number
  export function rgbToHex(r: number, g: number, b: number): string
  export function hexToComponents(hex: string): [number, number, number]
  export function componentsToHex(r: number, g: number, b: number): string
  export function hexDump(buf: Uint8Array, start: number, end: number, options?: { width?: number }): string[]
  export function readF32LE(view: DataView, offset: number): number
  export function readU32LE(view: DataView, offset: number): number
  export function readI32LE(view: DataView, offset: number): number
  export function readU16LE(view: DataView, offset: number): number
  export function readU8(buf: Uint8Array, offset: number): number
  export function readAscii(buf: Uint8Array, start: number, end: number): string
  export function readAsciiPrintable(buf: Uint8Array, start: number, end: number): string
  export function isValidColorMarker(buf: Uint8Array, view: DataView, pos: number, end: number): boolean
  export function isValidBoolMarker(buf: Uint8Array, pos: number, end: number): boolean
  export function isValidTexslotMarker(buf: Uint8Array, pos: number, end: number): boolean
  export function cleanParamName(raw: string): string
  export function unzipArchive(input: Uint8Array | ArrayBuffer, options?: { maxSize?: number }): Map<string, Uint8Array>
  export function enumerateEntries(archive: Map<string, Uint8Array>): { mtls: string[]; xml: string | null; textures: string[] }
  export function safeExtract(archive: Map<string, Uint8Array>, options?: { maxSize?: number }): Map<string, Uint8Array>
  export function findPngBounds(buf: Uint8Array): { start: number; end: number; size: number } | null
  export function findParamSection(buf: Uint8Array, pngEnd: number, shaderLineEnd: number): { start: number; end: number }
  export function findFooter(buf: Uint8Array, paramStart: number): { type: 'matmeta' | 'name_footer' | 'eof'; offset: number }
  export function findSubShaderRegion(buf: Uint8Array, paramStart: number, paramEnd: number, knownShaderTypes: readonly string[]): SubShaderRegion | null
  export function findSubShaderRefs(buf: Uint8Array, paramStart: number, paramEnd: number): Array<{ offset: number; slot: number }>
}
