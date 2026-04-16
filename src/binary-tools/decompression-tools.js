// Isomorphic ZIP handling via fflate.
// Evidence: kmp-pipeline.mjs:489-510 (extractKmpArchive) reimplemented without
// a CLI shell-out so this works in both Node and modern browsers.

import { unzipSync } from 'fflate'
import { KmpParseError } from '../pipeline/process.js'

const TEXTURE_EXTS = new Set(['png', 'jpg', 'jpeg', 'exr', 'hdr', 'tif', 'tiff', 'bmp'])

function toU8(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (typeof Buffer !== 'undefined' && input && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new KmpParseError('BAD_ZIP', 'Unsupported archive input type')
}

export function unzipArchive(input) {
  const bytes = toU8(input)
  let entries
  try {
    entries = unzipSync(bytes)
  } catch (e) {
    throw new KmpParseError('BAD_ZIP', `ZIP decode failed: ${e.message}`)
  }
  return new Map(Object.entries(entries).map(([k, v]) => [k, v]))
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
  const maxSize = options.maxSize ?? 256 * 1024 * 1024
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
