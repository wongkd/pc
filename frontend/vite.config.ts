import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 开发期 /api 的目标。
 *
 * 默认指向**本地隔离后端** `backend/scripts/dev-server.mjs`
 * （miniflare 跑真实 Worker 入口 + 内存 D1 + 演示数据，不连远端）。
 *
 * 这里刻意不再默认指向生产（旧配置是 `/api/auth` → https://pc.huangqidong.cn）：
 * 前端调页面时会一路触发真实读写，拿生产库当调试库等于在真账上试手；
 * AGENTS 的停止条件也把「请求指向生产且环境未隔离」列为不得继续写入。
 *
 * 确实要连别的环境时用 `VITE_API_TARGET` 显式指定 —— 那是明确的选择，不是默认值。
 */
const LOCAL_API_TARGET = process.env.VITE_API_TARGET || 'http://127.0.0.1:8787'
const IS_LOCAL_TARGET = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(LOCAL_API_TARGET)

if (!IS_LOCAL_TARGET) {
  console.warn(`\n⚠️  /api 代理指向非本地地址：${LOCAL_API_TARGET}\n    此时 dev 的每一次读写都会落到该环境。请确认它不是你不想动的那套数据。\n`)
}

export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    proxy: {
      // 全部 /api 打到本地隔离后端；不再只代理 /api/auth 且指向生产。
      '/api': {
        target: LOCAL_API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
