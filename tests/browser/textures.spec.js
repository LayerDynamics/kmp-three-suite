import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

// Minimal valid 1x1 transparent PNG — real magic + IHDR + IDAT + IEND.
const PNG_1X1_TRANSPARENT = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

function buildArchiveWithTexture(kmpPath, textureName, textureBytes) {
  const originalEntries = unzipSync(new Uint8Array(readFileSync(kmpPath)))
  const combined = { ...originalEntries, [textureName]: textureBytes }
  return zipSync(combined)
}

async function runProcess(page, archiveBase64) {
  return page.evaluate(async (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const probe = await fetch('/dist/kmp-three-suite.browser.mjs')
    if (!probe.ok) throw new Error(`bundle fetch failed: ${probe.status} ${probe.statusText}`)
    const src = await probe.text()
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
    const mod = await import(/* @vite-ignore */ url)
    const [r] = await mod.process(bytes, { includeHexDump: false, includeCoverage: false })
    return {
      textureCount: r.textures.length,
      textures: r.textures.map((t) => ({
        path: t.path,
        extension: t.extension,
        byteLength: t.byteLength,
      })),
      map: r.materialDefinition.map,
      normalMap: r.materialDefinition.normalMap,
      roughnessMap: r.materialDefinition.roughnessMap,
      shaderType: r.shaderType,
    }
  }, archiveBase64)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/index.html')
})

test('diffuse PNG texture in archive passes through and auto-assigns to map slot', async ({ page }) => {
  // Filename uses a hyphen so `\bdiffuse\b` matches (underscore is a word char
  // and would prevent the boundary — see src/kmp/kmp.schema.js).
  const archive = buildArchiveWithTexture(
    join(KMP_DIR, 'toon-fill-black-bright.kmp'),
    'body-diffuse.png',
    PNG_1X1_TRANSPARENT,
  )
  const b64 = Buffer.from(archive).toString('base64')
  const result = await runProcess(page, b64)

  expect(result.shaderType).toBe('lux_toon')
  expect(result.textureCount).toBe(1)
  expect(result.textures[0].path).toBe('body-diffuse.png')
  expect(result.textures[0].extension).toBe('png')
  expect(result.textures[0].byteLength).toBe(PNG_1X1_TRANSPARENT.byteLength)
  expect(result.map).toBe('body-diffuse.png')
  expect(result.normalMap).toBeNull()
  expect(result.roughnessMap).toBeNull()
})

test('multiple texture slots route by filename keyword', async ({ page }) => {
  const originalEntries = unzipSync(new Uint8Array(readFileSync(join(KMP_DIR, 'toon-fill-black-bright.kmp'))))
  const combined = {
    ...originalEntries,
    'material_albedo.png': PNG_1X1_TRANSPARENT,
    'material_normal.png': PNG_1X1_TRANSPARENT,
    'material_roughness.png': PNG_1X1_TRANSPARENT,
  }
  const archive = zipSync(combined)
  const b64 = Buffer.from(archive).toString('base64')
  const result = await runProcess(page, b64)

  expect(result.textureCount).toBe(3)
  const paths = result.textures.map((t) => t.path).sort()
  expect(paths).toEqual(['material_albedo.png', 'material_normal.png', 'material_roughness.png'])
  expect(result.map).toBe('material_albedo.png')
  expect(result.normalMap).toBe('material_normal.png')
  expect(result.roughnessMap).toBe('material_roughness.png')
})
