// Fuzz invariants for the full pipeline process(): on any input, the call
// must either return ProcessResult[] OR throw KmpParseError. No RangeError,
// no TypeError, no OOM, no hang beyond the per-call budget.
//
// Three surfaces:
//   1. Raw random bytes fed to process() — exercises ZIP decode failure path.
//   2. Valid ZIPs with fuzzed .mtl / .xml entries — exercises MTL extraction,
//      parameter parsing, material-definition construction, XML config.
//   3. CVE-style anchors — zip-slip, NUL byte, unicode slash, prototype-
//      pollution XML, NO_MTL. Named cases that must throw KmpParseError with
//      the declared code.
//
// Override scale for deeper runs:
//   FUZZ_ITERATIONS=5000 FUZZ_SEED=0x1234abcd npm test -- process-fuzz

import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import { zipSync } from 'fflate'
import { process as kmpProcess } from '../../src/pipeline/process.js'
import { KmpParseError } from '../../src/errors.js'
import {
  mulberry32, randomBuffer, sprinkle, sample, hexPreview, LANDMARKS,
} from './_prng.js'

const ITER = Number(process.env.FUZZ_ITERATIONS ?? 250)
const BASE_SEED = Number(process.env.FUZZ_SEED ?? 0x2b3c4d5e)
const PER_CALL_BUDGET_MS = 2000
const ALL_LANDMARKS = Object.values(LANDMARKS)

async function assertSafeCall(input, seed, iter, label, opts) {
  const t0 = performance.now()
  let result, thrown
  try {
    result = await kmpProcess(input, opts)
  } catch (e) {
    thrown = e
  }
  const elapsed = performance.now() - t0
  const sizeHint = input instanceof Uint8Array ? `bytes=${input.length}` : `type=${typeof input}`
  if (thrown && !(thrown instanceof KmpParseError)) {
    throw new Error(
      `fuzz panic: non-KmpParseError thrown from process()\n` +
      `  label=${label} seed=0x${seed.toString(16)} iter=${iter} ${sizeHint}\n` +
      `  head=${hexPreview(input)}\n` +
      `  throwType=${thrown?.constructor?.name} throwMsg=${thrown?.message}`,
      { cause: thrown },
    )
  }
  if (elapsed > PER_CALL_BUDGET_MS) {
    throw new Error(
      `fuzz slow-call: process() exceeded ${PER_CALL_BUDGET_MS} ms\n` +
      `  label=${label} seed=0x${seed.toString(16)} iter=${iter} ${sizeHint}\n` +
      `  elapsed=${elapsed.toFixed(1)} ms head=${hexPreview(input)}`,
    )
  }
  if (result !== undefined) {
    // The user's stated invariant is the non-panic bar only:
    // "either succeeds OR throws KmpParseError, never panics."
    // We assert just enough to detect a pipeline that silently returned
    // the wrong top-level type — deeper result-shape invariants (coverage
    // bounds, material-definition correctness) live in their own suites.
    expect(Array.isArray(result)).toBe(true)
    for (const r of result) {
      expect(typeof r.meta).toBe('object')
      expect(typeof r.meta.mtlFile).toBe('string')
      expect(r.meta.mtlFile).toMatch(/\.mtl$/i)
      expect(Array.isArray(r.rawParameters)).toBe(true)
      expect(typeof r.materialDefinition).toBe('object')
      expect(Array.isArray(r.warnings)).toBe(true)
    }
  }
}

function fuzzedMtlBuffer(rng, size) {
  const buf = randomBuffer(rng, size)
  buf.set(LANDMARKS.shaderVersionLn, 0)
  const k = 1 + Math.floor(rng() * 5)
  sprinkle(rng, buf, sample(rng, ALL_LANDMARKS, k))
  return buf
}

describe('fuzz: process() — raw random bytes', () => {
  it(`survives ${ITER} random buffers fed as non-archive input`, { timeout: 60_000 }, async () => {
    for (let i = 0; i < ITER; i++) {
      const seed = (BASE_SEED + i) >>> 0
      const rng = mulberry32(seed)
      const size = Math.floor(rng() * 8192)
      const buf = randomBuffer(rng, size)
      await assertSafeCall(buf, seed, i, 'raw-random')
    }
  })

  it('rejects non-Uint8Array / non-Buffer / non-Blob inputs with KmpParseError', async () => {
    const bad = [42, {}, [], true, Symbol('x')]
    for (const input of bad) {
      let thrown
      try { await kmpProcess(input) } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(KmpParseError)
      expect(thrown.code).toBe('BAD_ZIP')
    }
  })
})

