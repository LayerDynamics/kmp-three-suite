import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))

export default {
  testDir: 'tests/browser',
  testMatch: /.*\.spec\.js/,
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: `npx http-server "${ROOT}" -p 4173 --silent -c-1`,
    port: 4173,
    timeout: 30000,
    reuseExistingServer: !process.env.CI,
  },
}
