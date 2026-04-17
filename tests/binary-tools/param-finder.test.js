import { describe, it, expect } from 'vitest'
import { findSequence, findPngBounds, findParamSection, findFooter, findSubShaderRegion, findSubShaderRefs } from '../../src/binary-tools/param-finder.js'
import { PNG_MAGIC, PNG_IEND, MATMETA_MARKER, FOOTER_NAME_PREFIX, TYPE_SUBSHADER_REF } from '../../src/mtl/mtl.schema.js'

describe('findSequence', () => {
  it('returns -1 when not found', () => {
    const buf = new Uint8Array([1, 2, 3])
    expect(findSequence(buf, new Uint8Array([4, 5]))).toBe(-1)
  })
  it('returns first match offset', () => {
    const buf = new Uint8Array([1, 2, 3, 2, 3, 4])
    expect(findSequence(buf, new Uint8Array([2, 3]))).toBe(1)
  })
  it('honours startOffset', () => {
    const buf = new Uint8Array([1, 2, 3, 2, 3, 4])
    expect(findSequence(buf, new Uint8Array([2, 3]), 2)).toBe(3)
  })
})

function buildPngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type)
  const length = data.length
  const chunk = new Uint8Array(12 + length)
  chunk[0] = (length >>> 24) & 0xff
  chunk[1] = (length >>> 16) & 0xff
  chunk[2] = (length >>> 8) & 0xff
  chunk[3] = length & 0xff
  chunk.set(typeBytes, 4)
  chunk.set(data, 8)
  chunk[8 + length] = 0xde
  chunk[8 + length + 1] = 0xad
  chunk[8 + length + 2] = 0xbe
  chunk[8 + length + 3] = 0xef
  return chunk
}

function buildPng(...chunks) {
  const total = PNG_MAGIC.length + chunks.reduce((n, c) => n + c.length, 0)
  const buf = new Uint8Array(total)
  buf.set(PNG_MAGIC, 0)
  let off = PNG_MAGIC.length
  for (const c of chunks) {
    buf.set(c, off)
    off += c.length
  }
  return buf
}

describe('findPngBounds', () => {
  it('returns null when no PNG', () => {
    expect(findPngBounds(new Uint8Array(64))).toBeNull()
  })
  it('walks chunks and returns bounds covering the full PNG including the trailing CRC', () => {
    const png = buildPng(
      buildPngChunk('IHDR', new Uint8Array(13)),
      buildPngChunk('IEND', new Uint8Array(0)),
    )
    const buf = new Uint8Array(128)
    buf.set(png, 10)
    const bounds = findPngBounds(buf)
    expect(bounds.start).toBe(10)
    expect(bounds.end).toBe(10 + png.length)
    expect(bounds.size).toBe(png.length)
    const slice = buf.subarray(bounds.start, bounds.end)
    expect(slice[slice.length - 1]).toBe(0xef)
    expect(slice[slice.length - 2]).toBe(0xbe)
    expect(slice[slice.length - 3]).toBe(0xad)
    expect(slice[slice.length - 4]).toBe(0xde)
  })
  it('does not false-match "IEND" appearing inside a tEXt chunk payload', () => {
    const tEXtPayload = new TextEncoder().encode('IEND\0embedded-value')
    const png = buildPng(
      buildPngChunk('IHDR', new Uint8Array(13)),
      buildPngChunk('tEXt', tEXtPayload),
      buildPngChunk('IEND', new Uint8Array(0)),
    )
    const bounds = findPngBounds(png)
    expect(bounds).not.toBeNull()
    expect(bounds.end).toBe(png.length)
    const iendChunkStart = png.length - 12
    const tEXtRawStart = PNG_MAGIC.length + (12 + 13) + 8
    expect(bounds.end).toBeGreaterThan(tEXtRawStart + 4)
    expect(bounds.end).toBe(iendChunkStart + 12)
  })
  it('does not false-match "IEND" bytes appearing inside an IDAT payload', () => {
    const idatPayload = new Uint8Array([0x78, 0x9c, 0x49, 0x45, 0x4e, 0x44, 0x00, 0x01])
    const png = buildPng(
      buildPngChunk('IHDR', new Uint8Array(13)),
      buildPngChunk('IDAT', idatPayload),
      buildPngChunk('IEND', new Uint8Array(0)),
    )
    const bounds = findPngBounds(png)
    expect(bounds).not.toBeNull()
    expect(bounds.end).toBe(png.length)
  })
  it('ignores garbage before and after the PNG', () => {
    const png = buildPng(
      buildPngChunk('IHDR', new Uint8Array(13)),
      buildPngChunk('IEND', new Uint8Array(0)),
    )
    const buf = new Uint8Array(256)
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) & 0xff
    buf.set(png, 64)
    const bounds = findPngBounds(buf)
    expect(bounds.start).toBe(64)
    expect(bounds.end).toBe(64 + png.length)
    expect(bounds.size).toBe(png.length)
  })
  it('returns null when the PNG is truncated before IEND', () => {
    const png = buildPng(
      buildPngChunk('IHDR', new Uint8Array(13)),
      buildPngChunk('IDAT', new Uint8Array(32)),
    )
    expect(findPngBounds(png)).toBeNull()
  })
  it('returns null when a chunk length overruns the buffer', () => {
    const png = buildPng(buildPngChunk('IHDR', new Uint8Array(13)))
    const buf = new Uint8Array(png.length + 12)
    buf.set(png, 0)
    buf[png.length] = 0xff
    buf[png.length + 1] = 0xff
    buf[png.length + 2] = 0xff
    buf[png.length + 3] = 0xff
    buf[png.length + 4] = PNG_IEND[0]
    buf[png.length + 5] = PNG_IEND[1]
    buf[png.length + 6] = PNG_IEND[2]
    buf[png.length + 7] = PNG_IEND[3]
    expect(findPngBounds(buf)).toBeNull()
  })
  it('returns null when the first IEND-like byte sequence sits inside an unrelated chunk header but no real IEND follows', () => {
    const png = buildPng(
      buildPngChunk('IHDR', new Uint8Array(13)),
      buildPngChunk('tEXt', new TextEncoder().encode('IEND\0payload')),
    )
    expect(findPngBounds(png)).toBeNull()
  })
})

