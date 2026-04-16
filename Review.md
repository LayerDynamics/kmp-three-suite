# Code Review: kmp-three-suite

**Date:** 2026-04-16
**Scope:** `kmp-three-suite/src/**/*.js`, `index.d.ts`, `tests/**`, `README.md`, `package.json`
**Method:** Three parallel review agents (quality+architecture, security+performance, testing+docs) + synthesis.

## Summary

Clean, well-layered parser library with extensive reference citations, dedicated security tests, and golden-file parity. Three categories of Critical findings: binary-parsing correctness (sub-shader inner-marker validation missing, PNG boundary calculation off-by-4, footer scanner can hang on `;`), security/DoS (zip-bomb cap runs AFTER full decompression, unicode/NUL zip-slip bypass, prototype-pollution in XML config), and API/contract drift (6 exports missing from `.d.ts`, contract test regex-only never imports). Rest is polish — function size, magic numbers, JSDoc gaps, 28 untested shader-type branches.

## Findings

### Critical

- **Zip-bomb cap runs after full decompression** (`src/binary-tools/decompression-tools.js:22-28, 44-57`) — `unzipSync` inflates every entry into memory *before* `safeExtract` runs the 256 MB cap. A 1 KB archive with 100 000:1 compression ratio OOMs the process before any check. The cap only prevents downstream iteration of oversized content; it does nothing to protect peak memory. Fix: gate on the central-directory uncompressed sizes before `unzipSync`, or use fflate's streaming `Unzip` API with running byte counts.

- **Prototype pollution via `parseXmlConfig`** (`src/kmp/kmp-param-parser.js:9-12`) — `renderHints = {}` (plain object) followed by `renderHints[k] = v` where `k` is attacker-controlled from the XML manifest. `<cfg __proto__="x" constructor="y">` can break downstream serialisation; `renderHints.constructor = "..."` corrupts `JSON.stringify` paths. Fix: `renderHints = Object.create(null)` and skip `__proto__|prototype|constructor` keys.

- **Zip-slip bypass via unicode slashes / NUL bytes** (`src/binary-tools/decompression-tools.js:44-57`) — Segment check catches literal `..` and `/` but not `\uff0f` (fullwidth solidus), `\u2215` (division slash), `\u29f8` (big solidus), NUL-byte injection, or URL-encoded `..%2f`. fflate returns raw UTF-8 / CP437 bytes. Fix: normalise the path, resolve it against a sentinel root, reject if it escapes, and strip / reject NUL bytes and unicode slash variants.

- **Sub-shader scanner: false positives + bogus `subId`** (`src/mtl/mtl-extraction.js:130-143`) — Comment declares the block header is `0x89 0x00 0x9d 0x00` followed by `0x39 0x04` at bytes 4–5 and the `0x23 0xf9 0x8b 0x29 0x15` marker at bytes 7–11. Code only checks the first four bytes, so any coincidental `89 00 9d 00` followed by 3 plausible floats is accepted. Worse, `subId = buf[pos + 2]` re-reads the literal `0x9d` from the header — not a real sub-id. Downstream, `lux-extraction.js:501-504` falls back to the first colorSlot for SSS, so a false positive silently corrupts `sssParams.subsurfaceColor`.

- **`extractMaterialName` pattern-3 can hang on a `;` byte** (`src/mtl/mtl-extraction.js:85-95`) — `isPrintableByte(0x3b) === true`, so the outer `if` re-enters on `;`; the inner `while` exits immediately on `buf[i] === 0x3b`; `s === i` → empty candidate → fallthrough without advancing `i`. Any MTL with a semicolon inside the fallback-scanned region loops. Add a terminator increment to the empty-candidate path and align `isPrintableByte` with an explicit `isNameByte` excluding `;`.

- **PNG bounds are 4 bytes short and scan from the wrong offset** (`src/binary-tools/param-finder.js:21-28`) — `findSequence(buf, PNG_IEND, s)` starts at the magic offset, so `"IEND"` appearing inside the header region (before the real PNG) would match first. `end = i + 4 + 4` covers IEND marker + its own 4-byte CRC but skips the trailing chunk CRC, producing a file strict decoders reject. Fix: start IEND scan at `s + 8`, and compute `end = i + 4 + 4 + 4` (length prefix + `IEND` + CRC32) or locate the real chunk boundary.

