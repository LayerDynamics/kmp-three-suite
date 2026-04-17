import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { extractMtl } from '../../src/mtl/mtl-extraction.js'
import { isPrintable, readAscii } from '../../src/binary-tools/binary-tools.js'
import { computeCoverage } from '../../src/pipeline/process.js'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

function loadMtl(p) {
  const entries = unzipSync(new Uint8Array(readFileSync(p)))
  const name = Object.keys(entries).find(n => n.endsWith('.mtl'))
  return entries[name]
}

// Reference implementation — the pre-fix Set<number> version. Used to verify
// that the bitmap rewrite produces identical outputs on well-formed inputs.
function coverageReference(buf, paramStart, paramEnd, params) {
  const claimed = new Set()
  for (const p of params) {
    let valueLen
    if (p.type === 'color') valueLen = 14
    else if (p.type === 'bool_inferred') valueLen = p.rawLength || 0
    else valueLen = 6
    const nameLen = (p.name || '').length
    for (let b = p.offset - nameLen; b < p.offset + valueLen; b++) {
      if (b >= paramStart && b < paramEnd) claimed.add(b)
    }
  }
  const unclaimedBytes = []
  let runStart = -1
  for (let i = paramStart; i < paramEnd; i++) {
    if (!claimed.has(i) && isPrintable(buf[i])) {
      if (runStart === -1) runStart = i
    } else if (runStart !== -1) {
      if (i - runStart >= 3) {
        unclaimedBytes.push({ offset: '0x' + runStart.toString(16), text: readAscii(buf, runStart, i) })
      }
      runStart = -1
    }
  }
  if (runStart !== -1 && paramEnd - runStart >= 3) {
    unclaimedBytes.push({ offset: '0x' + runStart.toString(16), text: readAscii(buf, runStart, paramEnd) })
  }
  return { claimedBytes: claimed.size, totalBytes: paramEnd - paramStart, unclaimedBytes }
}

describe('computeCoverage — parity with Set<number> reference on real fixtures', () => {
  it.each([
    ['paint-metallic-sienna-gold.kmp'],
    ['toon-fill-black-bright.kmp'],
    ['translucent-candle-wax.kmp'],
  ])('matches reference output for %s', (fixture) => {
    const buf = loadMtl(join(KMP_DIR, fixture))
    const res = extractMtl(buf)
    const actual = computeCoverage(buf, res.paramSection.start, res.paramSection.end, res.rawParameters)
    const expected = coverageReference(buf, res.paramSection.start, res.paramSection.end, res.rawParameters)
    expect(actual.claimedBytes).toBe(expected.claimedBytes)
    expect(actual.totalBytes).toBe(expected.totalBytes)
    expect(actual.unclaimedBytes).toEqual(expected.unclaimedBytes)
  })
})

describe('computeCoverage — DoS resistance (CVE regression, Review.md §53)', () => {
  // The pre-fix Set<number> implementation allocated ~40 B per claimed byte
  // offset → 256 MB paramSection = ~10 GB heap. The bitmap rewrite caps the
  // structure at ceil(sectionLen/8) bytes. These tests lock in that bound.

  it('runs in bounded memory and time on a 64 MB synthetic paramSection', () => {
    const SECTION_MB = 64
    const sectionLen = SECTION_MB * 1024 * 1024
    const buf = new Uint8Array(sectionLen)
    // Fill with non-printable noise so unclaimed runs don't explode the output.
    for (let i = 0; i < sectionLen; i++) buf[i] = 0x00
    // A handful of params scattered across the section.
    const params = [
      { name: 'alpha', type: 'scalar', offset: 1024 },
      { name: 'beta', type: 'color', offset: 2048 },
      { name: 'gamma', type: 'bool_inferred', offset: 3072, rawLength: 4 },
      { name: 'delta', type: 'scalar', offset: sectionLen - 1024 },
    ]

    const heapBefore = process.memoryUsage().heapUsed
    const t0 = performance.now()
    const result = computeCoverage(buf, 0, sectionLen, params)
    const elapsedMs = performance.now() - t0
    const heapAfter = process.memoryUsage().heapUsed
    const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024)

    expect(result.totalBytes).toBe(sectionLen)
    expect(result.claimedBytes).toBeGreaterThan(0)
    expect(result.claimedBytes).toBeLessThanOrEqual(sectionLen)
    expect(result.unclaimedBytes).toEqual([])
    // Primary invariant: memory bound. Bitmap for a 64 MB section is 8 MB.
    // A regression to Set<number> on a fully-claimed 64 MB section would
    // push heap delta past 2 GB; even partially-claimed pathological inputs
    // would easily exceed 100 MB.
    expect(heapDeltaMb).toBeLessThan(100)
    // Secondary time bound — the 64 MB unclaimedBytes scan is inherently
    // O(sectionLen) in JS and runs ~2.5s on modern hardware. A Set-based
    // regression on a densely-claimed section would compound that with
    // per-byte hash allocation, blowing past this threshold.
    expect(elapsedMs).toBeLessThan(10000)
  })

  it('handles a densely-claimed paramSection without per-byte Set overhead', () => {
    // Craft a section where nearly every byte is claimed. This is the
    // worst case for the old Set<number> implementation (one Set entry
    // per byte). 8 MB section with one big "bool_inferred" spanning it.
    const sectionLen = 8 * 1024 * 1024
    const buf = new Uint8Array(sectionLen)
    const params = [
      { name: 'a', type: 'bool_inferred', offset: 1, rawLength: sectionLen - 1 },
    ]

    const t0 = performance.now()
    const result = computeCoverage(buf, 0, sectionLen, params)
    const elapsedMs = performance.now() - t0

    expect(result.totalBytes).toBe(sectionLen)
    // Every byte from offset 0 (name 'a' is 1 char, so name-start = 0)
    // through offset + rawLength = sectionLen is claimed.
    expect(result.claimedBytes).toBe(sectionLen)
    expect(result.unclaimedBytes).toEqual([])
    // On the old Set code, 8M add() calls + Set.has() lookups take seconds
    // and allocate hundreds of MB. The bitmap path is O(sectionLen) byte ops.
    expect(elapsedMs).toBeLessThan(1500)
  })

  it('clips name prefix that would extend before paramStart', () => {
    // Param name would nominally extend before paramStart=10; implementation
    // must not index out-of-bounds or miscount claimed bytes.
    const buf = new Uint8Array(32)
    const params = [
      { name: 'longname', type: 'scalar', offset: 12 }, // name would start at 4, before paramStart=10
    ]
    const result = computeCoverage(buf, 10, 32, params)
    expect(result.totalBytes).toBe(22)
    // Only bytes [10, 12+6) = [10, 18) are in-section → 8 claimed.
    expect(result.claimedBytes).toBe(8)
  })

  it('clips value suffix that would extend past paramEnd', () => {
    const buf = new Uint8Array(32)
    const params = [
      { name: 'x', type: 'color', offset: 28 }, // value would extend to 28+14=42, past paramEnd=32
    ]
    const result = computeCoverage(buf, 0, 32, params)
    // In-section claim: [28-1, 32) = [27, 32) → 5 bytes.
    expect(result.claimedBytes).toBe(5)
    expect(result.totalBytes).toBe(32)
  })

  it('returns zero-claim coverage when params list is empty', () => {
    const buf = new Uint8Array(100)
    const result = computeCoverage(buf, 0, 100, [])
    expect(result.claimedBytes).toBe(0)
    expect(result.totalBytes).toBe(100)
    expect(result.unclaimedBytes).toEqual([])
  })
})
