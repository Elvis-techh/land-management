import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `host: true` exposes the dev server on your local network so you can open
    // Lindero on your real phone (http://<your-computer-ip>:5173) instead of
    // only trusting Chrome's device toolbar.
    host: true,
    // Anything the app requests at /api/... is forwarded to the Fastify backend
    // on port 3000. This means frontend code always calls "/api/lots" and never
    // needs to know the backend's address, in dev or in production.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
