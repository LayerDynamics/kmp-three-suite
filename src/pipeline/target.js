// Output adapters: toMemory (identity), toFilesystem (JSON + PNG + textures),
// toMaterialDefinitionOnly (lean for browser consumers), toFixtureJson
// (deterministic test-fixture JSON written to a single path).

/**
 * Identity adapter — returns the full {@link ProcessResult} unchanged so the
 * caller receives every field the pipeline produced (meta, rawParameters,
 * hex dumps, coverage, textures, xmlConfig, etc.).
 *
 * @param {import('../../index.d.ts').ProcessResult} result
 * @returns {import('../../index.d.ts').ProcessResult}
 */
export function toMemory(result) {
  return result
}

/**
 * Lean adapter for browser / renderer consumers — returns only the
 * {@link MaterialDefinition} and drops metadata, buffers, and diagnostics.
 *
 * @param {import('../../index.d.ts').ProcessResult} result
 * @returns {import('../../index.d.ts').MaterialDefinition}
 */
export function toMaterialDefinitionOnly(result) {
  return result.materialDefinition
}

/**
 * Write a {@link ProcessResult} to disk as `<slug>-extracted.json`, an optional
 * `<slug>-thumbnail.png`, and a `textures/<slug>/` directory containing each
 * texture entry. `slug` is derived from `result.materialName`, falling back to
 * the MTL filename (minus `.mtl`).
 *
 * The JSON content is built by {@link serialiseResult}, which enumerates every
 * field of `ProcessResult` explicitly. Raw binary (`png.bytes`, `textures[].bytes`)
 * is stripped from the JSON because those bytes are written as sibling files.
 * Any field not on the allowlist — including anything added to `ProcessResult`
 * in the future — is omitted until the allowlist is updated; this prevents
 * silent leaks and silent drops.
 *
 * Node-only (uses `node:fs/promises` and `node:path`).
 *
 * @param {import('../../index.d.ts').ProcessResult} result
 * @param {string} outDir Target directory — created recursively if absent.
 * @returns {Promise<{ jsonPath: string; pngPath: string; texturePaths: string[] }>}
 *   Absolute paths of the files written (`pngPath` is set even when no PNG was
 *   present; `texturePaths` is empty when the result has no textures).
 */
export async function toFilesystem(result, outDir) {
  const { mkdir, writeFile, access } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { createHash } = await import('node:crypto')
  await mkdir(outDir, { recursive: true })

  const rawBase = slugify(result.materialName || result.meta.mtlFile.replace(/\.mtl$/i, ''), createHash)
  const base = await resolveFreeBase(rawBase, outDir, access, join)
  const jsonPath = join(outDir, `${base}-extracted.json`)
  const pngPath = join(outDir, `${base}-thumbnail.png`)
  const textureDir = join(outDir, 'textures', base)
  const texturePaths = []

  await writeFile(jsonPath, JSON.stringify(serialiseResult(result), null, 2))

  if (result.png) await writeFile(pngPath, Buffer.from(result.png.bytes))

  if (result.textures.length > 0) {
    await mkdir(textureDir, { recursive: true })
    for (const t of result.textures) {
      const fileName = t.path.split('/').pop()
      const tp = join(textureDir, fileName)
      await writeFile(tp, Buffer.from(t.bytes))
      texturePaths.push(tp)
    }
  }

  return { jsonPath, pngPath, texturePaths }
}

