import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { createDefaultMaterialDefinition } from '../../src/lux/lux.schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..', '..')
const dtsPath = join(pkgRoot, 'index.d.ts')
const srcRoot = join(pkgRoot, 'src')
const dts = readFileSync(dtsPath, 'utf8')

function parseInterfaceKeys(source, interfaceName) {
  const re = new RegExp(`export\\s+interface\\s+${interfaceName}\\s*\\{([\\s\\S]*?)^\\}`, 'm')
  const match = source.match(re)
  if (!match) throw new Error(`interface ${interfaceName} not found in .d.ts`)
  const body = match[1]
  return [...body.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)].map(m => m[1])
}

function parseSideLiteralUnion(source) {
  const match = source.match(/^\s*side\s*:\s*([^\n]+)$/m)
  if (!match) throw new Error('side field not found in MaterialDefinition')
  const literals = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  if (literals.length === 0) throw new Error('side declaration has no string literals')
  return literals
}

function walkJsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkJsFiles(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

describe('MaterialDefinition shape contract (index.d.ts ↔ lux.schema.js)', () => {
  it('factory emits exactly the keys declared in MaterialDefinition', () => {
    const declared = parseInterfaceKeys(dts, 'MaterialDefinition')
    const emitted = Object.keys(createDefaultMaterialDefinition())
    const declaredSet = new Set(declared)
    const emittedSet = new Set(emitted)

    const declaredButNotEmitted = declared.filter(k => !emittedSet.has(k))
    const emittedButNotDeclared = emitted.filter(k => !declaredSet.has(k))

    expect(
      declaredButNotEmitted,
      `index.d.ts declares keys the factory does not emit: ${declaredButNotEmitted.join(', ')}`,
    ).toEqual([])
    expect(
      emittedButNotDeclared,
      `factory emits keys not declared in index.d.ts: ${emittedButNotDeclared.join(', ')}`,
    ).toEqual([])
    expect(emitted).toHaveLength(declared.length)
  })

  it('default mat.side is one of the declared literal union members', () => {
    const allowed = parseSideLiteralUnion(dts)
    const mat = createDefaultMaterialDefinition()
    expect(allowed).toContain(mat.side)
  })

  it('every `mat.side = "..."` assignment in src/ uses a declared literal', () => {
    // Guards against typos like `mat.side = 'Front'` or `'double-sided'` inside
    // a shader-type branch — TypeScript cannot catch these because the factory
    // and mappers live in .js files. Evidence: src/lux/lux-extraction.js:572
    // writes `mat.side = 'double'` from applyTranslucentSss.
    const allowed = new Set(parseSideLiteralUnion(dts))
    const files = walkJsFiles(srcRoot)
    const offenders = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/\bmat\.side\s*=\s*['"]([^'"]+)['"]/)
        if (m && !allowed.has(m[1])) {
          offenders.push(`${file}:${i + 1} — side = '${m[1]}' (allowed: ${[...allowed].join(', ')})`)
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
