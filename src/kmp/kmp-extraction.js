// KMP archive → list of per-MTL extractions.
// Input forms: path | Uint8Array | ArrayBuffer | Buffer | File | Blob.

import { unzipArchive, safeExtract, enumerateEntries } from '../binary-tools/binary-tools.js'
import { extractMtl } from '../mtl/mtl-extraction.js'
import { parseXmlConfig } from './kmp-param-parser.js'
import { KmpParseError } from '../errors.js'

/**
 * Resolve a KMP input to bytes, inflate the ZIP (size-capped, traversal-safe),
 * and return one {@link KmpExtraction} per embedded MTL — each carrying the
 * decoded MTL, the shared texture list, and the (optional) parsed XML config.
 *
 * Accepted input forms: filesystem path string (Node), Uint8Array, ArrayBuffer,
 * Node Buffer, browser File, or Blob.
 *
 * @param {import('../../index.d.ts').ProcessInput} input Archive to decode.
 * @param {import('../../index.d.ts').ExtractOptions} [options] `maxArchiveSize`
 *   caps cumulative uncompressed size (default 256 MB). Pipeline-level flags
 *   (hex dump, coverage, shader overrides) live on `ProcessOptions` and are
 *   consumed downstream by {@link process}.
 * @returns {Promise<import('../../index.d.ts').KmpExtraction[]>}
 * @throws {import('../../index.d.ts').KmpParseError} `'NO_MTL'` when the
 *   archive contains no `.mtl` file; `'BAD_ZIP'` for oversized, malformed, or
 *   unsafe archives.
 */
export async function extractKmp(input, options = {}) {
  const bytes = await resolveInput(input)
  const archive = safeExtract(
    unzipArchive(bytes, { maxSize: options.maxArchiveSize }),
    { maxSize: options.maxArchiveSize }
  )
  const cat = enumerateEntries(archive)
  if (cat.mtls.length === 0) throw new KmpParseError('NO_MTL', 'No .mtl file in archive')
  const xmlConfig = cat.xml ? parseXmlConfig(new TextDecoder().decode(archive.get(cat.xml))) : null
  const textures = cat.textures.map((path) => {
    const b = archive.get(path)
    return { path, bytes: b, byteLength: b.byteLength, extension: path.split('.').pop().toLowerCase() }
  })
  const extractions = []
  for (const mtlName of cat.mtls) {
    const mtlExtraction = extractMtl(archive.get(mtlName))
    extractions.push({ mtlName, mtlExtraction, textures, xmlConfig })
  }
  return extractions
}

async function resolveInput(input) {
  if (typeof input === 'string') {
    const { readFile } = await import('node:fs/promises')
    return new Uint8Array(await readFile(input))
  }
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (typeof Buffer !== 'undefined' && input && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer())
  }
  throw new KmpParseError('BAD_ZIP', 'Unsupported input type; expected string|Uint8Array|ArrayBuffer|Buffer|File|Blob')
}
