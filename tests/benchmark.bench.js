import { bench } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { process } from '../src/index.js'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

for (const f of [
  'paint-metallic-sienna-gold.kmp',
  'toon-fill-black-bright.kmp',
  'translucent-candle-wax.kmp',
]) {
  const bytes = new Uint8Array(readFileSync(join(KMP_DIR, f)))
  bench(`process() — ${f}`, async () => {
    await process(bytes, { includeHexDump: false, includeCoverage: false })
  }, { iterations: 100, warmupIterations: 5 })
}
