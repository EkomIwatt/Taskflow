import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The dev proxy lets the app run against a local backend on the SAME origin,
// so the httpOnly refresh cookie (Contract 1) round-trips without SameSite pain.
// The WebSocket does NOT go through this proxy in production: Vercel does not
// proxy WebSockets, so VITE_WS_BASE points at the API origin directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_API_TARGET ?? "http://localhost:8000",
        changeOrigin: false,
        ws: true,
      },
      "/ws": {
        target: process.env.VITE_DEV_API_TARGET ?? "http://localhost:8000",
        changeOrigin: false,
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