/**
 * Write a deterministic test-fixture JSON to a single target path. The file
 * contains the full {@link MaterialDefinition} plus the traceability fields
 * a consumer project needs to verify the baked fixture still matches the
 * source KMP: `sourceKmp` (descriptive identifier, caller-provided),
 * `mtlName`, `shaderType`, `warnings`, and a `bakedAt` ISO-8601 timestamp.
 *
 * Purpose: consumers of kmp-three-suite that do NOT take a runtime
 * dependency on the library still need a way to snapshot the canonical
 * MaterialDefinition produced by {@link process}. This adapter is that
 * snapshot — it emits a single JSON file suitable for checking in to a
 * consumer repo as a static fixture, skipping the PNG + texture + hex-dump
 * output that {@link toFilesystem} produces.
 *
 * Deterministic by construction: the JSON serialiser walks only the listed
 * fields of `MaterialDefinition` and uses 2-space indentation with a
 * trailing newline. Two byte-identical runs over identical input always
 * produce identical bytes, so the file can be committed and diffed.
 *
 * Node-only (uses `node:fs/promises` and `node:path`).
 *
 * @param {import('../../index.d.ts').ProcessResult} result Output of
 *   {@link process} for a single MTL.
 * @param {string} outPath Absolute or CWD-relative file path. Parent
 *   directories are created recursively if absent. Existing files at
 *   `outPath` are overwritten.
 * @param {object} [options]
 * @param {string} [options.sourceKmp] Human-readable identifier for the
 *   source KMP file, written into the `sourceKmp` field of the fixture
 *   (e.g. a repo-relative path). Defaults to the empty string.
 * @param {string} [options.bakerVersion] Human-readable library version
 *   string written into the `bakerVersion` field. Defaults to
 *   `'kmp-three-suite'` when omitted.
 * @param {string} [options.bakedAt] Override the timestamp — injected so
 *   callers who need byte-identical re-runs (e.g. tests asserting file
 *   hashes) can pin it. Defaults to `new Date().toISOString()` at call
 *   time.
 * @returns {Promise<{ outPath: string; byteLength: number }>} Absolute
 *   path actually written (after any path resolution) and the byte
 *   length of the written file.
 */
export async function toFixtureJson(result, outPath, options = {}) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('toFixtureJson: result must be a ProcessResult object')
  }
  if (typeof outPath !== 'string' || outPath.length === 0) {
    throw new TypeError('toFixtureJson: outPath must be a non-empty string')
  }
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname, resolve } = await import('node:path')
  const absOut = resolve(outPath)
  await mkdir(dirname(absOut), { recursive: true })

  const payload = {
    sourceKmp: typeof options.sourceKmp === 'string' ? options.sourceKmp : '',
    bakerVersion: typeof options.bakerVersion === 'string' ? options.bakerVersion : 'kmp-three-suite',
    bakedAt: typeof options.bakedAt === 'string' ? options.bakedAt : new Date().toISOString(),
    mtlName: result.meta?.mtlFile ?? null,
    materialName: result.materialName ?? null,
    shaderType: result.shaderType ?? null,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    materialDefinition: result.materialDefinition,
  }
  const body = JSON.stringify(payload, null, 2) + '\n'
  await writeFile(absOut, body, 'utf8')
  return { outPath: absOut, byteLength: Buffer.byteLength(body, 'utf8') }
}

// Upper bound on the disambiguation search. Any outDir already holding this
// many same-slug entries has a deeper organisational problem than a numeric
// suffix can paper over — surface it loudly rather than loop forever.
const MAX_COLLISION_ATTEMPTS = 10_000

/**
 * Return a slug variant that does NOT collide with any existing entry in
 * `outDir`. Probes all three output slots used by {@link toFilesystem}
 * (`<base>-extracted.json`, `<base>-thumbnail.png`, and `textures/<base>/`)
 * together so the three files always share a single base even when only one
 * of them was previously taken. Bumps `base`, `base-2`, `base-3`, … until a
 * fully-free triple is found.
 *
 * Deterministic per outDir — fresh directories always return `base`, matching
 * the invariant the adapter's public tests assert. Atomic only against
 * same-process callers; concurrent writers racing into the same directory
 * are outside this helper's guarantee.
 *
 * @param {string} base Sanitised slug from {@link slugify}.
 * @param {string} outDir Target directory (already created).
 * @param {(path: string) => Promise<void>} access Node `fs/promises.access`.
 * @param {(...parts: string[]) => string} join Node `path.join`.
 * @returns {Promise<string>}
 */
