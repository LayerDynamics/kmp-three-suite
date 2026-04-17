// Isomorphic ZIP handling via fflate.
// Evidence: kmp-pipeline.mjs:489-510 (extractKmpArchive) reimplemented without
// a CLI shell-out so this works in both Node and modern browsers.

import { unzipSync } from 'fflate'
import { KmpParseError, sanitizeForLog } from '../errors.js'
import { TEXTURE_EXTENSIONS } from './texture-extensions.js'

const DEFAULT_MAX_SIZE = 256 * 1024 * 1024

function toU8(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (typeof Buffer !== 'undefined' && input && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new KmpParseError('BAD_ZIP', 'Unsupported archive input type')
}

// Memory-safe ZIP inflation.
//
// The cap is enforced BEFORE fflate allocates any per-entry output buffer.
// Without this gate, `unzipSync` calls `new Uint8Array(originalSize)` per
// entry using the central-directory declared size, so an archive whose
// central directory claims a multi-gigabyte entry OOMs the process during
// allocation — long before any post-hoc check on the returned map could run.
//
// The filter callback runs once per entry as fflate walks the central
// directory. We refuse an entry (returning false) when its declared
// originalSize, or the cumulative declared total so far, would cross
// `maxSize`. fflate then skips allocation for that entry and every entry
// where the filter returns false, so peak memory is bounded by
// min(sum of accepted originalSize, maxSize).
//
// A second, authoritative tripwire runs on the returned entries and sums
// the actual byteLengths. This covers the residual case where a decoder
// somehow produces more bytes than the central directory declared (fflate's
// `inflateSync` silently truncates into the pre-sized buffer rather than
// growing, but the tripwire documents the invariant and fails loudly if
// the decoder ever changes).
/**
 * Memory-safe ZIP inflation. Inflates a ZIP archive into a `Map<path, bytes>`
 * while enforcing a strict size cap at two points: (1) pre-allocation filtering
 * on each entry's declared `originalSize`, and (2) a post-hoc tripwire on the
 * actual summed byteLengths. Missing / negative declared sizes are rejected.
 *
 * Isomorphic: runs in Node and modern browsers (uses `fflate`). Path validation
 * is handled separately by {@link safeExtract}.
 *
 * @param {Uint8Array | ArrayBuffer | Buffer} input ZIP bytes.
 * @param {{ maxSize?: number }} [options] `maxSize` defaults to 256 MB.
 * @returns {Map<string, Uint8Array>} Entry path → inflated bytes.
 * @throws {import('../errors.js').KmpParseError} `'BAD_ZIP'` for malformed
 *   archives, missing declared sizes, or any size-cap breach.
 */
export function unzipArchive(input, options = {}) {
  const bytes = toU8(input)
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE
  let cumulativeDeclared = 0
  let bombError = null
  const filter = (info) => {
    if (bombError) return false
    const safeName = sanitizeForLog(info.name)
    const declared = info.originalSize
    if (typeof declared !== 'number' || declared < 0) {
      bombError = new KmpParseError(
        'BAD_ZIP',
        `Entry "${safeName}" has no declared uncompressed size; refusing to decompress`
      )
      return false
    }
    if (declared > maxSize) {
      bombError = new KmpParseError(
        'BAD_ZIP',
        `Entry "${safeName}" declared size ${declared} exceeds cap ${maxSize}`
      )
      return false
    }
    const next = cumulativeDeclared + declared
    if (next > maxSize) {
      bombError = new KmpParseError(
        'BAD_ZIP',
        `Cumulative declared size ${next} at "${safeName}" exceeds cap ${maxSize}`
      )
      return false
    }
    cumulativeDeclared = next
    return true
  }
  let entries
  try {
    entries = unzipSync(bytes, { filter })
  } catch (e) {
    if (bombError) throw bombError
    throw new KmpParseError(
      'BAD_ZIP',
      `ZIP decode failed: ${sanitizeForLog(e && e.message)}`,
      undefined,
      { cause: e }
    )
  }
  if (bombError) throw bombError
  let actualTotal = 0
  const archive = new Map()
  for (const name of Object.keys(entries)) {
    const buf = entries[name]
    actualTotal += buf.byteLength
    if (actualTotal > maxSize) {
      throw new KmpParseError(
        'BAD_ZIP',
        `Actual decompressed size ${actualTotal} at "${sanitizeForLog(name)}" exceeds cap ${maxSize}`
      )
    }
    archive.set(name, buf)
  }
  return archive
}

/**
 * Classify the entries of an inflated archive into MTL paths, a single XML
 * config path (first one wins), and texture paths (png/jpg/jpeg/exr/hdr/tif/
 * tiff/bmp). Classification is extension-based and case-insensitive.
 *
 * @param {Map<string, Uint8Array>} archive Output of {@link unzipArchive}.
 * @returns {{ mtls: string[]; xml: string | null; textures: string[] }}
 */
export function enumerateEntries(archive) {
  const mtls = []
  let xml = null
  const textures = []
  for (const path of archive.keys()) {
    const lower = path.toLowerCase()
    const ext = lower.split('.').pop()
    if (ext === 'mtl') mtls.push(path)
    else if (ext === 'xml' && xml === null) xml = path
    else if (TEXTURE_EXTENSIONS.has(ext)) textures.push(path)
  }
  return { mtls, xml, textures }
}

// Unicode characters that render as a forward- or back-slash but are not the
// ASCII separator. Some downstream consumers (custom extractors, NFKC-
// normalising filesystems, URL layers) can fold these to `/` or `\` after
// the segment check runs, turning a single-segment name into a traversal.
// We reject them outright rather than trying to predict every consumer.
const SLASH_LOOKALIKES = /[\u2044\u2215\u29F8\uFF0F\uFE68\uFF3C]/
// Percent-encoded forms of `.` and `/` / `\` that a downstream URL decode
// would fold into traversal characters.
const ENCODED_TRAVERSAL = /%(?:2e|2f|5c)/i

function pathEscapesRoot(norm) {
  // Segment-walk a path against a notional root. Any `..` that would pop
  // above the root means the path escapes — covers absolute paths once the
  // leading `/` has stripped depth to zero, and mid-path `../..` traversal.
  let depth = 0
  for (const seg of norm.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      depth -= 1
      if (depth < 0) return true
    } else {
      depth += 1
    }
  }
  return false
}

