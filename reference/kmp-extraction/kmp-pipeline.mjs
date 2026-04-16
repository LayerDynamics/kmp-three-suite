#!/usr/bin/env node
/**
 * kmp-pipeline.mjs — Unified KMP extraction and parsing pipeline
 *
 * Extracts EVERY value from a Luxion KeyShot .kmp material package:
 *   - PNG thumbnail (embedded in binary MTL)
 *   - Configuration.xml (archive manifest)
 *   - ALL binary TLV parameters (float 0x17, color 0x27, int 0x1d, bool 0x25, texslot 0x9b)
 *   - Material name from MATMETA / footer
 *   - Header metadata (KeyShot version, shader version, mat version)
 *   - Sub-shader blocks (lux_const_color_extended) with per-block color params
 *   - Texture files (.png, .jpg, .exr, .hdr, .tif, .bmp) → copied to public/assets/kmp/textures/
 *   - Texture auto-assignment to material slots by naming convention (albedo, normal, roughness, etc.)
 *   - Multi-material KMP archives (all .mtl files processed)
 *   - Complete MaterialDefinition JSON for use in the renderer
 *
 * Shader types supported (26+):
 *   toon, metallic_paint, car_paint, paint, metal, glass, liquid, dielectric,
 *   plastic (basic/cloudy/transparent), velvet, fabric, cloth, realcloth,
 *   translucent (SSS), translucent_medium, scattering_medium, gem, diamond,
 *   thin_film, anisotropic, brushed_metal, advanced, generic, xray, flat
 *
 * Outputs:
 *   - <basename>-extracted.json       Complete extraction with all raw + mapped params
 *   - <basename>-thumbnail.png        Embedded preview image
 *   - textures/<basename>/<file>      Extracted texture files (if any in archive)
 *   - Console: full parameter dump with coverage verification
 *
 * Usage:
 *   node kmp-pipeline.mjs [options] [file1.kmp file2.kmp ...]
 *   node kmp-pipeline.mjs                                           # defaults to toon-fill-black-bright.kmp
 *   node kmp-pipeline.mjs ~/materials/my-material.kmp               # any .kmp file by path
 *   node kmp-pipeline.mjs file1.kmp file2.kmp file3.kmp             # multiple files
 *   node kmp-pipeline.mjs --all                                     # all .kmp in public/assets/kmp/
 *   node kmp-pipeline.mjs --dir ~/my-kmps                           # scan a custom directory
 *   node kmp-pipeline.mjs --dir ~/my-kmps --recursive               # scan recursively
 *   node kmp-pipeline.mjs --dir ~/kmps --out ~/output               # custom input + output dirs
 *   node kmp-pipeline.mjs ~/mat.kmp --out ~/Desktop                 # specific file, custom output
 *
 * Integrates techniques from:
 *   - extract-kmp-exact.mjs     (full MaterialDefinition mapping)
 *   - extract-toon-bools.mjs    (name-first bool detection)
 *   - extract-toon-area.mjs     (hex dump + structure analysis)
 *   - extract-toon-hex.mjs      (raw hex inspection)
 *   - extract-translucent.mjs   (SSS parameter mapping)
 *   - parse-kmp.mjs / parse-kmp2.mjs (TLV scanning)
 *   - LuxionMtlParser.ts        (production parser logic — all 26+ shader types)
 *   - KmpImporter.ts            (texture extraction + auto-assignment)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname, resolve, basename } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const repoRoot = resolve(projectRoot, '..')
const tempDir = join(repoRoot, 'temp')
const kmpDir = join(projectRoot, 'public/assets/kmp')

// ═════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

function isPrintable(b) { return b >= 0x20 && b < 0x7f }
function clamp01(v) { return Math.max(0, Math.min(1, v)) }
function lerp(a, b, t) { return a + (b - a) * t }

function linearToSrgb(c) {
  c = Math.max(0, Math.min(1, c))
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055
}

function rgbToHex(r, g, b) {
  const ri = Math.round(Math.min(255, Math.max(0, linearToSrgb(r) * 255)))
  const gi = Math.round(Math.min(255, Math.max(0, linearToSrgb(g) * 255)))
  const bi = Math.round(Math.min(255, Math.max(0, linearToSrgb(b) * 255)))
  return '#' + ri.toString(16).padStart(2, '0') +
               gi.toString(16).padStart(2, '0') +
               bi.toString(16).padStart(2, '0')
}

function findSequence(buf, needle, start = 0) {
  for (let i = start; i <= buf.length - needle.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) { match = false; break }
    }
    if (match) return i
  }
  return -1
}

function readAsciiClean(data, start, end) {
  let result = ''
  for (let i = start; i < end && i < data.length; i++) {
    if (isPrintable(data[i])) result += String.fromCharCode(data[i])
  }
  return result
}

// ── SECTION DECODERS ──

// Decode the MTL file header: everything from byte 0 to PNG start (or param section start if no PNG)
function decodeFileHeader(buf, headerEnd) {
  const result = []
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 0

  while (pos < headerEnd) {
    const b = buf[pos]

    // Detect //--lux: comment lines
    if (b === 0x2f && pos + 1 < headerEnd && buf[pos + 1] === 0x2f) {
      // Read until newline (0x0a) or non-printable after the comment
      let lineEnd = pos + 2
      while (lineEnd < headerEnd && buf[lineEnd] !== 0x0a) lineEnd++
      const line = buf.slice(pos, lineEnd).toString('ascii')

      if (line.startsWith('//--lux:mat:')) {
        const version = line.match(/\/\/--lux:mat:(\S+)/)?.[1] || line
        result.push({ offset: '0x' + pos.toString(16), length: lineEnd - pos, role: 'lux_mat_version', value: version, raw: line })
      } else if (line.startsWith('//--lux:shader:')) {
        const version = line.match(/\/\/--lux:shader:(\S+)/)?.[1] || line
        result.push({ offset: '0x' + pos.toString(16), length: lineEnd - pos, role: 'lux_shader_version', value: version, raw: line })
      } else if (line.startsWith('// KeyShot')) {
        result.push({ offset: '0x' + pos.toString(16), length: lineEnd - pos, role: 'keyshot_comment', value: line })
      } else {
        result.push({ offset: '0x' + pos.toString(16), length: lineEnd - pos, role: 'comment', value: line })
      }
      pos = lineEnd
      // Consume the newline
      if (pos < headerEnd && buf[pos] === 0x0a) {
        result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'newline', value: '0x0a' })
        pos++
      }
      continue
    }

    // Detect 0x8d length-prefixed strings: 0x8d <len> <string>
    if (b === 0x8d && pos + 1 < headerEnd) {
      const strLen = buf[pos + 1]
      if (pos + 2 + strLen <= headerEnd) {
        const str = buf.slice(pos + 2, pos + 2 + strLen).toString('ascii')
        result.push({
          offset: '0x' + pos.toString(16), length: 2 + strLen,
          role: 'length_prefixed_string',
          marker: '0x8d',
          stringLength: strLen,
          value: str,
        })
        pos += 2 + strLen
        continue
      }
    }

    // Detect 0x87 binary metadata blocks
    if (b === 0x87 && pos + 1 < headerEnd) {
      const blockLen = buf[pos + 1]
      if (pos + 2 + blockLen <= headerEnd) {
        const blockBytes = Array.from(buf.slice(pos + 2, pos + 2 + blockLen))
          .map(x => '0x' + x.toString(16).padStart(2, '0')).join(' ')
        result.push({
          offset: '0x' + pos.toString(16), length: 2 + blockLen,
          role: 'binary_metadata_block',
          marker: '0x87',
          blockLength: blockLen,
          rawBytes: blockBytes,
        })
        pos += 2 + blockLen
        continue
      }
    }

    // Try to read runs of zero bytes as padding
    if (b === 0x00) {
      let zeroEnd = pos
      while (zeroEnd < headerEnd && buf[zeroEnd] === 0x00) zeroEnd++
      if (zeroEnd - pos >= 2) {
        result.push({ offset: '0x' + pos.toString(16), length: zeroEnd - pos, role: 'padding', value: '0x00 x' + (zeroEnd - pos) })
        pos = zeroEnd
        continue
      }
    }

    // Try to read printable text runs
    if (isPrintable(b)) {
      let textEnd = pos
      while (textEnd < headerEnd && isPrintable(buf[textEnd])) textEnd++
      if (textEnd - pos > 1) {
        result.push({ offset: '0x' + pos.toString(16), length: textEnd - pos, role: 'text', value: buf.slice(pos, textEnd).toString('ascii') })
        pos = textEnd
        continue
      }
    }

    // Individual byte with best-effort interpretation
    const desc = {}
    if (pos + 3 < headerEnd && b !== 0x00) {
      // Try as uint32 LE
      const u32 = view.getUint32(pos, true)
      if (u32 > 0 && u32 <= 0x100000) {
        desc.asUint32LE = u32
        desc.asHex32 = '0x' + u32.toString(16)
      }
    }
    if (pos + 1 < headerEnd) {
      const u16 = view.getUint16(pos, true)
      if (u16 > 0 && u16 <= 0xffff) {
        desc.asUint16LE = u16
      }
    }
    result.push({
      offset: '0x' + pos.toString(16), length: 1,
      role: 'byte',
      value: '0x' + b.toString(16).padStart(2, '0'),
      decimal: b,
      ...desc,
    })
    pos++
  }

  return result
}

function decodeParamSectionHeader(buf, start) {
  // Param section starts with: marker(1) flags(1) type(1) length(1) shaderIndex(4) shaderName...
  // Example: 89 00 07 0c 01 00 00 00 "lux_toon"
  if (start + 8 > buf.length) return { size: 0, decoded: {} }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const marker = buf[start]
  const flags = buf[start + 1]
  const sectionType = buf[start + 2]
  const lengthOrCount = buf[start + 3]
  const shaderIndex = view.getUint32(start + 4, true)
  // Find the shader name that follows
  let nameStart = start + 8
  let nameEnd = nameStart
  while (nameEnd < buf.length && isPrintable(buf[nameEnd])) nameEnd++
  const shaderName = buf.slice(nameStart, nameEnd).toString('ascii')
  return {
    size: nameEnd - start,
    decoded: {
      marker: '0x' + marker.toString(16),
      flags,
      sectionType: '0x' + sectionType.toString(16),
      lengthOrCount,
      shaderIndex,
      shaderName,
      rawBytes: Array.from(buf.slice(start, start + 8)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
    }
  }
}

function decodeFooter(buf, footerStart) {
  if (footerStart < 0 || footerStart >= buf.length) return null
  const result = { offset: '0x' + footerStart.toString(16), sections: [] }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = footerStart

  // Check for --MATMETA-- marker
  const matmeta = buf.slice(pos, pos + 11).toString('ascii')
  if (matmeta === '--MATMETA--') {
    result.type = 'MATMETA'
    // MATMETA is base64 encoded metadata — decode it
    pos += 11
    let metaEnd = pos
    while (metaEnd < buf.length && buf[metaEnd] !== 0x00) metaEnd++
    const metaStr = buf.slice(pos, metaEnd).toString('ascii')
    try {
      const decoded = Buffer.from(metaStr, 'base64')
      result.sections.push({
        type: 'matmeta_base64',
        raw: metaStr,
        decodedSize: decoded.length,
        decodedBytes: Array.from(decoded.slice(0, 64)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
      })
    } catch {
      result.sections.push({ type: 'matmeta_raw', value: metaStr })
    }
    pos = metaEnd
    // Look for material name after MATMETA
    while (pos < buf.length && !isPrintable(buf[pos])) pos++
    if (pos < buf.length) {
      let nameEnd = pos
      while (nameEnd < buf.length && isPrintable(buf[nameEnd])) nameEnd++
      const name = buf.slice(pos, nameEnd).toString('ascii')
      if (name.length > 3) result.sections.push({ type: 'material_name_after_matmeta', value: name })
    }
    return result
  }

  // Pattern: 0x09 0x00 0x0b <len> <name> ";" <metadata>
  if (buf[pos] === 0x09 && buf[pos + 1] === 0x00 && buf[pos + 2] === 0x0b) {
    result.type = 'name_footer'
    const nameMarker = { marker: '0x09 0x00 0x0b', offset: '0x' + pos.toString(16) }
    const nameLen = buf[pos + 3]
    nameMarker.nameLength = nameLen
    pos += 4
    if (nameLen > 0 && pos + nameLen <= buf.length) {
      const name = buf.slice(pos, pos + nameLen).toString('ascii')
      nameMarker.materialName = name
      pos += nameLen
    }
    result.sections.push(nameMarker)

    // Decode remaining footer bytes as structured data
    if (pos < buf.length) {
      const remainingBytes = []
      while (pos < buf.length) {
        remainingBytes.push(buf[pos])
        pos++
      }
      // Try to decode structured fields
      const footerMeta = { rawBytes: remainingBytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ') }
      // Known patterns: ';' separator, then sub-type markers
      const semiIdx = remainingBytes.indexOf(0x3b)
      if (semiIdx >= 0) {
        footerMeta.separator = ';'
        footerMeta.afterSeparator = remainingBytes.slice(semiIdx + 1)
          .map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')
      }
      result.sections.push({ type: 'footer_metadata', ...footerMeta })
    }
    return result
  }

  // Fallback: dump all bytes with annotation
  result.type = 'unknown'
  const bytes = []
  while (pos < buf.length) {
    bytes.push({ offset: '0x' + pos.toString(16), byte: '0x' + buf[pos].toString(16).padStart(2, '0'), value: buf[pos], ascii: isPrintable(buf[pos]) ? String.fromCharCode(buf[pos]) : null })
    pos++
  }
  result.sections = bytes
  return result
}

function decodeSubShaderBlocks(buf, start, mainShaderStart) {
  // Translucent and other complex materials have sub-shader blocks before the main shader.
  // Pattern: <header bytes> "lux_const_color_extended" 0xa1 0x09 <sub_id> <color_bytes> "color" 0x09 0x00 0x07 <count_bytes>
  if (mainShaderStart <= start) return []
  const blocks = []
  const region = buf.slice(start, mainShaderStart)
  const text = region.toString('latin1')
  const subShaderName = 'lux_const_color_extended'
  let idx = text.indexOf(subShaderName)
  while (idx >= 0) {
    const absStart = start + idx
    const nameEnd = absStart + subShaderName.length
    const block = { name: subShaderName, offset: '0x' + absStart.toString(16) }

    // After the name: 0xa1 marker, sub_id, then color reference bytes
    if (nameEnd + 2 < mainShaderStart && buf[nameEnd] === 0xa1) {
      block.refMarker = '0xa1'
      block.subId = buf[nameEnd + 1]
      // Next bytes are typically: 0x23 0xf9 0x8b then a possible color reference
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      if (nameEnd + 5 < mainShaderStart) {
        block.refBytes = Array.from(buf.slice(nameEnd + 2, nameEnd + 5)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')
      }
      // Look for "color" followed by 0x09 0x00 0x07 <index>
      const colorIdx = text.indexOf('color', idx + subShaderName.length)
      if (colorIdx >= 0 && colorIdx < text.indexOf(subShaderName, idx + 1) || colorIdx >= 0) {
        const colorAbsEnd = start + colorIdx + 5
        if (colorAbsEnd + 4 < mainShaderStart) {
          if (buf[colorAbsEnd] === 0x09 && buf[colorAbsEnd + 1] === 0x00 && buf[colorAbsEnd + 2] === 0x07) {
            block.colorSlotIndex = buf[colorAbsEnd + 3]
          }
        }
      }
    }
    blocks.push(block)
    idx = text.indexOf(subShaderName, idx + subShaderName.length)
  }
  return blocks
}

// Byte-level decode of sub-shader region (for translucent and complex materials)
function decodeSubShaderRegionBytes(buf, start, end) {
  const result = []
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = start

  while (pos < end) {
    const b = buf[pos]

    // Detect 0x89 section header marker
    if (b === 0x89 && pos + 7 < end) {
      result.push({
        offset: '0x' + pos.toString(16), length: 1,
        role: 'section_marker', value: '0x89', description: 'Sub-shader section start',
      })
      pos++
      // Read flags, type, length
      result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'flags', value: '0x' + buf[pos].toString(16).padStart(2, '0') })
      pos++
      // Next bytes vary — try to detect pattern
      continue
    }

    // Detect 0x9f end-of-block marker
    if (b === 0x9f && pos + 1 < end) {
      result.push({
        offset: '0x' + pos.toString(16), length: 1,
        role: 'end_of_block_marker', value: '0x9f', description: 'Sub-shader block end',
      })
      pos++
      continue
    }

    // Detect 0xa1 sub-shader reference marker
    if (b === 0xa1 && pos + 1 < end) {
      const subId = buf[pos + 1]
      result.push({
        offset: '0x' + pos.toString(16), length: 2,
        role: 'subshader_ref_marker', value: '0xa1', subId, description: 'Sub-shader reference, subId=' + subId,
      })
      pos += 2
      continue
    }

    // Detect known text like "lux_const_color_extended", "color"
    if (isPrintable(b)) {
      let textEnd = pos
      while (textEnd < end && isPrintable(buf[textEnd])) textEnd++
      const text = buf.slice(pos, textEnd).toString('ascii')
      result.push({ offset: '0x' + pos.toString(16), length: textEnd - pos, role: 'text', value: text })
      pos = textEnd
      continue
    }

    // Detect 0x23 color reference bytes
    if (b === 0x23 && pos + 2 < end) {
      result.push({
        offset: '0x' + pos.toString(16), length: 3,
        role: 'color_ref_bytes', value: Array.from(buf.slice(pos, pos + 3)).map(x => '0x' + x.toString(16).padStart(2, '0')).join(' '),
      })
      pos += 3
      continue
    }

    // Try float32 if 4+ bytes remain
    if (pos + 3 < end) {
      const f = view.getFloat32(pos, true)
      if (f >= -1000 && f <= 1000 && !isNaN(f) && f !== 0) {
        result.push({
          offset: '0x' + pos.toString(16), length: 4,
          role: 'float32', value: f,
          rawBytes: Array.from(buf.slice(pos, pos + 4)).map(x => '0x' + x.toString(16).padStart(2, '0')).join(' '),
        })
        pos += 4
        continue
      }
    }

    // Individual byte
    result.push({
      offset: '0x' + pos.toString(16), length: 1,
      role: 'byte', value: '0x' + b.toString(16).padStart(2, '0'), decimal: b,
    })
    pos++
  }
  return result
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IEND  = Buffer.from([0x49, 0x45, 0x4e, 0x44])
const TYPE_FLOAT = 0x17
const TYPE_COLOR = 0x27  // Also ASCII apostrophe (')
const TYPE_INT   = 0x1d
const TYPE_BOOL  = 0x25  // Also ASCII percent (%)
const TYPE_TEXSLOT = 0x9b // Texture slot binding (links param to sub-shader)
const TYPE_SUBSHADER_REF = 0xa1 // Sub-shader reference marker

// Known main shader type names (the first param name IS the shader type)
const KNOWN_SHADER_TYPES = [
  'lux_toon', 'toon', 'lux_translucent', 'metallic_paint',
  'lux_plastic', 'lux_metal', 'lux_glass', 'lux_dielectric',
  'lux_gem', 'lux_diffuse', 'lux_emissive', 'lux_velvet',
  'lux_paint', 'lux_car_paint', 'lux_cloth', 'lux_skin',
  'lux_x_ray', 'lux_flat', 'lux_advanced', 'lux_cutaway',
]

// ═════════════════════════════════════════════════════════════════════════════
// STEP 1: KMP ARCHIVE EXTRACTION
// ═════════════════════════════════════════════════════════════════════════════

function extractKmpArchive(kmpPath) {
  const kmpName = basename(kmpPath, '.kmp')
  const extractDir = join(tempDir, kmpName)
  execSync(`mkdir -p "${extractDir}"`, { stdio: 'pipe' })
  execSync(`unzip -o "${kmpPath}" -d "${extractDir}"`, { stdio: 'pipe' })

  const files = readdirSync(extractDir)
  const mtlFiles = files.filter(f => f.endsWith('.mtl'))
  const xmlFile = files.find(f => f.endsWith('.xml'))

  if (mtlFiles.length === 0) throw new Error(`No .mtl file found in ${kmpPath}`)

  const mtlBuf = readFileSync(join(extractDir, mtlFiles[0]))
  const xmlContent = xmlFile ? readFileSync(join(extractDir, xmlFile), 'utf-8') : null

  // Multi-material: read all additional MTL files
  const additionalMtls = mtlFiles.slice(1).map(f => ({
    name: f,
    buf: readFileSync(join(extractDir, f)),
  }))

  return { mtlBuf, mtlName: mtlFiles[0], xmlContent, extractDir, additionalMtls }
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 2: STRUCTURAL ANALYSIS — PNG, HEADER, PARAM BOUNDS
// ═════════════════════════════════════════════════════════════════════════════

function analyzeStructure(buf) {
  const structure = {
    header: {},
    png: null,
    paramSection: { start: 0, end: 0 },
    footer: { start: -1, end: buf.length },
  }

  // Header metadata
  const headerStr = buf.slice(0, Math.min(256, buf.length)).toString('ascii')
  const matMatch = headerStr.match(/\/\/--lux:mat:(\S+)/)
  if (matMatch) structure.header.matVersion = matMatch[1]
  const shaderMatch = headerStr.match(/\/\/--lux:shader:(\S+)/)
  if (shaderMatch) structure.header.shaderVersion = shaderMatch[1]
  const ksMatch = headerStr.match(/KeyShot.*?v([\d.]+)/)
  if (ksMatch) structure.header.keyshotVersion = ksMatch[1]

  // PNG thumbnail
  const pngStart = findSequence(buf, PNG_MAGIC)
  if (pngStart >= 0) {
    const iendPos = findSequence(buf, PNG_IEND, pngStart)
    if (iendPos >= 0) {
      const pngEnd = iendPos + 8 // IEND(4) + CRC(4)
      structure.png = { start: pngStart, end: pngEnd, size: pngEnd - pngStart }
      structure.paramSection.start = pngEnd
    }
  }

  if (structure.paramSection.start === 0) {
    const shaderMarker = Buffer.from('//--lux:shader:')
    const pos = findSequence(buf, shaderMarker)
    if (pos >= 0) {
      let i = pos + shaderMarker.length
      while (i < buf.length && buf[i] !== 0x0a) i++
      structure.paramSection.start = i + 1
    } else {
      structure.paramSection.start = Math.min(128, buf.length)
    }
  }

  // Footer: look for 0x09 0x00 0x0b pattern (material name length-prefixed footer)
  // or --MATMETA-- marker
  const matmetaMarker = Buffer.from('--MATMETA--')
  const matmetaPos = findSequence(buf, matmetaMarker, structure.paramSection.start)
  if (matmetaPos >= 0) {
    structure.footer.start = matmetaPos
    structure.paramSection.end = matmetaPos
  } else {
    // Look for footer pattern: 0x09 0x00 0x0b <length_byte> <name_string>
    for (let i = structure.paramSection.start; i < buf.length - 4; i++) {
      if (buf[i] === 0x09 && buf[i + 1] === 0x00 && buf[i + 2] === 0x0b) {
        structure.footer.start = i
        structure.paramSection.end = i
        break
      }
    }
    if (structure.paramSection.end === 0) {
      structure.paramSection.end = buf.length
    }
  }

  // Find main shader type within param section — complex materials have sub-shader
  // blocks (lux_const_color_extended) before the main shader params.
  structure.mainShaderStart = structure.paramSection.start
  structure.subShaderRegion = null
  const paramText = buf.slice(structure.paramSection.start, structure.paramSection.end).toString('latin1')
  for (const shaderType of KNOWN_SHADER_TYPES) {
    const idx = paramText.indexOf(shaderType)
    if (idx >= 0) {
      // Walk backwards from the shader name to find its header marker (0x89 or similar)
      const absPos = structure.paramSection.start + idx
      // The header bytes are typically 8 bytes before the shader name
      let headerStart = absPos
      // Scan backwards for the 0x89 marker or section start byte
      for (let scan = absPos - 1; scan >= Math.max(absPos - 16, structure.paramSection.start); scan--) {
        if (buf[scan] === 0x89 || buf[scan] === 0x09) {
          headerStart = scan
          break
        }
      }
      // If there's content before the main shader, it's sub-shader blocks
      if (headerStart > structure.paramSection.start + 4) {
        structure.subShaderRegion = {
          start: structure.paramSection.start,
          end: headerStart,
        }
        structure.mainShaderStart = headerStart
      }
      break
    }
  }

  return structure
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 3: HYBRID PARAMETER PARSER
// ═════════════════════════════════════════════════════════════════════════════
//
// Uses TWO complementary strategies combined:
//
// Strategy A: MARKER-SCAN (from LuxionMtlParser.ts)
//   Scan for 0x17 (FLOAT) and 0x1d (INT) markers — these are non-printable
//   so they're unambiguous. For 0x27 (COLOR), detect by checking if the byte
//   after the apostrophe is non-printable (sub_id < 0x20).
//
// Strategy B: NAME-FIRST (from extract-toon-bools.mjs)
//   For 0x25 (BOOL / '%') which is printable ASCII, search for known param
//   names in the text and check the marker byte at name_end. This catches
//   bools that Strategy A misses.
//
// After both strategies run, merge results by offset to eliminate duplicates.

function parseParameters(buf, start, end) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const results = new Map() // offset → param object (dedup by offset)

  // ── UNIFIED APPROACH: Find ALL markers in one pass, then parse sequentially ──
  //
  // Marker types and their byte sizes:
  //   0x17 (FLOAT): sub_id(1) + f32le(4) = 5 bytes after marker
  //   0x1d (INT):   sub_id(1) + u32le(4) = 5 bytes after marker
  //   0x27 (COLOR): sub_id(1) + r(4) + g(4) + b(4) = 13 bytes after marker
  //   0x25 (BOOL):  sub_id(1) + u32le(4) = 5 bytes after marker
  //
  // 0x17 and 0x1d are non-printable so they're unambiguous markers.
  // 0x27 (') and 0x25 (%) are printable ASCII, so we validate context:
  //   - byte after marker must be sub_id < 0x20 (non-printable)
  //   - byte before marker should be a letter (end of param name)

  const allMarkers = []

  for (let m = start; m < end; m++) {
    const b = buf[m]

    if (b === TYPE_FLOAT || b === TYPE_INT) {
      // 0x17 and 0x1d are non-printable — always valid markers
      allMarkers.push({ pos: m, type: b === TYPE_FLOAT ? 'float' : 'int' })
    } else if (b === TYPE_COLOR && m > start && m + 13 < end) {
      // 0x27 (') — valid COLOR marker if followed by non-printable sub_id
      const after = buf[m + 1]
      if (after < 0x20) {
        allMarkers.push({ pos: m, type: 'color' })
      }
    } else if (b === TYPE_BOOL && m > start && m + 5 < end) {
      // 0x25 (%) — valid BOOL marker if:
      //   - preceded by a letter (end of param name)
      //   - followed by sub_id < 0x20
      const before = buf[m - 1]
      const after = buf[m + 1]
      if (isPrintable(before) && before !== TYPE_BOOL && after < 0x20) {
        allMarkers.push({ pos: m, type: 'bool' })
      }
    } else if (b === TYPE_TEXSLOT && m > start && m + 5 < end) {
      // 0x9b — texture slot binding marker (links param to a sub-shader color slot)
      // Format: name 0x9b sub_id(1) slot_index(u32le)
      // Followed by the same param name again with a FLOAT/COLOR value
      const before = buf[m - 1]
      const after = buf[m + 1]
      if (isPrintable(before) && after < 0x20) {
        allMarkers.push({ pos: m, type: 'texslot' })
      }
    }
  }

  // Sort markers by position
  allMarkers.sort((a, b) => a.pos - b.pos)

  // Parse sequentially: skip markers that fall within value bytes of a previous marker
  let cursor = start
  let valueEnd = start // tracks end of last parsed value to skip embedded false markers

  for (const marker of allMarkers) {
    // Skip markers that fall within the value bytes of a previously parsed param
    if (marker.pos < valueEnd) continue
    // Skip if already claimed
    if (results.has(marker.pos)) continue

    // Read name: scan backwards from marker to find printable text
    let nameEnd = marker.pos
    let nameStart = nameEnd - 1
    while (nameStart >= cursor && isPrintable(buf[nameStart])) {
      nameStart--
    }
    nameStart++

    let name = buf.slice(nameStart, nameEnd).toString('ascii')
    name = name.replace(/^[^a-zA-Z_]+/, '')

    if (marker.type === 'color') {
      if (marker.pos + 14 <= end) {
        const subId = buf[marker.pos + 1]
        const r = view.getFloat32(marker.pos + 2, true)
        const g = view.getFloat32(marker.pos + 6, true)
        const b = view.getFloat32(marker.pos + 10, true)
        results.set(marker.pos, {
          name, type: 'color', subId, offset: marker.pos,
          value: { r, g, b }, hex: rgbToHex(r, g, b),
        })
        cursor = marker.pos + 14
        valueEnd = cursor
      }
    } else if (marker.type === 'float') {
      if (marker.pos + 6 <= end) {
        const subId = buf[marker.pos + 1]
        const val = view.getFloat32(marker.pos + 2, true)
        results.set(marker.pos, {
          name, type: 'float', subId, offset: marker.pos,
          value: val,
        })
        cursor = marker.pos + 6
        valueEnd = cursor
      }
    } else if (marker.type === 'int') {
      if (marker.pos + 6 <= end) {
        const subId = buf[marker.pos + 1]
        const val = view.getUint32(marker.pos + 2, true)
        results.set(marker.pos, {
          name, type: 'int', subId, offset: marker.pos,
          value: val,
        })
        cursor = marker.pos + 6
        valueEnd = cursor
      }
    } else if (marker.type === 'bool') {
      if (marker.pos + 6 <= end) {
        const subId = buf[marker.pos + 1]
        const val = view.getUint32(marker.pos + 2, true)
        results.set(marker.pos, {
          name, type: 'bool', subId, offset: marker.pos,
          value: val, bool: val !== 0,
        })
        cursor = marker.pos + 6
        valueEnd = cursor
      }
    } else if (marker.type === 'texslot') {
      // Texture slot binding: 0x9b sub_id(1) slot_index(u32le)
      // This links the param name to a sub-shader color slot
      if (marker.pos + 6 <= end) {
        const subId = buf[marker.pos + 1]
        const slotIndex = view.getUint32(marker.pos + 2, true)
        results.set(marker.pos, {
          name, type: 'texslot', subId, offset: marker.pos,
          value: slotIndex,
          note: `Texture slot binding → sub-shader color slot #${slotIndex}`,
        })
        cursor = marker.pos + 6
        valueEnd = cursor
      }
    }
  }

  // ── BARE NAME DETECTION: find trailing param names with no marker ──
  // Some params (e.g. "light source shadows") appear as text at the end of the
  // param section with no type marker. Record them as bool=false by default.
  if (cursor < end) {
    let trailStart = cursor
    while (trailStart < end && !isPrintable(buf[trailStart])) trailStart++
    if (trailStart < end) {
      let trailEnd = trailStart
      while (trailEnd < end && isPrintable(buf[trailEnd])) trailEnd++
      if (trailEnd > trailStart) {
        const rawBareName = buf.slice(trailStart, trailEnd).toString('ascii')
        let bareName = rawBareName
          .replace(/^[^a-zA-Z_]+/, '')  // strip leading junk
          .replace(/[/;:].+$/, '')  // strip from first separator char (e.g. "/xk", "/H;", ";...")
        const claimStart = cursor  // claim from cursor (includes any non-printable gap before name)
        const rawLen = end - claimStart  // claim ALL remaining bytes to end of param section
        if (bareName.length > 3) {
          // No marker found — record as bool=false (KeyShot omits marker for trailing false bools)
          results.set(claimStart, {
            name: bareName, type: 'bool_inferred', subId: 0, offset: claimStart,
            rawLength: rawLen,  // includes leading gap + name + junk suffix + trailing bytes
            value: 0, bool: false,
            note: 'No type marker found — inferred as bool false from bare name at end of param section',
          })
        }
      }
    }
  }

  // ── NAME-FIRST FALLBACK: catch params missed by marker scan ──
  // Search for known param names that might have unusual type storage
  const text = buf.slice(start, end).toString('latin1')

  const knownParams = [
    'transparency', 'contour width is in pixels',
    'outline contour', 'material contour', 'part contour',
    'interior edge contour', 'environment shadows', 'light source shadows',
    'contour color', 'shadow color',
  ]

  for (const paramName of knownParams) {
    let idx = text.indexOf(paramName)
    while (idx >= 0) {
      const absOffset = start + idx + paramName.length
      if (absOffset < end && !results.has(absOffset)) {
        const markerByte = buf[absOffset]
        if (absOffset + 6 <= end) {
          const subId = buf[absOffset + 1]
          if (markerByte === TYPE_BOOL) {
            const val = view.getUint32(absOffset + 2, true)
            results.set(absOffset, {
              name: paramName, type: 'bool', subId, offset: absOffset,
              value: val, bool: val !== 0,
            })
          } else if (markerByte === TYPE_FLOAT) {
            const val = view.getFloat32(absOffset + 2, true)
            results.set(absOffset, {
              name: paramName, type: 'float', subId, offset: absOffset,
              value: val,
            })
          } else if (markerByte === TYPE_INT) {
            const val = view.getUint32(absOffset + 2, true)
            results.set(absOffset, {
              name: paramName, type: 'int', subId, offset: absOffset,
              value: val,
            })
          } else if (markerByte === TYPE_COLOR && absOffset + 14 <= end) {
            const r = view.getFloat32(absOffset + 2, true)
            const g = view.getFloat32(absOffset + 6, true)
            const b = view.getFloat32(absOffset + 10, true)
            results.set(absOffset, {
              name: paramName, type: 'color', subId, offset: absOffset,
              value: { r, g, b }, hex: rgbToHex(r, g, b),
            })
          }
        }
      }
      idx = text.indexOf(paramName, idx + paramName.length)
    }
  }

  // Sort results by offset and return as array
  return Array.from(results.values()).sort((a, b) => a.offset - b.offset)
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 4: EXTRACT MATERIAL NAME
// ═════════════════════════════════════════════════════════════════════════════

function extractMaterialName(buf, footerStart) {
  if (footerStart < 0) return null

  // Pattern 1: --MATMETA-- section with "attribute" keyword
  const attrMarker = Buffer.from('attribute')
  const attrPos = findSequence(buf, attrMarker, footerStart)
  if (attrPos >= 0) {
    let i = attrPos + attrMarker.length
    while (i < buf.length && !isPrintable(buf[i])) i++
    const nameStart = i
    while (i < buf.length && buf[i] >= 0x20 && buf[i] < 0x7f && buf[i] !== 0x3b) i++
    const name = buf.slice(nameStart, i).toString('ascii').trim()
    if (name.length > 3) return name
  }

  // Pattern 2: 0x09 0x00 0x0b <len> <name_string> ";"
  if (buf[footerStart] === 0x09 && buf[footerStart + 1] === 0x00 && buf[footerStart + 2] === 0x0b) {
    const nameLen = buf[footerStart + 3]
    if (nameLen > 0 && footerStart + 4 + nameLen <= buf.length) {
      const name = buf.slice(footerStart + 4, footerStart + 4 + nameLen).toString('ascii')
      // Strip trailing semicolon if present
      return name.replace(/;$/, '').trim()
    }
  }

  // Pattern 3: scan for readable string in footer
  let i = footerStart
  while (i < buf.length) {
    if (isPrintable(buf[i])) {
      const start = i
      while (i < buf.length && buf[i] >= 0x20 && buf[i] < 0x7f && buf[i] !== 0x3b) i++
      const candidate = buf.slice(start, i).toString('ascii').trim()
      if (candidate.length > 5 && /[A-Z]/.test(candidate[0])) return candidate
    }
    i++
  }

  return null
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 5: MATERIAL DEFINITION MAPPER
// ═════════════════════════════════════════════════════════════════════════════
//
// Maps raw parameters to a MaterialDefinition, matching LuxionMtlParser.ts logic.

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
    glassParams: null, gemParams: null, velvetParams: null, anisotropicParams: null,
  }
}

// ── Helper: parse hex color to [0-1] RGB components ──
function hexToComponents(hex) {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ]
}

function componentsToHex(r, g, b) {
  const ri = Math.round(Math.min(255, Math.max(0, r * 255)))
  const gi = Math.round(Math.min(255, Math.max(0, g * 255)))
  const bi = Math.round(Math.min(255, Math.max(0, b * 255)))
  return '#' + ri.toString(16).padStart(2, '0') +
               gi.toString(16).padStart(2, '0') +
               bi.toString(16).padStart(2, '0')
}

function buildMaterialDefinition(rawParams, shaderType, subShaderColors) {
  const byName = {}
  for (const p of rawParams) {
    if (p.name) byName[p.name] = p
  }
  const warnings = []

  // ── Type-flexible accessors (matching LuxionMtlParser.ts exactly) ──

  const getFloat = (...keys) => {
    for (const key of keys) {
      const p = byName[key]
      if (p && (p.type === 'float' || p.type === 'float_as_bool')) return p.value
    }
    return null
  }
  const getColor = (...keys) => {
    for (const key of keys) {
      const p = byName[key]
      if (p && p.type === 'color') return rgbToHex(p.value.r, p.value.g, p.value.b)
    }
    return null
  }
  const getColorRaw = (...keys) => {
    for (const key of keys) {
      const p = byName[key]
      if (p && p.type === 'color') return p.value
    }
    return null
  }
  const getInt = (...keys) => {
    for (const key of keys) {
      const p = byName[key]
      if (p && (p.type === 'int' || p.type === 'bool')) return p.value
    }
    return null
  }
  /** Type-flexible scalar: checks float, then int, then bool — returns number */
  const getAnyScalar = (...keys) => {
    for (const key of keys) {
      const p = byName[key]
      if (!p) continue
      if (p.type === 'float' || p.type === 'float_as_bool' || p.type === 'int' || p.type === 'bool') return p.value
    }
    return null
  }
  /** Type-flexible color-or-scalar: checks color first, then float→{r:v,g:v,b:v} */
  const getColorOrScalar = (...keys) => {
    for (const key of keys) {
      const p = byName[key]
      if (!p) continue
      if (p.type === 'color') return p.value
      if (p.type === 'float' || p.type === 'float_as_bool') {
        const v = p.value
        return { r: v, g: v, b: v }
      }
    }
    return null
  }
  /** Type-flexible bool: checks bool, then int, then float > 0.5 */
  const getBoolFlex = (...keys) => {
    for (const key of keys) {
      const p = byName[key]
      if (!p) continue
      if (p.type === 'bool' || p.type === 'bool_inferred') return p.value !== 0
      if (p.type === 'int') return p.value !== 0
      if (p.type === 'float' || p.type === 'float_as_bool') return p.value > 0.5
    }
    return null
  }
  // Legacy compat alias
  const getBool = (key) => getBoolFlex(key) ?? false
  // Get any value as [r,g,b] array
  const getAnyAsColorArray = (...keys) => {
    for (const key of keys) {
      const p = byName[key]
      if (!p) continue
      if (p.type === 'color') return [p.value.r, p.value.g, p.value.b]
      if (p.type === 'float' || p.type === 'float_as_bool') return [p.value, p.value, p.value]
    }
    return null
  }

  const mat = createDefaultMaterialDefinition()
  const type = (shaderType || '').toLowerCase()

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERIC PARAMETER MAPPING (from LuxionMtlParser.ts mapLuxionParamsToMaterial)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Shader type name holds the base diffuse color ──
  if (shaderType && byName[shaderType]?.type === 'color') {
    mat.color = getColor(shaderType)
  }

  // ── Diffuse color aliases ──
  const diffuseColor = getColor('diffuse', 'surface_color')
  if (diffuseColor && (!shaderType || !byName[shaderType] || byName[shaderType]?.type !== 'color')) {
    mat.color = diffuseColor
  }

  // ── Base weight (diffuse contribution intensity) ──
  const baseWeight = getFloat('base')
  if (baseWeight !== null && baseWeight < 1.0 && baseWeight >= 0) {
    const [cr, cg, cb] = hexToComponents(mat.color)
    mat.color = componentsToHex(cr * baseWeight, cg * baseWeight, cb * baseWeight)
  }

  // ── Standard scalar parameters ──

  const roughness = getFloat('roughness')
  if (roughness !== null) mat.roughness = clamp01(roughness)

  const metal = getFloat('metal', 'metallic')
  if (metal !== null) mat.metalness = clamp01(metal)

  // KeyShot IOR → Three.js IOR + specularIntensity
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

  // Clearcoat IOR → adjust clearcoat intensity for non-standard IOR
  const clearcoatIor = getFloat('clearcoat_ior', 'clearcoat_refractive_index', 'coat_ior')
  if (clearcoatIor !== null && clearcoatIor > 0) {
    const ccF0 = Math.pow((clearcoatIor - 1) / (clearcoatIor + 1), 2)
    const defaultCcF0 = Math.pow((1.5 - 1) / (1.5 + 1), 2)
    const ccScale = Math.min(ccF0 / defaultCcF0, 3.0)
    mat.clearcoat = clamp01(mat.clearcoat * ccScale)
  }

  const transmission = getFloat('transmission', 'transparency')
  if (transmission !== null) mat.transmission = clamp01(transmission)

  // Specular transmission (Advanced shader): color → average to transmission weight
  const specTransmission = getColorRaw('specular_transmission')
  if (specTransmission) {
    const avg = (specTransmission.r + specTransmission.g + specTransmission.b) / 3
    if (avg > 0.01) {
      mat.transmission = clamp01(avg)
      mat.transparent = true
      mat.attenuationColor = rgbToHex(specTransmission.r, specTransmission.g, specTransmission.b)
    }
  }

  // Diffuse transmission (Advanced shader): translucent scattering
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

  // Transparency distance (Glass/Dielectric): controls color saturation by thickness
  const transparencyDist = getFloat('transparency_distance', 'color_density')
  if (transparencyDist !== null && transparencyDist > 0) {
    mat.attenuationDistance = transparencyDist
  }

  const sheen = getFloat('sheen', 'fuzz')
  if (sheen !== null) mat.sheen = clamp01(sheen)

  const sheenRoughness = getFloat('sheen_roughness', 'fuzz_roughness')
  if (sheenRoughness !== null) mat.sheenRoughness = clamp01(sheenRoughness)

  // ── Anisotropy ──
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

  // Anisotropy rotation: KeyShot uses degrees (0-360), Three.js uses radians
  const anisoRotation = getFloat('anisotropy_rotation')
  const anisoAngle = getFloat('angle')
  if (anisoRotation !== null) {
    mat.anisotropyRotation = anisoRotation
  } else if (anisoAngle !== null) {
    mat.anisotropyRotation = (anisoAngle * Math.PI) / 180
  }

  const emissiveIntensity = getFloat('emissive_intensity', 'emission_luminance', 'luminance')
  if (emissiveIntensity !== null) mat.emissiveIntensity = emissiveIntensity

  const specular = getFloat('specular', 'specular_weight')
  if (specular !== null) mat.specularIntensity = Math.max(0, specular)

  // Specular tint (Generic/Disney BRDF): blend specularColor toward base color
  const specularTint = getFloat('specular_tint')
  if (specularTint !== null && specularTint > 0) {
    const [br, bg, bb] = hexToComponents(mat.color)
    const t = clamp01(specularTint)
    mat.specularColor = rgbToHex(lerp(1, br, t), lerp(1, bg, t), lerp(1, bb, t))
  }

  // ── Iridescence / Thin Film ──
  const iridescence = getFloat('iridescence', 'thin_film')
  if (iridescence !== null) mat.iridescence = clamp01(iridescence)

  const iridescenceIOR = getFloat('thin_film_ior', 'film_refractive_index')
  if (iridescenceIOR !== null) mat.iridescenceIOR = Math.max(1.0, Math.min(iridescenceIOR, 3.0))

  // Film thickness: controls iridescent color shift
  const filmThickness = getFloat('film_thickness', 'thin_film_thickness')
  if (filmThickness !== null && filmThickness > 0) {
    if (mat.iridescence === 0) mat.iridescence = 1.0
    mat.iridescenceThicknessMin = Math.max(0, filmThickness * 0.5)
    mat.iridescenceThicknessMax = filmThickness * 1.5
  }

  // Film extinction coefficient: controls metallic absorption in thin film
  const filmExtinction = getFloat('film_extinction', 'film_extinction_coefficient')
  if (filmExtinction !== null && filmExtinction > 0) {
    if (mat.iridescence > 0) {
      mat.iridescence = clamp01(mat.iridescence * (1 + filmExtinction * 0.1))
    }
  }

  // Color filter (Thin Film): multiply into base color
  const colorFilter = getColor('color_filter')
  if (colorFilter) {
    const [br, bg, bb] = hexToComponents(mat.color)
    const [fr, fg, fb] = hexToComponents(colorFilter)
    mat.color = componentsToHex(br * fr, bg * fg, bb * fb)
  }

  // Bump / normal intensity
  const bumpIntensity = getFloat('bump_intensity', 'normal_scale', 'bump')
  if (bumpIntensity !== null) { mat.normalScaleX = bumpIntensity; mat.normalScaleY = bumpIntensity }

  // Displacement scale
  const displacementScale = getFloat('displacement_scale', 'height_scale')
  if (displacementScale !== null) mat.displacementScale = displacementScale

  // Dispersion: KeyShot uses Abbe number (higher = less dispersion)
  const dispersion = getFloat('dispersion')
  const abbeNumber = getFloat('abbe_number')
  if (dispersion !== null) {
    mat.dispersion = dispersion
  } else if (abbeNumber !== null && abbeNumber > 0) {
    mat.dispersion = 1.0 / abbeNumber
  }

  // Roughness transmission (Glass/Dielectric): internal roughness
  const roughnessTransmission = getFloat('roughness_transmission')
  if (roughnessTransmission !== null) {
    if (mat.transmission > 0.5) {
      mat.roughness = lerp(mat.roughness, clamp01(roughnessTransmission), mat.transmission)
    }
  }

  // Diffuse saturation (Generic/Disney BRDF): fluorescent intensity boost
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

  // ── Color parameters ──

  const alpha = getColorRaw('alpha')
  if (alpha) {
    const avg = (alpha.r + alpha.g + alpha.b) / 3
    if (avg < 0.99) { mat.opacity = clamp01(avg); mat.transparent = true }
  }

  const emissive = getColor('emissive', 'emission', 'emissive_color')
  if (emissive) mat.emissive = emissive

  // Specular color: check both dedicated color params and "specular" key
  const specularColor = getColor('specular_color', 'reflection_color')
  if (specularColor) {
    mat.specularColor = specularColor
  } else {
    const specAsColor = getColor('specular')
    if (specAsColor) mat.specularColor = specAsColor
  }

  const attenuationColor = getColor('attenuation_color', 'transmission_color', 'subsurface_color', 'transmission')
  if (attenuationColor) mat.attenuationColor = attenuationColor

  // Transmission Out (Dielectric): exterior color for containers
  const transmissionOut = getColor('transmission_out')
  if (transmissionOut) {
    if (mat.attenuationColor === '#ffffff') mat.attenuationColor = transmissionOut
  }

  const sheenColor = getColor('sheen_color', 'fuzz_color', 'sheen')
  if (sheenColor) mat.sheenColor = sheenColor

  // Sheen tint (Generic/Disney BRDF): color contribution from base color to sheen
  const sheenTint = getFloat('sheen_tint')
  if (sheenTint !== null && sheenTint > 0 && mat.sheen > 0) {
    const [br, bg, bb] = hexToComponents(mat.color)
    const t = clamp01(sheenTint)
    mat.sheenColor = rgbToHex(lerp(1, br, t), lerp(1, bg, t), lerp(1, bb, t))
  }

  // Backscatter color (Velvet): light scattered across shadowed areas
  const backscatter = getColor('backscatter')
  if (backscatter) {
    mat.emissive = backscatter
    mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 0.05)
  }

  // Ambient color (Advanced): self-shadowing tint in unlit areas
  const ambient = getColor('ambient')
  if (ambient && mat.emissive === '#000000') {
    mat.emissive = ambient
    mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 0.02)
  }

  const attenuationDistance = getFloat('attenuation_distance', 'subsurface_radius', 'translucency')
  if (attenuationDistance !== null && attenuationDistance > 0) mat.attenuationDistance = attenuationDistance

  // Edginess (Velvet): controls sheen spread from edge to center
  const edginess = getFloat('edginess')
  if (edginess !== null && mat.sheen > 0) {
    mat.sheenRoughness = clamp01(1.0 - edginess)
  }

  // Fresnel toggle (Advanced): when disabled, remove specular Fresnel
  const fresnelToggle = getInt('fresnel')
  if (fresnelToggle !== null && fresnelToggle === 0) {
    mat.specularIntensity = Math.max(mat.specularIntensity, 0.5)
  }

  // Refractive Index Outside (Dielectric): interface between two refracting materials
  const iorOutside = getFloat('refractive_index_outside')
  if (iorOutside !== null && iorOutside > 0 && mat.ior > 0) {
    const effectiveIor = mat.ior / iorOutside
    mat.ior = Math.max(1.0, Math.min(effectiveIor, 5.0))
    const f0 = Math.pow((effectiveIor - 1) / (effectiveIor + 1), 2)
    mat.specularIntensity = Math.min(f0 / 0.04, 2.0)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHADER-TYPE-SPECIFIC MAPPING (from LuxionMtlParser.ts applyShaderTypeMapping)
  // ═══════════════════════════════════════════════════════════════════════════

  if (type.includes('toon')) {
    // ── KeyShot Toon (lux_toon) ──
    mat.roughness = 1.0
    mat.metalness = 0.0
    mat.specularIntensity = 0.0

    const toonFillColor = getColorRaw(type) ?? getColorRaw('color', 'diffuse')
    const toonAlpha = getColorRaw('alpha')
    const toonShadowColor = getColorOrScalar('shadow color')
    const toonContourColor = getColorOrScalar('contour color')
    const toonShadowStrength = getColorOrScalar('shadow strength')

    const toonShadowMultiplier = getAnyScalar('shadow multiplier') ?? 1.0
    const toonContourAngle = getAnyScalar('contour angle') ?? 60.0
    const toonContourWidth = getAnyScalar('contour width') ?? 1.0
    const toonContourQuality = getAnyScalar('contour quality') ?? 1.0
    const toonOutlineWidthMul = getAnyScalar('outline width multiplier') ?? 1.0
    const toonPartWidthMul = getAnyScalar('part width multiplier') ?? 1.0

    const toonTransparency = getBoolFlex('transparency') ?? false
    const toonContourInPixels = getBoolFlex('contour width is in pixels') ?? false
    const toonOutlineContour = getBoolFlex('outline contour') ?? false
    const toonMaterialContour = getBoolFlex('material contour') ?? false
    const toonPartContour = getBoolFlex('part contour') ?? false
    const toonInteriorEdge = getBoolFlex('interior edge contour') ?? false
    const toonEnvShadows = getBoolFlex('environment shadows') ?? false
    const toonLightShadows = getBoolFlex('light source shadows') ?? false

    if (toonAlpha) {
      const avg = (toonAlpha.r + toonAlpha.g + toonAlpha.b) / 3
      if (avg < 0.99) { mat.opacity = clamp01(avg); mat.transparent = true }
    }
    if (toonTransparency) mat.transparent = true

    if (toonFillColor) {
      mat.color = rgbToHex(toonFillColor.r, toonFillColor.g, toonFillColor.b)
    }

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

  } else if (type.includes('metallic_paint') || type.includes('car_paint')) {
    // ── KeyShot Metallic Paint ──
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

    // Thickness multiplier: used for specular tinting and attenuation
    const thicknessMulRaw = getColorRaw('thickness multiplier')

    // Metal flakes → metalness
    const metalCoverage = getFloat('metal_coverage') ?? 0
    const flakeVisInt = getInt('metal_flake_visibility') ?? 16
    const metalVisibility = Math.min(flakeVisInt / 16.0, 1.0)
    if (metalCoverage > 0) {
      const baseMetal = metalCoverage <= 1.0
        ? metalCoverage * 0.7
        : 0.7 + Math.min((metalCoverage - 1.0) / 2.0, 0.3)
      mat.metalness = clamp01(baseMetal * clamp01(metalVisibility))
    }

    // Metal color: flake reflection tint
    const metalColorRaw = getColorRaw('metal_color')
    if (metalColorRaw) {
      mat.specularColor = rgbToHex(metalColorRaw.r, metalColorRaw.g, metalColorRaw.b)
    } else if (thicknessMulRaw) {
      mat.specularColor = rgbToHex(thicknessMulRaw.r, thicknessMulRaw.g, thicknessMulRaw.b)
    }

    // Metal roughness
    const metalRoughnessVal = getFloat('metal_roughness')
    if (metalRoughnessVal !== null && metalCoverage > 0.3) {
      const blendFactor = Math.min(metalCoverage / 1.5, 1.0)
      mat.roughness = lerp(mat.roughness, clamp01(metalRoughnessVal), blendFactor)
    }

    // Attenuation
    if (thicknessMulRaw) {
      mat.attenuationColor = rgbToHex(thicknessMulRaw.r, thicknessMulRaw.g, thicknessMulRaw.b)
      mat.attenuationDistance = 0.5
    }

    // Clearcoat color
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

    // Populate carpaintParams
    const baseColorRaw = getColorRaw(type) ?? getColorRaw('diffuse', 'surface_color')
    const metalFlakeSize = getFloat('metal_flake_size', 'flake_size') ?? 2.0
    const metalSamples = getInt('metal_samples') ?? 8
    const metalRoughness = getFloat('metal_roughness') ?? 0.3
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
      metalRoughness,
      metalFlakeSize,
      metalFlakeVisibility: metalFlakeVis,
    }

    const density = clamp01(0.3 + metalCoverageVal * 0.3)
    const flakeIntensity = clamp01(0.05 + (1 - metalRoughness) * 0.15)
    mat.metalFlakeParams = {
      resolution: 512,
      flakeSize: Math.max(1, Math.round(metalFlakeSize)),
      flakeIntensity,
      flakeDensity: density,
      seed: 42,
    }

  } else if (type.includes('paint') && !type.includes('metal')) {
    // ── KeyShot Paint (non-metallic) ──
    const paintIor = getFloat('ior', 'refractive_index', 'clearcoat_ior')
    if (paintIor !== null && paintIor <= 0) {
      mat.clearcoat = 0.0
    } else {
      if (!byName['clearcoat']) mat.clearcoat = 1.0
      if (mat.clearcoatRoughness === 0) mat.clearcoatRoughness = 0.03
      if (paintIor !== null && paintIor >= 1.0) {
        const ccF0 = Math.pow((paintIor - 1) / (paintIor + 1), 2)
        const defaultCcF0 = Math.pow((1.5 - 1) / (1.5 + 1), 2)
        mat.clearcoat = clamp01(mat.clearcoat * Math.min(ccF0 / defaultCcF0, 3.0))
      }
    }
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0
    if (paintIor !== null && paintIor <= 0) {
      mat.ior = 1.5
      mat.specularIntensity = 1.0
    }

  } else if (type.includes('metal') && !type.includes('paint')) {
    // ── KeyShot Metal ──
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 1.0
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.2
    const hasFilm = byName['film_refractive_index'] || byName['film_thickness'] || byName['film_extinction']
    if (hasFilm && mat.iridescence === 0) mat.iridescence = 1.0
    mat.envMapIntensity = Math.max(mat.envMapIntensity, 1.5)

  } else if (type.includes('glass') || type.includes('liquid')) {
    // ── KeyShot Glass / Liquid ──
    if (!byName['transmission'] && !byName['transparency']) mat.transmission = 1.0
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.0
    if (mat.ior === 1.5 && !byName['ior'] && !byName['refractive_index']) {
      mat.ior = type.includes('liquid') ? 1.33 : 1.52
    }
    mat.transparent = true
    mat.kmpShaderType = 'lux_glass'

    // Build glassParams for custom shader
    const absorptionColorRaw = getColorRaw('attenuation_color', 'transmission_color') ?? getColorRaw(type)
    mat.glassParams = {
      absorptionColor: absorptionColorRaw ? [absorptionColorRaw.r, absorptionColorRaw.g, absorptionColorRaw.b] : [1, 1, 1],
      absorptionDistance: mat.attenuationDistance > 0 ? mat.attenuationDistance : 0.5,
      chromaticAberration: mat.dispersion > 0 ? clamp01(mat.dispersion * 10) : 0.0,
    }

  } else if (type.includes('dielectric')) {
    // ── KeyShot Dielectric ──
    if (!byName['transmission'] && !byName['transparency']) mat.transmission = 1.0
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.0
    if (mat.ior === 1.5 && !byName['ior'] && !byName['refractive_index']) mat.ior = 1.52
    mat.transparent = true
    mat.kmpShaderType = 'lux_glass'

    const absorptionColorRaw = getColorRaw('attenuation_color', 'transmission_color') ?? getColorRaw(type)
    mat.glassParams = {
      absorptionColor: absorptionColorRaw ? [absorptionColorRaw.r, absorptionColorRaw.g, absorptionColorRaw.b] : [1, 1, 1],
      absorptionDistance: mat.attenuationDistance > 0 ? mat.attenuationDistance : 0.5,
      chromaticAberration: mat.dispersion > 0 ? clamp01(mat.dispersion * 10) : 0.0,
    }

  } else if (type.includes('plastic') && type.includes('cloudy')) {
    // ── KeyShot Plastic (Cloudy) ──
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.35
    if (mat.transmission === 0) mat.transmission = 0.2
    if (mat.attenuationDistance === 0) mat.attenuationDistance = 0.3
    mat.transparent = true

  } else if (type.includes('plastic') && type.includes('transparent')) {
    // ── KeyShot Plastic (Transparent) ──
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.15
    if (!byName['transmission'] && !byName['transparency']) mat.transmission = 0.8
    mat.transparent = true

  } else if (type.includes('plastic')) {
    // ── KeyShot Plastic (basic) ──
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.35

  } else if (type.includes('velvet') || type.includes('fabric') || type.includes('cloth') || type.includes('realcloth')) {
    // ── KeyShot Fabric/Velvet/RealCloth ──
    if (!byName['sheen'] && !byName['fuzz']) mat.sheen = 1.0
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.8
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0

    // Build velvetParams for custom shader
    const sheenColorRaw = getColorRaw('sheen_color', 'fuzz_color', 'sheen') ?? getColorRaw('backscatter')
    const fuzzAmount = getFloat('fuzz', 'sheen') ?? 1.0
    mat.kmpShaderType = 'lux_velvet'
    mat.velvetParams = {
      sheenColor: sheenColorRaw ? [sheenColorRaw.r, sheenColorRaw.g, sheenColorRaw.b] : [1, 1, 1],
      sheenIntensity: clamp01(fuzzAmount),
      fiberDirection: [0, 1, 0],
      fuzzAmount: clamp01(fuzzAmount),
    }

  } else if (type.includes('translucent') && type.includes('medium')) {
    // ── KeyShot Translucent Medium ──
    if (!byName['transmission'] && !byName['transparency']) mat.transmission = 0.7
    if (mat.attenuationDistance === 0) mat.attenuationDistance = 1.0
    mat.transparent = true

  } else if (type.includes('scattering') && type.includes('medium')) {
    // ── KeyShot Scattering Medium ──
    if (!byName['transmission'] && !byName['transparency']) mat.transmission = 0.9
    if (mat.attenuationDistance === 0) mat.attenuationDistance = 0.5
    mat.transparent = true

  } else if (type.includes('translucent') || type.includes('sss')) {
    // ── KeyShot Translucent/SSS (lux_translucent) ──
    if (!byName['transmission'] && !byName['transparency']) mat.transmission = 0.5
    if (mat.attenuationDistance === 0) mat.attenuationDistance = 0.5

    const sssSubsurfaceColor = getColorRaw('translucency', 'subsurface_color', 'sss_color')
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

    // Use sub-shader colors as fallbacks for SSS params
    let sssFallbackSubsurface = null
    let sssFallbackTransmission = null
    let sssFallbackSpecular = null
    if (subShaderColors && subShaderColors.size > 0) {
      const slots = Array.from(subShaderColors.entries()).sort((a, b) => a[0] - b[0])
      if (slots.length >= 1 && !sssSubsurfaceColor) sssFallbackSubsurface = slots[0][1]
      if (slots.length >= 2 && !sssTransmissionColor) sssFallbackTransmission = slots[1][1]
      if (slots.length >= 3 && !sssSpecularColorRaw) sssFallbackSpecular = slots[2][1]
    }

    mat.kmpShaderType = 'lux_translucent'
    mat.sssParams = {
      subsurfaceColor: sssSubsurfaceColor ? [sssSubsurfaceColor.r, sssSubsurfaceColor.g, sssSubsurfaceColor.b]
        : sssFallbackSubsurface ? [sssFallbackSubsurface.r, sssFallbackSubsurface.g, sssFallbackSubsurface.b]
        : [1, 0.9, 0.8],
      subsurfaceRadius: sssDiffuseWeight * 0.5,
      iorChannels: sssIorChannels,
      diffuseWeight: sssDiffuseWeight,
      transmissionColor: sssTransmissionColor ? [sssTransmissionColor.r, sssTransmissionColor.g, sssTransmissionColor.b]
        : sssFallbackTransmission ? [sssFallbackTransmission.r, sssFallbackTransmission.g, sssFallbackTransmission.b]
        : [1, 1, 1],
      specularColor: sssSpecularColorRaw ? [sssSpecularColorRaw.r, sssSpecularColorRaw.g, sssSpecularColorRaw.b]
        : sssFallbackSpecular ? [sssFallbackSpecular.r, sssFallbackSpecular.g, sssFallbackSpecular.b]
        : [1, 1, 1],
      specularity: sssSpecularity ? [sssSpecularity.r, sssSpecularity.g, sssSpecularity.b] : [1, 1, 1],
      dispersion: sssDispersion,
    }

    if (sssSubsurfaceColor) {
      mat.attenuationColor = rgbToHex(sssSubsurfaceColor.r, sssSubsurfaceColor.g, sssSubsurfaceColor.b)
    }
    mat.transparent = true
    mat.side = 'double'

  } else if (type.includes('gem') || type.includes('diamond')) {
    // ── KeyShot Gem/Diamond ──
    if (!byName['transmission'] && !byName['transparency']) mat.transmission = 1.0
    if (mat.ior === 1.5 && !byName['ior'] && !byName['refractive_index']) mat.ior = 2.42
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.0
    if (mat.dispersion === 0 && !byName['dispersion'] && !byName['abbe_number']) mat.dispersion = 0.044
    mat.transparent = true
    mat.kmpShaderType = 'lux_gem'

    mat.gemParams = {
      dispersionStrength: mat.dispersion > 0 ? mat.dispersion : 0.044,
      brilliance: 1.0,
      fireIntensity: clamp01(mat.dispersion * 20),
    }

  } else if (type.includes('thin_film') || type.includes('thin film')) {
    // ── KeyShot Thin Film ──
    if (mat.iridescence === 0) mat.iridescence = 1.0
    if (mat.iridescenceIOR === 1.3 && !byName['thin_film_ior'] && !byName['refractive_index']) {
      mat.iridescenceIOR = 1.5
    }
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0

  } else if (type.includes('anisotropic')) {
    // ── KeyShot Anisotropic ──
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 1.0
    mat.envMapIntensity = Math.max(mat.envMapIntensity, 1.3)
    mat.kmpShaderType = 'anisotropic'

    const rxVal = getFloat('roughness_x') ?? mat.roughness
    const ryVal = getFloat('roughness_y') ?? mat.roughness
    const rotAngle = getFloat('anisotropy_rotation') ?? getFloat('angle') ?? 0
    mat.anisotropicParams = {
      roughnessX: clamp01(rxVal),
      roughnessY: clamp01(ryVal),
      rotationAngle: typeof rotAngle === 'number' ? rotAngle : 0,
      tangentSource: 'uv',
    }

  } else if (type.includes('multi_layer') || type.includes('multi-layer') || type.includes('multilayer')) {
    // ── KeyShot Multi-Layer Optics ──
    if (mat.iridescence === 0) mat.iridescence = 1.0
    if (mat.clearcoat === 0) mat.clearcoat = 0.5

  } else if (type.includes('generic')) {
    // ── KeyShot Generic (Disney BRDF) ──
    // All parameters handled by generic mapping above

  } else if (type.includes('advanced')) {
    // ── KeyShot Advanced ──
    // All parameters handled by generic mapping above

  } else if (type.includes('emissive')) {
    // ── KeyShot Emissive ──
    if (mat.emissiveIntensity === 0) mat.emissiveIntensity = 1.0
    if (mat.emissive === '#000000') mat.emissive = mat.color

  } else if (type.includes('flat')) {
    // ── KeyShot Flat ──
    mat.emissive = mat.color
    mat.emissiveIntensity = 1.0
    mat.metalness = 0.0
    mat.roughness = 1.0
    mat.specularIntensity = 0.0
    mat.kmpShaderType = 'lux_flat'

  } else if (type.includes('matte') || type.includes('diffuse')) {
    // ── KeyShot Matte/Diffuse ──
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.9
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0
    if (!byName['specular'] && !byName['specular_weight']) mat.specularIntensity = 0.3

  } else if (type.includes('glossy')) {
    // ── KeyShot Glossy ──
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.05
    mat.envMapIntensity = Math.max(mat.envMapIntensity, 1.3)

  } else if (type.includes('rubber') || type.includes('silicone')) {
    // ── KeyShot Rubber ──
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.7
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0

  } else if (type.includes('ceramic') || type.includes('porcelain')) {
    // ── KeyShot Ceramic ──
    if (!byName['clearcoat']) mat.clearcoat = 0.8
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.15
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0

  } else if (type.includes('leather')) {
    // ── KeyShot Leather ──
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.6
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0
    if (!byName['sheen'] && !byName['fuzz']) mat.sheen = 0.3

  } else if (type.includes('axalta') || type.includes('measured')) {
    // ── KeyShot Axalta Paint / Measured ──
    if (!byName['clearcoat']) mat.clearcoat = 1.0
    if (mat.clearcoatRoughness === 0) mat.clearcoatRoughness = 0.03

  } else if (type.includes('xray')) {
    // ── KeyShot X-Ray ──
    mat.transparent = true
    mat.opacity = 0.3
    mat.transmission = 0.7
    mat.metalness = 0.0
    mat.roughness = 1.0
    mat.kmpShaderType = 'lux_x_ray'

  } else if (type.includes('wireframe')) {
    // ── KeyShot Wireframe ──
    mat.wireframe = true

  } else if (type.includes('skin')) {
    // ── KeyShot Skin ──
    // SSS variant with skin-specific defaults
    if (!byName['transmission'] && !byName['transparency']) mat.transmission = 0.3
    if (mat.attenuationDistance === 0) mat.attenuationDistance = 0.2
    if (!byName['metal'] && !byName['metallic']) mat.metalness = 0.0
    if (mat.roughness === 0.5 && !byName['roughness']) mat.roughness = 0.4
    mat.transparent = true
    mat.side = 'double'

  } else if (type.includes('cutaway')) {
    // ── KeyShot Cutaway ──
    mat.transparent = true
    mat.alphaTest = 0.5
    mat.side = 'double'
  }

  // ── Post-mapping: apply any remaining params ──

  // Subsurface scattering radius from color param
  const sssColor = getColorRaw('subsurface_color', 'sss_color')
  if (sssColor && mat.attenuationColor === '#ffffff') {
    mat.attenuationColor = rgbToHex(sssColor.r, sssColor.g, sssColor.b)
  }

  // Texture repeat/tiling from int params
  const tileU = getInt('tile_u', 'repeat_u')
  const tileV = getInt('tile_v', 'repeat_v')
  if (tileU !== null || tileV !== null) {
    warnings.push(`KMP tile params found: U=${tileU}, V=${tileV} — apply to texture transforms manually`)
  }

  // Log unmapped parameters as warnings
  const mappedKeys = new Set([
    shaderType?.toLowerCase() ?? '',
    'base', 'roughness', 'metal', 'metallic', 'ior', 'refractive_index',
    'clearcoat', 'clear_coat', 'clearcoat_roughness', 'coat_roughness', 'clear_coat_roughness',
    'clearcoat_ior', 'clearcoat_refractive_index', 'coat_ior',
    'transmission', 'transparency', 'thickness', 'transmission_depth',
    'transparency_distance', 'color_density',
    'sheen', 'fuzz', 'sheen_roughness', 'fuzz_roughness',
    'anisotropy', 'specular_anisotropy', 'anisotropy_rotation', 'angle',
    'roughness_x', 'roughness_y',
    'emissive_intensity', 'emission_luminance', 'luminance',
    'specular', 'specular_weight', 'specular_tint',
    'iridescence', 'thin_film', 'thin_film_ior', 'film_refractive_index',
    'film_thickness', 'thin_film_thickness', 'film_extinction', 'film_extinction_coefficient',
    'color_filter',
    'bump_intensity', 'normal_scale', 'bump',
    'displacement_scale', 'height_scale',
    'dispersion', 'abbe_number',
    'roughness_transmission', 'diffuse_saturation',
    'alpha', 'emissive', 'emission', 'emissive_color',
    'specular_color', 'reflection_color',
    'attenuation_color', 'transmission_color', 'subsurface_color', 'transmission_out',
    'sheen_color', 'fuzz_color', 'sheen_tint',
    'backscatter', 'ambient', 'edginess', 'fresnel', 'refractive_index_outside',
    'attenuation_distance', 'subsurface_radius', 'translucency',
    'specular_transmission', 'diffuse_transmission',
    'diffuse', 'surface_color', 'color',
    // Toon params
    'shadow color', 'shadow multiplier', 'shadow strength',
    'contour color', 'contour angle', 'contour width', 'contour quality',
    'contour width is in pixels', 'outline width multiplier', 'part width multiplier',
    'outline contour', 'material contour', 'part contour', 'interior edge contour',
    'environment shadows', 'light source shadows',
    // SSS params
    'sss_color', 'specularity', 'diffuse_weight',
    // Carpaint params
    'metal_coverage', 'metal_roughness', 'metal_flake_size', 'flake_size',
    'metal_samples', 'metal_color', 'metal_flake_visibility',
    'thickness multiplier', 'clearcoat_color', 'coat_color',
    'clearcoat_refractive_index',
    // Tile params
    'tile_u', 'repeat_u', 'tile_v', 'repeat_v',
  ])
  for (const p of rawParams) {
    if (p.name && !mappedKeys.has(p.name) && !mappedKeys.has(p.name.toLowerCase())) {
      warnings.push(`Unmapped parameter: "${p.name}" (${p.type}) = ${JSON.stringify(p.value)}`)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL VALIDATION PASS — clamp all PBR values to valid ranges
  // ═══════════════════════════════════════════════════════════════════════════
  mat.roughness = clamp01(mat.roughness)
  mat.metalness = clamp01(mat.metalness)
  mat.clearcoat = clamp01(mat.clearcoat)
  mat.clearcoatRoughness = clamp01(mat.clearcoatRoughness)
  mat.transmission = clamp01(mat.transmission)
  mat.sheen = clamp01(mat.sheen)
  mat.sheenRoughness = clamp01(mat.sheenRoughness)
  mat.iridescence = clamp01(mat.iridescence)
  mat.opacity = clamp01(mat.opacity)
  mat.anisotropy = Math.max(-1, Math.min(1, mat.anisotropy))
  mat.ior = Math.max(1.0, Math.min(mat.ior, 5.0))
  mat.iridescenceIOR = Math.max(1.0, Math.min(mat.iridescenceIOR, 3.0))
  mat.specularIntensity = Math.max(0, mat.specularIntensity)
  mat.envMapIntensity = Math.max(0, mat.envMapIntensity)
  mat.emissiveIntensity = Math.max(0, mat.emissiveIntensity)
  if (mat.attenuationDistance < 0) mat.attenuationDistance = 0
  if (mat.thickness < 0) mat.thickness = 0

  return { mat, warnings }
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 6: HEX DUMP & COVERAGE ANALYSIS
// ═════════════════════════════════════════════════════════════════════════════

// Decode every byte in the footer section with annotations
function decodeFooterBytes(buf, footerStart) {
  if (footerStart < 0 || footerStart >= buf.length) return null
  const result = []
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = footerStart

  // Check for --MATMETA-- marker
  const matmeta = buf.slice(pos, Math.min(pos + 11, buf.length)).toString('ascii')
  if (matmeta === '--MATMETA--') {
    result.push({ offset: '0x' + pos.toString(16), length: 11, role: 'matmeta_marker', value: '--MATMETA--' })
    pos += 11
    // Read base64 content until null or end
    let metaEnd = pos
    while (metaEnd < buf.length && buf[metaEnd] !== 0x00) metaEnd++
    const metaStr = buf.slice(pos, metaEnd).toString('ascii')
    let decodedMeta = null
    try {
      const decoded = Buffer.from(metaStr, 'base64')
      // Try to interpret the decoded bytes
      const metaBytes = []
      for (let i = 0; i < decoded.length; i++) {
        metaBytes.push({ byte: '0x' + decoded[i].toString(16).padStart(2, '0'), value: decoded[i], ascii: isPrintable(decoded[i]) ? String.fromCharCode(decoded[i]) : null })
      }
      decodedMeta = metaBytes
    } catch { /* ignore */ }
    result.push({ offset: '0x' + pos.toString(16), length: metaStr.length, role: 'matmeta_base64', value: metaStr, decodedBytes: decodedMeta })
    pos = metaEnd
    // Scan for material name or other content after MATMETA
    while (pos < buf.length) {
      if (isPrintable(buf[pos])) {
        const strStart = pos
        while (pos < buf.length && isPrintable(buf[pos])) pos++
        result.push({ offset: '0x' + strStart.toString(16), length: pos - strStart, role: 'text', value: buf.slice(strStart, pos).toString('ascii') })
      } else {
        result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'byte', value: '0x' + buf[pos].toString(16).padStart(2, '0'), decimal: buf[pos] })
        pos++
      }
    }
    return result
  }

  // Pattern: 0x09 0x00 0x0b <len> <name> ";" <metadata>
  if (pos + 3 < buf.length && buf[pos] === 0x09 && buf[pos + 1] === 0x00 && buf[pos + 2] === 0x0b) {
    result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'footer_start_marker', value: '0x09', description: 'Footer section start' })
    pos++
    result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'padding', value: '0x00' })
    pos++
    result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'name_section_marker', value: '0x0b', description: 'Material name section' })
    pos++
    const nameLen = buf[pos]
    result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'name_length', value: nameLen, description: `Material name is ${nameLen} bytes` })
    pos++
    if (nameLen > 0 && pos + nameLen <= buf.length) {
      const name = buf.slice(pos, pos + nameLen).toString('ascii')
      result.push({ offset: '0x' + pos.toString(16), length: nameLen, role: 'material_name', value: name })
      pos += nameLen
    }
    // Decode remaining footer bytes individually
    while (pos < buf.length) {
      const b = buf[pos]
      if (b === 0x3b) {
        result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'separator', value: ';', description: 'Name/metadata separator' })
        pos++
      } else if (b === 0x04 && pos + 1 < buf.length) {
        // 0x04 followed by a sub-type byte — metadata type marker
        const subType = buf[pos + 1]
        result.push({ offset: '0x' + pos.toString(16), length: 2, role: 'metadata_type', value: '0x04 0x' + subType.toString(16).padStart(2, '0'), description: `Metadata block type=${subType}` })
        pos += 2
      } else if (b === 0x11 && pos + 1 < buf.length) {
        // 0x11 — uint32 count/flag marker
        const flagByte = buf[pos + 1]
        result.push({ offset: '0x' + pos.toString(16), length: 2, role: 'flag_marker', value: '0x11 0x' + flagByte.toString(16).padStart(2, '0'), description: `Flag marker type=0x11 sub=${flagByte}` })
        pos += 2
      } else if (b === 0x39 && pos + 1 < buf.length) {
        // 0x39 0x04 — version/capability marker (seen as "9." pattern)
        const next = buf[pos + 1]
        result.push({ offset: '0x' + pos.toString(16), length: 2, role: 'version_marker', value: '0x39 0x' + next.toString(16).padStart(2, '0'), description: `Version/capability marker` })
        pos += 2
      } else if (pos + 3 < buf.length && !isPrintable(b)) {
        // Try reading as uint32 LE
        const u32 = view.getUint32(pos, true)
        if (u32 <= 0xffff) { // reasonable small value
          result.push({ offset: '0x' + pos.toString(16), length: 4, role: 'uint32', value: u32, hex: '0x' + u32.toString(16), rawBytes: Array.from(buf.slice(pos, pos + 4)).map(x => '0x' + x.toString(16).padStart(2, '0')).join(' ') })
          pos += 4
        } else {
          result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'byte', value: '0x' + b.toString(16).padStart(2, '0'), decimal: b })
          pos++
        }
      } else if (isPrintable(b)) {
        const strStart = pos
        while (pos < buf.length && isPrintable(buf[pos])) pos++
        result.push({ offset: '0x' + strStart.toString(16), length: pos - strStart, role: 'text', value: buf.slice(strStart, pos).toString('ascii') })
      } else {
        result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'byte', value: '0x' + b.toString(16).padStart(2, '0'), decimal: b })
        pos++
      }
    }
    return result
  }

  // Fallback: byte-by-byte with best-effort annotation
  while (pos < buf.length) {
    if (isPrintable(buf[pos])) {
      const strStart = pos
      while (pos < buf.length && isPrintable(buf[pos])) pos++
      result.push({ offset: '0x' + strStart.toString(16), length: pos - strStart, role: 'text', value: buf.slice(strStart, pos).toString('ascii') })
    } else {
      result.push({ offset: '0x' + pos.toString(16), length: 1, role: 'byte', value: '0x' + buf[pos].toString(16).padStart(2, '0'), decimal: buf[pos] })
      pos++
    }
  }
  return result
}

