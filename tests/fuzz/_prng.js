// Deterministic PRNG + adversarial corpus helpers for fuzz suites.
// Every failing fuzz iteration prints its seed, so failures reproduce by
// re-running with FUZZ_SEED=<hex> FUZZ_ITERATIONS=<count>.

export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomBuffer(rng, size) {
  const buf = new Uint8Array(size)
  for (let i = 0; i < size; i++) buf[i] = Math.floor(rng() * 256)
  return buf
}

// Byte sequences the parser looks for. Sprinkling them into otherwise-random
// buffers raises the odds of hitting code paths that pure white noise rarely
// exercises (PNG walker, sub-shader scanner, footer detectors, TLV readers).
// Evidence for each constant: src/mtl/mtl.schema.js and the sub-shader layout
// comment in src/mtl/mtl-extraction.js:115-138.
export const LANDMARKS = Object.freeze({
  pngMagic: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  pngIend: Uint8Array.of(0x49, 0x45, 0x4e, 0x44),
  matmeta: new TextEncoder().encode('--MATMETA--'),
  footerName: Uint8Array.of(0x09, 0x00, 0x0b),
  shaderVersionLn: new TextEncoder().encode('//--lux:shader:1.0\n'),
  matVersionLn: new TextEncoder().encode('//--lux:mat:1.0\n'),
  shaderMarker: Uint8Array.of(0x89, 0x09),
  subShaderHeader: Uint8Array.of(
    0x89, 0x00, 0x9d, 0x00, 0x39, 0x04, 0x00,
    0x23, 0xf9, 0x8b, 0x29, 0x15,
  ),
  colorMarker: Uint8Array.of(0x23, 0xf9, 0x8b, 0x29, 0x15),
  tlvFloat: Uint8Array.of(0x17),
  tlvColor: Uint8Array.of(0x27),
  tlvInt: Uint8Array.of(0x1d),
  tlvBool: Uint8Array.of(0x25),
  tlvTexslot: Uint8Array.of(0x9b),
  semicolon: Uint8Array.of(0x3b),
  attributeKw: new TextEncoder().encode('attribute'),
  shaderName: new TextEncoder().encode('lux_toon'),
  knownBoolName: new TextEncoder().encode('transparency'),
})

export function sprinkle(rng, buf, sequences) {
  for (const seq of sequences) {
    if (seq.length === 0 || seq.length >= buf.length) continue
    const off = Math.floor(rng() * (buf.length - seq.length + 1))
    buf.set(seq, off)
  }
  return buf
}

export function sample(rng, arr, k) {
  const copy = arr.slice()
  const out = []
  const take = Math.min(k, copy.length)
  for (let i = 0; i < take; i++) {
    const idx = Math.floor(rng() * copy.length)
    out.push(copy[idx])
    copy.splice(idx, 1)
  }
  return out
}

export function hexPreview(buf, limit = 32) {
  if (!(buf instanceof Uint8Array)) return String(buf).slice(0, limit)
  const slice = buf.subarray(0, Math.min(limit, buf.length))
  return Array.from(slice, b => b.toString(16).padStart(2, '0')).join(' ')
}