async function resolveFreeBase(base, outDir, access, join) {
  for (let n = 1; n <= MAX_COLLISION_ATTEMPTS; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    const paths = [
      join(outDir, `${candidate}-extracted.json`),
      join(outDir, `${candidate}-thumbnail.png`),
      join(outDir, 'textures', candidate),
    ]
    let free = true
    for (const p of paths) {
      try {
        await access(p)
        free = false
        break
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    }
    if (free) return candidate
  }
  throw new Error(
    `toFilesystem: could not find a free output slot for slug "${base}" in ${outDir} ` +
    `after ${MAX_COLLISION_ATTEMPTS} attempts. Clean the directory or pick a different slug source.`
  )
}

/**
 * Allowlist-driven serialiser for the on-disk JSON written by {@link toFilesystem}.
 *
 * Every property of {@link import('../../index.d.ts').ProcessResult} is named
 * here explicitly. Binary-bearing fields (`png.bytes`, `textures[].bytes`) are
 * stripped because the bytes are persisted as sibling files. `subShaderColors`
 * is converted from `Map` to a plain object so JSON.stringify emits a useful
 * representation instead of `{}`.
 *
 * Adding a new field to `ProcessResult` requires adding it here as a deliberate
 * decision — unknown fields on the input object are silently ignored rather
 * than passed through blindly.
 *
 * @param {import('../../index.d.ts').ProcessResult} result
 * @returns {object} A plain object safe to pass to `JSON.stringify`.
 */
export function serialiseResult(result) {
  return {
    meta: result.meta,
    materialName: result.materialName,
    shaderType: result.shaderType,
    png: result.png
      ? {
          size: result.png.size,
          startOffset: result.png.startOffset,
          endOffset: result.png.endOffset,
        }
      : null,
    rawParameters: result.rawParameters,
    subShaderColors: Object.fromEntries(result.subShaderColors),
    materialDefinition: result.materialDefinition,
    warnings: result.warnings,
    coverage: result.coverage,
    paramHexDump: result.paramHexDump,
    tailHexDump: result.tailHexDump,
    textures: result.textures.map((t) => ({
      path: t.path,
      byteLength: t.byteLength,
      extension: t.extension,
    })),
    xmlConfig: result.xmlConfig,
  }
}

// Upper bound for the slug itself (excluding the `-extracted.json` /
// `-thumbnail.png` suffix added by callers). 80 bytes leaves ≥160 bytes
// of headroom under the 255-byte per-component limit enforced by ext4,
// APFS, and NTFS for the longest suffix we append.
const MAX_SLUG_BYTES = 80

// When we have to append a hash, it's 8 hex chars prefixed by a dash, so
// the readable prefix must fit in MAX_SLUG_BYTES - 9 bytes.
const HASH_SUFFIX_BYTES = 9

/**
 * Derive an on-disk filename stem from an arbitrary material / MTL name.
 *
 * Guarantees:
 *   - Output is non-empty (pure-CJK, pure-symbol, or empty input → 8-char hash).
 *   - Output is ≤ MAX_SLUG_BYTES UTF-8 bytes (oversized input → truncated
 *     readable prefix joined to an 8-char hash of the full input).
 *   - Output is pure ASCII `[a-z0-9-]`, safe for every POSIX and Windows
 *     filesystem, every S3 key, and every URL path segment.
 *   - Deterministic: same input → same output across runs.
 *   - Collision-resistant: any input that would otherwise collide with
 *     another (empty-after-filter, or sharing an 80-byte prefix) gets the
 *     SHA-1 hash of the *original* input appended, so two distinct inputs
 *     cannot produce the same slug.
 *
 * Latin-script diacritics are transliterated via NFKD decomposition +
 * combining-mark stripping (`Café` → `cafe`, `Noño` → `nono`) so the
 * readable portion is preserved for the common case.
 *
 * @param {string} s Source material name or MTL filename stem.
 * @param {(algorithm: string) => import('node:crypto').Hash} createHash
 *   Node `crypto.createHash` factory, passed in so this module stays
 *   loadable in non-Node environments (browser bundlers).
 * @returns {string}
 */
function slugify(s, createHash) {
  const input = String(s ?? '')
  const ascii = input
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii !== '' && ascii.length <= MAX_SLUG_BYTES) return ascii
  const hash = createHash('sha1').update(input, 'utf8').digest('hex').slice(0, 8)
  if (ascii === '') return hash
  const prefix = ascii.slice(0, MAX_SLUG_BYTES - HASH_SUFFIX_BYTES).replace(/-+$/g, '')
  return prefix === '' ? hash : `${prefix}-${hash}`
}
