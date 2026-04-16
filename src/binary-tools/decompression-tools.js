// Isomorphic ZIP handling via fflate.
// Evidence: kmp-pipeline.mjs:489-510 (extractKmpArchive) reimplemented without
// a CLI shell-out so this works in both Node and modern browsers.

import { unzipSync } from 'fflate'
import { KmpParseError } from '../pipeline/errors.js'

const TEXTURE_EXTS = new Set(['png', 'jpg', 'jpeg', 'exr', 'hdr', 'tif', 'tiff', 'bmp'])
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
export function unzipArchive(input, options = {}) {
  const bytes = toU8(input)
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE
  let cumulativeDeclared = 0
  let bombError = null
  const filter = (info) => {
    if (bombError) return false
    const name = info.name
    const declared = info.originalSize
    if (typeof declared !== 'number' || declared < 0) {
      bombError = new KmpParseError(
        'BAD_ZIP',
        `Entry "${name}" has no declared uncompressed size; refusing to decompress`
      )
      return false
    }
    if (declared > maxSize) {
      bombError = new KmpParseError(
        'BAD_ZIP',
        `Entry "${name}" declared size ${declared} exceeds cap ${maxSize}`
      )
      return false
    }
    const next = cumulativeDeclared + declared
    if (next > maxSize) {
      bombError = new KmpParseError(
        'BAD_ZIP',
        `Cumulative declared size ${next} at "${name}" exceeds cap ${maxSize}`
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
    throw new KmpParseError('BAD_ZIP', `ZIP decode failed: ${e.message}`)
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
        `Actual decompressed size ${actualTotal} at "${name}" exceeds cap ${maxSize}`
      )
    }
    archive.set(name, buf)
  }
  return archive
}

export function enumerateEntries(archive) {
  const mtls = []
  let xml = null
  const textures = []
  for (const path of archive.keys()) {
    const lower = path.toLowerCase()
    const ext = lower.split('.').pop()
    if (ext === 'mtl') mtls.push(path)
    else if (ext === 'xml' && xml === null) xml = path
    else if (TEXTURE_EXTS.has(ext)) textures.push(path)
  }
  return { mtls, xml, textures }
}

export function safeExtract(archive, options = {}) {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE
  let total = 0
  for (const [path, bytes] of archive) {
    const norm = path.replaceAll('\\', '/')
    const segments = norm.split('/')
    if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || segments.includes('..')) {
      throw new KmpParseError('BAD_ZIP', `Unsafe archive path: ${path}`)
    }
    total += bytes.byteLength
    if (total > maxSize) {
      throw new KmpParseError('BAD_ZIP', `Decompressed size ${total} exceeds cap ${maxSize}`)
    }
  }
  return archive
}
