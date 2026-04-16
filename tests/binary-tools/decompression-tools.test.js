import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { unzipArchive, enumerateEntries, safeExtract } from '../../src/binary-tools/decompression-tools.js'
import { KmpParseError } from '../../src/pipeline/process.js'

function makeZip(files) {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])))
}

describe('unzipArchive', () => {
  it('returns a Map<path, Uint8Array>', () => {
    const zip = makeZip({ 'a.txt': 'hi', 'b.mtl': 'mtlbytes' })
    const archive = unzipArchive(zip)
    expect(archive).toBeInstanceOf(Map)
    expect(archive.size).toBe(2)
    expect(new TextDecoder().decode(archive.get('a.txt'))).toBe('hi')
  })
  it('accepts ArrayBuffer', () => {
    const zip = makeZip({ 'x': 'y' })
    const ab = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)
    expect(unzipArchive(ab).get('x')).toBeInstanceOf(Uint8Array)
  })
  it('throws KmpParseError on malformed input', () => {
    expect(() => unzipArchive(new Uint8Array([0, 1, 2, 3]))).toThrow(KmpParseError)
  })
})

describe('enumerateEntries', () => {
  it('categorises by extension', () => {
    const zip = makeZip({
      'main.mtl': 'a', 'extra.mtl': 'b', 'Configuration.xml': '<x/>',
      'diffuse.png': 'p', 'normal.jpg': 'n', 'ignore.txt': 't',
    })
    const archive = unzipArchive(zip)
    const cat = enumerateEntries(archive)
    expect(cat.mtls.sort()).toEqual(['extra.mtl', 'main.mtl'])
    expect(cat.xml).toBe('Configuration.xml')
    expect(cat.textures.sort()).toEqual(['diffuse.png', 'normal.jpg'])
  })
})

describe('safeExtract', () => {
  it('throws on path traversal (..)', () => {
    const archive = new Map()
    archive.set('../evil.mtl', new Uint8Array([1]))
    expect(() => safeExtract(archive)).toThrow(KmpParseError)
  })
  it('throws on absolute paths', () => {
    const archive = new Map()
    archive.set('/etc/passwd', new Uint8Array([1]))
    expect(() => safeExtract(archive)).toThrow(KmpParseError)
  })
  it('throws when total decompressed size exceeds cap', () => {
    const archive = new Map()
    archive.set('a.mtl', new Uint8Array(1024))
    expect(() => safeExtract(archive, { maxSize: 512 })).toThrow(KmpParseError)
  })
  it('passes valid archives through', () => {
    const archive = new Map()
    archive.set('a.mtl', new Uint8Array([1]))
    expect(safeExtract(archive).get('a.mtl').length).toBe(1)
  })
})
