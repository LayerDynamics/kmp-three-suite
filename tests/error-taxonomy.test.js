import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { process, KmpParseError } from '../src/index.js'
import { sanitizeForLog } from '../src/errors.js'

describe('KmpParseError taxonomy', () => {
  it('BAD_ZIP on garbage input', async () => {
    await expect(process(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).rejects.toMatchObject({
      name: 'KmpParseError', code: 'BAD_ZIP',
    })
  })
  it('NO_MTL when archive has no .mtl file', async () => {
    const bogus = zipSync({ 'notes.txt': strToU8('hi') })
    await expect(process(bogus)).rejects.toMatchObject({
      name: 'KmpParseError', code: 'NO_MTL',
    })
  })
  it('BAD_ZIP for unsupported input types', async () => {
    await expect(process(42)).rejects.toMatchObject({ code: 'BAD_ZIP' })
    await expect(process({})).rejects.toMatchObject({ code: 'BAD_ZIP' })
  })
  it('KmpParseError instances include name and code', () => {
    const e = new KmpParseError('BAD_PNG', 'bad png at offset', 0x1234)
    expect(e.name).toBe('KmpParseError')
    expect(e.code).toBe('BAD_PNG')
    expect(e.offset).toBe(0x1234)
    expect(e).toBeInstanceOf(Error)
  })

  // Regression for Review.md finding: `no assertion that new KmpParseError('NO_MTL','x').offset
  // === undefined vs 'offset' in ... semantics`. errors.js:28 uses the guard
  // `if (offset !== undefined) this.offset = offset`, so when a caller omits
  // offset the instance must have NO own-property at all — not an undefined
  // sentinel. Consumers that probe with `in` rely on this.
  it('omitted offset leaves no own-property, only undefined on access', () => {
    const e = new KmpParseError('NO_MTL', 'archive contained no .mtl entry')
    expect(e.offset).toBeUndefined()
    expect('offset' in e).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(e, 'offset')).toBe(false)
  })
  it('explicit offset=0 is retained as an own-property (falsy but meaningful)', () => {
    // Byte offset 0 is a legal failure location — the constructor must not
    // drop it as if it were "missing". Guards against a careless `if (offset)`
    // check replacing the current `!== undefined` guard.
    const e = new KmpParseError('BAD_PNG', 'bad png at buffer start', 0)
    expect(e.offset).toBe(0)
    expect('offset' in e).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(e, 'offset')).toBe(true)
  })

  // Regression for Review.md finding: `KmpParseError never propagates cause`.
  // The constructor previously accepted only (code, message, offset) and
  // silently dropped any underlying error, so callers could not reach the
  // original stack (e.g. the fflate inflate crash). Ensures `options.cause`
  // is forwarded to Error's standard `cause` property.
  it('forwards options.cause to the native Error cause slot', () => {
    const inner = new Error('inflate blew up')
    const wrapper = new KmpParseError('BAD_ZIP', 'decode failed', undefined, { cause: inner })
    expect(wrapper.cause).toBe(inner)
  })

  // Regression for Review.md finding: `ZIP decode failed` threw a KmpParseError
  // that string-interpolated `e.message` but discarded the underlying error,
  // losing the fflate stack entirely. Verifies the wrapper surfaces the
  // underlying decoder error to consumers.
  it('propagates the underlying fflate error as cause on BAD_ZIP decode failures', async () => {
    // Minimally plausible ZIP signature with corrupt central directory so
    // fflate enters the decode path and throws mid-parse.
    const corrupt = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, // local file header signature
      0xff, 0xff, 0xff, 0xff, // junk version/flags
      0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff,
    ])
    let thrown
    try {
      await process(corrupt)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(KmpParseError)
    expect(thrown.code).toBe('BAD_ZIP')
    expect(thrown.cause).toBeDefined()
    expect(thrown.cause).not.toBe(thrown)
  })

  // Regression for Review.md finding: error messages echoed attacker-controlled
  // paths/sizes into logs. An archive entry name containing a CR/LF or ANSI
  // escape could inject a fake log line once the caught error flowed into a
  // consumer log pipeline. `sanitizeForLog` runs on every name/path
  // interpolation in decompression-tools.js.
  describe('sanitizeForLog', () => {
    it('escapes newline and carriage-return injection', () => {
      const out = sanitizeForLog('evil\r\nINJECTED fake log entry')
      expect(out).not.toContain('\n')
      expect(out).not.toContain('\r')
      expect(out).toContain('\\x0d')
      expect(out).toContain('\\x0a')
    })
    it('escapes ANSI CSI / ESC sequences', () => {
      const out = sanitizeForLog('\u001b[31mred\u001b[0m')
      expect(out).not.toContain('\u001b')
      expect(out).toContain('\\x1b')
    })
    it('escapes NUL bytes', () => {
      expect(sanitizeForLog('a\u0000b')).toBe('a\\x00b')
    })
    it('escapes Unicode bidi overrides and line/paragraph separators', () => {
      const input = '\u202Erecoded\u202C \u2028 \u2029'
      const out = sanitizeForLog(input)
      expect(out).not.toContain('\u202E')
      expect(out).not.toContain('\u202C')
      expect(out).not.toContain('\u2028')
      expect(out).not.toContain('\u2029')
      expect(out).toContain('\\u202e')
    })
    it('doubles backslashes so the escape output is unambiguous', () => {
      expect(sanitizeForLog('a\\b')).toBe('a\\\\b')
    })
    it('truncates pathologically long strings', () => {
      const long = 'a'.repeat(5000)
      const out = sanitizeForLog(long)
      expect(out.length).toBeLessThanOrEqual(201) // 200 chars + ellipsis
      expect(out.endsWith('…')).toBe(true)
    })
    it('stringifies non-string inputs', () => {
      expect(sanitizeForLog(42)).toBe('42')
      expect(sanitizeForLog(undefined)).toBe('undefined')
      expect(sanitizeForLog(null)).toBe('null')
    })
  })

  // Regression: verify the sanitizer actually reaches the thrown error
  // message on the oversized-archive path. Attack payload is a ZIP entry
  // whose name contains a CR/LF pair; the BAD_ZIP error message must not
  // carry those raw bytes.
  it('archive errors do not leak raw control bytes from entry names', async () => {
    // Declared-size gate trips before decompression, so any entry name with
    // declared size > cap produces a BAD_ZIP with the entry name echoed.
    const smallCap = 10
    const bigPayload = new Uint8Array(1024)
    const archive = zipSync({
      'evil\r\nINJECTED.bin': bigPayload,
    })
    let thrown
    try {
      await process(archive, { maxArchiveSize: smallCap })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(KmpParseError)
    expect(thrown.code).toBe('BAD_ZIP')
    expect(thrown.message).not.toMatch(/[\r\n]/)
    expect(thrown.message).toContain('\\x0d')
    expect(thrown.message).toContain('\\x0a')
  })
})
