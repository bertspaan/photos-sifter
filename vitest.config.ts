import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  resolve: {
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts']
  }
})
