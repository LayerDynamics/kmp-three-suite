// End-to-end MTL decode. Orchestrates header / PNG / param-section / footer /
// material-name extraction. Evidence: kmp-pipeline.mjs:517-610, 858-895.

import {
  findPngBounds, findParamSection, findFooter, findSubShaderRegion,
  findSequence, readAscii, readF32LE,
} from '../binary-tools/binary-tools.js'
import { parseParamSection } from './mtl-param-parser.js'
import { KNOWN_SHADER_TYPES } from '../lux/lux.schema.js'

// Re-exported so `src/index.js` can expose it as `MTL_KNOWN_SHADER_TYPES`.
// Single source of truth lives in `lux/lux.schema.js`; this avoids two
// independent frozen arrays drifting apart.
export { KNOWN_SHADER_TYPES }

/**
 * Encoded marker for the MATMETA footer pattern. Hoisted to module scope so
 * the TextEncoder allocation + encode run once at module load instead of on
 * every `extractMaterialName` call for matmeta-typed footers.
 */
const ATTR_MARKER = new TextEncoder().encode('attribute')

/**
 * Sub-shader color-block "display_name" label (Variant C). Hoisted once per
 * module load so the per-block validator walk does not re-encode it.
 */
const SUBSHADER_DISPLAY_NAME = new TextEncoder().encode('display_name')

/** Sanity cap on Variant C's u32 inline name length. */
const SUBSHADER_NAME_MAX = 128

/**
 * End-to-end decode of a single MTL byte buffer — header text, embedded PNG,
 * parameter TLV section, sub-shader color region, footer (material name), and
 * the shader type (always the first parsed param's name).
 *
 * The returned object retains the source buffer on `.source` so downstream
 * code can re-scan (hex dumps, coverage, re-archiving) without re-decoding.
 * Drop the extraction reference to free those bytes.
 *
 * @param {Uint8Array | ArrayBufferLike} mtlBuf Raw MTL bytes.
 * @returns {import('../../index.d.ts').MtlExtraction}
 */
export function extractMtl(mtlBuf) {
  const buf = mtlBuf instanceof Uint8Array ? mtlBuf : new Uint8Array(mtlBuf)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  const header = decodeHeader(buf)
  const pngInfo = findPngBounds(buf)
  const png = pngInfo
    ? { bytes: buf.subarray(pngInfo.start, pngInfo.end), start: pngInfo.start, end: pngInfo.end, size: pngInfo.size }
    : null

  const pngEnd = pngInfo ? pngInfo.end : -1
  const { start, end } = findParamSection(buf, pngEnd, -1)

  const subShaderRegion = decodeSubShaderRegion(buf, view, start, end)
  const parseStart = subShaderRegion ? subShaderRegion.mainShaderStart : start

  const rawParameters = parseParamSection(buf, view, parseStart, end)
  const shaderType = rawParameters.length > 0 ? rawParameters[0].name : null

  const footer = findFooter(buf, end)
  const materialName = extractMaterialName(buf, footer)

  return {
    header,
    png,
    paramSection: { start: parseStart, end },
    subShaderRegion,
    footer: { start: footer.offset, type: footer.type },
    rawParameters,
    materialName,
    shaderType,
    source: buf,
  }
}

function extractMaterialName(buf, footer) {
  if (footer.type === 'eof') return null
  const footerStart = footer.offset

  // Pattern 1: MATMETA — look for the "attribute" keyword, then the printable run
  // after it (terminated by ';' or non-printable). Evidence: kmp-pipeline.mjs:861-871.
  if (footer.type === 'matmeta') {
    const attrPos = findSequence(buf, ATTR_MARKER, footerStart)
    if (attrPos >= 0) {
      let i = attrPos + ATTR_MARKER.length
      while (i < buf.length && !isPrintableByte(buf[i])) i++
      const nameStart = i
      while (i < buf.length && buf[i] >= 0x20 && buf[i] < 0x7f && buf[i] !== 0x3b) i++
      const name = readAscii(buf, nameStart, i).trim()
      if (name.length > 3) return name
    }
  }

  // Pattern 2: name footer prefix 0x09 0x00 0x0b <len_byte> <name> ';'.
  // Evidence: kmp-pipeline.mjs:873-881.
  if (footer.type === 'name_footer'
      && buf[footerStart] === 0x09 && buf[footerStart + 1] === 0x00 && buf[footerStart + 2] === 0x0b) {
    const nameLen = buf[footerStart + 3]
    if (nameLen > 0 && footerStart + 4 + nameLen <= buf.length) {
      const raw = readAscii(buf, footerStart + 4, footerStart + 4 + nameLen).replace(/;$/, '').trim()
      if (raw.length > 0) return raw
    }
  }

  // Pattern 3: scan the footer region for a capitalised printable string of
  // length > 5. Evidence: kmp-pipeline.mjs:883-893.
  let i = footerStart
  while (i < buf.length) {
    if (isPrintableByte(buf[i])) {
      const s = i
      while (i < buf.length && buf[i] >= 0x20 && buf[i] < 0x7f && buf[i] !== 0x3b) i++
      const cand = readAscii(buf, s, i).trim()
      if (cand.length > 5 && /^[A-Z]/.test(cand)) return cand
    }
    i++
  }
  return null
}

