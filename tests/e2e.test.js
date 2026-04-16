import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, existsSync, readFileSync as rf } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'
import {
  process, extractKmp, toMemory, toMaterialDefinitionOnly, toFilesystem, KmpParseError,
} from '../src/index.js'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

describe('process() — path input (Node)', () => {
  it('parses metallic paint end-to-end', async () => {
    const [res] = await process(join(KMP_DIR, 'paint-metallic-sienna-gold.kmp'))
    expect(res.shaderType).toBe('metallic_paint')
    expect(res.materialName).toMatch(/Sienna/)
    expect(res.png).not.toBeNull()
    expect(res.png.bytes[0]).toBe(0x89)
    expect(res.materialDefinition.kmpShaderType).toBe('metallic_paint')
    expect(res.materialDefinition.carpaintParams).not.toBeNull()
    expect(res.coverage.unclaimedBytes).toEqual([])
  })
  it('parses toon end-to-end', async () => {
    const [res] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    expect(res.shaderType).toBe('lux_toon')
    expect(res.materialDefinition.kmpShaderType).toBe('lux_toon')
    expect(res.materialDefinition.toonParams).not.toBeNull()
    expect(res.coverage.unclaimedBytes).toEqual([])
  })
  it('parses translucent end-to-end', async () => {
    const [res] = await process(join(KMP_DIR, 'translucent-candle-wax.kmp'))
    expect(res.shaderType).toBe('lux_translucent')
    expect(res.materialDefinition.kmpShaderType).toBe('lux_translucent')
    expect(res.materialDefinition.sssParams).not.toBeNull()
    expect(res.coverage.unclaimedBytes).toEqual([])
  })
})

describe('process() — all 5 input forms', () => {
  const path = join(KMP_DIR, 'toon-fill-black-bright.kmp')
  const bytes = new Uint8Array(readFileSync(path))

  it('accepts string path', async () => {
    const [r] = await process(path)
    expect(r.shaderType).toBe('lux_toon')
  })
  it('accepts Uint8Array', async () => {
    const [r] = await process(bytes)
    expect(r.shaderType).toBe('lux_toon')
  })
  it('accepts ArrayBuffer', async () => {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const [r] = await process(ab)
    expect(r.shaderType).toBe('lux_toon')
  })
  it('accepts Buffer', async () => {
    const [r] = await process(readFileSync(path))
    expect(r.shaderType).toBe('lux_toon')
  })
  it('accepts Blob', async () => {
    const blob = new Blob([bytes])
    const [r] = await process(blob)
    expect(r.shaderType).toBe('lux_toon')
  })
})

describe('process() — error taxonomy', () => {
  it('throws NO_MTL when archive has no .mtl', async () => {
    const bogus = zipSync({ 'readme.txt': strToU8('hello') })
    await expect(process(bogus)).rejects.toThrow(KmpParseError)
  })
  it('throws BAD_ZIP on garbage input', async () => {
    await expect(process(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(KmpParseError)
  })
})

describe('adapters', () => {
  it('toMemory is identity', async () => {
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    expect(toMemory(r)).toBe(r)
  })
  it('toMaterialDefinitionOnly returns just the material def', async () => {
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const md = toMaterialDefinitionOnly(r)
    expect(md.kmpShaderType).toBe('lux_toon')
    expect(md.rawParameters).toBeUndefined()
  })
  it('toFilesystem writes JSON + PNG to disk', async () => {
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-target-'))
    try {
      const { jsonPath, pngPath } = await toFilesystem(r, outDir)
      expect(existsSync(jsonPath)).toBe(true)
      expect(existsSync(pngPath)).toBe(true)
      const parsed = JSON.parse(rf(jsonPath, 'utf8'))
      expect(parsed.shaderType).toBe('lux_toon')
      expect(parsed.materialDefinition.kmpShaderType).toBe('lux_toon')
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})

describe('extractKmp multi-material', () => {
  it('returns one entry per .mtl in the archive', async () => {
    // Craft a fake multi-material ZIP reusing the real MTL bytes twice.
    const realPath = join(KMP_DIR, 'toon-fill-black-bright.kmp')
    const realEntries = await extractKmp(realPath)
    expect(realEntries.length).toBeGreaterThanOrEqual(1)
    // Build a synthetic multi-material archive.
    const mtlBytes = realEntries[0].mtlExtraction._buf
    const zip = zipSync({
      'first.mtl': mtlBytes,
      'second.mtl': mtlBytes,
    })
    const extractions = await extractKmp(zip)
    expect(extractions.length).toBe(2)
    expect(extractions[0].mtlName).toMatch(/\.mtl$/)
    expect(extractions[1].mtlName).toMatch(/\.mtl$/)
  })
})