function assertSafePath(path) {
  if (typeof path !== 'string') {
    throw new KmpParseError('BAD_ZIP', `Unsafe archive path: non-string entry name`)
  }
  const safePath = sanitizeForLog(path)
  if (path.includes('\u0000')) {
    throw new KmpParseError('BAD_ZIP', `Unsafe archive path (NUL byte): ${safePath}`)
  }
  if (SLASH_LOOKALIKES.test(path)) {
    throw new KmpParseError('BAD_ZIP', `Unsafe archive path (unicode slash look-alike): ${safePath}`)
  }
  if (ENCODED_TRAVERSAL.test(path)) {
    throw new KmpParseError('BAD_ZIP', `Unsafe archive path (percent-encoded traversal): ${safePath}`)
  }
  // Also decode once, catching `%25%32%66` → `%2f` double-encoding.
  let decoded = path
  try {
    const once = decodeURIComponent(path)
    if (once !== path) {
      if (once.includes('\u0000') || SLASH_LOOKALIKES.test(once) || ENCODED_TRAVERSAL.test(once)) {
        throw new KmpParseError('BAD_ZIP', `Unsafe archive path (decoded traversal): ${safePath}`)
      }
      decoded = once
    }
  } catch {
    // Malformed percent-encoding. Keep the original; subsequent checks catch
    // real traversal and the raw bytes are still rejected if they contain
    // `..` segments or absolute prefixes.
  }
  // NFKC folds fullwidth `/` (U+FF0F) and fullwidth `\` (U+FF3C) into ASCII
  // `/` and `\`. Run the full check on the normalised form too so any
  // compatibility-equivalent path fails the segment walk.
  const candidates = new Set([path, decoded, path.normalize('NFKC'), decoded.normalize('NFKC')])
  for (const candidate of candidates) {
    const norm = candidate.replaceAll('\\', '/')
    if (norm.startsWith('/')) {
      throw new KmpParseError('BAD_ZIP', `Unsafe archive path (absolute): ${safePath}`)
    }
    if (/^[A-Za-z]:/.test(norm)) {
      throw new KmpParseError('BAD_ZIP', `Unsafe archive path (drive letter): ${safePath}`)
    }
    if (pathEscapesRoot(norm)) {
      throw new KmpParseError('BAD_ZIP', `Unsafe archive path (traversal): ${safePath}`)
    }
  }
}

/**
 * Validate every entry path in an inflated archive against path-traversal and
 * cumulative-size attacks, then return the same archive unchanged.
 *
 * Rejected forms: non-string names, NUL bytes, absolute paths, Windows drive
 * letters, `..` escape via segment walk, Unicode slash look-alikes (FF0F /
 * FF3C / 2044 / 2215 / 29F8 / FE68), percent-encoded traversal sequences, and
 * double-encoded variants (all checked against both the raw and
 * `decodeURIComponent`/NFKC-normalised forms). Also enforces a cumulative
 * byteLength cap.
 *
 * @param {Map<string, Uint8Array>} archive Output of {@link unzipArchive}.
 * @param {{ maxSize?: number }} [options] `maxSize` defaults to 256 MB.
 * @returns {Map<string, Uint8Array>} The same archive (for fluent chaining).
 * @throws {import('../errors.js').KmpParseError} `'BAD_ZIP'` on any unsafe
 *   path or size-cap breach.
 */
export function safeExtract(archive, options = {}) {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE
  let total = 0
  for (const [path, bytes] of archive) {
    assertSafePath(path)
    total += bytes.byteLength
    if (total > maxSize) {
      throw new KmpParseError('BAD_ZIP', `Decompressed size ${total} exceeds cap ${maxSize}`)
    }
  }
  return archive
}
