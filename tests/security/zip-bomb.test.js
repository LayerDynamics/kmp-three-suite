import { describe, it, expect } from 'vitest'
import { zipSync } from 'fflate'
import { safeExtract, unzipArchive } from '../../src/binary-tools/binary-tools.js'
import { KmpParseError } from '../../src/errors.js'

describe('zip-bomb protection (safeExtract — post-inflation tripwire)', () => {
  it('trips the 256 MB default cap when cumulative size exceeds it', () => {
    const m = new Map()
    m.set('a.mtl', new Uint8Array(200 * 1024 * 1024))
    m.set('b.mtl', new Uint8Array(200 * 1024 * 1024))
    expect(() => safeExtract(m)).toThrow(KmpParseError)
  })
  it('accepts archives under a configured maxSize', () => {
    const m = new Map()
    m.set('small.mtl', new Uint8Array(1024))
    expect(safeExtract(m, { maxSize: 4096 }).get('small.mtl').byteLength).toBe(1024)
  })
  it('rejects when single entry alone exceeds the cap', () => {
    const m = new Map()
    m.set('big.mtl', new Uint8Array(8192))
    expect(() => safeExtract(m, { maxSize: 4096 })).toThrow(KmpParseError)
  })
})

describe('zip-bomb protection (unzipArchive — central-directory pre-gate)', () => {
  it('rejects a single declared-huge entry before allocating its buffer', () => {
    // 5 MB of zeros compresses to a few hundred bytes; the attack vector is
    // fflate allocating `new u8(originalSize)` = 5 MB before any cap check.
    const payload = new Uint8Array(5 * 1024 * 1024)
    const zip = zipSync({ 'huge.bin': payload })
    expect(zip.byteLength).toBeLessThan(100 * 1024)
    const start = process.hrtime.bigint()
    expect(() => unzipArchive(zip, { maxSize: 256 * 1024 })).toThrow(KmpParseError)
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    // Pre-gate must abort before inflation would run. A 5 MB inflation takes
    // tens of ms on typical hardware; the gate path is microseconds.
    expect(elapsedMs).toBeLessThan(50)
  })

  it('rejects cumulative declared sizes that exceed the cap', () => {
    const entry = new Uint8Array(2048)
    const zip = zipSync({ 'a.bin': entry, 'b.bin': entry, 'c.bin': entry })
    // 3 x 2048 = 6144 bytes declared, cap 4096.
    expect(() => unzipArchive(zip, { maxSize: 4096 })).toThrow(KmpParseError)
  })

  it('accepts an archive whose declared total is under the cap', () => {
    const zip = zipSync({ 'small.mtl': new Uint8Array(100) })
    const map = unzipArchive(zip, { maxSize: 4096 })
    expect(map.get('small.mtl').byteLength).toBe(100)
  })

  it('uses a 256 MB default cap when maxSize is not provided', () => {
    // A normal tiny archive should still decode with default options.
    const zip = zipSync({ 'ok.mtl': new Uint8Array(16) })
    expect(unzipArchive(zip).get('ok.mtl').byteLength).toBe(16)
  })

  it('reports the offending entry name in the thrown error', () => {
    const payload = new Uint8Array(8192)
    const zip = zipSync({ 'fine.bin': new Uint8Array(64), 'bomb.bin': payload })
    try {
      unzipArchive(zip, { maxSize: 4096 })
      throw new Error('expected KmpParseError')
    } catch (e) {
      expect(e).toBeInstanceOf(KmpParseError)
      expect(e.code).toBe('BAD_ZIP')
      expect(e.message).toContain('bomb.bin')
    }
  })

  it('rejects before fflate allocates for any entry following the offender', () => {
    // Two declared-large entries; cap trips on first. Second must never be
    // touched (fflate receives filter=false and skips allocation).
    const big = new Uint8Array(5 * 1024 * 1024)
    const zip = zipSync({ 'first.bin': big, 'second.bin': big })
    const start = process.hrtime.bigint()
    expect(() => unzipArchive(zip, { maxSize: 256 * 1024 })).toThrow(KmpParseError)
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    expect(elapsedMs).toBeLessThan(50)
  })
})
