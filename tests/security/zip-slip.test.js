import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { process, KmpParseError } from '../../src/index.js'

describe('zip-slip protection', () => {
  it('rejects an archive with a ".." path entry', async () => {
    const bogus = zipSync({ '../evil.mtl': strToU8('x') })
    await expect(process(bogus)).rejects.toThrow(KmpParseError)
    try { await process(bogus) } catch (e) {
      expect(e.code).toBe('BAD_ZIP')
      expect(e.message).toMatch(/Unsafe/)
    }
  })
  it('rejects absolute paths', async () => {
    // fflate normalises some paths; craft the Map directly via decompression-tools
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('/etc/passwd', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(KmpParseError)
  })
  it('rejects Windows drive-letter paths', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('C:/Windows/System32/cmd.exe', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(KmpParseError)
  })
})
