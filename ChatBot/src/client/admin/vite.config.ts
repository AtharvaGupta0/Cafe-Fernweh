import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: "/admin/",
  publicDir: path.resolve(__dirname, "../../public"),
  build: {
    outDir: path.resolve(__dirname, "../../../public/admin"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "index.html"),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      // Dev proxy: forward API calls to the local Worker so the admin dashboard
      // can run on http://localhost:5174 while the API runs on :8787 during
      // development. Cookies are NOT forwarded by this proxy (auth is verified
      // against the live Worker in end-to-end testing).
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
