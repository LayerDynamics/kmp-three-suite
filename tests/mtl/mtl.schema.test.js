import { describe, it, expect } from 'vitest'
import {
  TYPE_FLOAT, TYPE_COLOR, TYPE_INT, TYPE_BOOL, TYPE_TEXSLOT, TYPE_SUBSHADER_REF,
  VALUE_SIZES, PNG_MAGIC, PNG_IEND, FOOTER_NAME_PREFIX, MATMETA_MARKER,
  SHADER_MARKER_BYTES, SHADER_VERSION_LINE, MAT_VERSION_LINE,
} from '../../src/mtl/mtl.schema.js'

describe('mtl.schema', () => {
  it('has correct TLV type byte constants', () => {
    expect(TYPE_FLOAT).toBe(0x17)
    expect(TYPE_COLOR).toBe(0x27)
    expect(TYPE_INT).toBe(0x1d)
    expect(TYPE_BOOL).toBe(0x25)
    expect(TYPE_TEXSLOT).toBe(0x9b)
    expect(TYPE_SUBSHADER_REF).toBe(0xa1)
  })
  it('has value sizes by type name', () => {
    expect(VALUE_SIZES).toEqual({ float: 5, color: 13, int: 5, bool: 5, texslot: 5 })
  })
  it('has PNG magic bytes', () => {
    expect(PNG_MAGIC).toBeInstanceOf(Uint8Array)
    expect(Array.from(PNG_MAGIC)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })
  it('has PNG IEND marker', () => {
    expect(Array.from(PNG_IEND)).toEqual([0x49, 0x45, 0x4e, 0x44])
  })
  it('has footer name-prefix bytes 09 00 0b', () => {
    expect(Array.from(FOOTER_NAME_PREFIX)).toEqual([0x09, 0x00, 0x0b])
  })
  it('has MATMETA marker as UTF-8 encoded --MATMETA--', () => {
    expect(new TextDecoder().decode(MATMETA_MARKER)).toBe('--MATMETA--')
  })
  it('has shader section marker bytes 0x89 and 0x09', () => {
    expect(Array.from(SHADER_MARKER_BYTES)).toEqual([0x89, 0x09])
  })
  it('has shader/mat version line prefixes', () => {
    expect(new TextDecoder().decode(SHADER_VERSION_LINE)).toBe('//--lux:shader:')
    expect(new TextDecoder().decode(MAT_VERSION_LINE)).toBe('//--lux:mat:')
  })
})
