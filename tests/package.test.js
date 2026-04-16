import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))

describe('package.json contract', () => {
  it('is ESM-only', () => {
    expect(pkg.type).toBe('module')
  })
  it('has a single runtime dep on fflate, pinned exactly', () => {
    expect(Object.keys(pkg.dependencies || {})).toEqual(['fflate'])
    expect(pkg.dependencies.fflate).toMatch(/^\d+\.\d+\.\d+$/)
  })
  it('declares main, module, exports, and types', () => {
    expect(pkg.main).toBe('src/index.js')
    expect(pkg.module).toBe('src/index.js')
    expect(pkg.types).toBe('index.d.ts')
    expect(pkg.exports['.']).toBeDefined()
    expect(pkg.exports['.'].import).toBe('./src/index.js')
    expect(pkg.exports['.'].types).toBe('./index.d.ts')
  })
  it('requires Node 20+', () => {
    expect(pkg.engines.node).toMatch(/>=\s*20/)
  })
})
