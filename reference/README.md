# reference/

These files are the original exploration scripts that informed the design of
`kmp-three-suite`. They are preserved here as **read-only fixtures** — they are
not imported by any module in `src/`, and they must not be re-introduced into
the build or test graph.

| file                     | role                                                   |
|--------------------------|--------------------------------------------------------|
| `kmp-extraction/extract-kmp-exact.mjs`     | Canonical `mapLuxionParamsToMaterial` reference        |
| `kmp-extraction/extract-toon-complete.mjs` | Full-coverage TLV scan + toon param build              |
| `kmp-extraction/kmp-pipeline.mjs`          | End-to-end pipeline (pre-library)                      |
| `kmp-extraction/parse-kmp.mjs`             | First-pass TLV probe (superseded)                      |
| `kmp-extraction/parse-kmp2.mjs`            | Second TLV probe (superseded)                          |
| `kmp-extraction/extract-toon-*.mjs`        | Toon-specific exploration (bools, hex, area scans)     |
| `kmp-extraction/extract-translucent.mjs`   | SSS / sub-shader exploration                           |

If you need to cite behaviour from one of these files, reference the exact
line number inside the generated `src/**/*.js` docstring — never import.

These files depend on the system `unzip` CLI and hard-coded paths into
`file-browser-client/public/assets/kmp/`, so they are not runnable from this
package and will not be published to npm (see `package.json` `files`).
