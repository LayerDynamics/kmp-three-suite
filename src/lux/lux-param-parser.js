// Type-flexible accessors over the parsed parameter list.
// Evidence: kmp-pipeline.mjs:961-1033.

import { rgbToHex } from '../binary-tools/binary-tools.js'

/**
 * Build a bundle of type-tolerant accessors over a parsed parameter list.
 *
 * Each getter accepts one or more param names and returns the first record
 * that matches both an input name AND the getter's expected type family:
 *   - `getFloat`   → `float` / `float_as_bool` → number
 *   - `getColor`   → `color` → `#rrggbb` string (sRGB-converted)
 *   - `getColorRaw`→ `color` → `{ r, g, b }` linear triplet
 *   - `getInt`     → `int` / `bool` → number
 *   - `getBoolFlex`→ `bool`/`bool_inferred`/`int`/`float`/`float_as_bool` → boolean
 *   - `getAnyScalar` → any scalar-ish type → number
 *   - `getColorOrScalar` → color OR scalar broadcast to `{r,g,b}` → triplet
 *   - `getAnyAsColorArray` → color OR scalar broadcast to `[r,g,b]` → triplet array
 *
 * All getters return `null` if no matching param is found. `byName` exposes
 * the raw lookup map for accessor-agnostic inspection (e.g. shaderType checks).
 *
 * @param {import('../../index.d.ts').RawParam[]} rawParams Parsed TLV records.
 * @returns {import('../../index.d.ts').Accessors}
 */
export function makeAccessors(rawParams) {
  const byName = Object.create(null)
  for (const p of rawParams) {
    if (p && p.name) byName[p.name] = p
  }
  const getFloat = (...keys) => {
    for (const k of keys) {
      const p = byName[k]
      if (p && (p.type === 'float' || p.type === 'float_as_bool')) return p.value
    }
    return null
  }
  const getColor = (...keys) => {
    for (const k of keys) {
      const p = byName[k]
      if (p && p.type === 'color') return rgbToHex(p.value.r, p.value.g, p.value.b)
    }
    return null
  }
  const getColorRaw = (...keys) => {
    for (const k of keys) {
      const p = byName[k]
      if (p && p.type === 'color') return p.value
    }
    return null
  }
  const getInt = (...keys) => {
    for (const k of keys) {
      const p = byName[k]
      if (p && (p.type === 'int' || p.type === 'bool')) return p.value
    }
    return null
  }
  const getAnyScalar = (...keys) => {
    for (const k of keys) {
      const p = byName[k]
      if (!p) continue
      if (p.type === 'float' || p.type === 'float_as_bool' || p.type === 'int' || p.type === 'bool') {
        return p.value
      }
    }
    return null
  }
  const getColorOrScalar = (...keys) => {
    for (const k of keys) {
      const p = byName[k]
      if (!p) continue
      if (p.type === 'color') return p.value
      if (p.type === 'float' || p.type === 'float_as_bool') {
        const v = p.value
        return { r: v, g: v, b: v }
      }
    }
    return null
  }
  const getBoolFlex = (...keys) => {
    for (const k of keys) {
      const p = byName[k]
      if (!p) continue
      if (p.type === 'bool' || p.type === 'bool_inferred') return p.value !== 0
      if (p.type === 'int') return p.value !== 0
      if (p.type === 'float' || p.type === 'float_as_bool') return p.value > 0.5
    }
    return null
  }
  const getAnyAsColorArray = (...keys) => {
    for (const k of keys) {
      const p = byName[k]
      if (!p) continue
      if (p.type === 'color') return [p.value.r, p.value.g, p.value.b]
      if (p.type === 'float' || p.type === 'float_as_bool') return [p.value, p.value, p.value]
    }
    return null
  }
  return { getFloat, getColor, getColorRaw, getInt, getAnyScalar, getColorOrScalar, getBoolFlex, getAnyAsColorArray, byName }
}
