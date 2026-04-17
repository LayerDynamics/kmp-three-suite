import { nodeResolve } from '@rollup/plugin-node-resolve'

// Drop `/** … */` blocks so public-export JSDoc (kept in src/ for IDE hover
// and plain-JS consumers that import from src/index.js) does not bloat the
// browser bundle. Newlines inside each stripped block are preserved so the
// emitted sourcemap still lines up with src/.
const stripJsDoc = {
  name: 'strip-jsdoc',
  transform(code) {
    if (!code.includes('/**')) return null
    const stripped = code.replace(/\/\*\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    return { code: stripped, map: null }
  },
}

export default {
  input: 'src/index.js',
  output: {
    file: 'dist/kmp-three-suite.browser.mjs',
    format: 'esm',
    sourcemap: true,
  },
  external: [
    'node:fs', 'node:fs/promises', 'node:path', 'node:url',
    'node:os', 'node:child_process', 'node:buffer', 'node:zlib',
  ],
  plugins: [stripJsDoc, nodeResolve({ browser: true })],
  treeshake: { moduleSideEffects: false },
}
