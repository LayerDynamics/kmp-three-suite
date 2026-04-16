// XML config parsing + filename-based texture auto-assignment.

import { TEXTURE_SLOT_KEYWORDS } from './kmp.schema.js'

export function parseXmlConfig(xmlText) {
  if (!xmlText) return { shaderHint: null, renderHints: {} }
  const shaderMatch = xmlText.match(/shader\s*=\s*"([^"]+)"/i)
  const shaderHint = shaderMatch ? shaderMatch[1] : null
  const renderHints = {}
  const attrs = xmlText.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)
  for (const [, k, v] of attrs) renderHints[k] = v
  return { shaderHint, renderHints }
}

export function autoAssignTextures(mat, textures) {
  for (const t of textures) {
    const base = t.path.split('/').pop().toLowerCase()
    for (const { pattern, slot } of TEXTURE_SLOT_KEYWORDS) {
      if (pattern.test(base)) {
        if (!mat[slot]) mat[slot] = t.path
        break
      }
    }
  }
  return mat
}
