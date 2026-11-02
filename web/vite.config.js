import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.MOCK_SERVER_URL || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/v1": { target, changeOrigin: true },
      "/mcp": { target, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
