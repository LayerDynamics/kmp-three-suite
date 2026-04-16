// sRGB/linear conversion and hex dump helpers.
// Evidence: extract-kmp-exact.mjs:16-26, kmp-pipeline.mjs:934-950, 381-398.

export function linearToSrgb(c) {
  const v = Math.max(0, Math.min(1, c))
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

export function srgbToLinear(c) {
  const v = Math.max(0, Math.min(1, c))
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function clamp255(x) { return Math.max(0, Math.min(255, Math.round(x))) }

export function rgbToHex(r, g, b) {
  const ri = clamp255(linearToSrgb(r) * 255)
  const gi = clamp255(linearToSrgb(g) * 255)
  const bi = clamp255(linearToSrgb(b) * 255)
  return '#' + ri.toString(16).padStart(2, '0') + gi.toString(16).padStart(2, '0') + bi.toString(16).padStart(2, '0')
}

export function hexToComponents(hex) {
  const h = hex.replace(/^#/, '')
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ]
}

export function componentsToHex(r, g, b) {
  return '#' + clamp255(r * 255).toString(16).padStart(2, '0') +
               clamp255(g * 255).toString(16).padStart(2, '0') +
               clamp255(b * 255).toString(16).padStart(2, '0')
}

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