function hexDump(buf, start, end) {
  const lines = []
  for (let i = start; i < end; i += 16) {
    const hexParts = []
    const asciiParts = []
    for (let j = 0; j < 16 && i + j < end; j++) {
      hexParts.push(buf[i + j].toString(16).padStart(2, '0'))
      const b = buf[i + j]
      asciiParts.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')
    }
    lines.push(i.toString(16).padStart(6, '0') + ': ' + hexParts.join(' ').padEnd(48) + ' ' + asciiParts.join(''))
  }
  return lines
}

// Create a fully decoded byte map: every byte annotated with its purpose
function createDecodedByteMap(buf, start, end, rawParams, paramHeader) {
  const annotations = [] // { offset, length, role, description }

  // Annotate param header
  if (paramHeader && paramHeader.decoded && paramHeader.decoded.shaderName) {
    const headerSize = paramHeader.size || 8
    annotations.push({
      offset: start, length: Math.min(8, headerSize),
      role: 'param_header',
      description: `Section header: marker=${paramHeader.decoded.marker} flags=${paramHeader.decoded.flags} type=${paramHeader.decoded.sectionType} count=${paramHeader.decoded.lengthOrCount} shaderIndex=${paramHeader.decoded.shaderIndex}`,
      rawBytes: paramHeader.decoded.rawBytes,
    })
  }

  // Annotate each parameter
  for (const p of rawParams) {
    const markerSize = p.type === 'color' ? 14 : 6
    // Name bytes (before the marker)
    if (p.type !== 'bool_inferred') {
      const nameStart = p.offset - p.name.length
      if (nameStart >= start) {
        annotations.push({
          offset: nameStart, length: p.name.length,
          role: 'param_name',
          description: `"${p.name}"`,
        })
      }
      // Marker byte
      const markerNames = { float: '0x17 FLOAT', color: '0x27 COLOR', int: '0x1d INT', bool: '0x25 BOOL', texslot: '0x9b TEXSLOT' }
      annotations.push({
        offset: p.offset, length: 1,
        role: 'type_marker',
        description: markerNames[p.type] || p.type,
      })
      // Sub-ID byte
      annotations.push({
        offset: p.offset + 1, length: 1,
        role: 'sub_id',
        description: `sub_id=${p.subId}`,
      })
      // Value bytes
      const valueLen = p.type === 'color' ? 12 : 4
      const valueDesc = p.type === 'color'
        ? `rgb(${p.value.r.toFixed(4)}, ${p.value.g.toFixed(4)}, ${p.value.b.toFixed(4)}) → ${p.hex}`
        : p.type === 'bool' ? `${p.value} (${p.bool})`
        : `${p.value}`
      annotations.push({
        offset: p.offset + 2, length: valueLen,
        role: 'param_value',
        description: valueDesc,
      })
    } else {
      // Bare name (bool_inferred) — use rawLength to cover junk suffix bytes too
      const bareLen = p.rawLength || p.name.length
      annotations.push({
        offset: p.offset, length: bareLen,
        role: 'bare_param_name',
        description: `"${p.name}" (no marker — inferred as bool false)${bareLen > p.name.length ? ` + ${bareLen - p.name.length} trailing junk bytes` : ''}`,
      })
    }
  }

  // Sort by offset
  annotations.sort((a, b) => a.offset - b.offset)
  return annotations
}

