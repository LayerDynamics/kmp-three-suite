// sRGB/linear conversion and hex dump helpers.
// Evidence: extract-kmp-exact.mjs:16-26, kmp-pipeline.mjs:934-950, 381-398.

/**
 * Convert a linear-light channel value to sRGB using the IEC 61966-2-1
 * piecewise curve. Input is clamped to `[0, 1]` before conversion.
 *
 * @param {number} c Linear-light channel value.
 * @returns {number} sRGB-encoded channel value in `[0, 1]`.
 */
export function linearToSrgb(c) {
  const v = Math.max(0, Math.min(1, c))
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/**
 * Convert an sRGB-encoded channel value to linear light using the inverse of
 * {@link linearToSrgb}. Input is clamped to `[0, 1]` before conversion.
 *
 * @param {number} c sRGB-encoded channel value.
 * @returns {number} Linear-light channel value in `[0, 1]`.
 */
export function srgbToLinear(c) {
  const v = Math.max(0, Math.min(1, c))
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function clamp255(x) { return Math.max(0, Math.min(255, Math.round(x))) }

/**
 * Convert a linear-light RGB triplet to an `#rrggbb` hex string via
 * {@link linearToSrgb} (i.e. the returned hex is sRGB-encoded for direct use
 * in CSS or Three.js color inputs).
 *
 * @param {number} r Linear red channel in `[0, 1]`.
 * @param {number} g Linear green channel in `[0, 1]`.
 * @param {number} b Linear blue channel in `[0, 1]`.
 * @returns {string} Lowercase `#rrggbb` hex string.
 */
export function rgbToHex(r, g, b) {
  const ri = clamp255(linearToSrgb(r) * 255)
  const gi = clamp255(linearToSrgb(g) * 255)
  const bi = clamp255(linearToSrgb(b) * 255)
  return '#' + ri.toString(16).padStart(2, '0') + gi.toString(16).padStart(2, '0') + bi.toString(16).padStart(2, '0')
}

/**
 * Decompose an `#rrggbb` hex string into three `[0, 1]`-normalised channel
 * values. The leading `#` is optional. No colour-space conversion is applied —
 * the returned triplet is in whatever space the hex encodes.
 *
 * @param {string} hex e.g. `"#ff8800"` or `"ff8800"`.
 * @returns {[number, number, number]}
 */
export function hexToComponents(hex) {
  const h = hex.replace(/^#/, '')
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ]
}

/**
 * Encode three `[0, 1]`-normalised channel values into an `#rrggbb` hex string
 * without colour-space conversion. Use {@link rgbToHex} if the inputs are in
 * linear space and the output is destined for an sRGB consumer.
 *
 * @param {number} r Channel value in `[0, 1]`.
 * @param {number} g Channel value in `[0, 1]`.
 * @param {number} b Channel value in `[0, 1]`.
 * @returns {string} Lowercase `#rrggbb` hex string.
 */
export function componentsToHex(r, g, b) {
  return '#' + clamp255(r * 255).toString(16).padStart(2, '0') +
               clamp255(g * 255).toString(16).padStart(2, '0') +
               clamp255(b * 255).toString(16).padStart(2, '0')
}

/**
 * Render a byte range as lines of `offset: hex-pairs  ascii` (classic hex dump
 * format). Non-printable bytes render as `.` in the ASCII gutter. Offsets are
 * always 6 zero-padded hex digits.
 *
 * @param {Uint8Array} buf Source buffer.
 * @param {number} start Inclusive byte offset.
 * @param {number} end Exclusive byte offset.
 * @param {{ width?: number }} [options] Bytes per line; defaults to 16.
 * @returns {string[]} One entry per line — suitable for `join('\n')`.
 */
export function hexDump(buf, start, end, options = {}) {
  const width = options.width ?? 16
  const lines = []
  for (let i = start; i < end; i += width) {
    const hexParts = []
    const asciiParts = []
    for (let j = 0; j < width && i + j < end; j++) {
      const b = buf[i + j]
      hexParts.push(b.toString(16).padStart(2, '0'))
      asciiParts.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')
    }
    lines.push(i.toString(16).padStart(6, '0') + ': ' + hexParts.join(' ').padEnd(width * 3 - 1) + '  ' + asciiParts.join(''))
  }
  return lines
}