- **Contract test is regex-only — never imports runtime** (`tests/contract.test.js:15-29`) — Every assertion matches against the raw `.d.ts` string. A refactor that deletes `export { process }` from `src/index.js` while leaving `index.d.ts` intact passes. The regex `export\s+…\s+(function|const|class|namespace|interface|type)\s+${name}` also accepts the wrong kind (e.g. `interface process` satisfies the `process` test). Import `* as lib from '../src/index.js'` and assert `typeof lib[name]`.

- **Six public exports missing from `index.d.ts`** (`src/index.js:6-13` vs `index.d.ts`) — `MTL_KNOWN_SHADER_TYPES`, `KNOWN_BOOL_PARAM_NAMES`, `autoAssignTextures`, `parseXmlConfig`, `TEXTURE_SLOT_KEYWORDS`, `TEXTURE_EXTENSIONS` are re-exported but not declared. TypeScript consumers get `TS2305` on any of these. The contract test omits all six, so the gap is invisible in CI.

- **Bounds off-by-one inconsistency across three call sites** (`src/mtl/mtl-param-parser.js:113-169` vs `src/binary-tools/validator.js:22-37`) — `scanMarkers` enqueues on `m + 5 < end`, the validators check `pos + 5 >= end → reject`, and `readValue` uses `pos + 6 > end → reject`. At the boundary where the 5-byte value is flush with EOF, float/int get accepted by the scanner but bool/texslot drop silently. Introduce a single `fitsValue(pos, size, end)` helper.

### High

- **`shaderTypeOverrides` declared in public contract but never wired up** (`index.d.ts:237` vs `src/lux/lux-extraction.js:67-88`) — `ProcessOptions.shaderTypeOverrides` is advertised; `buildMaterialDefinition` takes only `(rawParams, shaderType, subShaderColors)` and `process.js:21-23` never threads options through. Silent no-op. Either implement or delete from `.d.ts`.

- **`applyShaderTypeMapping` is a 420-line if/else ladder with implicit precedence and brittle substring matching** (`src/lux/lux-extraction.js:322-742`) — ~35 `type.includes(...)` branches; `metal` branch uses `!type.includes('lic')` to avoid `metallic_paint` — any future shader name containing "lic" is excluded from the metal branch. Every branch hand-constructs `mat.kmpShaderType`. Replace with table-driven dispatch `{ matcher, apply, canonical }[]`, first-match-wins. That also lets `shaderTypeOverrides` be wired trivially.

- **28 of 30+ shader-type branches have no dedicated test** (`src/lux/lux-extraction.js`) — Only toon, metallic_paint, translucent, glass/liquid, metal, plastic variants, velvet, gem/diamond, and anisotropic are tested. Missing: `dielectric`, `plain plastic`, `brushed_metal`, `paint` (non-metal), `thin_film`, `multi_layer`, `generic`, `advanced`, `emissive`, `flat`, `matte`, `diffuse`, `glossy`, `rubber`/`silicone`, `ceramic`/`porcelain`, `leather`, `measured`, `xray`, `wireframe`, `skin`, `cutaway`, `translucent_medium`, `scattering_medium`. A `kmpShaderType = 'lux_ceremic'` typo would sail through CI.

- **Order-dependency in shader-type branches is untested** (`src/lux/lux-extraction.js:467, 576, 613, 679, 698`) — `lux_translucent_medium` must hit the combined `translucent && medium` branch *before* plain `translucent`. Re-ordering silently regresses semantics. Add explicit "does NOT fall into plain branch" tests.

- **`_buf` is a private field smuggled through the public return type** (`src/mtl/mtl-extraction.js:49`, `src/pipeline/process.js:27`) — Leading-underscore convention isn't enforced. Not declared in `index.d.ts`'s `MtlExtraction`. Every MTL extraction retains a full buffer copy, so multi-MTL archives keep `N × mtlSize` in memory. Either rename to a documented `source` field or scope the buffer to a closure in `process.js`.

