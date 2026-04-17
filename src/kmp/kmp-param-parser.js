// XML config parsing + filename-based texture auto-assignment.
//
// parseXmlConfig is intentionally NOT a full XML parser. It is a hardened
// attribute extractor that treats the input as potentially attacker-controlled:
//   - Comments, CDATA, processing instructions, and DOCTYPE are stripped before
//     attribute scanning so attackers cannot smuggle attributes through them.
//   - Only the root element's opening tag is scanned — nested-element attributes
//     never leak into the result.
//   - Attribute name matching is word-boundary-anchored so `preshader="x"` does
//     not match `shader=`.
//   - Duplicate attributes resolve first-wins (consistent between shaderHint
//     and renderHints).
//   - Predefined XML entities and numeric character references are decoded in
//     attribute values.
//   - Forbidden prototype-pollution keys (__proto__, prototype, constructor)
//     are dropped; the returned renderHints has a null prototype.

import { TEXTURE_SLOT_KEYWORDS } from './kmp.schema.js'
import { KmpParseError } from '../errors.js'

const FORBIDDEN_HINT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

// Hard cap on the XML sidecar. The archive-level `maxSize` (default 256 MB)
// can deliver an XML blob up to that size — running four full-buffer
// `stripXmlStructure` sweeps + `matchAll` at that scale is a CPU/memory DoS
// even without catastrophic backtracking. Real KMP sidecars are well under
// 10 KB, so 1 MB is a comfortable ceiling.
export const XML_CONFIG_MAX_LENGTH = 1024 * 1024

const XML_NAMED_ENTITIES = Object.freeze({
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
})

function stripXmlStructure(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
}

function extractRootOpeningTag(s) {
  const rootStart = s.search(/<[A-Za-z_]/)
  if (rootStart < 0) return null
  let i = rootStart + 1
  while (i < s.length && /[\w.\-:]/.test(s[i])) i++
  let quote = null
  while (i < s.length) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return s.slice(rootStart, i + 1)
    }
    i++
  }
  return s.slice(rootStart)
}

function decodeXmlEntities(text) {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body) => {
    if (body.charCodeAt(0) === 35) {
      const code = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return Object.prototype.hasOwnProperty.call(XML_NAMED_ENTITIES, body)
      ? XML_NAMED_ENTITIES[body]
      : match
  })
}

const ATTR_RE = /(?:^|[\s/])([A-Za-z_][\w.\-:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * Extract shader and render hints from a KMP sidecar XML document.
 *
 * This is NOT a general-purpose XML parser — it is a hardened attribute
 * extractor for attacker-controlled input:
 *   - Comments, CDATA, processing instructions, and DOCTYPE are stripped first
 *     so attributes cannot be smuggled through them.
 *   - Only the root element's opening tag is scanned — nested attributes are
 *     ignored.
 *   - Attribute name matching is word-boundary anchored (`preshader="x"` will
 *     not match `shader=`).
 *   - Duplicate attributes resolve first-wins.
 *   - XML entities (named + numeric) are decoded in attribute values.
 *   - `__proto__`, `prototype`, `constructor` are dropped; the returned
 *     `renderHints` has a null prototype.
 *   - Input longer than {@link XML_CONFIG_MAX_LENGTH} (1 MB) is rejected with
 *     `KmpParseError('BAD_ZIP', ...)` — the stripping/attribute sweeps are
 *     full-buffer and become a CPU/memory DoS at archive-cap scale.
 *
 * @param {string | null | undefined} xmlText Raw XML text, or null/undefined
 *   for an archive that did not contain an XML sidecar.
 * @returns {import('../../index.d.ts').XmlConfig} `shaderHint` mirrors the
 *   `shader` attribute (if any); `renderHints` carries every other root
 *   attribute as string values.
 * @throws {import('../errors.js').KmpParseError} `'BAD_ZIP'` when `xmlText`
 *   exceeds {@link XML_CONFIG_MAX_LENGTH}.
 */
export function parseXmlConfig(xmlText) {
  if (!xmlText) return { shaderHint: null, renderHints: Object.create(null) }
  if (xmlText.length > XML_CONFIG_MAX_LENGTH) {
    throw new KmpParseError(
      'BAD_ZIP',
      `XML config length ${xmlText.length} exceeds cap ${XML_CONFIG_MAX_LENGTH}`
    )
  }
  const stripped = stripXmlStructure(xmlText)
  const openingTag = extractRootOpeningTag(stripped)
  const renderHints = Object.create(null)
  let shaderHint = null
  if (openingTag) {
    for (const m of openingTag.matchAll(ATTR_RE)) {
      const name = m[1]
      if (FORBIDDEN_HINT_KEYS.has(name)) continue
      if (Object.prototype.hasOwnProperty.call(renderHints, name)) continue
      const rawValue = m[2] !== undefined ? m[2] : m[3]
      const value = decodeXmlEntities(rawValue)
      renderHints[name] = value
      if (shaderHint === null && name.toLowerCase() === 'shader') {
        shaderHint = value
      }
    }
  }
  return { shaderHint, renderHints }
}

/**
 * Bind archive textures to material slots by filename pattern. Iterates
 * {@link TEXTURE_SLOT_KEYWORDS}; first pattern match wins per texture, and an
 * already-populated slot on `mat` is never overwritten.
 *
 * Mutates and returns `mat` for fluent chaining.
 *
 * @param {import('../../index.d.ts').MaterialDefinition} mat Material whose
 *   `map`/`normalMap`/`roughnessMap`/etc. slots may be populated.
 * @param {import('../../index.d.ts').TextureEntry[]} textures Archive texture
 *   entries (from {@link extractKmp} or manually assembled).
 * @returns {import('../../index.d.ts').MaterialDefinition} The same `mat`.
 */
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
