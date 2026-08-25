import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('app/shared'), '@main': resolve('app/main') }
  },
  test: {
    projects: [
      {
        resolve: {
          alias: { '@shared': resolve('app/shared'), '@main': resolve('app/main') }
        },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        resolve: {
          alias: { '@shared': resolve('app/shared'), '@main': resolve('app/main') }
        },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // Real network: DHT bootstrap + tracker announce + peer handshake.
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false
        }
      }
    ]
  }
})
