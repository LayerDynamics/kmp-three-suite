// End-to-end MTL decode. Orchestrates header / PNG / param-section / footer /
// material-name extraction. Evidence: kmp-pipeline.mjs:517-610, 858-895.

import {
  findPngBounds, findParamSection, findFooter, findSubShaderRegion,
  readAscii, readF32LE,
} from '../binary-tools/binary-tools.js'
import { parseParamSection } from './mtl-param-parser.js'

export const KNOWN_SHADER_TYPES = Object.freeze([
  'lux_toon', 'toon', 'lux_translucent', 'metallic_paint',
  'lux_plastic', 'lux_metal', 'lux_glass', 'lux_dielectric',
  'lux_gem', 'lux_diffuse', 'lux_emissive', 'lux_velvet',
  'lux_paint', 'lux_car_paint', 'lux_cloth', 'lux_skin',
  'lux_x_ray', 'lux_flat', 'lux_advanced', 'lux_cutaway',
])

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
    _buf: buf,
  }
}

function extractMaterialName(buf, footer) {
  if (footer.type === 'eof') return null
  const footerStart = footer.offset

  // Pattern 1: MATMETA — look for the "attribute" keyword, then the printable run
  // after it (terminated by ';' or non-printable). Evidence: kmp-pipeline.mjs:861-871.
  if (footer.type === 'matmeta') {
    const attrMarker = new TextEncoder().encode('attribute')
    const attrPos = findSub(buf, attrMarker, footerStart)
    if (attrPos >= 0) {
      let i = attrPos + attrMarker.length
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

function findSub(buf, needle, start) {
  const last = buf.length - needle.length
  outer: for (let i = start; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function decodeSubShaderRegion(buf, view, paramStart, paramEnd) {
  const region = findSubShaderRegion(buf, paramStart, paramEnd, KNOWN_SHADER_TYPES)
  if (!region) return null

  const blocks = []
  const colorSlots = new Map()

  // Each color-definition block begins with the 4-byte header `0x89 0x00 0x9d 0x00`.
  // Layout (relative to block start):
  //   byte 0-3   : 0x89 0x00 0x9d 0x00 (block header)
  //   byte 4-5   : 0x39 0x04 (inner marker)
  //   byte 6     : slot_index (u8 — matches the slot byte referenced later by
  //                lux_const_color_extended 0xa1 0x09 <slot> 0x23 0xf9 0x8b color)
  //   byte 7-11  : 0x23 0xf9 0x8b 0x29 0x15 (5-byte marker sequence)
  //   byte 12-15 : float32 r
  //   byte 16-19 : float32 g
  //   byte 20-23 : float32 b
  //   byte 24-27 : float32 a  (alpha channel; not stored in colorSlots)
  //   byte 28+   : "color"  + 0x1d + flags + "flags" + 0x9f  end-of-block marker
  // Evidence: hex dump of translucent candle wax sub-shader region, decoded bytes
  // match the reference's sub-shader interpretation in kmp-pipeline.mjs:380-465.
  for (let pos = region.start; pos + 28 < region.mainShaderStart; pos++) {
    if (buf[pos] === 0x89 && buf[pos + 1] === 0x00 && buf[pos + 2] === 0x9d && buf[pos + 3] === 0x00) {
      const slotIndex = buf[pos + 6]
      const subId = buf[pos + 2]
      const r = view.getFloat32(pos + 12, true)
      const g = view.getFloat32(pos + 16, true)
      const b = view.getFloat32(pos + 20, true)
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
          && r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1) {
        colorSlots.set(slotIndex, { r, g, b })
        blocks.push({ offset: pos, subId, slotIndex })
      }
    }
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
