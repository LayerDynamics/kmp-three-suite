// Full pipeline orchestrator. Resolves input → extracts → maps → assembles
// a ProcessResult per MTL (multi-material archives return length-N array).

import { extractKmp } from '../kmp/kmp-extraction.js'
import { buildMaterialDefinition } from '../lux/lux-extraction.js'
import { autoAssignTextures } from '../kmp/kmp-param-parser.js'
import { hexDump, isPrintable, readAscii } from '../binary-tools/binary-tools.js'

export { KmpParseError } from '../errors.js'

/**
 * Run the full KMP pipeline: resolve input → extract archive → decode each MTL →
 * map raw params to a {@link MaterialDefinition} → assemble per-MTL results.
 *
 * Multi-material archives resolve to a length-N array (one {@link ProcessResult}
 * per MTL entry). Single-material archives resolve to a one-element array.
 *
 * @param {import('../../index.d.ts').ProcessInput} input Path, Uint8Array,
 *   ArrayBuffer, Node Buffer, browser File, or Blob containing the KMP zip bytes.
 * @param {import('../../index.d.ts').ProcessOptions} [options] Pipeline knobs:
 *   `includeHexDump` (default true), `includeCoverage` (default true),
 *   `maxArchiveSize` (byte cap, default 256 MB), and `shaderTypeOverrides`
 *   (per-shader-type mapping overrides; see docs).
 * @returns {Promise<import('../../index.d.ts').ProcessResult[]>}
 * @throws {import('../../index.d.ts').KmpParseError} When the archive is
 *   malformed, exceeds the size cap, or contains no MTL.
 */
export async function process(input, options = {}) {
  const extractions = await extractKmp(input, options)
  const now = new Date().toISOString()
  const sourceFile = typeof input === 'string' ? input : null
  const includeHexDump = options.includeHexDump !== false
  const includeCoverage = options.includeCoverage !== false
  const results = []

  for (const { mtlName, mtlExtraction, textures, xmlConfig } of extractions) {
    const subColors = mtlExtraction.subShaderRegion?.colorSlots ?? new Map()
    const { materialDefinition, warnings: mapWarnings } = buildMaterialDefinition(
      mtlExtraction.rawParameters, mtlExtraction.shaderType, subColors, options,
    )
    autoAssignTextures(materialDefinition, textures)

    const warnings = [...mapWarnings]
    const buf = mtlExtraction.source
    const mtlSize = buf ? buf.byteLength : 0

    const paramHexDump = includeHexDump && buf
      ? hexDump(buf, mtlExtraction.paramSection.start, mtlExtraction.paramSection.end)
      : []
    const tailHexDump = includeHexDump && buf
      ? hexDump(buf, mtlExtraction.footer.start, mtlSize)
      : []

    const coverage = includeCoverage && buf
      ? computeCoverage(buf, mtlExtraction.paramSection.start, mtlExtraction.paramSection.end, mtlExtraction.rawParameters)
      : { claimedBytes: 0, totalBytes: 0, unclaimedBytes: [] }

    results.push({
      meta: {
        sourceFile,
        mtlFile: mtlName,
        mtlSize,
        paramSectionOffset: '0x' + mtlExtraction.paramSection.start.toString(16),
        paramSectionEnd: '0x' + mtlExtraction.paramSection.end.toString(16),
        paramSectionSize: mtlExtraction.paramSection.end - mtlExtraction.paramSection.start,
        tailSectionOffset: '0x' + mtlExtraction.footer.start.toString(16),
        extractedAt: now,
        ...mtlExtraction.header,
      },
      materialName: mtlExtraction.materialName,
      shaderType: mtlExtraction.shaderType,
      png: mtlExtraction.png
        ? {
            bytes: mtlExtraction.png.bytes,
            size: mtlExtraction.png.size,
            startOffset: '0x' + mtlExtraction.png.start.toString(16),
            endOffset: '0x' + mtlExtraction.png.end.toString(16),
          }
        : null,
      rawParameters: mtlExtraction.rawParameters,
      subShaderColors: subColors,
      materialDefinition,
      warnings,
      coverage,
      paramHexDump,
      tailHexDump,
      textures,
      xmlConfig,
    })
  }
  return results
}

/**
 * Report which bytes of an MTL param section were consumed by the parser and
 * which printable runs remain unclaimed (useful for forensics / coverage tests).
 *
 * Uses a bit-packed Uint8Array (one bit per section byte, ~40× smaller than
 * the historical Set<number>). See tests/security/coverage-dos.test.js.
 *
 * @param {Uint8Array} buf Full MTL buffer.
 * @param {number} paramStart Inclusive byte offset of the param section.
 * @param {number} paramEnd Exclusive byte offset of the param section.
 * @param {import('../../index.d.ts').RawParam[]} params Parsed records from the
 *   section — each contributes `nameLen + valueLen` claimed bytes.
 * @returns {import('../../index.d.ts').Coverage} `claimedBytes`, `totalBytes`,
 *   and printable unclaimed runs of length ≥ 3 with their hex offsets.
 */
export function computeCoverage(buf, paramStart, paramEnd, params) {
  const sectionLen = paramEnd - paramStart
  const bitmap = new Uint8Array((sectionLen + 7) >>> 3)
  let claimedBytes = 0
  for (const p of params) {
    let valueLen
    if (p.type === 'color') valueLen = 14
    else if (p.type === 'bool_inferred') valueLen = p.rawLength || 0
    else valueLen = 6
    const nameLen = (p.name || '').length
    const from = Math.max(paramStart, p.offset - nameLen)
    const to = Math.min(paramEnd, p.offset + valueLen)
    for (let b = from; b < to; b++) {
      const rel = b - paramStart
      const byteIdx = rel >>> 3
      const bitMask = 1 << (rel & 7)
      if ((bitmap[byteIdx] & bitMask) === 0) {
        bitmap[byteIdx] |= bitMask
        claimedBytes++
      }
    }
  }
  const unclaimedBytes = []
  let runStart = -1
  for (let i = paramStart; i < paramEnd; i++) {
    const rel = i - paramStart
    const claimedBit = bitmap[rel >>> 3] & (1 << (rel & 7))
    if (claimedBit === 0 && isPrintable(buf[i])) {
      if (runStart === -1) runStart = i
    } else if (runStart !== -1) {
      if (i - runStart >= 3) {
        unclaimedBytes.push({ offset: '0x' + runStart.toString(16), text: readAscii(buf, runStart, i) })
      }
      runStart = -1
    }
  }
  if (runStart !== -1 && paramEnd - runStart >= 3) {
    unclaimedBytes.push({ offset: '0x' + runStart.toString(16), text: readAscii(buf, runStart, paramEnd) })
  }
  return { claimedBytes, totalBytes: sectionLen, unclaimedBytes }
}
