import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

async function runProcess(page, kmpBase64) {
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
      shaderType: r.shaderType,
      materialName: r.materialName,
      kmpShaderType: r.materialDefinition.kmpShaderType,
      roughness: r.materialDefinition.roughness,
      metalness: r.materialDefinition.metalness,
      color: r.materialDefinition.color,
      hasToonParams: r.materialDefinition.toonParams !== null,
      hasCarpaintParams: r.materialDefinition.carpaintParams !== null,
      hasMetalFlakeParams: r.materialDefinition.metalFlakeParams !== null,
      hasSssParams: r.materialDefinition.sssParams !== null,
      textureCount: r.textures.length,
      warningsLength: r.warnings.length,
    }
  }, kmpBase64)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/index.html')
})

test('toon-fill-black-bright → lux_toon with toonParams', async ({ page }) => {
  const kmpBase64 = readFileSync(join(KMP_DIR, 'toon-fill-black-bright.kmp')).toString('base64')
  const result = await runProcess(page, kmpBase64)

  expect(result.shaderType).toBe('lux_toon')
  expect(result.kmpShaderType).toBe('lux_toon')
  expect(result.materialName).toBe('Toon Fill Black bright  #9')
  expect(result.roughness).toBe(1.0)
  expect(result.metalness).toBe(0.0)
  expect(result.color).toMatch(/^#[0-9a-f]{6}$/)
  expect(result.hasToonParams).toBe(true)
  expect(result.hasCarpaintParams).toBe(false)
  expect(result.hasSssParams).toBe(false)
  expect(result.textureCount).toBe(0)
})

test('paint-metallic-sienna-gold → metallic_paint with carpaintParams + metalFlakeParams', async ({ page }) => {
  const kmpBase64 = readFileSync(join(KMP_DIR, 'paint-metallic-sienna-gold.kmp')).toString('base64')
  const result = await runProcess(page, kmpBase64)

  expect(result.shaderType).toBe('metallic_paint')
  expect(result.kmpShaderType).toBe('metallic_paint')
  expect(result.materialName).toBe('Paint Metallic Sienna gold #1')
  expect(result.color).toMatch(/^#[0-9a-f]{6}$/)
  expect(result.hasCarpaintParams).toBe(true)
  expect(result.hasMetalFlakeParams).toBe(true)
  expect(result.hasToonParams).toBe(false)
  expect(result.hasSssParams).toBe(false)
  expect(result.textureCount).toBe(0)
})

test('translucent-candle-wax → lux_translucent with sssParams', async ({ page }) => {
  const kmpBase64 = readFileSync(join(KMP_DIR, 'translucent-candle-wax.kmp')).toString('base64')
  const result = await runProcess(page, kmpBase64)

  expect(result.shaderType).toBe('lux_translucent')
  expect(result.kmpShaderType).toBe('lux_translucent')
  expect(result.materialName).toBe('Translucent Candle Wax #3')
  expect(result.color).toMatch(/^#[0-9a-f]{6}$/)
  expect(result.hasSssParams).toBe(true)
  expect(result.hasToonParams).toBe(false)
  expect(result.hasCarpaintParams).toBe(false)
  expect(result.textureCount).toBe(0)
})
