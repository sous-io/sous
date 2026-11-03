import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The socket messages, defined once in the plugin.
      "@protocol": path.resolve(__dirname, "../src/protocol.ts"),
    },
  },
  server: {
    // `vite dev` talks to a running `sous serve --no-launch`. sous checks the Origin, so start it with
    // SOUS_SERVE_ORIGINS=http://localhost:5173.
    proxy: {
      "/ws": { target: "ws://127.0.0.1:4777", ws: true },
    },
  },
})
