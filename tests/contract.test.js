import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const dts = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.d.ts'), 'utf8')

describe('public .d.ts contract', () => {
  const exports = [
    'process', 'extractKmp', 'extractMtl', 'parseParamSection',
    'buildMaterialDefinition', 'makeAccessors', 'createDefaultMaterialDefinition',
    'KNOWN_SHADER_TYPES', 'toMemory', 'toFilesystem', 'toMaterialDefinitionOnly',
    'KmpParseError', 'binaryTools',
  ]
  for (const name of exports) {
    it(`exports ${name}`, () => {
      expect(dts).toMatch(new RegExp(`export\\s+(declare\\s+)?(function|const|class|namespace|interface|type)\\s+${name}\\b`))
    })
  }
  it('defines MaterialDefinition interface', () => {
    expect(dts).toMatch(/export\s+interface\s+MaterialDefinition\b/)
  })
  it('defines RawParam union', () => {
    expect(dts).toMatch(/export\s+type\s+RawParam\b/)
  })
  it('defines ProcessResult interface', () => {
    expect(dts).toMatch(/export\s+interface\s+ProcessResult\b/)
  })
})
