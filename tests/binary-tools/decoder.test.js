import { describe, it, expect } from 'vitest'
import { readF32LE, readU32LE, readI32LE, readU16LE, readU8, readAscii, readAsciiPrintable } from '../../src/binary-tools/decoder.js'

describe('decoder', () => {
  it('reads little-endian float32', () => {
    const buf = new Uint8Array([0x00, 0x00, 0x80, 0x3f])
    const view = new DataView(buf.buffer)
    expect(readF32LE(view, 0)).toBe(1.0)
  })
  it('reads little-endian uint32', () => {
    const buf = new Uint8Array([0x04, 0x03, 0x02, 0x01])
    const view = new DataView(buf.buffer)
    expect(readU32LE(view, 0)).toBe(0x01020304)
  })
  it('reads little-endian int32 (negative)', () => {
    const buf = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const view = new DataView(buf.buffer)
    expect(readI32LE(view, 0)).toBe(-1)
  })
  it('reads little-endian uint16', () => {
    const buf = new Uint8Array([0x34, 0x12])
    const view = new DataView(buf.buffer)
    expect(readU16LE(view, 0)).toBe(0x1234)
  })
  it('reads single byte', () => {
    const buf = new Uint8Array([0x2a])
    expect(readU8(buf, 0)).toBe(0x2a)
  })
  it('reads ASCII (includes non-printables)', () => {
    const buf = new Uint8Array([0x48, 0x69, 0x00, 0x21])
    expect(readAscii(buf, 0, 4)).toBe('Hi\x00!')
  })
  it('reads ASCII printable-only (filters non-printable)', () => {
    const buf = new Uint8Array([0x48, 0x69, 0x00, 0x21])
    expect(readAsciiPrintable(buf, 0, 4)).toBe('Hi!')
  })
})
