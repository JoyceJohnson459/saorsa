import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"

const target = process.env.SAORSA_DEV_API ?? process.env.NEXCODE_DEV_API ?? process.env.TEAMOS_DEV_API ?? "http://127.0.0.1:8787"

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/api", "/auth", "/gateway", "/mcp", "/healthz"].map((path) => [path, { target, changeOrigin: false }])),
  },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: { echarts: ["echarts"], element: ["element-plus"] },
      },
    },
  },
})
