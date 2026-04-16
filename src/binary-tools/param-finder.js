// Byte-pattern landmark finders inside an MTL buffer.
// Evidence: kmp-pipeline.mjs:83-92 (findSequence), 534-576 (param bounds + footer),
//           578-607 (sub-shader region), extract-toon-complete.mjs:82-92 (PNG).

import {
  PNG_MAGIC, PNG_IEND, MATMETA_MARKER, FOOTER_NAME_PREFIX,
  SHADER_VERSION_LINE, SHADER_MARKER_BYTES,
} from '../mtl/mtl.schema.js'

export function findSequence(buf, needle, start = 0) {
  const last = buf.length - needle.length
  outer: for (let i = start; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

export function findPngBounds(buf) {
  const s = findSequence(buf, PNG_MAGIC)
  if (s < 0) return null
  const i = findSequence(buf, PNG_IEND, s)
  if (i < 0) return null
  const end = i + 4 + 4
  return { start: s, end, size: end - s }
}

export function findParamSection(buf, pngEnd, shaderLineEnd) {
  let start = 0
  if (pngEnd > 0) start = pngEnd
  else if (shaderLineEnd > 0) start = shaderLineEnd
  else {
    const pos = findSequence(buf, SHADER_VERSION_LINE)
    if (pos >= 0) {
      let i = pos + SHADER_VERSION_LINE.length
      while (i < buf.length && buf[i] !== 0x0a) i++
      start = i + 1
    } else {
      start = Math.min(128, buf.length)
    }
  }
  const foot = findFooter(buf, start)
  return { start, end: foot.offset }
}

export function findFooter(buf, paramStart) {
  const m = findSequence(buf, MATMETA_MARKER, paramStart)
  if (m >= 0) return { type: 'matmeta', offset: m }
  for (let i = paramStart; i < buf.length - 2; i++) {
    if (buf[i] === FOOTER_NAME_PREFIX[0] && buf[i + 1] === FOOTER_NAME_PREFIX[1] && buf[i + 2] === FOOTER_NAME_PREFIX[2]) {
      return { type: 'name_footer', offset: i }
    }
  }
  return { type: 'eof', offset: buf.length }
}

export function findSubShaderRegion(buf, paramStart, paramEnd, knownShaderTypes) {
  const text = new TextDecoder('latin1').decode(buf.subarray(paramStart, paramEnd))
  for (const name of knownShaderTypes) {
    const relative = text.indexOf(name)
    if (relative < 0) continue
    const absPos = paramStart + relative
    let headerStart = absPos
    const scanLimit = Math.max(paramStart, absPos - 16)
    for (let scan = absPos - 1; scan >= scanLimit; scan--) {
      if (buf[scan] === SHADER_MARKER_BYTES[0] || buf[scan] === SHADER_MARKER_BYTES[1]) {
        headerStart = scan
        break
      }
    }
    if (headerStart > paramStart + 4) {
      return { start: paramStart, end: headerStart, mainShaderStart: headerStart, blocks: [], colorSlots: new Map() }
    }
    return null
  }
  return null
}
