// Full pipeline orchestrator. Resolves input → extracts → maps → assembles
// a ProcessResult per MTL (multi-material archives return length-N array).

import { extractKmp } from '../kmp/kmp-extraction.js'
import { buildMaterialDefinition } from '../lux/lux-extraction.js'
import { autoAssignTextures } from '../kmp/kmp-param-parser.js'
import { hexDump, isPrintable } from '../binary-tools/binary-tools.js'

export { KmpParseError } from './errors.js'

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
      mtlExtraction.rawParameters, mtlExtraction.shaderType, subColors,
    )
    autoAssignTextures(materialDefinition, textures)

    const warnings = [...mapWarnings]
    const buf = mtlExtraction._buf
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

function computeCoverage(buf, paramStart, paramEnd, params) {
  const claimed = new Set()
  for (const p of params) {
    let valueLen
    if (p.type === 'color') valueLen = 14
    else if (p.type === 'bool_inferred') valueLen = p.rawLength || 0
    else valueLen = 6
    const nameLen = (p.name || '').length
    for (let b = p.offset - nameLen; b < p.offset + valueLen; b++) {
      if (b >= 0) claimed.add(b)
    }
  }
  const unclaimedBytes = []
  let run = ''
  let runStart = -1
  for (let i = paramStart; i < paramEnd; i++) {
    if (!claimed.has(i) && isPrintable(buf[i])) {
      if (run === '') runStart = i
      run += String.fromCharCode(buf[i])
    } else {
      if (run.length >= 3) unclaimedBytes.push({ offset: '0x' + runStart.toString(16), text: run })
      run = ''
    }
  }
  if (run.length >= 3) unclaimedBytes.push({ offset: '0x' + runStart.toString(16), text: run })
  return { claimedBytes: claimed.size, totalBytes: paramEnd - paramStart, unclaimedBytes }
}