- **`MaterialDefinition` declared shape partially drifts from the factory** (`index.d.ts:90-157` vs `src/lux/lux.schema.js:14-40`) — Audit confirms the factory currently emits every declared key, but CI should programmatically diff the two to prevent a future mismatch. The `side: 'front'|'back'|'double'` literal is the most likely future break — any typo inside a shader-type branch would pass `.d.ts` but mis-configure Three.js.

- **Pass-2 name-first fallback: O(n·k) string scan + full Latin-1 decode** (`src/mtl/mtl-param-parser.js:82-108`) — Decodes the entire param section to a JS string, then runs `indexOf` for each of 10 known bool names. For a 256 MB param section that's ~2.5 GB of scanning + a 256 MB string allocation. Integrate into Pass-1 marker scan with pre-encoded byte needles.

- **`readName`, `readAscii`, coverage-run accumulator all use quadratic `str += String.fromCharCode(b)`** (`src/mtl/mtl-param-parser.js:137-139`, `src/binary-tools/decoder.js:9-24`, `src/pipeline/process.js:90-101`) — On large buffers this allocates many intermediate strings. Use cached `new TextDecoder('latin1', { fatal: false })` at module scope and slice-decode.

- **`new DataView(...)` constructed per validator call** (`src/binary-tools/validator.js:15`) — `isValidColorMarker` creates a fresh DataView on every 0x27 byte in a full-buffer scan. Thread the caller's DataView through.

- **Coverage uses a `Set<number>` over every byte → O(paramSize) Set entries** (`src/pipeline/process.js:78, 86`) — 256 MB × ~40-byte V8 Set-entry overhead = ~10 GB. DoS-adjacent when `includeCoverage` defaults to true. Use a `Uint8Array` bitmap.

