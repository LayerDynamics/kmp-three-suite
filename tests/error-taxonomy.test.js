import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { process, KmpParseError } from '../src/index.js'

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
    const e = new KmpParseError('BAD_TLV', 'bad', 0x1234)
    expect(e.name).toBe('KmpParseError')
    expect(e.code).toBe('BAD_TLV')
    expect(e.offset).toBe(0x1234)
    expect(e).toBeInstanceOf(Error)
  })
})
