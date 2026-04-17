import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { process as processKmp } from '../src/index.js'

const KMP_DIR = '/Users/ryanoboyle/defcad-file-browser/file-browser-client/public/assets/kmp'

// README-quoted p95 targets on Node 24 / M2 MacBook. Strict mode asserts
// best-p95 < target * STRICT_MULTIPLIER.
const README_TARGETS_MS = {
  'paint-metallic-sienna-gold.kmp': 0.6,
  'toon-fill-black-bright.kmp': 0.4,
  'translucent-candle-wax.kmp': 2.7,
}

const LOOSE_P95_BUDGET_MS = 10
const STRICT_MULTIPLIER = 3

// 500 samples per inner run gives a stable median; 3 outer runs + best-of
// rejects one-off GC/scheduler/thermal tail events. Up to MAX_ATTEMPTS
// retries protect against sustained concurrent-test CPU contention —
// a real 10× regression survives every retry, transient contention does not.
const ITERATIONS = 500
const WARMUP_ITERATIONS = 50
const OUTER_RUNS = 3
const MAX_ATTEMPTS = 3

const STRICT = process.env.BENCH_STRICT === '1'

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) throw new Error('percentile: empty input')
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  return sortedAsc[Math.min(rank, sortedAsc.length) - 1]
}

async function oneRun(bytes) {
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    await processKmp(bytes, { includeHexDump: false, includeCoverage: false })
  }
  const samples = new Array(ITERATIONS)
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now()
    await processKmp(bytes, { includeHexDump: false, includeCoverage: false })
    samples[i] = performance.now() - t0
  }
  samples.sort((a, b) => a - b)
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    min: samples[0],
    max: samples[samples.length - 1],
    mean: samples.reduce((s, v) => s + v, 0) / samples.length,
  }
}

async function measureBestOfN(bytes) {
  const runs = []
  for (let r = 0; r < OUTER_RUNS; r++) {
    runs.push(await oneRun(bytes))
  }
  const best = runs.reduce((a, b) => (a.p95 <= b.p95 ? a : b))
  return { best, runs }
}

// Gate the measurement: retry the full best-of-N up to MAX_ATTEMPTS times.
// Returns the smallest best-p95 observed across attempts plus diagnostics.
async function measureWithRetry(bytes, budgetMs) {
  const attempts = []
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { best, runs } = await measureBestOfN(bytes)
    attempts.push({ attempt, best, runs })
    if (best.p95 < budgetMs) break
  }
  const overall = attempts.reduce((a, b) => (a.best.p95 <= b.best.p95 ? a : b))
  return { overall, attempts }
}

describe('process() performance regression gate', () => {
  for (const [filename, readmeTargetMs] of Object.entries(README_TARGETS_MS)) {
    const bytes = new Uint8Array(readFileSync(join(KMP_DIR, filename)))
    const strictBudget = readmeTargetMs * STRICT_MULTIPLIER
    const retryBudget = STRICT ? strictBudget : LOOSE_P95_BUDGET_MS

    it(`${filename} — best-p95 < ${LOOSE_P95_BUDGET_MS} ms (loose guardrail)${STRICT ? `, < ${strictBudget.toFixed(2)} ms (strict)` : ''}`, async () => {
      const { overall, attempts } = await measureWithRetry(bytes, retryBudget)
      // eslint-disable-next-line no-console
      console.log(
        `[perf] ${filename}  best-p95=${overall.best.p95.toFixed(3)}ms  attempts=${attempts.length}  `
        + `outer=[${overall.runs.map(r => `p50=${r.p50.toFixed(2)}/p95=${r.p95.toFixed(2)}/p99=${r.p99.toFixed(2)}/mean=${r.mean.toFixed(2)}`).join(' | ')}]`,
      )
      expect(
        overall.best.p95,
        `${filename} best-p95 exceeded ${LOOSE_P95_BUDGET_MS} ms loose regression guardrail after ${attempts.length} attempt(s); `
        + `attempt p95s=[${attempts.map(a => a.best.p95.toFixed(2)).join(', ')}]`,
      ).toBeLessThan(LOOSE_P95_BUDGET_MS)
      if (STRICT) {
        expect(
          overall.best.p95,
          `${filename} best-p95 exceeded ${strictBudget.toFixed(2)} ms strict budget `
          + `(README target ${readmeTargetMs} ms × ${STRICT_MULTIPLIER}) after ${attempts.length} attempt(s); `
          + `attempt p95s=[${attempts.map(a => a.best.p95.toFixed(2)).join(', ')}]`,
        ).toBeLessThan(strictBudget)
      }
    }, 180_000)
  }
})
