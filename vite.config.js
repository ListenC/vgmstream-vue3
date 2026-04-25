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
      },
      // 禁用日志以防干扰
      middlewareMode: false
    },

    build: {
      // 确保所有资源都被正确处理
      assetsDir: 'assets',
      copyPublicDir: true,
      // 不压缩以防 WASM 损坏
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: {
        output: {
          // 确保大文件不被分割
          manualChunks: undefined
        }
      }
    },
    
    // 优化依赖预构建
    optimizeDeps: {
      // 不预构建 Worker
      exclude: ['./vgmstream/cli-worker.js']
    }
  }
})