describe('findParamSection', () => {
  it('uses pngEnd when positive', () => {
    const buf = new Uint8Array(100)
    buf.set(MATMETA_MARKER, 80)
    const section = findParamSection(buf, 40, -1)
    expect(section.start).toBe(40)
    expect(section.end).toBe(80)
  })
  it('ends at MATMETA when present', () => {
    const buf = new Uint8Array(200)
    buf.set(MATMETA_MARKER, 100)
    const section = findParamSection(buf, 10, -1)
    expect(section.end).toBe(100)
  })
  it('falls back to shader-version-line newline', () => {
    const line = '//--lux:shader:3.0\n'
    const head = new TextEncoder().encode(line)
    const buf = new Uint8Array(head.length + 64)
    buf.set(head, 0)
    buf.set(MATMETA_MARKER, head.length + 16)
    const section = findParamSection(buf, -1, -1)
    expect(section.start).toBe(head.length)
    expect(section.end).toBe(head.length + 16)
  })
})

describe('findFooter', () => {
  it('identifies MATMETA', () => {
    const buf = new Uint8Array(128)
    buf.set(MATMETA_MARKER, 32)
    expect(findFooter(buf, 10)).toEqual({ type: 'matmeta', offset: 32 })
  })
  it('falls back to 09 00 0b name footer', () => {
    const buf = new Uint8Array(128)
    buf.set(FOOTER_NAME_PREFIX, 50)
    expect(findFooter(buf, 10)).toEqual({ type: 'name_footer', offset: 50 })
  })
  it('returns eof when nothing found', () => {
    expect(findFooter(new Uint8Array(20), 0)).toEqual({ type: 'eof', offset: 20 })
  })
})

