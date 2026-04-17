import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import * as lib from '../src/index.js'

const dts = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.d.ts'), 'utf8')

describe('public .d.ts contract', () => {
  const runtimeExports = [
    { name: 'process', dtsKind: 'function', runtimeType: 'function' },
    { name: 'extractKmp', dtsKind: 'function', runtimeType: 'function' },
    { name: 'extractMtl', dtsKind: 'function', runtimeType: 'function' },
    { name: 'parseParamSection', dtsKind: 'function', runtimeType: 'function' },
    { name: 'buildMaterialDefinition', dtsKind: 'function', runtimeType: 'function' },
    { name: 'makeAccessors', dtsKind: 'function', runtimeType: 'function' },
    { name: 'createDefaultMaterialDefinition', dtsKind: 'function', runtimeType: 'function' },
    { name: 'toMemory', dtsKind: 'function', runtimeType: 'function' },
    { name: 'toFilesystem', dtsKind: 'function', runtimeType: 'function' },
    { name: 'toMaterialDefinitionOnly', dtsKind: 'function', runtimeType: 'function' },
    { name: 'toFixtureJson', dtsKind: 'function', runtimeType: 'function' },
    { name: 'KmpParseError', dtsKind: 'class', runtimeType: 'function' },
    { name: 'KNOWN_SHADER_TYPES', dtsKind: 'const', runtimeType: 'object' },
    { name: 'MTL_KNOWN_SHADER_TYPES', dtsKind: 'const', runtimeType: 'object' },
    { name: 'KNOWN_BOOL_PARAM_NAMES', dtsKind: 'const', runtimeType: 'object' },
    { name: 'TEXTURE_SLOT_KEYWORDS', dtsKind: 'const', runtimeType: 'object' },
    { name: 'TEXTURE_EXTENSIONS', dtsKind: 'const', runtimeType: 'object' },
    { name: 'parseXmlConfig', dtsKind: 'function', runtimeType: 'function' },
    { name: 'autoAssignTextures', dtsKind: 'function', runtimeType: 'function' },
    { name: 'binaryTools', dtsKind: 'namespace', runtimeType: 'object' },
  ]

  for (const { name, dtsKind, runtimeType } of runtimeExports) {
    it(`exports ${name} as ${dtsKind}`, () => {
      expect(lib[name], `${name} is not exported by src/index.js`).toBeDefined()
      expect(typeof lib[name], `${name} runtime typeof should be ${runtimeType}`).toBe(runtimeType)
      expect(dts).toMatch(new RegExp(`export\\s+(declare\\s+)?${dtsKind}\\s+${name}\\b`))
    })
  }

  it('MTL_KNOWN_SHADER_TYPES and KNOWN_SHADER_TYPES are the same frozen object', () => {
    // Regression: src/lux/lux.schema.js and src/mtl/mtl-extraction.js previously
    // defined two independent frozen arrays with identical contents. Any future
    // edit to one would have silently drifted from the other. Reference equality
    // here guarantees a single source of truth.
    expect(lib.MTL_KNOWN_SHADER_TYPES).toBe(lib.KNOWN_SHADER_TYPES)
    expect(Object.isFrozen(lib.KNOWN_SHADER_TYPES)).toBe(true)
    expect(Array.isArray(lib.KNOWN_SHADER_TYPES)).toBe(true)
    expect(lib.KNOWN_SHADER_TYPES.length).toBe(20)
  })

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