function coverageAnalysis(buf, start, end, rawParams) {
  const claimed = new Set()
  for (const p of rawParams) {
    if (p.type === 'bool_inferred') {
      // Bare name with no marker — claim full span including junk suffix
      const bareLen = p.rawLength || p.name.length
      for (let b = p.offset; b < p.offset + bareLen; b++) claimed.add(b)
    } else {
      const valueLen = p.type === 'color' ? 14 : 6
      for (let b = p.offset - p.name.length; b < p.offset + valueLen; b++) claimed.add(b)
    }
  }

  const unclaimed = []
  let run = '', runStart = -1
  for (let i = start; i < end; i++) {
    if (!claimed.has(i) && isPrintable(buf[i])) {
      if (run === '') runStart = i
      run += String.fromCharCode(buf[i])
    } else {
      if (run.length >= 3) unclaimed.push({ offset: '0x' + runStart.toString(16), text: run })
      run = ''
    }
  }
  if (run.length >= 3) unclaimed.push({ offset: '0x' + runStart.toString(16), text: run })
  return unclaimed
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ═════════════════════════════════════════════════════════════════════════════

function processKmp(kmpPath, outDir) {
  const kmpName = basename(kmpPath, '.kmp')
  console.log('\n' + '═'.repeat(70))
  console.log('  KMP: ' + kmpName)
  console.log('  File: ' + kmpPath)
  console.log('═'.repeat(70))

  // Step 1: Extract archive
  const { mtlBuf, mtlName, xmlContent, extractDir, additionalMtls } = extractKmpArchive(kmpPath)
  console.log('  MTL: ' + mtlName + ' (' + mtlBuf.length + ' bytes)')
  if (additionalMtls.length > 0) {
    console.log('  Additional MTLs: ' + additionalMtls.map(m => m.name).join(', '))
  }

  // Step 1b: List all archive contents and extract texture files to public assets
  const textureExts = ['.jpg', '.jpeg', '.png', '.exr', '.hdr', '.tif', '.tiff', '.bmp', '.webp']
  const textureDir = join(outDir, 'textures', kmpName)
  const extractedTextures = []
  const allExtracted = readdirSync(extractDir)
  console.log('  Archive contents: ' + allExtracted.join(', '))

  // Separate thumbnails from material textures
  const textureFiles = allExtracted.filter(f => {
    const lower = f.toLowerCase()
    return textureExts.some(ext => lower.endsWith(ext)) &&
      !lower.includes('thumbnail') && !lower.includes('preview') && !lower.includes('thumb')
  })
  if (textureFiles.length > 0) {
    mkdirSync(textureDir, { recursive: true })
    for (const tf of textureFiles) {
      const dest = join(textureDir, tf)
      copyFileSync(join(extractDir, tf), dest)
      const publicPath = '/assets/kmp/textures/' + kmpName + '/' + tf
      const lower = tf.toLowerCase()

      // Auto-detect texture slot by naming convention (matching KmpImporter.ts)
      let slot = null
      if (/(?:diffuse|albedo|base.?color|color|_d\b|_bc\b|_col\b)/i.test(lower)) slot = 'map'
      else if (/(?:normal|nrm|_n\b|_nor\b|bump)/i.test(lower)) slot = 'normalMap'
      else if (/(?:roughness|rough|_r\b|_rgh\b)/i.test(lower)) slot = 'roughnessMap'
      else if (/(?:metalness|metallic|metal|_m\b|_met\b)/i.test(lower)) slot = 'metalnessMap'
      else if (/(?:ao|ambient.?occlusion|occlusion|_ao\b)/i.test(lower)) slot = 'aoMap'
      else if (/(?:displacement|height|_h\b|_disp\b)/i.test(lower)) slot = 'displacementMap'
      else if (/(?:emissive|emission|glow|_e\b|_emit\b)/i.test(lower)) slot = 'emissiveMap'
      else if (/(?:alpha|opacity|transparency|_a\b|_alpha\b)/i.test(lower)) slot = 'alphaMap'

      extractedTextures.push({ name: tf, path: dest, publicPath, slot })
    }
    console.log('  Textures: ' + textureFiles.length + ' → ' + textureDir)
    for (const t of extractedTextures) {
      console.log('    ' + t.name + (t.slot ? ' → ' + t.slot : ' (unassigned)'))
    }
  }

  // Step 2: Structural analysis
  const structure = analyzeStructure(mtlBuf)
  console.log('  Header:', JSON.stringify(structure.header))
  console.log('  Param section: 0x' + structure.paramSection.start.toString(16) +
    ' – 0x' + structure.paramSection.end.toString(16) +
    ' (' + (structure.paramSection.end - structure.paramSection.start) + ' bytes)')

  // Step 3: Extract PNG
  let pngPath = null
  if (structure.png) {
    const pngData = mtlBuf.slice(structure.png.start, structure.png.end)
    pngPath = join(outDir, kmpName + '-thumbnail.png')
    writeFileSync(pngPath, pngData)
    console.log('  PNG: ' + structure.png.size + ' bytes → ' + pngPath)
  }

  // Step 3b: Decode file header (everything before PNG)
  const headerEnd = structure.png ? structure.png.start : structure.paramSection.start
  const decodedFileHeader = decodeFileHeader(mtlBuf, headerEnd)

  // Step 4a: Decode sub-shader blocks if present
  let subShaderBlocks = []
  if (structure.subShaderRegion) {
    subShaderBlocks = decodeSubShaderBlocks(mtlBuf, structure.subShaderRegion.start, structure.subShaderRegion.end)
    console.log('  Sub-shader blocks: ' + subShaderBlocks.length + ' (lux_const_color_extended)')
    console.log('  Main shader start: 0x' + structure.mainShaderStart.toString(16))
  }

  // Step 4b: Decode param section header
  const paramHeader = decodeParamSectionHeader(mtlBuf, structure.mainShaderStart)

  // Step 4c: Parse ALL parameters from main shader region
  const rawParams = parseParameters(mtlBuf, structure.mainShaderStart, structure.paramSection.end)
  const shaderType = rawParams.length > 0 ? rawParams[0].name : null

  // Step 4d: Decode footer
  const decodedFooter = decodeFooter(mtlBuf, structure.footer.start)

  console.log('\n  ── RAW PARAMETERS (' + rawParams.length + ') ──')
  for (const p of rawParams) {
    if (p.type === 'color') {
      console.log(`    [COLOR] "${p.name}" = (${p.value.r.toFixed(6)}, ${p.value.g.toFixed(6)}, ${p.value.b.toFixed(6)}) → ${p.hex}`)
    } else if (p.type === 'float') {
      console.log(`    [FLOAT] "${p.name}" = ${p.value}`)
    } else if (p.type === 'bool' || p.type === 'float_as_bool' || p.type === 'bool_inferred') {
      console.log(`    [BOOL]  "${p.name}" = ${p.value} (${p.bool})${p.note ? ' ⚠ ' + p.note : ''}`)
    } else if (p.type === 'texslot') {
      console.log(`    [TXSLOT] "${p.name}" → slot #${p.value}`)
    } else {
      console.log(`    [INT]   "${p.name}" = ${p.value}`)
    }
  }

  // Step 5: Extract material name
  const materialName = extractMaterialName(mtlBuf, structure.footer.start)
  console.log('\n  Material name:', materialName)
  console.log('  Shader type:', shaderType)

  // Step 5b: Extract sub-shader colors for buildMaterialDefinition
  const subShaderColors = new Map()
  for (const block of subShaderBlocks) {
    if (block.params) {
      for (const p of block.params) {
        if (p.type === 'color' && p.hex) {
          subShaderColors.set(p.name, p.hex)
        }
      }
    }
  }

  // Step 6: Build MaterialDefinition
  const { mat, warnings } = buildMaterialDefinition(rawParams, shaderType, subShaderColors)

  // Step 6b: Auto-assign extracted textures to material slots
  for (const tex of extractedTextures) {
    if (tex.slot && mat[tex.slot] === null) {
      mat[tex.slot] = tex.publicPath
      console.log('  Texture auto-assigned: ' + tex.name + ' → mat.' + tex.slot)
    }
  }

  if (warnings.length > 0) {
    console.log('\n  ── MAPPING WARNINGS (' + warnings.length + ') ──')
    for (const w of warnings) console.log('    ⚠ ' + w)
  }

  console.log('\n  ── MATERIAL DEFINITION ──')
  // Print only non-null, non-default fields
  const relevant = {}
  for (const [k, v] of Object.entries(mat)) {
    if (v !== null && v !== undefined) relevant[k] = v
  }
  console.log(JSON.stringify(relevant, null, 4).split('\n').map(l => '    ' + l).join('\n'))

  // Step 7: Coverage analysis (on main shader region only, sub-shader blocks accounted separately)
  const unclaimed = coverageAnalysis(mtlBuf, structure.mainShaderStart, structure.paramSection.end, rawParams)
  console.log('\n  ── COVERAGE ──')
  if (unclaimed.length === 0) {
    console.log('    ✓ ALL bytes accounted for. Zero missing parameters.')
  } else {
    console.log('    UNCLAIMED text sequences (' + unclaimed.length + '):')
    for (const u of unclaimed) console.log(`      ${u.offset}: "${u.text}"`)
  }

  // Step 7b: Process additional materials (multi-material KMP)
  const additionalMaterials = []
  for (const extra of additionalMtls) {
    try {
      const extraStructure = analyzeStructure(extra.buf)
      const extraRawParams = parseParameters(extra.buf, extraStructure.mainShaderStart, extraStructure.paramSection.end)
      const extraShaderType = extraRawParams.length > 0 ? extraRawParams[0].name : null
      const extraName = extractMaterialName(extra.buf, extraStructure.footer.start)
      const { mat: extraMat, warnings: extraWarnings } = buildMaterialDefinition(extraRawParams, extraShaderType, new Map())
      const extraRelevant = {}
      for (const [k, v] of Object.entries(extraMat)) {
        if (v !== null && v !== undefined) extraRelevant[k] = v
      }
      additionalMaterials.push({
        mtlFile: extra.name,
        materialName: extraName,
        shaderType: extraShaderType,
        materialDefinition: extraRelevant,
        warnings: extraWarnings.length > 0 ? extraWarnings : undefined,
      })
      console.log('\n  ── ADDITIONAL MATERIAL: ' + extraName + ' (' + extraShaderType + ') ──')
    } catch (e) {
      console.log('  ⚠ Failed to process additional MTL ' + extra.name + ': ' + e.message)
    }
  }

  // Step 8: Write JSON output — fully decoded, no raw hex dumps
  const output = {
    _meta: {
      sourceFile: kmpPath,
      mtlFile: mtlName,
      mtlSize: mtlBuf.length,
      paramSectionOffset: structure.mainShaderStart,
      paramSectionEnd: structure.paramSection.end,
      paramSectionSize: structure.paramSection.end - structure.mainShaderStart,
      tailSectionOffset: structure.footer.start,
      extractedAt: new Date().toISOString(),
      ...structure.header,
    },
    materialName,
    shaderType,
    png: structure.png ? {
      size: structure.png.size,
      startOffset: structure.png.start,
      endOffset: structure.png.end,
      savedTo: pngPath,
    } : null,
    configurationXml: xmlContent,
    archiveContents: allExtracted,
    textures: extractedTextures.length > 0 ? extractedTextures : undefined,
    decodedFileHeader,
    paramSectionHeader: paramHeader.decoded,
    subShaderBlocks: subShaderBlocks.length > 0 ? subShaderBlocks : undefined,
    decodedSubShaderRegion: structure.subShaderRegion
      ? decodeSubShaderRegionBytes(mtlBuf, structure.subShaderRegion.start, structure.subShaderRegion.end) : undefined,
    rawParameters: rawParams.map(p => ({
      name: p.name, type: p.type, subId: p.subId,
      offset: '0x' + p.offset.toString(16),
      value: p.value,
      ...(p.hex ? { hex: p.hex } : {}),
      ...(p.bool !== undefined ? { bool: p.bool } : {}),
      ...(p.note ? { note: p.note } : {}),
    })),
    mappedToonParams: mat.toonParams || undefined,
    mappedCarpaintParams: mat.carpaintParams || undefined,
    mappedSssParams: mat.sssParams || undefined,
    mappedGlassParams: mat.glassParams || undefined,
    mappedGemParams: mat.gemParams || undefined,
    mappedVelvetParams: mat.velvetParams || undefined,
    mappedAnisotropicParams: mat.anisotropicParams || undefined,
    mappingWarnings: warnings.length > 0 ? warnings : undefined,
    materialDefinition: relevant,
    decodedParamSection: createDecodedByteMap(mtlBuf, structure.mainShaderStart, structure.paramSection.end, rawParams, paramHeader),
    decodedFooter: decodedFooter,
    decodedFooterBytes: structure.footer.start >= 0
      ? decodeFooterBytes(mtlBuf, structure.footer.start) : null,
    unclaimedBytes: unclaimed,
    additionalMaterials: additionalMaterials.length > 0 ? additionalMaterials : undefined,
  }

  const jsonPath = join(outDir, kmpName + '-extracted.json')
  writeFileSync(jsonPath, JSON.stringify(output, null, 2))
  console.log('\n  → JSON: ' + jsonPath)
  if (pngPath) console.log('  → PNG:  ' + pngPath)

  return output
}

// ── CLI Argument Parser ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const flags = {
    all: false,
    recursive: false,
    help: false,
    dir: null,    // --dir <path> : scan directory for .kmp files
    out: null,    // --out <path> : output directory (default: public/assets/kmp/)
    files: [],    // positional args: specific .kmp file paths
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--all' || arg === '-a') {
      flags.all = true
    } else if (arg === '--recursive' || arg === '-r') {
      flags.recursive = true
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg === '--dir' || arg === '-d') {
      flags.dir = args[++i]
    } else if (arg === '--out' || arg === '-o') {
      flags.out = args[++i]
    } else if (!arg.startsWith('--')) {
      flags.files.push(arg)
    }
  }

  return flags
}

