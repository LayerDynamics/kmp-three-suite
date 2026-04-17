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
  it('rejects NUL-byte injection in entry names', async () => {
    // `evil\0safe.mtl` is a single benign-looking segment to the old split-
    // on-`/` check, but a C-string filesystem API truncates at NUL, writing
    // `evil` instead of `evil\0safe.mtl`. Reject NUL outright.
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('evil\u0000safe.mtl', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(/NUL byte/)
  })
  it('rejects fullwidth solidus (U+FF0F) look-alike', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('foo\uFF0F..\uFF0Fevil.mtl', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(KmpParseError)
  })
  it('rejects division slash (U+2215) look-alike', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('foo\u2215..\u2215evil.mtl', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(/unicode slash/)
  })
  it('rejects big solidus (U+29F8) look-alike', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('foo\u29F8..\u29F8evil.mtl', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(/unicode slash/)
  })
  it('rejects fullwidth reverse solidus (U+FF3C)', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('foo\uFF3C..\uFF3Cevil.mtl', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(KmpParseError)
  })
  it('rejects URL-encoded traversal (..%2f)', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('..%2fevil.mtl', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(/percent-encoded/)
  })
  it('rejects percent-encoded dot-dot (%2e%2e/)', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('%2e%2e/evil.mtl', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(/percent-encoded/)
  })
  it('rejects percent-encoded backslash (..%5c)', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('..%5cevil.mtl', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(/percent-encoded/)
  })
  it('rejects deep mid-path traversal that escapes root', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('a/b/../../../etc/passwd', new Uint8Array([1]))
    expect(() => safeExtract(m)).toThrow(/traversal/)
  })
  it('still accepts benign nested paths', async () => {
    const { safeExtract } = await import('../../src/binary-tools/binary-tools.js')
    const m = new Map()
    m.set('sub/dir/ok.mtl', new Uint8Array([1]))
    m.set('./also-ok.mtl', new Uint8Array([1]))
    m.set('a/b/../b/ok.mtl', new Uint8Array([1]))
    expect(safeExtract(m).size).toBe(3)
  })
})
