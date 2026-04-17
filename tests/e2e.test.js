import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, existsSync, readFileSync as rf } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'
import {
  process, extractKmp, toMemory, toMaterialDefinitionOnly, toFilesystem, toFixtureJson, KmpParseError,
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
  it('toFilesystem emits the ProcessResult allowlist — no extra keys, no raw bytes', async () => {
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-target-allowlist-'))
    try {
      await toFilesystem(r, outDir)
      const jsonPath = join(outDir, `${r.materialName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-extracted.json`)
      const parsed = JSON.parse(rf(jsonPath, 'utf8'))
      const expectedKeys = [
        'meta', 'materialName', 'shaderType', 'png', 'rawParameters',
        'subShaderColors', 'materialDefinition', 'warnings', 'coverage',
        'paramHexDump', 'tailHexDump', 'textures', 'xmlConfig',
      ].sort()
      expect(Object.keys(parsed).sort()).toEqual(expectedKeys)
      if (parsed.png !== null) {
        expect(parsed.png.bytes).toBeUndefined()
        expect(typeof parsed.png.size).toBe('number')
        expect(typeof parsed.png.startOffset).toBe('string')
        expect(typeof parsed.png.endOffset).toBe('string')
      }
      for (const t of parsed.textures) {
        expect(t.bytes).toBeUndefined()
        expect(typeof t.path).toBe('string')
        expect(typeof t.byteLength).toBe('number')
        expect(typeof t.extension).toBe('string')
      }
      expect(parsed.subShaderColors).not.toBeNull()
      expect(typeof parsed.subShaderColors).toBe('object')
      expect(Array.isArray(parsed.subShaderColors)).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
  it('toFilesystem handles non-ASCII material names without empty-slug collisions', async () => {
    // Regression: slugify used to strip every non-[a-z0-9] codepoint, so
    // "日本語" and "αβγ" both collapsed to "" and produced the same on-disk
    // filename "-extracted.json", silently overwriting each other.
    const [r1] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const [r2] = await process(join(KMP_DIR, 'paint-metallic-sienna-gold.kmp'))
    r1.materialName = '日本語'
    r2.materialName = 'αβγ'
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-target-nonascii-'))
    try {
      const w1 = await toFilesystem(r1, outDir)
      const w2 = await toFilesystem(r2, outDir)
      expect(w1.jsonPath).not.toBe(w2.jsonPath)
      expect(w1.pngPath).not.toBe(w2.pngPath)
      // Neither filename may start with the suffix — that indicates empty slug.
      for (const p of [w1.jsonPath, w2.jsonPath, w1.pngPath, w2.pngPath]) {
        const name = p.split('/').pop()
        expect(name.startsWith('-')).toBe(false)
        expect(name).not.toBe('-extracted.json')
        expect(name).not.toBe('-thumbnail.png')
      }
      // Slug is deterministic — same input → same output.
      const r1b = { ...r1 }
      const outDir2 = mkdtempSync(join(tmpdir(), 'k3s-target-nonascii2-'))
      try {
        const w1b = await toFilesystem(r1b, outDir2)
        expect(w1b.jsonPath.split('/').pop()).toBe(w1.jsonPath.split('/').pop())
      } finally {
        rmSync(outDir2, { recursive: true, force: true })
      }
      expect(existsSync(w1.jsonPath)).toBe(true)
      expect(existsSync(w2.jsonPath)).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
  it('toFilesystem caps slug length so combined filename fits the 255-byte filesystem limit', async () => {
    // Regression: slugify had no length cap, so a 300-char materialName
    // produced "<300 chars>-extracted.json" → ENAMETOOLONG on ext4/APFS.
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    r.materialName = 'A'.repeat(300)
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-target-long-'))
    try {
      const { jsonPath, pngPath } = await toFilesystem(r, outDir)
      const jsonName = jsonPath.split('/').pop()
      const pngName = pngPath.split('/').pop()
      // Buffer.byteLength uses UTF-8; 255 is the per-component limit on ext4/APFS.
      expect(Buffer.byteLength(jsonName, 'utf8')).toBeLessThanOrEqual(255)
      expect(Buffer.byteLength(pngName, 'utf8')).toBeLessThanOrEqual(255)
      expect(jsonName.endsWith('-extracted.json')).toBe(true)
      expect(pngName.endsWith('-thumbnail.png')).toBe(true)
      expect(existsSync(jsonPath)).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
  it('toFilesystem preserves Latin-diacritic material names via transliteration', async () => {
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    r.materialName = 'Café Noño'
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-target-diacritic-'))
    try {
      const { jsonPath } = await toFilesystem(r, outDir)
      const name = jsonPath.split('/').pop()
      expect(name).toBe('cafe-nono-extracted.json')
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
  it('toFilesystem disambiguates when two materials slugify to the same name', async () => {
    // Regression (Review #91): before this fix, calling toFilesystem twice in
    // the same outDir with two results whose slugs collided silently
    // overwrote the first JSON, PNG, and textures/ directory — data loss
    // without warning. Collision sources include: identical materialName,
    // punctuation variants ("Red Paint" vs "red_paint"), and any pair that
    // slugify keeps on the short-ASCII branch (no hash suffix applied).
    const [r1] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const [r2] = await process(join(KMP_DIR, 'paint-metallic-sienna-gold.kmp'))
    r1.materialName = 'Shared Name'
    r2.materialName = 'Shared Name'
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-target-collide-'))
    try {
      const w1 = await toFilesystem(r1, outDir)
      const w2 = await toFilesystem(r2, outDir)
      expect(w1.jsonPath).not.toBe(w2.jsonPath)
      expect(w1.pngPath).not.toBe(w2.pngPath)
      expect(existsSync(w1.jsonPath)).toBe(true)
      expect(existsSync(w2.jsonPath)).toBe(true)
      expect(existsSync(w1.pngPath)).toBe(true)
      expect(existsSync(w2.pngPath)).toBe(true)
      // Content preservation: each JSON must carry its own ProcessResult —
      // proves no silent overwrite happened.
      const j1 = JSON.parse(rf(w1.jsonPath, 'utf8'))
      const j2 = JSON.parse(rf(w2.jsonPath, 'utf8'))
      expect(j1.shaderType).toBe('lux_toon')
      expect(j2.shaderType).toBe('metallic_paint')
      // A third collision bumps to -3, never back to the -2 slot.
      const [r3] = await process(join(KMP_DIR, 'translucent-candle-wax.kmp'))
      r3.materialName = 'Shared Name'
      const w3 = await toFilesystem(r3, outDir)
      expect(w3.jsonPath).not.toBe(w1.jsonPath)
      expect(w3.jsonPath).not.toBe(w2.jsonPath)
      expect(existsSync(w1.jsonPath)).toBe(true)
      expect(existsSync(w2.jsonPath)).toBe(true)
      expect(existsSync(w3.jsonPath)).toBe(true)
      expect(JSON.parse(rf(w3.jsonPath, 'utf8')).shaderType).toBe('lux_translucent')
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
  it('toFilesystem disambiguates the textures/ directory in lockstep with JSON/PNG', async () => {
    // The textures subdir is derived from the same slug as JSON/PNG; a
    // collision must bump all three together so texture files from one
    // material cannot land inside another material's directory.
    const [r1] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const [r2] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    r1.materialName = 'Twin'
    r2.materialName = 'Twin'
    r1.textures = [{ path: 'tex/one.png', bytes: new Uint8Array([1, 2, 3]), byteLength: 3, extension: 'png' }]
    r2.textures = [{ path: 'tex/one.png', bytes: new Uint8Array([4, 5, 6]), byteLength: 3, extension: 'png' }]
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-target-coltex-'))
    try {
      const w1 = await toFilesystem(r1, outDir)
      const w2 = await toFilesystem(r2, outDir)
      expect(w1.texturePaths[0]).not.toBe(w2.texturePaths[0])
      expect(existsSync(w1.texturePaths[0])).toBe(true)
      expect(existsSync(w2.texturePaths[0])).toBe(true)
      expect(w1.texturePaths[0].includes(`${join('textures', 'twin')}/`)).toBe(true)
      expect(w2.texturePaths[0].includes(`${join('textures', 'twin-2')}/`)).toBe(true)
      // Same basename `one.png` in each directory retains its own bytes.
      expect(Array.from(rf(w1.texturePaths[0]))).toEqual([1, 2, 3])
      expect(Array.from(rf(w2.texturePaths[0]))).toEqual([4, 5, 6])
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
  it('toFilesystem detects collision when only the textures/<slug> dir pre-exists', async () => {
    // Probes all three target paths as a unit — a pre-existing textures dir
    // must force a suffix bump even when JSON and PNG slots are free.
    const { mkdirSync } = await import('node:fs')
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    r.materialName = 'Lonely'
    r.textures = [{ path: 'tex/only.png', bytes: new Uint8Array([9]), byteLength: 1, extension: 'png' }]
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-target-texcoll-'))
    try {
      mkdirSync(join(outDir, 'textures', 'lonely'), { recursive: true })
      const w = await toFilesystem(r, outDir)
      expect(w.jsonPath.endsWith('lonely-2-extracted.json')).toBe(true)
      expect(w.pngPath.endsWith('lonely-2-thumbnail.png')).toBe(true)
      expect(w.texturePaths[0].includes(`${join('textures', 'lonely-2')}/`)).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
  it('toFilesystem ignores unknown fields tacked onto the ProcessResult (allowlist enforced)', async () => {
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    r.futureDebugBlob = { secret: 'should-not-leak', payload: new Uint8Array([1, 2, 3]) }
    r.futureHandle = Symbol('handle')
    r.futureCount = 42
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-target-unknown-'))
    try {
      const { jsonPath } = await toFilesystem(r, outDir)
      const parsed = JSON.parse(rf(jsonPath, 'utf8'))
      expect(parsed.futureDebugBlob).toBeUndefined()
      expect(parsed.futureHandle).toBeUndefined()
      expect(parsed.futureCount).toBeUndefined()
      const raw = rf(jsonPath, 'utf8')
      expect(raw).not.toContain('should-not-leak')
      expect(raw).not.toContain('futureDebugBlob')
      expect(raw).not.toContain('futureHandle')
      expect(raw).not.toContain('futureCount')
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  // ── toFixtureJson: single-file deterministic MaterialDefinition snapshot ──
  it('toFixtureJson writes a single JSON file at the given path', async () => {
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-fixture-'))
    try {
      const outPath = join(outDir, 'toon.material.json')
      const { outPath: written, byteLength } = await toFixtureJson(r, outPath)
      expect(existsSync(written)).toBe(true)
      expect(byteLength).toBeGreaterThan(100)
      const parsed = JSON.parse(rf(written, 'utf8'))
      expect(parsed.shaderType).toBe('lux_toon')
      expect(parsed.materialDefinition.kmpShaderType).toBe('lux_toon')
      expect(parsed.materialDefinition.toonParams).not.toBeNull()
      // Traceability fields must be present.
      expect(typeof parsed.sourceKmp).toBe('string')
      expect(typeof parsed.bakerVersion).toBe('string')
      expect(typeof parsed.bakedAt).toBe('string')
      expect(parsed.bakedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(parsed.mtlName).toMatch(/\.mtl$/i)
      expect(Array.isArray(parsed.warnings)).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('toFixtureJson is byte-deterministic when bakedAt is pinned', async () => {
    // Regression: the fixture file is checked in to consumer repos. Any
    // hidden non-determinism (Map iteration order, timestamp drift) would
    // cause spurious diffs on re-bake. The only non-deterministic field
    // is bakedAt; pinning it should produce byte-identical runs.
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-fixture-det-'))
    try {
      const outA = join(outDir, 'a.json')
      const outB = join(outDir, 'b.json')
      const pinned = {
        sourceKmp: 'repo/path/to/toon.kmp',
        bakerVersion: 'kmp-three-suite@test',
        bakedAt: '2026-01-01T00:00:00.000Z',
      }
      await toFixtureJson(r, outA, pinned)
      await toFixtureJson(r, outB, pinned)
      const a = rf(outA, 'utf8')
      const b = rf(outB, 'utf8')
      expect(a).toBe(b)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('toFixtureJson creates parent directories recursively', async () => {
    const [r] = await process(join(KMP_DIR, 'toon-fill-black-bright.kmp'))
    const outDir = mkdtempSync(join(tmpdir(), 'k3s-fixture-mkdir-'))
    try {
      const deep = join(outDir, 'does', 'not', 'yet', 'exist', 'fixture.json')
      const { outPath: written } = await toFixtureJson(r, deep)
      expect(existsSync(written)).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('toFixtureJson rejects invalid inputs', async () => {
    await expect(toFixtureJson(null, '/tmp/x.json')).rejects.toThrow(TypeError)
    await expect(toFixtureJson({}, '')).rejects.toThrow(TypeError)
    await expect(toFixtureJson({}, 123)).rejects.toThrow(TypeError)
  })
})

describe('extractKmp multi-material', () => {
  it('returns one entry per .mtl in the archive', async () => {
    // Craft a fake multi-material ZIP reusing the real MTL bytes twice.
    const realPath = join(KMP_DIR, 'toon-fill-black-bright.kmp')
    const realEntries = await extractKmp(realPath)
    expect(realEntries.length).toBeGreaterThanOrEqual(1)
    // Build a synthetic multi-material archive.
    const mtlBytes = realEntries[0].mtlExtraction.source
    const zip = zipSync({
      'first.mtl': mtlBytes,
      'second.mtl': mtlBytes,
    })
    const extractions = await extractKmp(zip)
    expect(extractions.length).toBe(2)
    expect(extractions[0].mtlName).toMatch(/\.mtl$/)
    expect(extractions[1].mtlName).toMatch(/\.mtl$/)
  })

  // Invariant: extractKmp builds `textures` and `xmlConfig` ONCE per archive and
  // attaches the same references to every per-MTL entry. `process()` threads
  // those same references through to each ProcessResult. This is a deliberate
  // zero-copy contract — consumers that mutate one entry's `textures`/`xmlConfig`
  // will affect every sibling. Locking this in so that neither a post-construction
  // mutation inside the pipeline nor an accidental per-MTL clone can silently
  // flip the contract.
  describe('shared textures/xmlConfig invariant across per-MTL results', () => {
    // PNG-like bytes — just need distinct content; extractKmp treats textures as opaque blobs.
    const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const XML_SIDECAR = strToU8(
      '<?xml version="1.0"?><preset shader="lux_toon" foo="bar" baz="qux"/>'
    )

    async function buildMultiMtlZip() {
      const realPath = join(KMP_DIR, 'toon-fill-black-bright.kmp')
      const realEntries = await extractKmp(realPath)
      const mtlBytes = realEntries[0].mtlExtraction.source
      return zipSync({
        'first.mtl': mtlBytes,
        'second.mtl': mtlBytes,
        'textures/albedo.png': PNG_SIG,
        'textures/normal.png': PNG_SIG,
        'config.xml': XML_SIDECAR,
      })
    }

    it('extractKmp shares identical textures and xmlConfig object references across per-MTL entries', async () => {
      const zip = await buildMultiMtlZip()
      const extractions = await extractKmp(zip)
      expect(extractions.length).toBe(2)

      // Sanity-check the preconditions the identity check is about to assert on.
      expect(extractions[0].textures.length).toBe(2)
      expect(extractions[0].xmlConfig).not.toBeNull()
      expect(extractions[0].xmlConfig.shaderHint).toBe('lux_toon')

      // Array identity — same reference, not a deep-equal copy.
      expect(extractions[0].textures).toBe(extractions[1].textures)
      // Texture entry identity — entries themselves are shared, not cloned.
      for (let i = 0; i < extractions[0].textures.length; i++) {
        expect(extractions[0].textures[i]).toBe(extractions[1].textures[i])
      }
      // xmlConfig object identity — including its renderHints sub-object.
      expect(extractions[0].xmlConfig).toBe(extractions[1].xmlConfig)
      expect(extractions[0].xmlConfig.renderHints).toBe(extractions[1].xmlConfig.renderHints)
    })

    it('process() preserves shared textures/xmlConfig identity across ProcessResult[]', async () => {
      const zip = await buildMultiMtlZip()
      const results = await process(zip)
      expect(results.length).toBe(2)

      expect(results[0].textures).toBe(results[1].textures)
      for (let i = 0; i < results[0].textures.length; i++) {
        expect(results[0].textures[i]).toBe(results[1].textures[i])
      }
      expect(results[0].xmlConfig).toBe(results[1].xmlConfig)
      expect(results[0].xmlConfig.renderHints).toBe(results[1].xmlConfig.renderHints)
    })

    it('shares the null xmlConfig sentinel when no XML sidecar is present', async () => {
      // Same archive minus the XML sidecar — every entry must still observe
      // the same `xmlConfig` value (null) without the pipeline re-deriving it per MTL.
      const realPath = join(KMP_DIR, 'toon-fill-black-bright.kmp')
      const realEntries = await extractKmp(realPath)
      const mtlBytes = realEntries[0].mtlExtraction.source
      const zip = zipSync({
        'first.mtl': mtlBytes,
        'second.mtl': mtlBytes,
      })
      const extractions = await extractKmp(zip)
      expect(extractions[0].xmlConfig).toBeNull()
      expect(extractions[1].xmlConfig).toBeNull()
      expect(extractions[0].xmlConfig).toBe(extractions[1].xmlConfig)
      // Empty textures array must also be the same reference (not two fresh []s).
      expect(extractions[0].textures).toBe(extractions[1].textures)
    })

    it('documents the sharing contract: mutating one entry is visible to siblings', async () => {
      // This test pins the observable consequence of the sharing invariant.
      // If anyone later introduces a per-MTL clone (e.g. `{...result, textures: [...textures]}`),
      // this assertion flips and forces a deliberate contract change rather than a silent API shift.
      const zip = await buildMultiMtlZip()
      const results = await process(zip)

      const sentinel = { path: '__mutation_sentinel__.png', bytes: new Uint8Array(0), byteLength: 0, extension: 'png' }
      results[0].textures.push(sentinel)
      expect(results[1].textures).toContain(sentinel)
      expect(results[1].textures[results[1].textures.length - 1]).toBe(sentinel)

      results[0].xmlConfig.renderHints.__mutation_sentinel__ = 'seen'
      expect(results[1].xmlConfig.renderHints.__mutation_sentinel__).toBe('seen')

      // Clean up the sentinel mutations so later tests in the suite aren't affected
      // by cross-module references (defensive — no current test reuses these objects).
      results[0].textures.pop()
      delete results[0].xmlConfig.renderHints.__mutation_sentinel__
    })
  })
})
