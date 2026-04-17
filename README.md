# kmp-three-suite

Luxion KeyShot `.kmp` / `.mtl` material parser → Three.js-ready `MaterialDefinition` JSON. Isomorphic (Node 20+ and modern browsers), ESM-only, 22 KB gzipped browser bundle.

**Status:** implementing SPEC-09 against reference fixtures.
**Spec:** [`../docs/specs/SPEC-09-kmp-three-suite.md`](../docs/specs/SPEC-09-kmp-three-suite.md).
**Plan:** [`../docs/plans/2026-04-16-kmp-three-suite-implementation.md`](../docs/plans/2026-04-16-kmp-three-suite-implementation.md).

## Install

```sh
npm install kmp-three-suite
```

## Quick start

```javascript
import { process } from 'kmp-three-suite'

const results = await process('./materials/my-material.kmp')
for (const r of results) {
  console.log(r.shaderType, r.materialName)
  console.log(r.materialDefinition) // ready for THREE.MeshPhysicalMaterial
}
```

`process()` accepts five input forms — file path string (Node), `Uint8Array`, `ArrayBuffer`, `Buffer` (Node), and `File` / `Blob` (browser). It returns an array because a single `.kmp` may contain multiple `.mtl` materials.

## API

### `process(input, options?)` → `Promise<ProcessResult[]>`

Primary entry. Returns one record per MTL in the archive:

```javascript
{
  meta: { sourceFile, mtlFile, mtlSize, paramSectionOffset, …, keyshotVersion },
  materialName: string | null,
  shaderType: 'lux_toon' | 'metallic_paint' | 'lux_translucent' | …,
  png: { bytes: Uint8Array, size, startOffset, endOffset } | null,
  rawParameters: RawParam[],          // every TLV decoded
  subShaderColors: Map<slot, {r,g,b}>, // lux_const_color_extended blocks
  materialDefinition: MaterialDefinition, // the 60+ field Three.js-shaped object
  warnings: string[],                 // unmapped param names, etc.
  coverage: { claimedBytes, totalBytes, unclaimedBytes },
  paramHexDump: string[],
  tailHexDump: string[],
  textures: TextureEntry[],           // every .png/.jpg/.exr/… in the archive
  xmlConfig: { shaderHint, renderHints } | null,
}
```

Options:

- `includeHexDump` (default `true`) — emit `paramHexDump` / `tailHexDump`.
- `includeCoverage` (default `true`) — emit `coverage` analysis.
- `maxArchiveSize` (default `256 * 1024 * 1024`) — zip-bomb cap.

### Low-level entries

- `extractKmp(input, options)` — archive unpack only.
- `extractMtl(mtlBuf)` — given the raw MTL bytes.
- `parseParamSection(buf, view, start, end)` — TLV scanner only.
- `buildMaterialDefinition(rawParams, shaderType, subShaderColors)` — mapping only.

### Output adapters

```javascript
import { toFilesystem, toMaterialDefinitionOnly } from 'kmp-three-suite'

// Write a material + thumbnail + textures to disk (Node only):
await toFilesystem(result, './output-dir')

// Just the MaterialDefinition (drops raw params, hex dumps, coverage):
const md = toMaterialDefinitionOnly(result)
```

## Binary format reference

The `.kmp` archive contains a binary `.mtl` with a TLV parameter section:

| Marker | Type     | Bytes after marker |
|--------|----------|--------------------|
| `0x17` | FLOAT    | sub_id(1) + f32le(4) |
| `0x27` | COLOR    | sub_id(1) + r/g/b f32le (12) |
| `0x1d` | INT      | sub_id(1) + u32le(4) |
| `0x25` | BOOL     | sub_id(1) + u32le(4) |
| `0x9b` | TEXSLOT  | sub_id(1) + slot_u32le(4) |
| `0xa1` | SUB-SHADER REF | sub_id(1) |

`0x27` and `0x25` are printable ASCII (`'` and `%`), so the parser validates context (printable-before, non-printable sub_id, finite floats for COLOR) and runs a name-first fallback for well-known boolean params.

Full evidence: see the cited file:line references inside `src/**/*.js`.

## Supported shader types

30+ variants mapped in `src/lux/lux-extraction.js`: `lux_toon` / `toon`, `metallic_paint` / `car_paint`, `lux_translucent` / `sss`, `lux_glass` / `lux_liquid`, `lux_dielectric`, `lux_metal` / `lux_brushed_metal`, `lux_plastic` / `lux_plastic_cloudy` / `lux_plastic_transparent`, `lux_velvet` / `lux_fabric` / `lux_cloth`, `lux_gem` / `lux_diamond`, `lux_thin_film`, `lux_anisotropic`, `lux_multi_layer`, `lux_advanced`, `lux_generic`, `lux_emissive`, `lux_flat`, `lux_matte`, `lux_diffuse`, `lux_glossy`, `lux_rubber` / `lux_silicone`, `lux_ceramic` / `lux_porcelain`, `lux_leather`, `lux_measured`, `lux_xray`, `lux_wireframe`, `lux_skin`, `lux_cutaway`, `lux_translucent_medium`, `lux_scattering_medium`.

## Security

- **Zip-slip:** entries with `..` path components or absolute paths are rejected (`safeExtract`).
- **Zip-bomb:** cumulative decompressed size capped at 256 MB by default (configurable).
- **No eval, no native code, no network I/O.** The only runtime dependency is `fflate`.
- `npm audit --audit-level=high` must remain clean.

## Running tests

```sh
npm test              # full vitest suite (443 tests across 29 files)
npm run bench         # performance benchmark
npm run build         # browser bundle to dist/
npx playwright test   # Chromium smoke test of process(Uint8Array) in-browser
BENCH_STRICT=1 npm test   # enforce per-file p95 budgets (below) at ×3 tolerance
```

## Performance

On Node 24 / M2 MacBook, p95 per `.kmp`:

- `paint-metallic-sienna-gold.kmp` (108 KB): ~0.6 ms
- `toon-fill-black-bright.kmp` (20 KB): ~0.4 ms
- `translucent-candle-wax.kmp` (278 KB): ~2.7 ms

These targets are tracked as `README_TARGETS_MS` in `tests/benchmark.perf.test.js`;
default runs enforce a 10 ms loose guardrail, and `BENCH_STRICT=1` asserts each
target × 3 as a strict regression gate.

## License

MIT.
