import { nodeResolve } from '@rollup/plugin-node-resolve'

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
  plugins: [nodeResolve({ browser: true })],
  treeshake: { moduleSideEffects: false },
}
