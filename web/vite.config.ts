import path from 'node:path'

import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/* 局域网要用麦克风就得开 https：浏览器只在安全上下文下挂 navigator.mediaDevices，
   http://<IP> 不算，localhost 才豁免。做成开关是因为自签证书每换一个浏览器都要点一次
   "继续前往"，平时本机开发没必要吃这个成本——只有给局域网的人测时才 LAN_HTTPS=1。 */
const lanHttps = process.env.LAN_HTTPS === '1'

export default defineConfig({
  plugins: [{
    name: 'private-software-course',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const address = req.socket.remoteAddress
        if (req.url?.startsWith('/api/software-english') && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) {
          res.statusCode = 403
          res.end('Private software courses are only available on this Mac.')
          return
        }
        next()
      })
    },
  }, react(), tailwindcss(), ...(lanHttps ? [basicSsl()] : [])],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  /* harper.js 用 `new URL('harper_wasm_bg.wasm', import.meta.url)` 定位 wasm。
     被 esbuild 预打包后这个相对 URL 会指到 .vite/deps/ 下的不存在路径，
     dev server 按 SPA 回落返回 index.html，浏览器就报
     "expected magic word 00 61 73 6d, found 3c 21 44 4f"（那是 `<!DO`）。
     排除预打包后 Vite 按源文件解析，wasm 作为静态资产正常发出。 */
  optimizeDeps: { exclude: ['harper.js'] },
  server: {
    port: 5173,
    /* 局域网联调：监听所有网卡，同事用 http://<本机IP>:5173 直接访问。
       后端不必跟着暴露——前端一律走相对路径 /api，由下面的代理转发到回环地址上的 8100，
       WebSocket 也一样（ws: true），少开一个对外端口。 */
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        // 实时语音走 WebSocket，代理需透传升级请求
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
