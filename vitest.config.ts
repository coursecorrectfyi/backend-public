import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    // Every external dependency is faked in test/setup.ts. These values only
    // satisfy the code's "is it configured?" checks and are never used to
    // reach a real service.
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-jwt-secret',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/not-used-by-tests',
      GOOGLE_CLOUD_PROJECT: 'test-project',
      ALLOWED_ORIGINS: 'http://localhost:3001',
    },
    unstubEnvs: true,
    unstubGlobals: true,
    // Each test file starts its own in-process Postgres (PGlite) from a snapshot (~1s).
    hookTimeout: 60_000,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/index.ts', 'src/api/**/*.ts', 'src/lib/embedding/**/*.ts', 'src/lib/ids.ts'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
})