describe('fuzz: process() — valid ZIPs with fuzzed entries', () => {
  it(`survives ${ITER} zips with a fuzzed single .mtl entry`, { timeout: 120_000 }, async () => {
    for (let i = 0; i < ITER; i++) {
      const seed = (BASE_SEED + 0x10000 + i) >>> 0
      const rng = mulberry32(seed)
      const size = 256 + Math.floor(rng() * 4096)
      const mtl = fuzzedMtlBuffer(rng, size)
      const zip = zipSync({ 'material.mtl': mtl })
      await assertSafeCall(zip, seed, i, 'fuzzed-mtl-in-zip')
    }
  })

  it('survives zips with fuzzed .xml config entries (prototype-pollution surface)', async () => {
    const mtl = new Uint8Array(256)
    mtl.set(LANDMARKS.shaderVersionLn, 0)
    const xmlCases = [
      '<cfg shader="lux_toon" __proto__="x" />',
      '<cfg shader="lux_metal" constructor="x" prototype="y" />',
      '<cfg ' + 'shader="lux_translucent" '.repeat(200) + '/>',
      '<!-- shader="sneaky" --> <cfg shader="lux_toon" />',
      '<cfg shader="&amp;&lt;&gt;" />',
      '<cfg shader="' + 'A'.repeat(10_000) + '" />',
      '',
      '<<<>>>',
      '<cfg ' + 'badkey="v" '.repeat(100) + '/>',
    ]
    let i = 0
    for (const xml of xmlCases) {
      const zip = zipSync({
        'material.mtl': mtl,
        'config.xml': new TextEncoder().encode(xml),
      })
      await assertSafeCall(zip, BASE_SEED, i++, `fuzzed-xml[${i}]`)
    }
    // Prototype-pollution anchor: after parsing, Object.prototype must not
    // have gained a polluted key.
    expect(Object.prototype.polluted).toBeUndefined()
    expect(({}).__proto__.polluted).toBeUndefined()
  })

  it('survives multi-MTL archives with each entry independently fuzzed', { timeout: 60_000 }, async () => {
    for (let i = 0; i < 200; i++) {
      const seed = (BASE_SEED + 0x20000 + i) >>> 0
      const rng = mulberry32(seed)
      const count = 1 + Math.floor(rng() * 4)
      const entries = {}
      for (let e = 0; e < count; e++) {
        entries[`mat-${e}.mtl`] = fuzzedMtlBuffer(rng, 256 + Math.floor(rng() * 2048))
      }
      if (rng() < 0.5) entries['config.xml'] = new TextEncoder().encode('<cfg shader="lux_toon" />')
      if (rng() < 0.3) entries['tex/normal.png'] = fuzzedMtlBuffer(rng, 128)
      const zip = zipSync(entries)
      await assertSafeCall(zip, seed, i, 'multi-mtl')
    }
  })
})

describe('fuzz: process() — named CVE-style anchors', () => {
  const validMtl = () => {
    const m = new Uint8Array(256)
    m.set(LANDMARKS.shaderVersionLn, 0)
    return m
  }

  it('unsafe paths throw KmpParseError(BAD_ZIP)', async () => {
    const badPaths = [
      '../escape.mtl',
      '..\\escape.mtl',
      '/abs.mtl',
      'C:/drive.mtl',
      '\uff0fescape.mtl',
      '\u2215escape.mtl',
      '\u29f8escape.mtl',
      '%2e%2e/escape.mtl',
      // `sub/../escape.mtl` normalises to `escape.mtl` (in-root) and is
      // correctly NOT rejected — see pathEscapesRoot() walk in
      // src/binary-tools/decompression-tools.js:123-138. Only depth-escaping
      // traversals (net-negative walks) are unsafe.
      'sub/../../escape.mtl',
    ]
    for (const path of badPaths) {
      const zip = zipSync({ [path]: validMtl() })
      let thrown
      try { await kmpProcess(zip) } catch (e) { thrown = e }
      if (!(thrown instanceof KmpParseError)) {
        throw new Error(
          `fuzz anchor panic: path ${JSON.stringify(path)} did not throw KmpParseError\n` +
          `  threw=${thrown?.constructor?.name}: ${thrown?.message}`,
        )
      }
      expect(thrown.code).toBe('BAD_ZIP')
    }
  })

  it('archive with no .mtl throws KmpParseError(NO_MTL)', async () => {
    const zip = zipSync({ 'config.xml': new TextEncoder().encode('<cfg />') })
    let thrown
    try { await kmpProcess(zip) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(KmpParseError)
    expect(thrown.code).toBe('NO_MTL')
  })

  it('non-zip garbage throws KmpParseError(BAD_ZIP) without panicking', async () => {
    const junks = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array(64),
      new TextEncoder().encode('this is definitely not a zip archive, not even close'),
      (() => { const b = new Uint8Array(256); for (let i = 0; i < b.length; i++) b[i] = i & 0xff; return b })(),
    ]
    for (const j of junks) {
      let thrown
      try { await kmpProcess(j) } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(KmpParseError)
      expect(thrown.code).toBe('BAD_ZIP')
    }
  })

  it('oversized archive entry is rejected before decompression', async () => {
    const payload = new Uint8Array(8 * 1024 * 1024)
    const zip = zipSync({ 'huge.mtl': payload })
    let thrown
    try { await kmpProcess(zip, { maxArchiveSize: 64 * 1024 }) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(KmpParseError)
    expect(thrown.code).toBe('BAD_ZIP')
  })
})
