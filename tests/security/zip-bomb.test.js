import { describe, it, expect } from 'vitest'
import { safeExtract } from '../../src/binary-tools/binary-tools.js'
import { KmpParseError } from '../../src/pipeline/errors.js'

describe('zip-bomb protection', () => {
  it('trips the 256 MB default cap when cumulative size exceeds it', () => {
    const m = new Map()
    // Two 200 MB entries → 400 MB decompressed → over 256 MB default.
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
