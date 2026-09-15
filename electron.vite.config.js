import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // Keeps express/socket.io/electron-store as runtime requires instead of
    // bundling them. socket.io in particular does not survive bundling.
    plugins: [externalizeDepsPlugin()],
    build: {
      // electron-vite leaves minify off by default; the shipped binary has no
      // reason to carry unminified source.
      minify: 'esbuild',
      rollupOptions: {
        input: { main: resolve('src/main/main.js') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: { preload: resolve('src/preload/preload.js') },
        // Sandboxed preload scripts cannot be ES modules. Since package.json
        // sets "type": "module", a .js preload would be parsed as ESM and fail
        // to load -- so emit CommonJS with an explicit .cjs extension.
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@assets': resolve('src/assets')
      }
    },
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
