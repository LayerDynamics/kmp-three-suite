import { test, expect } from '@playwright/test'
import { zipSync, strToU8 } from 'fflate'

async function runProcessExpectError(page, bytesBase64) {
  return page.evaluate(async (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const probe = await fetch('/dist/kmp-three-suite.browser.mjs')
    if (!probe.ok) throw new Error(`bundle fetch failed: ${probe.status} ${probe.statusText}`)
    const src = await probe.text()
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
    const mod = await import(/* @vite-ignore */ url)
    try {
      await mod.process(bytes, { includeHexDump: false, includeCoverage: false })
      return { threw: false }
    } catch (err) {
      return {
        threw: true,
        name: err.name,
        code: err.code,
        message: err.message,
        isKmpParseError: err instanceof mod.KmpParseError,
        isError: err instanceof Error,
      }
    }
  }, bytesBase64)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/index.html')
})

test('garbage bytes reject with KmpParseError code=BAD_ZIP', async ({ page }) => {
  const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  const b64 = Buffer.from(garbage).toString('base64')
  const result = await runProcessExpectError(page, b64)

  expect(result.threw).toBe(true)
  expect(result.name).toBe('KmpParseError')
  expect(result.code).toBe('BAD_ZIP')
  expect(result.isKmpParseError).toBe(true)
  expect(result.isError).toBe(true)
})

test('valid zip without .mtl rejects with KmpParseError code=NO_MTL', async ({ page }) => {
  const archiveBytes = zipSync({ 'notes.txt': strToU8('no material here') })
  const b64 = Buffer.from(archiveBytes).toString('base64')
  const result = await runProcessExpectError(page, b64)

  expect(result.threw).toBe(true)
  expect(result.name).toBe('KmpParseError')
  expect(result.code).toBe('NO_MTL')
  expect(result.isKmpParseError).toBe(true)
  expect(result.isError).toBe(true)
})
