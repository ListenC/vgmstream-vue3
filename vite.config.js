import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  let base = '/'

  if (mode === 'desktop') {
    base = './'
  }

  // GitHub Pages 自动适配（不影响安卓、网页、桌面）
  if (process.env.GITHUB_PAGES === 'true') {
    base = '/vgmstream-vue3/'
  }

  return {
    plugins: [vue()],
    base: base,
    server: {},
    build: {
      copyPublicDir: true,
      minify: 'terser',  // ✅ 从 false 改为 terser
    },
    assetsInclude: ['**/*.wasm'],
  }
})