function isPrintableByte(b) { return b >= 0x20 && b < 0x7f }

/**
 * Locate the RGBA float32 quartet inside a sub-shader color-def block by
 * dispatching on the 5-byte post-slot marker at `pos + 7..+11`. Returns
 * `-1` when the bytes at `pos` do not match any known variant or when the
 * Variant C display-name preamble does not validate.
 *
 * @param {Uint8Array} buf
 * @param {DataView} view
 * @param {number} pos Block start (0x89 or 0x9f).
 * @param {number} lim Inclusive upper bound on any byte access (`mainShaderStart`).
 * @returns {number} Absolute byte offset of the RGBA f32 quartet, or `-1`.
 */
function findSubShaderRgba(buf, view, pos, lim) {
  const m7 = buf[pos + 7]
  const m8 = buf[pos + 8]
  const m9 = buf[pos + 9]
  const m10 = buf[pos + 10]
  const m11 = buf[pos + 11]
  if ((m7 === 0x23 && m8 === 0xf9 && m9 === 0x8b) || (m7 === 0xa5 && m8 === 0x20 && m9 === 0x0d)) {
    if (m10 === 0x29 && m11 === 0x15) return pos + 12
    if (m7 === 0xa5 && m10 === 0x2f && m11 === 0x15) {
      // Variant C — u32 name-length, <name> bytes, "display_name", 0x29 0x15, RGBA.
      if (pos + 16 >= lim) return -1
      const nameLen = view.getUint32(pos + 12, true)
      if (nameLen === 0 || nameLen > SUBSHADER_NAME_MAX) return -1
      const afterName = pos + 16 + nameLen
      const labelEnd = afterName + SUBSHADER_DISPLAY_NAME.length
      if (labelEnd + 2 >= lim) return -1
      for (let i = 0; i < SUBSHADER_DISPLAY_NAME.length; i++) {
        if (buf[afterName + i] !== SUBSHADER_DISPLAY_NAME[i]) return -1
      }
      if (buf[labelEnd] !== 0x29 || buf[labelEnd + 1] !== 0x15) return -1
      return labelEnd + 2
    }
  }
  return -1
}

function decodeSubShaderRegion(buf, view, paramStart, paramEnd) {
  const region = findSubShaderRegion(buf, paramStart, paramEnd, KNOWN_SHADER_TYPES)
  if (!region) return null

  const blocks = []
  const colorSlots = new Map()

  // Color-def blocks share header bytes 0..6 (0x89|0x9f, 0x00, 0x9d, 0x00,
  // 0x39, 0x04, slot). Three post-header variants carry the RGBA payload:
  //   A: 0x23 0xf9 0x8b 0x29 0x15 + RGBA           (KeyShot 11 — candle wax)
  //   B: 0xa5 0x20 0x0d 0x29 0x15 + RGBA           (KeyShot 14 — RED)
  //   C: 0xa5 0x20 0x0d 0x2f 0x15 + u32 name-len +
  //      <name> + "display_name" + 0x29 0x15 + RGBA (KeyShot 14 — GOLD)
  // Evidence: candle-wax blocks at 0x458ea+, RED at 0x48aba/0x48ae8,
  //           GOLD at 0x62c17/0x62c5b. `subId` is the +5 format-variant
  //           byte, not the header byte at +2 — matches reference pipeline.
  const lim = region.mainShaderStart
  for (let pos = region.start; pos + 28 < lim; pos++) {
    const b0 = buf[pos]
    if (b0 !== 0x89 && b0 !== 0x9f) continue
    if (buf[pos + 1] !== 0x00 || buf[pos + 2] !== 0x9d || buf[pos + 3] !== 0x00) continue
    if (buf[pos + 4] !== 0x39 || buf[pos + 5] !== 0x04) continue
    const rgbaOffset = findSubShaderRgba(buf, view, pos, lim)
    if (rgbaOffset < 0 || rgbaOffset + 16 > lim) continue
    const slotIndex = buf[pos + 6]
    const subId = buf[pos + 5]
    const r = readF32LE(view, rgbaOffset)
    const g = readF32LE(view, rgbaOffset + 4)
    const b = readF32LE(view, rgbaOffset + 8)
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue
    if (r < 0 || r > 1 || g < 0 || g > 1 || b < 0 || b > 1) continue
    colorSlots.set(slotIndex, { r, g, b })
    blocks.push({ offset: pos, subId, slotIndex })
  }

  return {
    start: region.start,
    end: region.end,
    mainShaderStart: region.mainShaderStart,
    blocks,
    colorSlots,
  }
}

function decodeHeader(buf) {
  const head = readAscii(buf, 0, Math.min(256, buf.length))
  const result = {}
  const mat = head.match(/\/\/--lux:mat:(\S+)/)
  if (mat) result.matVersion = mat[1]
  const shader = head.match(/\/\/--lux:shader:(\S+)/)
  if (shader) result.shaderVersion = shader[1]
  const ks = head.match(/KeyShot.*?v([\d.]+)/)
  if (ks) result.keyshotVersion = ks[1]
  return result
}
