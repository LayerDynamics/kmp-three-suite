// Fuzz invariants for extractMtl: on any Uint8Array, the call must either
// return a well-formed extraction OR throw KmpParseError. No RangeError,
// no TypeError, no hang beyond the per-call budget, no OOM.
//
// Review.md:65 — "Random-buffer extractMtl / process calls that assert
// 'either succeeds or throws KmpParseError, never panics' would catch every
// OOB, infinite-loop, and pathological-input bug in this review at once."
//
// Override scale for deeper nightly runs:
//   FUZZ_ITERATIONS=20000 FUZZ_SEED=0xcafef00d npm test -- fuzz

import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import { extractMtl } from '../../src/mtl/mtl-extraction.js'
import { KmpParseError } from '../../src/errors.js'
import {
  mulberry32, randomBuffer, sprinkle, sample, hexPreview, LANDMARKS,
} from './_prng.js'

const ITER = Number(process.env.FUZZ_ITERATIONS ?? 500)
const BASE_SEED = Number(process.env.FUZZ_SEED ?? 0x1a2b3c4d)
const PER_CALL_BUDGET_MS = 1000
const ALL_LANDMARKS = Object.values(LANDMARKS)

function assertSafeCall(buf, seed, iter, label) {
  const t0 = performance.now()
  let result, thrown
  try {
    result = extractMtl(buf)
  } catch (e) {
    thrown = e
  }
  const elapsed = performance.now() - t0
  if (thrown && !(thrown instanceof KmpParseError)) {
    throw new Error(
      `fuzz panic: non-KmpParseError thrown from extractMtl\n` +
      `  label=${label} seed=0x${seed.toString(16)} iter=${iter}\n` +
      `  size=${buf.length} head=${hexPreview(buf)}\n` +
      `  throwType=${thrown?.constructor?.name} throwMsg=${thrown?.message}`,
      { cause: thrown },
    )
  }
  if (elapsed > PER_CALL_BUDGET_MS) {
    throw new Error(
      `fuzz slow-call: extractMtl exceeded ${PER_CALL_BUDGET_MS} ms\n` +
      `  label=${label} seed=0x${seed.toString(16)} iter=${iter}\n` +
      `  elapsed=${elapsed.toFixed(1)} ms size=${buf.length} head=${hexPreview(buf)}`,
    )
  }
  if (result) {
    // Contract invariants on the success path — these are the properties any
    // downstream caller relies on. Any violation is a structural bug caught
    // by the fuzzer, not a format-specific one.
    expect(result.paramSection.start).toBeGreaterThanOrEqual(0)
    expect(result.paramSection.end).toBeGreaterThanOrEqual(result.paramSection.start)
    expect(result.paramSection.end).toBeLessThanOrEqual(buf.length)
    expect(Array.isArray(result.rawParameters)).toBe(true)
    if (result.png) {
      expect(result.png.start).toBeGreaterThanOrEqual(0)
      expect(result.png.end).toBeGreaterThan(result.png.start)
      expect(result.png.end).toBeLessThanOrEqual(buf.length)
      expect(result.png.size).toBe(result.png.end - result.png.start)
    }
    expect(typeof result.footer.start).toBe('number')
    expect(result.footer.start).toBeGreaterThanOrEqual(0)
    expect(result.footer.start).toBeLessThanOrEqual(buf.length)
  }
}

