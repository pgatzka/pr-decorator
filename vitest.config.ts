import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Globals are on so tsconfig's `types: ["vitest/globals"]` types the suite.
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