describe('findSubShaderRegion', () => {
  it('returns null when main shader is at start', () => {
    const buf = new Uint8Array(new TextEncoder().encode('lux_toon padding'))
    const region = findSubShaderRegion(buf, 0, 16, ['lux_toon'])
    expect(region).toBeNull()
  })
  it('detects sub-shader region when a header byte precedes the main shader name', () => {
    const pre = new Uint8Array(20)
    pre[0] = 0x89
    const name = new TextEncoder().encode('lux_translucent')
    const buf = new Uint8Array(pre.length + name.length + 8)
    buf.set(pre, 0)
    buf.set(name, pre.length)
    const region = findSubShaderRegion(buf, 0, buf.length, ['lux_translucent'])
    expect(region).not.toBeNull()
    expect(region.mainShaderStart).toBeGreaterThanOrEqual(0)
  })
  it('returns null only after exhausting every candidate (all matches fail the heuristic)', () => {
    // Guards against an early-return regression: when multiple shader-type
    // candidates match inside the param section but EVERY match's back-scan
    // resolves to a headerStart <= paramStart + 4, the function must iterate
    // the whole knownShaderTypes list before returning null. If it ever
    // short-circuits on the first heuristic failure, this expects-null test
    // will instead receive a region object (the complement of the "continues
    // to next candidate" test above).
    //
    // Layout: marker byte 0x09 at paramStart, then two adjacent shader-type
    // names packed close enough that both back-scans collapse headerStart to
    // position 0. With paramStart = 0, the threshold is paramStart + 4 = 4,
    // and headerStart = 0 fails both.
    //   buf[0]      = 0x09                   ← SHADER_MARKER_BYTES[1]
    //   buf[1..8]   = 'lux_toon'             ← first candidate, absPos=1
    //   buf[9..22]  = 'metallic_paint'       ← second candidate, absPos=9
    // Back-scan for each candidate reaches buf[0]=0x09 within its 16-byte
    // window, sets headerStart=0, and fails the 0 > 4 check.
    const first = new TextEncoder().encode('lux_toon')
    const second = new TextEncoder().encode('metallic_paint')
    const buf = new Uint8Array(80)
    buf[0] = 0x09
    buf.set(first, 1)
    buf.set(second, 1 + first.length)
    const region = findSubShaderRegion(buf, 0, buf.length, ['lux_toon', 'metallic_paint'])
    expect(region).toBeNull()
  })
  it('continues to next shader-type candidate when the first fails the header-distance heuristic', () => {
    // First candidate 'lux_toon' appears immediately at paramStart (fails headerStart > paramStart + 4
    // since no back-scan can yield a headerStart greater than absPos=0). Second candidate
    // 'metallic_paint' sits deeper in the buffer at absPos=40, with no leading marker byte in the
    // 16-byte back-scan window — so headerStart stays at 40, which clears paramStart + 4 = 4.
    // Before the fix, the function returned null on the first candidate's failure and never tried
    // the second. After the fix, it must return a region anchored on 'metallic_paint'.
    const first = new TextEncoder().encode('lux_toon')
    const second = new TextEncoder().encode('metallic_paint')
    const buf = new Uint8Array(80)
    buf.set(first, 0)
    buf.set(second, 40)
    const region = findSubShaderRegion(buf, 0, buf.length, ['lux_toon', 'metallic_paint'])
    expect(region).not.toBeNull()
    expect(region.mainShaderStart).toBe(40)
    expect(region.start).toBe(0)
    expect(region.end).toBe(40)
  })
})

describe('findSubShaderRefs', () => {
  it('returns empty array when no refs are present', () => {
    const buf = new Uint8Array([0x11, 0x22, 0x33, 0x44])
    expect(findSubShaderRefs(buf, 0, buf.length)).toEqual([])
  })
  it('matches the TYPE_SUBSHADER_REF 0x09 <slot> pattern at every occurrence', () => {
    // Two valid refs separated by unrelated noise. The trailing bytes past the
    // last ref are outside the 3-byte window so they must never be reported.
    const buf = new Uint8Array([
      0x00, 0x00,                          // padding
      TYPE_SUBSHADER_REF, 0x09, 0x02,      // ref slot=2 at offset 2
      0x11, 0x22, 0x33, 0x44,              // noise
      TYPE_SUBSHADER_REF, 0x09, 0x07,      // ref slot=7 at offset 9
      0x55, 0x66,                          // noise (no trailing ref)
    ])
    const refs = findSubShaderRefs(buf, 0, buf.length)
    expect(refs).toEqual([
      { offset: 2, slot: 2 },
      { offset: 9, slot: 7 },
    ])
  })
  it('ignores TYPE_SUBSHADER_REF bytes not followed by the 0x09 discriminator', () => {
    // Only the second occurrence matches — the first has 0x08 after it, the
    // third is the literal TYPE_SUBSHADER_REF value appearing as a slot byte
    // (i.e. data, not a marker) and must NOT be re-matched.
    const buf = new Uint8Array([
      TYPE_SUBSHADER_REF, 0x08, 0x05,          // not a ref (wrong discriminator)
      TYPE_SUBSHADER_REF, 0x09, TYPE_SUBSHADER_REF, // ref slot=0xa1 at offset 3
    ])
    const refs = findSubShaderRefs(buf, 0, buf.length)
    expect(refs).toEqual([{ offset: 3, slot: TYPE_SUBSHADER_REF }])
  })
  it('respects paramStart / paramEnd bounds', () => {
    const buf = new Uint8Array([
      TYPE_SUBSHADER_REF, 0x09, 0x01, // ref at offset 0 — outside start window
      0x00, 0x00,
      TYPE_SUBSHADER_REF, 0x09, 0x02, // ref at offset 5 — inside window
      0x00, 0x00,
      TYPE_SUBSHADER_REF, 0x09, 0x03, // ref at offset 10 — outside end window
    ])
    const refs = findSubShaderRefs(buf, 3, 8)
    expect(refs).toEqual([{ offset: 5, slot: 2 }])
  })
  it('never reads past the buffer end (partial trailing marker is skipped)', () => {
    // Last two bytes form a partial ref — must not crash or emit a ref with
    // an undefined slot.
    const buf = new Uint8Array([TYPE_SUBSHADER_REF, 0x09])
    expect(findSubShaderRefs(buf, 0, buf.length)).toEqual([])
  })
})