describe('fuzz: extractMtl — safety invariant', () => {
  it(`survives ${ITER} uniform-random buffers (0..64 KiB)`, { timeout: 60_000 }, () => {
    for (let i = 0; i < ITER; i++) {
      const seed = (BASE_SEED + i) >>> 0
      const rng = mulberry32(seed)
      const size = Math.floor(rng() * 65536)
      const buf = randomBuffer(rng, size)
      assertSafeCall(buf, seed, i, 'uniform')
    }
  })

  it(`survives ${ITER} landmark-sprinkled buffers`, { timeout: 60_000 }, () => {
    for (let i = 0; i < ITER; i++) {
      const seed = ((BASE_SEED ^ 0xdeadbeef) + i) >>> 0
      const rng = mulberry32(seed)
      const size = 256 + Math.floor(rng() * 32768)
      const buf = randomBuffer(rng, size)
      const k = 1 + Math.floor(rng() * 6)
      sprinkle(rng, buf, sample(rng, ALL_LANDMARKS, k))
      assertSafeCall(buf, seed, i, 'sprinkled')
    }
  })

  it('survives degenerate inputs (empty, 1-byte, all-zero, all-0xff, all-semicolons)', () => {
    const cases = [
      ['empty', new Uint8Array(0)],
      ['one-zero', new Uint8Array([0])],
      ['one-ff', new Uint8Array([0xff])],
      ['one-semicolon', new Uint8Array([0x3b])],
      ['two-bytes', new Uint8Array([0x89, 0x50])],
      ['32k-zeros', new Uint8Array(32_768)],
      ['32k-ff', new Uint8Array(32_768).fill(0xff)],
      ['32k-semicolons', new Uint8Array(32_768).fill(0x3b)],
      ['32k-printable', new Uint8Array(32_768).fill(0x41)],
    ]
    for (const [label, buf] of cases) {
      assertSafeCall(buf, BASE_SEED, 0, label)
    }
  })

  it('survives each landmark alone and repeated 8×', () => {
    let idx = 0
    for (const [name, seq] of Object.entries(LANDMARKS)) {
      assertSafeCall(new Uint8Array(seq), BASE_SEED, idx++, `solo:${name}`)
      const repeated = new Uint8Array(seq.length * 8)
      for (let r = 0; r < 8; r++) repeated.set(seq, r * seq.length)
      assertSafeCall(repeated, BASE_SEED, idx++, `repeat:${name}`)
    }
  })

  it('survives Review.md-cited adversarial shapes', () => {
    // Shape A: sub-shader header + garbage — scanner used to accept partial
    // matches. Drives src/mtl/mtl-extraction.js:139-161 with many variants.
    for (let i = 0; i < 64; i++) {
      const seed = (BASE_SEED + 0x5580 + i) >>> 0
      const rng = mulberry32(seed)
      const buf = randomBuffer(rng, 512)
      buf.set(LANDMARKS.shaderVersionLn, 0)
      buf.set(LANDMARKS.subShaderHeader, 80 + Math.floor(rng() * 64))
      assertSafeCall(buf, seed, i, 'adv:subShaderHeader+garbage')
    }

    // Shape B: footer peppered with ';' — Review.md:23 alleged pattern-3
    // could hang on a semicolon. Fuzz confirms the outer loop advances.
    for (let i = 0; i < 64; i++) {
      const seed = (BASE_SEED + 0x9900 + i) >>> 0
      const rng = mulberry32(seed)
      const buf = new Uint8Array(4096)
      buf.set(LANDMARKS.shaderVersionLn, 0)
      for (let j = LANDMARKS.shaderVersionLn.length; j < buf.length; j++) {
        buf[j] = rng() < 0.5 ? 0x3b : Math.floor(rng() * 256)
      }
      assertSafeCall(buf, seed, i, 'adv:semicolon-footer')
    }

    // Shape C: PNG magic with no IEND or a truncated chunk — must not read
    // past end of buffer. Drives src/binary-tools/param-finder.js:21-44.
    for (let i = 0; i < 64; i++) {
      const seed = (BASE_SEED + 0xc001 + i) >>> 0
      const rng = mulberry32(seed)
      const size = 16 + Math.floor(rng() * 256)
      const buf = randomBuffer(rng, size)
      buf.set(LANDMARKS.pngMagic, 0)
      assertSafeCall(buf, seed, i, 'adv:truncatedPng')
    }

    // Shape D: PNG magic + absurd big-endian chunk length. Walker must bail
    // instead of dereferencing buf[cursor + 8 + huge + 4].
    for (let i = 0; i < 32; i++) {
      const seed = (BASE_SEED + 0xabba + i) >>> 0
      const rng = mulberry32(seed)
      const buf = new Uint8Array(64)
      buf.set(LANDMARKS.pngMagic, 0)
      const len = Math.floor(rng() * 0xffffffff) >>> 0
      buf[8] = (len >>> 24) & 0xff
      buf[9] = (len >>> 16) & 0xff
      buf[10] = (len >>> 8) & 0xff
      buf[11] = len & 0xff
      assertSafeCall(buf, seed, i, 'adv:absurdChunkLen')
    }

    // Shape E: MATMETA marker but no "attribute" keyword — pattern-1 miss
    // then pattern-3 fallback. Drives src/mtl/mtl-extraction.js:51-94.
    for (let i = 0; i < 32; i++) {
      const seed = (BASE_SEED + 0xface + i) >>> 0
      const rng = mulberry32(seed)
      const buf = randomBuffer(rng, 1024)
      buf.set(LANDMARKS.shaderVersionLn, 0)
      buf.set(LANDMARKS.matmeta, 512)
      assertSafeCall(buf, seed, i, 'adv:matmetaNoAttribute')
    }

    // Shape F: footer-name prefix (09 00 0b) with random length byte right
    // after — exercises the length-prefixed Pattern-2 decode under adversarial
    // lengths (including 0xff which overflows the buffer).
    for (let i = 0; i < 64; i++) {
      const seed = (BASE_SEED + 0xf00b + i) >>> 0
      const rng = mulberry32(seed)
      const buf = randomBuffer(rng, 256 + Math.floor(rng() * 512))
      buf.set(LANDMARKS.shaderVersionLn, 0)
      const off = Math.floor(rng() * (buf.length - 8))
      buf.set(LANDMARKS.footerName, off)
      buf[off + 3] = Math.floor(rng() * 256)
      assertSafeCall(buf, seed, i, 'adv:footerNameRandomLength')
    }

    // Shape G: TLV marker bytes dense-packed near EOF — Review.md:31 cited
    // drift between scanMarkers (m + 5 < end), validator (pos + 5 >= end),
    // and readValue (pos + 6 > end). fitsValue canonicalisation means any
    // TLV marker within 5 bytes of end must be dropped uniformly.
    for (let i = 0; i < 64; i++) {
      const seed = (BASE_SEED + 0x7711 + i) >>> 0
      const rng = mulberry32(seed)
      const buf = new Uint8Array(128)
      buf.set(LANDMARKS.shaderVersionLn, 0)
      // Pack TLV markers densely at the end so every validator's boundary
      // check fires.
      const markers = [0x17, 0x1d, 0x25, 0x27, 0x9b]
      for (let j = buf.length - 10; j < buf.length; j++) {
        buf[j] = markers[Math.floor(rng() * markers.length)]
      }
      assertSafeCall(buf, seed, i, 'adv:tlvNearEof')
    }
  })
})
