import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const gatewayUrl = env.NEXUS_GATEWAY_URL || 'http://127.0.0.1:3000'

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': gatewayUrl,
        '/socket.io': {
          target: gatewayUrl,
          ws: true,
        },
      },
    },
  }
})
