import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function serveShortQrCodeBase(base: string): Plugin {
  const configuredBase = base.endsWith('/') ? base.slice(0, -1) : base

  return {
    name: 'serve-short-qrcode-base',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? ''
        const pathname = url.split('?')[0]

        if (
          (pathname === '/QrCode' || pathname.startsWith('/QrCode/')) &&
          !pathname.startsWith('/QrCode/api')
        ) {
          req.url = `${configuredBase}${pathname.slice('/QrCode'.length)}${url.slice(pathname.length)}`
        }

        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const base = env.VITE_BASE_PATH || process.env.VITE_BASE_PATH || '/corporate/QrCode/'
  const apiPort = env.PORT || process.env.PORT || '3001'
  const proxyTarget = `http://127.0.0.1:${apiPort}`
  const proxyOptions = {
    target: proxyTarget,
    changeOrigin: true,
  }

  return {
    base,
    plugins: [react(), serveShortQrCodeBase(base)],
    server: {
      proxy: {
        '/corporate/QrCode/api': proxyOptions,
        '/QrCode/api': proxyOptions,
      },
    },
  }
})
