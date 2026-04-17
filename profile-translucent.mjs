import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { unzipSync as fflateUnzip } from 'fflate'
import { process as kmpProcess } from '/Users/ryanoboyle/defcad-file-browser/kmp-three-suite/src/pipeline/process.js'
import { extractKmp } from '/Users/ryanoboyle/defcad-file-browser/kmp-three-suite/src/kmp/kmp-extraction.js'
import { unzipArchive, safeExtract, enumerateEntries } from '/Users/ryanoboyle/defcad-file-browser/kmp-three-suite/src/binary-tools/binary-tools.js'
import { extractMtl } from '/Users/ryanoboyle/defcad-file-browser/kmp-three-suite/src/mtl/mtl-extraction.js'

const KMP_BYTES = new Uint8Array(readFileSync('/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp/translucent-candle-wax.kmp'))
const OPTS = { includeHexDump: false, includeCoverage: false }

async function measureAsync(label, fn) {
  for (let i = 0; i < 50; i++) await fn()
  const N = 500
  const samples = new Array(N)
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    await fn()
    samples[i] = performance.now() - t0
  }
  samples.sort((a, b) => a - b)
  const p = (q) => samples[Math.floor(N * q)]
  const mean = samples.reduce((s, v) => s + v, 0) / N
  console.log(`${label.padEnd(34)}  p50=${p(0.50).toFixed(3)}  p95=${p(0.95).toFixed(3)}  p99=${p(0.99).toFixed(3)}  mean=${mean.toFixed(3)}`)
}

function measureSync(label, fn) {
  for (let i = 0; i < 50; i++) fn()
  const N = 500
  const samples = new Array(N)
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    fn()
    samples[i] = performance.now() - t0
  }
  samples.sort((a, b) => a - b)
  const p = (q) => samples[Math.floor(N * q)]
  const mean = samples.reduce((s, v) => s + v, 0) / N
  console.log(`${label.padEnd(34)}  p50=${p(0.50).toFixed(3)}  p95=${p(0.95).toFixed(3)}  p99=${p(0.99).toFixed(3)}  mean=${mean.toFixed(3)}`)
}

// Measure full pipeline first so allocation pattern mirrors real usage
await measureAsync('await kmpProcess()', () => kmpProcess(KMP_BYTES, OPTS))
await measureAsync('await extractKmp()', () => extractKmp(KMP_BYTES, OPTS))
measureSync('fflate unzipSync (bare)', () => fflateUnzip(KMP_BYTES))
measureSync('unzipArchive wrapper', () => unzipArchive(KMP_BYTES))
measureSync('unzipArchive + safeExtract', () => safeExtract(unzipArchive(KMP_BYTES)))
measureSync('unzip+safe+enumerate', () => { const a = safeExtract(unzipArchive(KMP_BYTES)); enumerateEntries(a) })

const archive = safeExtract(unzipArchive(KMP_BYTES))
const mtlBuf = archive.get('Translucent Candle Wax #3.mtl')
measureSync('extractMtl (pre-unzipped)', () => extractMtl(mtlBuf))