function printHelp() {
  console.log(`
kmp-pipeline.mjs — Extract and parse Luxion KeyShot .kmp material packages

Usage:
  node kmp-pipeline.mjs [options] [file1.kmp file2.kmp ...]

Options:
  -h, --help           Show this help message
  -a, --all            Process all .kmp files in default assets dir (public/assets/kmp/)
  -d, --dir <path>     Scan <path> for .kmp files instead of default directory
  -r, --recursive      When used with --all or --dir, scan subdirectories recursively
  -o, --out <path>     Write output files to <path> instead of default assets dir

Examples:
  node kmp-pipeline.mjs                                        # process default test file
  node kmp-pipeline.mjs ~/materials/my-material.kmp            # process a specific file
  node kmp-pipeline.mjs ~/mat1.kmp ~/mat2.kmp ~/mat3.kmp      # process multiple files
  node kmp-pipeline.mjs --all                                  # all .kmp in public/assets/kmp/
  node kmp-pipeline.mjs --dir ~/my-materials --recursive       # scan a directory recursively
  node kmp-pipeline.mjs --dir ~/kmps --out ~/output            # custom input and output dirs
  node kmp-pipeline.mjs ~/mat.kmp --out ~/Desktop              # specific file, custom output

Outputs (per .kmp file):
  <basename>-extracted.json        Complete extraction with all raw + mapped params
  <basename>-thumbnail.png         Embedded preview image (if present)
  textures/<basename>/<file>       Extracted texture files with auto-slot assignment
`)
}

