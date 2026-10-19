import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into the server's static folder and served at /draw/.
export default defineConfig({
  base: "/draw/",
  plugins: [react()],
  build: { outDir: "../server/static/draw", emptyOutDir: true, chunkSizeWarningLimit: 5000 },
  server: { proxy: { "/api": "http://127.0.0.1:8765", "/files": "http://127.0.0.1:8765" } },
});
