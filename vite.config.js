import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  // 为不同模式设置不同的base路径
  let base = '/'
  if (mode === 'desktop') {
    base = './'
  }
  // Android/iOS应用使用根路径
  
  return {
    plugins: [vue()],

    base: base,

    server: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      }
    },

    build: {
      // 确保所有资源都被正确处理
      assetsDir: 'assets',
      copyPublicDir: true,
      rollupOptions: {
        output: {
          // 确保大文件不被分割
          manualChunks: undefined
        }
      }
    }
  }
})