- **`applyGenericMapping` is 223 lines with ~25 independent concerns in one function** (`src/lux/lux-extraction.js:94-316`) — Violates single-responsibility; prevents unit-level test targeting (you can't test the clearcoat block without running everything else). Split into named helpers: `mapBaseColor`, `mapPbrScalars`, `mapClearcoat`, `mapIridescence`, `mapAnisotropy`, `mapAttenuation`, `mapMisc`. Also exposes several untested branches: `colorFilter`, `diffuseSaturation`, `backscatter`, `ambient`, `edginess`, `fresnel`, `refractive_index_outside`, `transmissionOut`.

- **`KNOWN_SHADER_TYPES` duplicated** (`src/lux/lux.schema.js:5-11` and `src/mtl/mtl-extraction.js:10-16`) — Identical 20-element frozen arrays exported twice. Re-exported as `KNOWN_SHADER_TYPES` and `MTL_KNOWN_SHADER_TYPES` from `index.js`. They can and will diverge.

- **Metallic paint branch reads every param twice** (`src/lux/lux-extraction.js:394-452`) — `metalCoverage`, `metal_roughness`, `metal_flake_visibility` each fetched twice; variable names `metalCoverageVal`, `flakeVisIntAgain` literally name the duplication. Extract locals at the top of the branch.

- **`getFloat('angle')` invoked twice in the anisotropic branch** (`src/lux/lux-extraction.js:641`) — `getFloat('angle') !== null ? (getFloat('angle') * Math.PI) / 180 : 0`. Idempotent today, fragile tomorrow.

- **Benchmark only measures, never asserts p95** (`tests/benchmark.bench.js:14-16`) — README quotes 0.4 / 0.6 / 2.7 ms p95; a 10× regression passes silently. Convert to a plain test that computes p95 and asserts `< 10 ms` with headroom, or gate a strict threshold behind an env var.

- **No fuzz tests for a binary parser consuming untrusted input** (`tests/**`) — Random-buffer `extractMtl` / `process` calls that assert "either succeeds or throws `KmpParseError`, never panics" would catch every OOB, infinite-loop, and pathological-input bug in this review at once.

- **Browser smoke test covers only the toon happy path** (`tests/browser/smoke.spec.js:7-40`) — Does not exercise the other two canonical fixtures (metallic_paint, translucent), error paths (`BAD_ZIP`, `NO_MTL`), or texture flow.

- **XML config parser has no malformed-input tests** (`tests/kmp/kmp-param-parser.test.js:5-19`) — Missing coverage for XML comments containing `shader=`, repeated `shader=` attributes, entity references inside values, nested elements. Given the input is attacker-controllable, this is security-relevant.

- **`tests/unzip-parity.test.js` hard-depends on system `unzip`** (`tests/unzip-parity.test.js:22-33`) — Silently fails on containers that strip `unzip`. Guard with `try { execSync('which unzip') } catch { it.skip(...) }`.

- **Public exports have no JSDoc** — Every `export function` in `src/lux/*.js`, `src/mtl/*.js`, `src/kmp/*.js`, `src/pipeline/*.js`, `src/binary-tools/*.js` is undocumented at runtime. TypeScript consumers see `.d.ts` hover info; plain-JS consumers get nothing. Minimum: `process`, `extractKmp`, `extractMtl`, `buildMaterialDefinition`, `makeAccessors`, `safeExtract`, `KmpParseError`.

### Medium

- **Layering violation: `binary-tools` imports from `pipeline`** (`src/binary-tools/decompression-tools.js:6`) — Even though the split exists to break a cycle, `binary-tools` is advertised as the lowest layer. Move `KmpParseError` to a package-root `src/errors.js`.

- **`findSubShaderRegion` first-match-wins and returns null instead of trying next candidate** (`src/binary-tools/param-finder.js:59-79`) — If the first matched shader-type string fails the header-distance heuristic, it returns `null` without looking for other known types.

- **`parseXmlConfig` is regex, not XML; attacker-controlled input accepted without length cap** (`src/kmp/kmp-param-parser.js:5-13`) — ReDoS-adjacent on large adversarial XMLs (up to 256 MB under current cap). Cap at 1 MB.

- **`autoAssignTextures` matches only the basename** (`src/kmp/kmp-param-parser.js:17`) — `textures/normal/base_color.png` routes to `normalMap` because only `base_color.png` is tested. Low impact but document the decision or consider full-path matching.

- **`readFileSync` in an async function stalls the event loop** (`src/kmp/kmp-extraction.js:28-31`) — For a 50 MB file, hundreds of ms of blocking. Use `await import('node:fs/promises')` and `readFile` instead, matching the pattern already used in `target.js`.

- **`toFilesystem` `JSON.parse(JSON.stringify)` silently drops every `Uint8Array`** (`src/pipeline/target.js:23-27`) — Future additions to `ProcessResult` disappear from the JSON without warning. Replace with an allowlist-driven serialiser.

- **`slugify` has no collision handling or length cap** (`src/pipeline/target.js:45-49`) — Non-ASCII names collapse to `""`, producing `-extracted.json` collisions. Long names exceed 255-byte filesystem limits. Fall back to a hash.

- **`pipeline/target.js` `toFilesystem` does not handle two materials that slugify to the same name** — Silent overwrite.

- **`textures` and `xmlConfig` references shared across multi-MTL `ProcessResult[]`** (`src/kmp/kmp-extraction.js:22`, `src/pipeline/process.js:70`) — Works today because neither is mutated post-construction, but no test asserts this invariant.

- **`MAPPED_KEYS` contains `'color'` which also appears in `STRUCTURAL_KEYS`** (`src/lux/lux-extraction.js:40, 64`) — Redundant and confusing; either is sufficient.

- **Pass 3 runs before Pass 2 despite code comments** (`src/mtl/mtl-param-parser.js:36-108`) — Comment numbering doesn't match execution order. Re-number or reorder.

- **`scanMarkers` applies zero context validation to FLOAT/INT markers** (`src/mtl/mtl-param-parser.js:117-120`) — `0x17`/`0x1d` are non-printable but appear in random bytes. Currently relies on name cleanup + sequential walk to filter. A printable-byte-before guard would reduce false positives.

- **`TextDecoder('latin1')` instantiated per call** (`src/binary-tools/param-finder.js:60`, `src/mtl/mtl-param-parser.js:82`) — Cache at module scope.

- **`new TextEncoder().encode('attribute')` inside `extractMaterialName`** (`src/mtl/mtl-extraction.js:60`) — Hoist to module-level `const`.

- **Duplicate `findSub`** (`src/mtl/mtl-extraction.js:100-107`) — Identical to `findSequence`; import and reuse.

- **`TEXTURE_EXTS` duplicated in two modules, one `Object.freeze`d incorrectly** (`src/binary-tools/decompression-tools.js:8`, `src/kmp/kmp.schema.js:3-5`) — `Object.freeze(new Set(...))` is a no-op on a Set's entries. Deduplicate and drop the misleading freeze.

- **Error messages echo attacker-controlled paths/sizes into logs** (`src/binary-tools/decompression-tools.js:25, 51, 55`) — Consider sanitising for consumer logging pipelines.

- **`KmpParseError` never propagates `cause`** (`src/pipeline/errors.js:5-12`) — `new KmpParseError(code, msg)` drops the underlying fflate stack. Use `super(message, { cause: e })`.

- **`index.d.ts` `extractKmp` reuses `ProcessOptions`** (`index.d.ts:258`) — But `includeHexDump`/`includeCoverage`/`shaderTypeOverrides` only matter for `process()`. Introduce a narrower `ExtractOptions`.

- **`BAD_TLV` is declared in the error-code union but never thrown anywhere in `src/`** (`src/pipeline/errors.js:5`, `index.d.ts:252`) — Either remove from the union or wire `parseParamSection` to throw it on genuinely malformed TLVs.

### Low

- **Unused `readF32LE` import** (`src/mtl/mtl-extraction.js:6`).
- **`view` parameter redundant in `parseParamSection`** (`src/mtl/mtl-param-parser.js:28`).
- **`TYPE_SUBSHADER_REF = 0xa1`** defined but never referenced (`src/mtl/mtl.schema.js:9`).
- **`applyPostMapping` accepts third arg at call site but signature has two** (`src/lux/lux-extraction.js:75, 748`).
- **`binary-tools.js` facade lacks the evidence-comment header every other file has** (`src/binary-tools/binary-tools.js`).
- **`package.json` `"types"` + `exports['.'].types` redundant** — both set; older tooling fallback vs modern resolver.
- **README performance numbers aren't grounded by an assertion** (`README.md:115-122`).
- **README "217+ tests" is stale** — count is 227 (`README.md:108-113`).
- **`tests/package.test.js`** doesn't assert absence of a `.require` export path.
- **No assertion that `new KmpParseError('NO_MTL','x').offset === undefined`** vs `'offset' in …` semantics.
- **`linearToSrgb`/`srgbToLinear`/`rgbToHex`/`componentsToHex` expose two colour-encoding paths** that look similar — callers must know which to use.

## Strengths

- **Layered architecture is clean and religiously honoured** — `binary-tools → mtl → lux → kmp → pipeline`. The one inversion (`decompression-tools` importing from `pipeline/errors.js`) is explicitly acknowledged in a comment.
- **Evidence-anchored comments on nearly every module** — `// Evidence: kmp-pipeline.mjs:630-852.` style citations make every parser decision traceable to the reference implementation. Exceptionally rare in ported-parser codebases.
- **Security-first ZIP handling with dedicated tests** — `safeExtract` implements zip-slip + zip-bomb guards; `tests/security/zip-slip.test.js` + `tests/security/zip-bomb.test.js` gate them.
- **Typed error taxonomy with `KmpParseError` + discriminated `code`** — small, well-scoped, programmatically branchable.
- **Isomorphic input handling** — `resolveInput` accepts `string | Uint8Array | ArrayBuffer | Buffer | Blob` and dynamically imports `node:fs` only when needed, keeping the browser bundle clean.
- **Accessor design** — `makeAccessors` exposes 8 overloaded getters with clean type-coercion semantics ideal for a format with many aliases.
- **Frozen constants across schemas** — prevents accidental mutation by downstream callers.
- **Hand-written `.d.ts`** — right tradeoff for a mixed JS/TS library; the `RawParam` discriminated union is nicely encoded.
- **Full piecewise sRGB transfer function** — correct encoding (not the `pow(x, 2.2)` shortcut) matches Three.js's `SRGBColorSpace`.
- **Pipeline is pure orchestration** — `process.js` is 104 lines of compose-and-dispatch, no parsing logic.
- **Coverage analysis is a shipped artefact** — machine-readable claimed/total bytes + unclaimed printable runs with hex offsets. This is exactly the right instrumentation for a parser-in-development.
- **Output adapters are small and composable** — `toMemory` / `toFilesystem` / `toMaterialDefinitionOnly` cleanly separate "give me data" from "where does it go".
- **Single runtime dep (`fflate`)** — minimal supply-chain surface; makes the 30 KB gzipped bundle target realistic (actual 22 KB).
- **No `eval`, `Function` constructor, or dynamic code execution anywhere** — zero runtime-code-injection surface.
- **Golden-file parity + coverage + unzip-parity tests** — three independent invariants give defense-in-depth against regressions.
- **Bundle-size CI gate** — `tests/bundle-size.test.js` catches dependency creep early.
- **Package contract test** — load-bearing for ESM-only distribution guarantees.

## Recommendations (prioritised)

1. **Fix the zip-bomb DoS** — gate on central-directory uncompressed sizes before `unzipSync`, or switch to fflate's streaming API with running byte counts.
2. **Fix the prototype-pollution vector** in `parseXmlConfig` — `Object.create(null)` + skip `__proto__|prototype|constructor`.
3. **Harden `safeExtract`** against unicode slash variants, NUL-byte injection, and URL-encoded `..`.
4. **Fix sub-shader inner-marker validation** — check bytes 4–5 (`0x39 0x04`) and 7–11 (`0x23 0xf9 0x8b 0x29 0x15`) before accepting a block; stop using byte offset 2 as `subId`.
5. **Fix the `;` hang** in `extractMaterialName` pattern-3 with a terminator increment.
6. **Correct `findPngBounds`** — scan IEND from `s + 8`, include the trailing chunk CRC in the slice.
7. **Make the contract test actually import runtime** — assert `typeof lib[name]` for every export, instantiate `KmpParseError`, verify `KNOWN_SHADER_TYPES` is frozen.
8. **Sync `index.d.ts` with `src/index.js`** — declare the six missing exports or remove them from the barrel.
9. **Either implement `shaderTypeOverrides` or delete from the contract** — a silent no-op is the worst option.
10. **Add dedicated tests for the 28 missing shader-type branches** — one `kmpShaderType` assertion + one invariant per branch.
11. **Introduce fuzz tests** — random `Uint8Array` inputs that must either succeed or throw `KmpParseError`. Highest bang-for-buck against the reviewed bugs.
12. **Convert the benchmark into an asserted p95 gate** — `< 10 ms` with CI headroom.
13. **Refactor `applyShaderTypeMapping` into a table-driven dispatcher** — eliminates order-dependency land mines and makes `shaderTypeOverrides` trivial.
14. **Replace coverage `Set<number>` with a `Uint8Array` bitmap** — eliminates the DoS surface under `includeCoverage: true` defaults.
15. **Cache `TextDecoder('latin1')` and `TextEncoder` at module scope** — removes 3 of the hottest allocation hotspots.
16. **Split `applyGenericMapping` into ~8 named helpers** — enables unit-level testing and surfaces the currently-untested edge cases (colorFilter, diffuseSaturation, backscatter, ambient, edginess, fresnel, refractive_index_outside).
17. **Add JSDoc to every public export** — min: `process`, `extractKmp`, `extractMtl`, `buildMaterialDefinition`, `makeAccessors`, `safeExtract`, `KmpParseError`.
18. **Deduplicate `KNOWN_SHADER_TYPES`** — single source in `mtl.schema.js` (or `lux.schema.js`), import into both modules.
19. **Rename `_buf` to a documented public field** or close over it in `process.js`.
20. **Fix `slugify` collisions and length** — hash fallback + 120-char cap.
