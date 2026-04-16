import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const KMP = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp/toon-fill-black-bright.kmp'

test('process(Uint8Array) works in Chromium and returns lux_toon MaterialDefinition', async ({ page }) => {
  await page.goto('/tests/browser/index.html')
  const kmpBase64 = readFileSync(KMP).toString('base64')

  const result = await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    // Diagnostic: fetch the bundle directly to confirm the URL works from the
    // browser context before attempting the dynamic import.
    const probe = await fetch('/dist/kmp-three-suite.browser.mjs')
    if (!probe.ok) {
      throw new Error(`bundle fetch failed: ${probe.status} ${probe.statusText}`)
    }
    const src = await probe.text()
    const blob = new Blob([src], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    const mod = await import(/* @vite-ignore */ url)
    const [r] = await mod.process(bytes, { includeHexDump: false, includeCoverage: false })
    return {
      shaderType: r.shaderType,
      kmpShaderType: r.materialDefinition.kmpShaderType,
      roughness: r.materialDefinition.roughness,
      metalness: r.materialDefinition.metalness,
      hasToonParams: r.materialDefinition.toonParams !== null,
    }
  }, kmpBase64)

  expect(result.shaderType).toBe('lux_toon')
  expect(result.kmpShaderType).toBe('lux_toon')
  expect(result.roughness).toBe(1.0)
  expect(result.metalness).toBe(0.0)
  expect(result.hasToonParams).toBe(true)
})