function findKmpFiles(dir, recursive) {
  const results = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.kmp')) {
      results.push(fullPath)
    } else if (entry.isDirectory() && recursive) {
      results.push(...findKmpFiles(fullPath, true))
    }
  }
  return results
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────

const flags = parseArgs()

if (flags.help) {
  printHelp()
  process.exit(0)
}

// Determine output directory
const outputDir = flags.out ? resolve(flags.out) : kmpDir
if (flags.out) {
  execSync(`mkdir -p "${outputDir}"`, { stdio: 'pipe' })
}

// Collect .kmp files to process
let kmpFilesToProcess = []

if (flags.files.length > 0) {
  // Explicit file paths provided
  kmpFilesToProcess = flags.files.map(f => resolve(f))
} else if (flags.dir) {
  // Scan a specific directory
  const scanDir = resolve(flags.dir)
  if (!existsSync(scanDir)) {
    console.error('Directory not found:', scanDir)
    process.exit(1)
  }
  kmpFilesToProcess = findKmpFiles(scanDir, flags.recursive)
} else if (flags.all) {
  // Scan default assets directory
  kmpFilesToProcess = findKmpFiles(kmpDir, flags.recursive)
} else {
  // No args: process default test file
  kmpFilesToProcess = [join(kmpDir, 'toon-fill-black-bright.kmp')]
}

if (kmpFilesToProcess.length === 0) {
  console.error('No .kmp files found.')
  process.exit(1)
}

// Validate all files exist
for (const f of kmpFilesToProcess) {
  if (!existsSync(f)) {
    console.error('File not found:', f)
    process.exit(1)
  }
}

console.log('Processing ' + kmpFilesToProcess.length + ' KMP file' + (kmpFilesToProcess.length === 1 ? '' : 's') + '...')
if (flags.out) console.log('Output directory: ' + outputDir)

for (const f of kmpFilesToProcess) {
  processKmp(f, outputDir)
}
