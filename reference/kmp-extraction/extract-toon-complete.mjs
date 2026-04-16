/**
 * Complete KMP material extractor — extracts EVERY parameter from the
 * binary .mtl file inside a .kmp archive, with zero missing values.
 * Also extracts the embedded PNG thumbnail.
 *
 * Output:
 *   - <name>-extracted.json  (all raw params + mapped MaterialDefinition)
 *   - <name>-thumbnail.png   (embedded preview image)
 *
 * Usage: node scripts/kmp-extraction/extract-toon-complete.mjs [kmp-path]
 *   Default kmp-path: public/assets/kmp/toon-fill-black-bright.kmp
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname, resolve, basename } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const repoRoot = resolve(projectRoot, '..')
const localTemp = join(repoRoot, 'temp')

// ── Config ──────────────────────────────────────────────────────────────────
const kmpPath = process.argv[2]
  ?? join(projectRoot, 'public/assets/kmp/toon-fill-black-bright.kmp')

const kmpBaseName = basename(kmpPath, '.kmp')
const outputDir = dirname(kmpPath)
const outputJsonPath = join(outputDir, kmpBaseName + '-extracted.json')
const outputPngPath  = join(outputDir, kmpBaseName + '-thumbnail.png')

// ── Helpers ─────────────────────────────────────────────────────────────────
function isPrintable(b) { return b >= 0x20 && b < 0x7f }
function clamp01(v) { return Math.max(0, Math.min(1, v)) }

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

// ── Marker constants ────────────────────────────────────────────────────────
const TYPE_FLOAT = 0x17
const TYPE_COLOR = 0x27
const TYPE_INT   = 0x1d
const TYPE_BOOL  = 0x25

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IEND  = Buffer.from([0x49, 0x45, 0x4e, 0x44])

// ── Find subsequence in buffer ──────────────────────────────────────────────
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

// ── Extract .mtl from .kmp (ZIP) using local temp/ ──────────────────────────
function extractMtl(kmpFile) {
  mkdirSync(localTemp, { recursive: true })
  execSync(`unzip -o "${kmpFile}" -d "${localTemp}"`, { stdio: 'pipe' })
  const files = readdirSync(localTemp)
  const mtlName = files.find(f => f.endsWith('.mtl'))
  if (!mtlName) throw new Error('No .mtl file found in KMP archive')
  return { buf: readFileSync(join(localTemp, mtlName)), name: mtlName }
}

// ── Extract PNG thumbnail from .mtl binary ──────────────────────────────────
function extractPng(buf) {
  const pngStart = findSequence(buf, PNG_MAGIC)
  if (pngStart < 0) return null

  const iendPos = findSequence(buf, PNG_IEND, pngStart)
  if (iendPos < 0) return null

  // IEND chunk: 4-byte length (00 00 00 00) + "IEND" + 4-byte CRC
  const pngEnd = iendPos + 4 + 4 // IEND marker + CRC32
  return { data: buf.slice(pngStart, pngEnd), start: pngStart, end: pngEnd }
}

// ── Sequential parameter section parser ─────────────────────────────────────
//
// The Luxion binary .mtl TLV format:
//   <ascii_name> <type_marker:u8> <sub_id:u8> <value_bytes>
//
// Type markers and value sizes:
//   0x27 (COLOR):  sub_id:u8 + r:f32le + g:f32le + b:f32le = 13 bytes after marker
//   0x17 (FLOAT):  sub_id:u8 + val:f32le                    = 5 bytes after marker
//   0x1d (INT):    sub_id:u8 + val:u32le                     = 5 bytes after marker
//   0x25 (BOOL):   sub_id:u8 + val:u32le                     = 5 bytes after marker
//
// The parser works SEQUENTIALLY: after consuming a parameter's value bytes,
// the next printable text run is the NEXT parameter's name, followed by its
// type marker. This avoids false positives from value bytes that happen to
// match marker constants.

function parseParameterSection(buf, start, end) {
  const results = []
  const TYPE_MARKERS = new Set([TYPE_FLOAT, TYPE_COLOR, TYPE_INT, TYPE_BOOL])

  // Strategy: scan for type markers by finding positions where:
  //   1. The byte is a known type marker (0x17, 0x27, 0x1d, 0x25)
  //   2. The byte immediately BEFORE it is a printable ASCII char (end of name)
  //   3. The byte immediately AFTER it (sub_id) is < 0x20 (non-printable)
  //      OR for sub_ids in range 0x00-0x1f which are always non-printable
  //
  // The tricky part: 0x27 = ASCII "'" and 0x25 = ASCII "%" are printable.
  // We disambiguate by checking the sub_id byte after the marker:
  //   - A real marker is followed by a sub_id (0x00-0x1f typically)
  //   - A literal ' or % in text is followed by more printable chars
  //
  // Additionally, for COLOR (0x27), we validate that the 3 floats after
  // sub_id are plausible color values (finite numbers).

  function isNameChar(b) {
    // Printable ASCII EXCEPT the type marker bytes themselves when they
    // appear at a boundary. We can't exclude them from names entirely
    // because they ARE valid ASCII. Instead we detect markers by context.
    return b >= 0x20 && b < 0x7f
  }

  function looksLikeMarker(pos) {
    if (pos < start || pos >= end) return false
    const b = buf[pos]
    if (!TYPE_MARKERS.has(b)) return false

    // Must have a name byte before it
    if (pos <= start) return false
    const before = buf[pos - 1]
    if (!isNameChar(before) || before === 0x20) return false // name shouldn't end with space

    // Sub_id byte after marker must be non-printable (0x00-0x1f)
    if (pos + 1 >= end) return false
    const subId = buf[pos + 1]
    if (subId >= 0x20) return false

    // For COLOR type, validate we have room for 3 floats and they're finite
    if (b === TYPE_COLOR) {
      if (pos + 14 > end) return false
      const r = buf.readFloatLE(pos + 2)
      const g = buf.readFloatLE(pos + 6)
      const b2 = buf.readFloatLE(pos + 10)
      if (!isFinite(r) || !isFinite(g) || !isFinite(b2)) return false
    }

    // For FLOAT type, validate the float is finite
    if (b === TYPE_FLOAT) {
      if (pos + 6 > end) return false
      const val = buf.readFloatLE(pos + 2)
      if (!isFinite(val)) return false
    }

    return true
  }

  // Pass 1: Find all confirmed marker positions
  const markers = []
  for (let i = start + 1; i < end; i++) {
    if (looksLikeMarker(i)) {
      markers.push(i)
    }
  }

  // Pass 2: For each marker, extract the name before it and the value after it
  let prevValueEnd = start
  for (const mPos of markers) {
    const marker = buf[mPos]
    const subId = buf[mPos + 1]

    // Read name: scan backwards from marker to find start of name
    let nameEnd = mPos
    let nameStart = nameEnd - 1
    while (nameStart >= prevValueEnd && isNameChar(buf[nameStart])) {
      nameStart--
    }
    nameStart++ // back to first printable char
    let name = buf.slice(nameStart, nameEnd).toString('ascii')
    // Clean leading non-alpha junk that leaked from previous value bytes
    name = name.replace(/^[^a-zA-Z_]+/, '')

    if (marker === TYPE_COLOR) {
      const r = buf.readFloatLE(mPos + 2)
      const g = buf.readFloatLE(mPos + 6)
      const b = buf.readFloatLE(mPos + 10)
      results.push({
        name, type: 'color', subId, offset: mPos,
        value: { r, g, b }, hex: rgbToHex(r, g, b),
      })
      prevValueEnd = mPos + 14
    } else if (marker === TYPE_FLOAT) {
      const val = buf.readFloatLE(mPos + 2)
      results.push({
        name, type: 'float', subId, offset: mPos,
        value: val,
      })
      prevValueEnd = mPos + 6
    } else if (marker === TYPE_INT) {
      const val = buf.readUInt32LE(mPos + 2)
      results.push({
        name, type: 'int', subId, offset: mPos,
        value: val,
      })
      prevValueEnd = mPos + 6
    } else if (marker === TYPE_BOOL) {
      const val = buf.readUInt32LE(mPos + 2)
      results.push({
        name, type: 'bool', subId, offset: mPos,
        value: val, bool: val !== 0,
      })
      prevValueEnd = mPos + 6
    }
  }

  return results
}

// ── Extract material name from MATMETA section ──────────────────────────────
function extractMaterialName(buf, matmetaOffset) {
  const searchRegion = buf.slice(matmetaOffset, Math.min(matmetaOffset + 256, buf.length)).toString('ascii')
  // The material name is the readable text after the MATMETA marker structure
  // Pattern: after "--MATMETA--" there's binary, then the name string ending with ";"
  const nameBytes = []
  let i = matmetaOffset + 11 // skip "--MATMETA--"
  // Search for printable name string
  while (i < buf.length) {
    if (isPrintable(buf[i])) {
      const start = i
      while (i < buf.length && buf[i] >= 0x20 && buf[i] < 0x7f && buf[i] !== 0x3b) i++
      const name = buf.slice(start, i).toString('ascii').trim()
      if (name.length > 3) return name
    }
    i++
  }
  return null
}

// ── Extract header metadata ─────────────────────────────────────────────────
function extractHeaderInfo(buf) {
  const info = {}
  const header = buf.slice(0, Math.min(256, buf.length)).toString('ascii')
  const matMatch = header.match(/\/\/--lux:mat:(\S+)/)
  if (matMatch) info.matVersion = matMatch[1]
  const shaderMatch = header.match(/\/\/--lux:shader:(\S+)/)
  if (shaderMatch) info.shaderVersion = shaderMatch[1]
  const ksMatch = header.match(/KeyShot.*?v([\d.]+)/)
  if (ksMatch) info.keyshotVersion = ksMatch[1]
  return info
}

// ── Build mapped toonParams from raw parameters ─────────────────────────────
function buildToonParams(rawParams) {
  const byName = {}
  for (const p of rawParams) {
    if (p.name) byName[p.name] = p
  }

  const getColor = (name) => {
    const p = byName[name]
    if (p && p.type === 'color') return [p.value.r, p.value.g, p.value.b]
    return null
  }
  const getFloat = (name) => {
    const p = byName[name]
    if (p && p.type === 'float') return p.value
    return null
  }
  const getInt = (name) => {
    const p = byName[name]
    if (p && (p.type === 'int' || p.type === 'bool')) return p.value
    return null
  }
  const getBool = (name) => {
    const intVal = getInt(name)
    if (intVal !== null) return intVal !== 0
    const floatVal = getFloat(name)
    if (floatVal !== null) return floatVal > 0.5
    return false
  }
  // Get a value regardless of type — for params stored inconsistently
  const getAny = (name) => {
    const p = byName[name]
    if (!p) return null
    if (p.type === 'color') return [p.value.r, p.value.g, p.value.b]
    if (p.type === 'float') return p.value
    if (p.type === 'int' || p.type === 'bool') return p.value
    return null
  }

  const shaderType = rawParams.length > 0 ? rawParams[0].name : null

  // Fill color: shader-type color, or 'color'/'diffuse' fallback
  const shaderTypeColor = getColor(shaderType)
  const fillColor = shaderTypeColor ?? getColor('color') ?? getColor('diffuse') ?? [0, 0, 0]

  // Alpha (opacity)
  const alphaColor = getColor('alpha')
  let opacity = 1.0
  let transparent = false
  if (alphaColor) {
    const avg = (alphaColor[0] + alphaColor[1] + alphaColor[2]) / 3
    if (avg < 0.99) {
      opacity = clamp01(avg)
      transparent = true
    }
  }

  const transparency = getBool('transparency')
  if (transparency) transparent = true

  // Contour color — can be COLOR (rgb) or FLOAT (grayscale brightness)
  let contourColor = getColor('contour color')
  if (!contourColor) {
    const contourFloat = getFloat('contour color')
    if (contourFloat !== null) {
      // Single float = grayscale value (1.0 = white, 0.0 = black)
      contourColor = [contourFloat, contourFloat, contourFloat]
    }
  }
  contourColor = contourColor ?? [0, 0, 0]

  // Shadow color — can be COLOR or FLOAT
  let shadowColor = getColor('shadow color')
  if (!shadowColor) {
    const shadowFloat = getFloat('shadow color')
    if (shadowFloat !== null) {
      shadowColor = [shadowFloat, shadowFloat, shadowFloat]
    }
  }
  shadowColor = shadowColor ?? [0, 0, 0]

  // contour width — can be int or float
  const contourWidthInt = getInt('contour width')
  const contourWidthFloat = getFloat('contour width')
  const contourWidth = contourWidthFloat ?? contourWidthInt ?? 1.0

  // part width multiplier — can be bool (1=true) or float
  const partWidthMulFloat = getFloat('part width multiplier')
  const partWidthMulBool = getBool('part width multiplier')
  const partWidthMultiplier = partWidthMulFloat ?? (partWidthMulBool ? 1.0 : 0.0)

  return {
    shaderType,
    fillColor,
    shadowColor,
    shadowMultiplier: getFloat('shadow multiplier') ?? 0.0,
    shadowStrength: getColor('shadow strength') ?? [1, 1, 1],
    contourColor,
    contourAngle: getFloat('contour angle') ?? 60.0,
    contourWidth,
    contourQuality: getFloat('contour quality') ?? 1.0,
    contourWidthInPixels: getBool('contour width is in pixels'),
    outlineWidthMultiplier: getFloat('outline width multiplier') ?? 1.0,
    partWidthMultiplier,
    outlineContour: getBool('outline contour'),
    materialContour: getBool('material contour'),
    partContour: getBool('part contour'),
    interiorEdgeContour: getBool('interior edge contour'),
    environmentShadows: getBool('environment shadows'),
    lightSourceShadows: getBool('light source shadows'),
    transparency,
    opacity,
    transparent,
    color: rgbToHex(fillColor[0], fillColor[1], fillColor[2]),
  }
}

// ── Hex dump utility ────────────────────────────────────────────────────────
function hexDumpSection(buf, start, end) {
  const lines = []
  for (let i = start; i < end; i += 16) {
    const hexParts = []
    const asciiParts = []
    for (let j = 0; j < 16 && i + j < end; j++) {
      hexParts.push(buf[i + j].toString(16).padStart(2, '0'))
      const b = buf[i + j]
      asciiParts.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')
    }
    lines.push(
      (i).toString(16).padStart(6, '0') + ': ' +
      hexParts.join(' ').padEnd(48) + ' ' +
      asciiParts.join('')
    )
  }
  return lines
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

console.log('KMP file:', kmpPath)

// Step 1: Extract .mtl from .kmp ZIP into local temp/
const { buf, name: mtlName } = extractMtl(kmpPath)
console.log('MTL file:', mtlName)
console.log('MTL size:', buf.length, 'bytes')

// Step 2: Extract header metadata
const headerInfo = extractHeaderInfo(buf)
console.log('Header:', JSON.stringify(headerInfo))

// Step 3: Extract and save PNG thumbnail
const png = extractPng(buf)
let pngInfo = null
if (png) {
  writeFileSync(outputPngPath, png.data)
  pngInfo = {
    size: png.data.length,
    startOffset: png.start,
    endOffset: png.end,
    savedTo: outputPngPath,
  }
  console.log('PNG thumbnail:', png.data.length, 'bytes →', outputPngPath)
} else {
  console.log('No PNG thumbnail found')
}

// Step 4: Find parameter section (after PNG)
let paramStart = 0
if (png) {
  paramStart = png.end
} else {
  const shaderMarker = Buffer.from('//--lux:shader:')
  const pos = findSequence(buf, shaderMarker)
  if (pos >= 0) {
    let i = pos + shaderMarker.length
    while (i < buf.length && buf[i] !== 0x0a) i++
    paramStart = i + 1
  } else {
    paramStart = Math.min(128, buf.length)
  }
}

// Step 5: Find MATMETA end marker
const matmetaMarker = Buffer.from('--MATMETA--')
const matmetaSearch = findSequence(buf, matmetaMarker, paramStart)
// Also check for the material name in the tail (no explicit MATMETA marker)
let matmetaPos = matmetaSearch
let paramEnd

// Look for the tail section — after all TLV params there's typically
// a non-TLV footer with the material name
if (matmetaPos >= 0) {
  paramEnd = matmetaPos
} else {
  // No MATMETA marker — look for the material name footer pattern
  // The footer typically starts with 0x09 0x00 0x0b followed by length + name
  paramEnd = buf.length
  for (let i = paramStart; i < buf.length - 4; i++) {
    if (buf[i] === 0x09 && buf[i + 1] === 0x00 && buf[i + 2] === 0x0b) {
      paramEnd = i
      matmetaPos = i // treat this as the metadata section start
      break
    }
  }
}

console.log('Param section: 0x' + paramStart.toString(16) + ' – 0x' + paramEnd.toString(16),
  '(' + (paramEnd - paramStart) + ' bytes)')

// Step 6: Parse ALL parameters sequentially
const rawParams = parseParameterSection(buf, paramStart, paramEnd)

console.log('\n=== RAW PARAMETERS (' + rawParams.length + ' found) ===')
for (const p of rawParams) {
  if (p.type === 'color') {
    console.log(`  [COLOR] "${p.name}" = (${p.value.r.toFixed(6)}, ${p.value.g.toFixed(6)}, ${p.value.b.toFixed(6)}) → ${p.hex}  [subId=0x${p.subId.toString(16).padStart(2,'0')} @0x${p.offset.toString(16)}]`)
  } else if (p.type === 'float') {
    console.log(`  [FLOAT] "${p.name}" = ${p.value}  [subId=0x${p.subId.toString(16).padStart(2,'0')} @0x${p.offset.toString(16)}]`)
  } else if (p.type === 'bool') {
    console.log(`  [BOOL]  "${p.name}" = ${p.value} (${p.bool})  [subId=0x${p.subId.toString(16).padStart(2,'0')} @0x${p.offset.toString(16)}]`)
  } else {
    console.log(`  [INT]   "${p.name}" = ${p.value}  [subId=0x${p.subId.toString(16).padStart(2,'0')} @0x${p.offset.toString(16)}]`)
  }
}

// Step 7: Extract material name from footer/MATMETA
let materialName = null
if (matmetaPos >= 0 && matmetaPos < buf.length) {
  materialName = extractMaterialName(buf, matmetaPos)
}
// Also try to read name from the tail bytes directly
if (!materialName) {
  // Look for readable string near end of file
  const tailStart = Math.max(paramEnd, buf.length - 100)
  const tailStr = buf.slice(tailStart, buf.length).toString('ascii')
  const nameMatch = tailStr.match(/([A-Z][a-zA-Z0-9 #]+[a-zA-Z0-9#])/)
  if (nameMatch) materialName = nameMatch[1].trim()
}
console.log('\nMaterial name:', materialName)

// Step 8: Parse the tail/footer section for any metadata
const tailData = []
if (matmetaPos >= 0) {
  console.log('\n=== TAIL/FOOTER SECTION (0x' + matmetaPos.toString(16) + ' – 0x' + buf.length.toString(16) + ') ===')
  const tailHex = hexDumpSection(buf, matmetaPos, buf.length)
  for (const line of tailHex) {
    console.log('  ' + line)
    tailData.push(line)
  }
}

// Step 9: Build mapped toon parameters
const toonParams = buildToonParams(rawParams)
console.log('\n=== MAPPED TOON PARAMS ===')
console.log(JSON.stringify(toonParams, null, 2))

// Step 10: Full hex dump of param section
const paramHexDump = hexDumpSection(buf, paramStart, paramEnd)

// Step 11: Coverage analysis — verify every byte is accounted for
console.log('\n=== COVERAGE ANALYSIS ===')
const claimed = new Set()
for (const p of rawParams) {
  const valueLen = p.type === 'color' ? 14 : 6
  // Claim name bytes + marker + value
  for (let b = p.offset - p.name.length; b < p.offset + valueLen; b++) {
    claimed.add(b)
  }
}

let unclaimed = []
let currentRun = ''
let runStart = -1
for (let i = paramStart; i < paramEnd; i++) {
  if (!claimed.has(i) && isPrintable(buf[i])) {
    if (currentRun === '') runStart = i
    currentRun += String.fromCharCode(buf[i])
  } else {
    if (currentRun.length >= 3) {
      unclaimed.push({ offset: '0x' + runStart.toString(16), text: currentRun })
    }
    currentRun = ''
  }
}
if (currentRun.length >= 3) {
  unclaimed.push({ offset: '0x' + runStart.toString(16), text: currentRun })
}

if (unclaimed.length > 0) {
  console.log('UNCLAIMED printable text (potential missed params):')
  for (const u of unclaimed) console.log(`  ${u.offset}: "${u.text}"`)
} else {
  console.log('ALL bytes in param section accounted for. Zero missing parameters.')
}

// Step 12: Write complete JSON output
const output = {
  _meta: {
    sourceFile: kmpPath,
    mtlFile: mtlName,
    mtlSize: buf.length,
    paramSectionOffset: paramStart,
    paramSectionEnd: paramEnd,
    paramSectionSize: paramEnd - paramStart,
    tailSectionOffset: matmetaPos,
    extractedAt: new Date().toISOString(),
    ...headerInfo,
  },
  materialName,
  shaderType: rawParams.length > 0 ? rawParams[0].name : null,
  png: pngInfo,
  rawParameters: rawParams.map(p => ({
    name: p.name,
    type: p.type,
    subId: p.subId,
    offset: '0x' + p.offset.toString(16),
    value: p.value,
    ...(p.hex ? { hex: p.hex } : {}),
    ...(p.bool !== undefined ? { bool: p.bool } : {}),
  })),
  mappedToonParams: toonParams,
  paramSectionHexDump: paramHexDump,
  tailSectionHexDump: tailData,
  unclaimedBytes: unclaimed,
}

writeFileSync(outputJsonPath, JSON.stringify(output, null, 2))
console.log('\nJSON output written to:', outputJsonPath)
console.log('PNG thumbnail written to:', outputPngPath)
