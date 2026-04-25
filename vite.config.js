import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  let base = '/'
  if (mode === 'desktop') {
    base = './'
  }

  return {
    plugins: [vue()],
    base: base,
    server: {},
    build: {
      copyPublicDir: true,
      minify: false,
    },
    assetsInclude: ['**/*.wasm'],
  }
})