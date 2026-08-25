import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('app/shared')

export default defineConfig({
  main: {
    // WebTorrent and its transitive deps (including the optional native utp-native
    // addon) must NOT be bundled -- they are resolved from node_modules at runtime
    // and shipped as unpacked asar content. See electron-builder.yml `asarUnpack`.
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared, '@main': resolve('app/main') }
    },
    build: {
      outDir: 'out/main',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        input: { main: resolve('app/main/main.ts') },
        output: { format: 'es', entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      outDir: 'out/preload',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        input: { preload: resolve('app/preload/preload.ts') },
        // CommonJS on purpose: the preload runs in a *sandboxed* renderer process,
        // which only supports CJS. Sandbox + contextIsolation is the hardened config.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('app/renderer'),
    plugins: [react()],
    resolve: {
      alias: { '@shared': shared, '@renderer': resolve('app/renderer') }
    },
    build: {
      outDir: 'out/renderer',
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve('app/renderer/index.html') }
      }
    }
  }
})
