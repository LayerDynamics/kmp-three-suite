// Little-endian readers and ASCII decoders.

// Module-scope Latin-1 decoder. Reused across every call to avoid per-invocation
// allocation and to replace the quadratic `str += String.fromCharCode(b)` pattern
// with a single O(n) slice decode.
const LATIN1_DECODER = new TextDecoder('latin1', { fatal: false })
const NON_PRINTABLE_RE = /[^\x20-\x7e]+/g

/**
 * Read a little-endian 32-bit IEEE-754 float at `offset`.
 * @param {DataView} view
 * @param {number} offset Byte offset within `view`.
 * @returns {number}
 */
export function readF32LE(view, offset) { return view.getFloat32(offset, true) }

/**
 * Read a little-endian unsigned 32-bit integer at `offset`.
 * @param {DataView} view
 * @param {number} offset Byte offset within `view`.
 * @returns {number}
 */
export function readU32LE(view, offset) { return view.getUint32(offset, true) }

/**
 * Read a little-endian signed 32-bit integer at `offset`.
 * @param {DataView} view
 * @param {number} offset Byte offset within `view`.
 * @returns {number}
 */
export function readI32LE(view, offset) { return view.getInt32(offset, true) }

/**
 * Read a little-endian unsigned 16-bit integer at `offset`.
 * @param {DataView} view
 * @param {number} offset Byte offset within `view`.
 * @returns {number}
 */
export function readU16LE(view, offset) { return view.getUint16(offset, true) }

/**
 * Read a single unsigned byte from a Uint8Array at `offset`.
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {number}
 */
export function readU8(buf, offset) { return buf[offset] }

/**
 * Decode a byte range as Latin-1 (verbatim; no normalisation or filtering).
 * `end` is clamped to `buf.length`; ranges where `stop <= start` return `''`.
 *
 * Uses a module-scope TextDecoder to avoid per-call allocation and the
 * O(n²) `String.fromCharCode` accumulator pattern.
 *
 * @param {Uint8Array} buf
 * @param {number} start Inclusive byte offset.
 * @param {number} end Exclusive byte offset (clamped to `buf.length`).
 * @returns {string}
 */
export function readAscii(buf, start, end) {
  const stop = Math.min(end, buf.length)
  if (stop <= start) return ''
  return LATIN1_DECODER.decode(buf.subarray(start, stop))
}

/**
 * Decode a byte range as Latin-1, then strip every run of non-printable
 * characters (outside `\x20–\x7e`). Useful for extracting param-name candidates
 * from mixed binary/ASCII regions.
 *
 * @param {Uint8Array} buf
 * @param {number} start Inclusive byte offset.
 * @param {number} end Exclusive byte offset (clamped to `buf.length`).
 * @returns {string}
 */
export function readAsciiPrintable(buf, start, end) {
  const stop = Math.min(end, buf.length)
  if (stop <= start) return ''
  return LATIN1_DECODER.decode(buf.subarray(start, stop)).replace(NON_PRINTABLE_RE, '')
}
