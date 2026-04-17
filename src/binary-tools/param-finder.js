// Byte-pattern landmark finders inside an MTL buffer.
// Evidence: kmp-pipeline.mjs:83-92 (findSequence), 534-576 (param bounds + footer),
//           578-607 (sub-shader region), extract-toon-complete.mjs:82-92 (PNG).

import {
  PNG_MAGIC, PNG_IEND, MATMETA_MARKER, FOOTER_NAME_PREFIX,
  SHADER_VERSION_LINE, SHADER_MARKER_BYTES, TYPE_SUBSHADER_REF,
} from '../mtl/mtl.schema.js'
import { readAscii } from './decoder.js'

/**
 * Linear byte-sequence search — return the first offset ≥ `start` at which
 * `needle` occurs in `buf`, or `-1` if not found. Equivalent to
 * `Buffer.indexOf` but works on plain `Uint8Array`.
 *
 * @param {Uint8Array} buf
 * @param {Uint8Array} needle
 * @param {number} [start=0] Inclusive search origin.
 * @returns {number} Absolute byte offset, or -1 if no match.
 */
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

/**
 * Locate the first embedded PNG in an MTL buffer and return its inclusive
 * start / exclusive end offsets plus its total byte size. Walks the PNG chunk
 * stream from the `\x89PNG\r\n\x1A\n` signature to the `IEND` chunk terminator
 * and validates each chunk's declared length against the buffer bounds.
 *
 * @param {Uint8Array} buf
 * @returns {{ start: number; end: number; size: number } | null} `null` when
 *   no PNG is present or the chunk stream is malformed.
 */
export function findPngBounds(buf) {
  const s = findSequence(buf, PNG_MAGIC)
  if (s < 0) return null
  let cursor = s + PNG_MAGIC.length
  while (cursor + 8 <= buf.length) {
    const length =
      ((buf[cursor] << 24) |
        (buf[cursor + 1] << 16) |
        (buf[cursor + 2] << 8) |
        buf[cursor + 3]) >>> 0
    if (length > 0x7fffffff) return null
    const typeOffset = cursor + 4
    const chunkEnd = cursor + 8 + length + 4
    if (chunkEnd > buf.length) return null
    const isIend =
      buf[typeOffset] === PNG_IEND[0] &&
      buf[typeOffset + 1] === PNG_IEND[1] &&
      buf[typeOffset + 2] === PNG_IEND[2] &&
      buf[typeOffset + 3] === PNG_IEND[3]
    if (isIend) return { start: s, end: chunkEnd, size: chunkEnd - s }
    cursor = chunkEnd
  }
  return null
}

/**
 * Resolve the `[start, end)` byte range of an MTL's parameter TLV section.
 *
 * Start is the earliest available anchor, in priority order: byte after the
 * embedded PNG (`pngEnd > 0`), byte after the `//--lux:shader:` line
 * (`shaderLineEnd > 0`), a fresh scan for that line, or `min(128, buf.length)`
 * as a last resort. End is the offset returned by {@link findFooter}.
 *
 * @param {Uint8Array} buf
 * @param {number} pngEnd Exclusive end of the embedded PNG, or `-1`/`0` if absent.
 * @param {number} shaderLineEnd End of the shader-version header line, or
 *   `-1`/`0` if unknown.
 * @returns {{ start: number; end: number }}
 */
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

/**
 * Find the footer that ends the parameter section and begins the material-
 * metadata region. Tries, in order: `--MATMETA--` marker → `0x09 0x00 0x0b`
 * name-prefix marker → end of buffer (`'eof'`).
 *
 * @param {Uint8Array} buf
 * @param {number} paramStart Byte offset at which to begin searching.
 * @returns {{ type: 'matmeta' | 'name_footer' | 'eof'; offset: number }}
 */
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

/**
 * Identify the sub-shader color block region, if any, that precedes the main
 * shader's parameter stream. Scans the param-section text for the first
 * occurrence of any known shader-type name, then walks back up to 16 bytes to
 * find the shader marker (`0x89` / `0x09`) that begins the main shader block.
 *
 * Returns a bare region descriptor with empty `blocks` / `colorSlots`;
 * {@link extractMtl} populates those via its own block-level validator.
 *
 * @param {Uint8Array} buf
 * @param {number} paramStart Inclusive byte offset of the param section.
 * @param {number} paramEnd Exclusive byte offset of the param section.
 * @param {readonly string[]} knownShaderTypes Candidate names searched in order.
 * @returns {import('../../index.d.ts').SubShaderRegion | null}
 */
export function findSubShaderRegion(buf, paramStart, paramEnd, knownShaderTypes) {
  const text = readAscii(buf, paramStart, paramEnd)
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
  }
  return null
}

/**
 * Scan a byte range for sub-shader reference markers of the form
 * `TYPE_SUBSHADER_REF 0x09 <slot>` (i.e. `0xa1 0x09 <u8>`). Each hit is a
 * reference in the main shader param stream to a colour previously defined in
 * the sub-shader colour block (see {@link findSubShaderRegion}). Callers can
 * correlate `slot` with the `colorSlots` map returned from that decode.
 *
 * Evidence: kmp-pipeline.mjs:412-421 (0xa1 subshader_ref_marker detection),
 *           340-356 (lux_const_color_extended `0xa1 0x09 <slot>` preamble).
 *
 * @param {Uint8Array} buf Full MTL buffer.
 * @param {number} paramStart Inclusive byte offset to begin scanning.
 * @param {number} paramEnd Exclusive byte offset to stop scanning.
 * @returns {Array<{ offset: number; slot: number }>} Byte offsets of every
 *   `TYPE_SUBSHADER_REF` marker followed by the fixed `0x09` discriminator, in
 *   ascending offset order. Empty array when no refs are present.
 */
export function findSubShaderRefs(buf, paramStart, paramEnd) {
  const refs = []
  // Need to read buf[i], buf[i+1], buf[i+2] — so i+2 must be strictly
  // less than both paramEnd (exclusive) and buf.length. A 2-byte-or-shorter
  // window contains no complete ref and yields an empty array.
  const stop = Math.min(paramEnd, buf.length) - 2
  for (let i = Math.max(0, paramStart); i < stop; i++) {
    if (buf[i] !== TYPE_SUBSHADER_REF) continue
    if (buf[i + 1] !== 0x09) continue
    refs.push({ offset: i, slot: buf[i + 2] })
  }
  return refs
}
