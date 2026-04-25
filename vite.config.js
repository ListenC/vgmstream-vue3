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
      },
      // 确保 public 文件夹中的文件在开发服务器中可访问
      fs: {
        allow: ['..']
      }
    },

    build: {
      // 确保所有资源都被正确处理
      assetsDir: 'assets',
      copyPublicDir: true,
      // Worker 文件需要特殊处理
      worker: {
        format: 'es'
      },
      rollupOptions: {
        output: {
          // 确保大文件不被分割
          manualChunks: undefined
        }
      }
    }
  }
})